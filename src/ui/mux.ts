/**
 * Tiny video muxers for the growth clip: encoded frames in, a playable file
 * out. MP4 for H.264 (what X, Instagram and iMessage take), WebM for VP9 and
 * VP8 (browsers without an H.264 encoder). Frames come from WebCodecs with
 * exact timestamps, so the clip is smooth however slowly it was rendered,
 * which MediaRecorder (wall-clock timestamps) can't promise.
 *
 * Pure byte-building, no DOM: tested in tests/mux.test.ts. One video track,
 * no audio, everything in memory (a 15-second clip is a few megabytes).
 */

export interface EncodedSample {
  data: Uint8Array;
  /** Presentation time, microseconds. */
  time: number;
  /** Microseconds. */
  duration: number;
  key: boolean;
}

/** The colour space the encoder reports (WebCodecs' VideoColorSpaceInit, as plain strings). */
export interface TrackColour {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

export interface VideoTrack {
  /** WebCodecs codec string: 'avc1.…', 'vp09.…' or 'vp8'. */
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** H.264: the avcC record (WebCodecs' decoderConfig.description). */
  description?: Uint8Array;
  colour?: TrackColour;
}

// ─── Bytes ───────────────────────────────────────────────────────────────

class Bytes {
  private buf = new Uint8Array(1024);
  length = 0;

  private room(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number) {
    this.room(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }

  u16(v: number) {
    return this.u8(v >>> 8).u8(v);
  }

  u24(v: number) {
    return this.u8(v >>> 16).u8(v >>> 8).u8(v);
  }

  u32(v: number) {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }

  /** Big-endian unsigned integer in exactly `n` bytes (up to 2^53). */
  uint(v: number, n: number) {
    for (let i = n - 1; i >= 0; i--) this.u8(Math.floor(v / 2 ** (8 * i)) % 256);
    return this;
  }

  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return this.bytes(b);
  }

  ascii(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  zeros(n: number) {
    this.room(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** ISO/IEC 23091-4 (H.273) code points for the colour names WebCodecs uses. */
const PRIMARIES: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9, smpte432: 12 };
const TRANSFER: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, 'iec61966-2-1': 13, pq: 16, hlg: 18 };
const MATRIX: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, 'bt2020-ncl': 9 };

function colourCodes(c: TrackColour | undefined) {
  if (!c) return null;
  const p = c.primaries ? PRIMARIES[c.primaries] : undefined;
  const t = c.transfer ? TRANSFER[c.transfer] : undefined;
  const m = c.matrix ? MATRIX[c.matrix] : undefined;
  if (p === undefined && t === undefined && m === undefined) return null;
  // 2 = "unspecified" in H.273.
  return { primaries: p ?? 2, transfer: t ?? 2, matrix: m ?? 2, full: !!c.fullRange };
}

// ─── MP4 (ISO BMFF) ──────────────────────────────────────────────────────

function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const size = 8 + body.reduce((n, b) => n + b.length, 0);
  return concat([new Bytes().u32(size).ascii(type).done(), ...body]);
}

function fullBox(type: string, version: number, flags: number, ...body: Uint8Array[]): Uint8Array {
  return box(type, new Bytes().u8(version).u24(flags).done(), ...body);
}

const UNITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/** Media timescale: 90 kHz, so every common frame rate has a whole-number frame duration. */
const MP4_TIMESCALE = 90_000;

/**
 * An MP4 with the index (moov) up front so it plays while downloading,
 * then one chunk holding every frame. H.264 only (avc1 + avcC).
 */
export function muxMp4(track: VideoTrack, samples: EncodedSample[]): Uint8Array {
  if (!track.codec.startsWith('avc1') && !track.codec.startsWith('avc3')) throw new Error(`MP4 muxer takes H.264, not ${track.codec}`);
  if (!track.description) throw new Error('H.264 needs its avcC description');
  const n = samples.length;
  const ticks = samples.map((s) => Math.max(1, Math.round((s.duration * MP4_TIMESCALE) / 1e6)));
  const mediaDuration = ticks.reduce((a, b) => a + b, 0);
  const movieDuration = Math.round((mediaDuration / MP4_TIMESCALE) * 1000);

  const mvhd = fullBox('mvhd', 0, 0, (() => {
    const b = new Bytes().u32(0).u32(0).u32(1000).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10);
    for (const v of UNITY_MATRIX) b.u32(v);
    return b.zeros(24).u32(2).done();
  })());

  const tkhd = fullBox('tkhd', 0, 3, (() => {
    const b = new Bytes().u32(0).u32(0).u32(1).u32(0).u32(movieDuration).zeros(8).u16(0).u16(0).u16(0).u16(0);
    for (const v of UNITY_MATRIX) b.u32(v);
    return b.u32(track.width * 65536).u32(track.height * 65536).done();
  })());

  // 'und' packed as three 5-bit letters.
  const mdhd = fullBox('mdhd', 0, 0, new Bytes().u32(0).u32(0).u32(MP4_TIMESCALE).u32(mediaDuration).u16(0x55c4).u16(0).done());
  const hdlr = fullBox('hdlr', 0, 0, new Bytes().u32(0).ascii('vide').zeros(12).ascii('TinyTown video').u8(0).done());
  const vmhd = fullBox('vmhd', 0, 1, new Bytes().u16(0).u16(0).u16(0).u16(0).done());
  const dinf = box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1).done(), fullBox('url ', 0, 1)));

  const colour = colourCodes(track.colour);
  const colr = colour
    ? box('colr', new Bytes().ascii('nclx').u16(colour.primaries).u16(colour.transfer).u16(colour.matrix).u8(colour.full ? 0x80 : 0).done())
    : new Uint8Array(0);
  const name = 'TinyTown';
  const entry = box(
    track.codec.startsWith('avc3') ? 'avc3' : 'avc1',
    new Bytes()
      .zeros(6)
      .u16(1) // data_reference_index
      .zeros(16) // pre_defined, reserved
      .u16(track.width)
      .u16(track.height)
      .u32(0x00480000) // 72 dpi
      .u32(0x00480000)
      .u32(0)
      .u16(1) // frame_count
      .u8(name.length)
      .ascii(name)
      .zeros(31 - name.length)
      .u16(0x0018) // depth
      .u16(0xffff) // pre_defined = -1
      .done(),
    box('avcC', track.description),
    colr,
    box('pasp', new Bytes().u32(1).u32(1).done()),
  );
  const stsd = fullBox('stsd', 0, 0, new Bytes().u32(1).done(), entry);

  // Durations, run-length coded (one run when every frame is the same length).
  const runs: [count: number, delta: number][] = [];
  for (const t of ticks) {
    const last = runs.at(-1);
    if (last && last[1] === t) last[0]++;
    else runs.push([1, t]);
  }
  const stts = fullBox('stts', 0, 0, (() => {
    const b = new Bytes().u32(runs.length);
    for (const [c, d] of runs) b.u32(c).u32(d);
    return b.done();
  })());
  const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
  const stss = fullBox('stss', 0, 0, (() => {
    const b = new Bytes().u32(keys.length);
    for (const k of keys) b.u32(k);
    return b.done();
  })());
  const stsc = fullBox('stsc', 0, 0, new Bytes().u32(1).u32(1).u32(n).u32(1).done());
  const stsz = fullBox('stsz', 0, 0, (() => {
    const b = new Bytes().u32(0).u32(n);
    for (const s of samples) b.u32(s.data.length);
    return b.done();
  })());

  // The chunk offset depends on the size of everything before it, which doesn't depend on the offset's value.
  const build = (offset: number) => {
    const stco = fullBox('stco', 0, 0, new Bytes().u32(1).u32(offset).done());
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const minf = box('minf', vmhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    return box('moov', mvhd, box('trak', tkhd, mdia));
  };
  const ftyp = box('ftyp', new Bytes().ascii('isom').u32(0x200).ascii('isom').ascii('iso2').ascii('avc1').ascii('mp41').done());
  const payload = samples.reduce((a, s) => a + s.data.length, 0);
  const moov = build(ftyp.length + build(0).length + 8);
  const mdat = new Bytes().u32(8 + payload).ascii('mdat').done();
  return concat([ftyp, moov, mdat, ...samples.map((s) => s.data)]);
}

// ─── WebM (Matroska) ─────────────────────────────────────────────────────

/** An EBML element id's bytes (ids carry their own length marker). */
function ebmlId(id: number): Uint8Array {
  const n = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  return new Bytes().uint(id, n).done();
}

/** An EBML variable-length size. */
export function ebmlSize(size: number): Uint8Array {
  let n = 1;
  while (n < 8 && size >= 2 ** (7 * n) - 1) n++;
  const b = new Bytes().uint(size, n).done();
  b[0]! |= 1 << (8 - n);
  return b;
}

function el(id: number, ...body: Uint8Array[]): Uint8Array {
  const payload = concat(body);
  return concat([ebmlId(id), ebmlSize(payload.length), payload]);
}

function uintBytes(v: number, fixed?: number): Uint8Array {
  let n = fixed ?? 1;
  if (!fixed) while (n < 8 && v >= 2 ** (8 * n)) n++;
  return new Bytes().uint(v, n).done();
}

const elUint = (id: number, v: number, fixed?: number) => el(id, uintBytes(v, fixed));
const elStr = (id: number, s: string) => el(id, new Bytes().ascii(s).done());
const elFloat = (id: number, v: number) => el(id, new Bytes().f64(v).done());

function matroskaCodec(codec: string): string {
  if (codec.startsWith('vp09')) return 'V_VP9';
  if (codec.startsWith('vp8')) return 'V_VP8';
  throw new Error(`WebM muxer takes VP9 or VP8, not ${codec}`);
}

/**
 * A WebM with Cues (seeking) ahead of the clusters, so the file needs no
 * second pass by the player. A new cluster starts at every keyframe.
 */
export function muxWebm(track: VideoTrack, samples: EncodedSample[]): Uint8Array {
  const codecId = matroskaCodec(track.codec);
  const header = el(
    0x1a45dfa3,
    elUint(0x4286, 1), // EBMLVersion
    elUint(0x42f7, 1), // EBMLReadVersion
    elUint(0x42f2, 4), // EBMLMaxIDLength
    elUint(0x42f3, 8), // EBMLMaxSizeLength
    elStr(0x4282, 'webm'), // DocType
    elUint(0x4287, 4), // DocTypeVersion
    elUint(0x4285, 2), // DocTypeReadVersion
  );
  const last = samples.at(-1);
  const durationMs = last ? (last.time + last.duration) / 1000 : 0;
  const info = el(
    0x1549a966,
    elUint(0x2ad7b1, 1_000_000), // TimecodeScale: 1 ms
    elStr(0x4d80, 'TinyTown'), // MuxingApp
    elStr(0x5741, 'TinyTown'), // WritingApp
    elFloat(0x4489, durationMs), // Duration
  );
  const colour = colourCodes(track.colour);
  const video = el(
    0xe0,
    elUint(0xb0, track.width),
    elUint(0xba, track.height),
    ...(colour
      ? [
          el(
            0x55b0,
            elUint(0x55b1, colour.matrix),
            elUint(0x55b9, colour.full ? 2 : 1),
            elUint(0x55ba, colour.transfer),
            elUint(0x55bb, colour.primaries),
          ),
        ]
      : []),
  );
  const tracks = el(
    0x1654ae6b,
    el(
      0xae,
      elUint(0xd7, 1), // TrackNumber
      elUint(0x73c5, 1), // TrackUID
      elUint(0x83, 1), // TrackType: video
      elUint(0x9c, 0), // FlagLacing
      elStr(0x86, codecId),
      elUint(0x23e383, Math.round(1e9 / track.fps)), // DefaultDuration, ns
      video,
    ),
  );

  // Clusters: one per keyframe (or every 30 s, the most a block's 16-bit offset allows).
  const clusters: { time: number; parts: Uint8Array[] }[] = [];
  for (const s of samples) {
    const ms = Math.round(s.time / 1000);
    let c = clusters.at(-1);
    if (!c || s.key || ms - c.time > 30_000) clusters.push((c = { time: ms, parts: [elUint(0xe7, ms)] }));
    const block = new Bytes()
      .u8(0x81) // track 1
      .u16((ms - c.time) & 0xffff)
      .u8(s.key ? 0x80 : 0)
      .bytes(s.data)
      .done();
    c.parts.push(el(0xa3, block));
  }
  const clusterBytes = clusters.map((c) => el(0x1f43b675, ...c.parts));

  // Cues before the clusters: positions are fixed-width, so the cues' size doesn't depend on them.
  const cues = (positions: number[]) =>
    el(
      0x1c53bb6b,
      ...clusters.map((c, i) => el(0xbb, elUint(0xb3, c.time), el(0xb7, elUint(0xf7, 1), elUint(0xf1, positions[i] ?? 0, 8)))),
    );
  let at = info.length + tracks.length + cues([]).length;
  const positions = clusterBytes.map((b) => {
    const p = at;
    at += b.length;
    return p;
  });
  const segment = el(0x18538067, info, tracks, cues(positions), ...clusterBytes);
  return concat([header, segment]);
}

/** The container and MIME type for a WebCodecs codec string. */
export function containerFor(codec: string): { ext: 'mp4' | 'webm'; mime: string } {
  return codec.startsWith('avc') ? { ext: 'mp4', mime: 'video/mp4' } : { ext: 'webm', mime: 'video/webm' };
}
