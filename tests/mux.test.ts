import { describe, expect, it } from 'vitest';
import { containerFor, ebmlSize, muxMp4, muxWebm, type EncodedSample } from '../src/ui/mux.ts';

const fps = 30;
const frame = 1e6 / fps;
const samples: EncodedSample[] = Array.from({ length: 95 }, (_, i) => ({
  data: new Uint8Array(10 + (i % 7)).fill(i),
  time: Math.round(i * frame),
  duration: Math.round(frame),
  key: i % 60 === 0,
}));

/** Top-level and nested MP4 boxes, as [type, offset, size]. */
function boxes(b: Uint8Array, from = 0, to = b.length): [string, number, number][] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: [string, number, number][] = [];
  for (let at = from; at < to; ) {
    const size = v.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    out.push([type, at, size]);
    if (size < 8) throw new Error(`bad box at ${at}`);
    at += size;
  }
  return out;
}

function find(b: Uint8Array, path: string[]): [number, number] {
  let from = 0;
  let to = b.length;
  let hit: [string, number, number] | undefined;
  for (const type of path) {
    hit = boxes(b, from, to).find((x) => x[0] === type);
    if (!hit) throw new Error(`no ${type}`);
    from = hit[1] + 8;
    to = hit[1] + hit[2];
  }
  return [hit![1], hit![2]];
}

describe('MP4 muxer', () => {
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
  const mp4 = muxMp4({ codec: 'avc1.640028', width: 1080, height: 1920, fps, description: avcC, colour: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } }, samples);

  it('writes ftyp, then the index, then the frames', () => {
    expect(boxes(mp4).map((x) => x[0])).toEqual(['ftyp', 'moov', 'mdat']);
    const total = boxes(mp4).reduce((n, x) => n + x[2], 0);
    expect(total).toBe(mp4.length);
  });

  it('points the chunk offset at the first frame', () => {
    const [stco] = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
    const v = new DataView(mp4.buffer, mp4.byteOffset);
    expect(v.getUint32(stco + 12)).toBe(1);
    const offset = v.getUint32(stco + 16);
    expect([...mp4.subarray(offset, offset + 10)]).toEqual([...samples[0]!.data]);
    const last = samples.at(-1)!.data;
    expect([...mp4.subarray(mp4.length - last.length)]).toEqual([...last]);
  });

  it('indexes every frame with its size, duration and keyframes', () => {
    const v = new DataView(mp4.buffer, mp4.byteOffset);
    const [stsz] = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz']);
    expect(v.getUint32(stsz + 16)).toBe(samples.length);
    expect(v.getUint32(stsz + 20)).toBe(samples[0]!.data.length);
    const [stts] = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts']);
    expect(v.getUint32(stts + 12)).toBe(1);
    expect(v.getUint32(stts + 16)).toBe(samples.length);
    expect(v.getUint32(stts + 20)).toBe(3000);
    const [stss] = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stss']);
    expect(v.getUint32(stss + 12)).toBe(2);
    expect(v.getUint32(stss + 16)).toBe(1);
    expect(v.getUint32(stss + 20)).toBe(61);
    const [mdhd] = find(mp4, ['moov', 'trak', 'mdia', 'mdhd']);
    expect(v.getUint32(mdhd + 20)).toBe(90_000);
    expect(v.getUint32(mdhd + 24)).toBe(3000 * samples.length);
  });

  it('describes the picture: avc1 with avcC, size and colour', () => {
    const [stsd, size] = find(mp4, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
    const entry = boxes(mp4, stsd + 16, stsd + size)[0]!;
    expect(entry[0]).toBe('avc1');
    const v = new DataView(mp4.buffer, mp4.byteOffset);
    expect(v.getUint16(entry[1] + 32)).toBe(1080);
    expect(v.getUint16(entry[1] + 34)).toBe(1920);
    const inner = boxes(mp4, entry[1] + 86, entry[1] + entry[2]).map((x) => x[0]);
    expect(inner).toEqual(['avcC', 'colr', 'pasp']);
    const [tkhd] = find(mp4, ['moov', 'trak', 'tkhd']);
    expect(v.getUint32(tkhd + 84) / 65536).toBe(1080);
    expect(v.getUint32(tkhd + 88) / 65536).toBe(1920);
  });

  it('refuses codecs it cannot carry', () => {
    expect(() => muxMp4({ codec: 'vp8', width: 2, height: 2, fps }, samples)).toThrow();
    expect(() => muxMp4({ codec: 'avc1.640028', width: 2, height: 2, fps }, samples)).toThrow(/avcC/);
  });
});

/** Reads EBML elements: [id, offset of data, size]. */
function ebml(b: Uint8Array, from: number, to: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let at = from;
  while (at < to) {
    let len = 1;
    while (!(b[at]! & (0x80 >> (len - 1)))) len++;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[at + i]!;
    at += len;
    let sl = 1;
    while (!(b[at]! & (0x80 >> (sl - 1)))) sl++;
    let size = b[at]! & (0xff >> sl);
    for (let i = 1; i < sl; i++) size = size * 256 + b[at + i]!;
    at += sl;
    out.push([id, at, size]);
    at += size;
  }
  return out;
}

describe('WebM muxer', () => {
  const webm = muxWebm({ codec: 'vp09.00.40.08', width: 1080, height: 1080, fps }, samples);

  it('encodes EBML sizes in the fewest bytes', () => {
    expect([...ebmlSize(0)]).toEqual([0x80]);
    expect([...ebmlSize(126)]).toEqual([0xfe]);
    expect([...ebmlSize(127)]).toEqual([0x40, 0x7f]);
    expect([...ebmlSize(16382)]).toEqual([0x7f, 0xfe]);
    expect([...ebmlSize(16383)]).toEqual([0x20, 0x3f, 0xff]);
  });

  it('writes a header and one segment that fill the file', () => {
    const top = ebml(webm, 0, webm.length);
    expect(top.map((x) => x[0])).toEqual([0x1a45dfa3, 0x18538067]);
    const seg = top[1]!;
    expect(seg[1] + seg[2]).toBe(webm.length);
    const kids = ebml(webm, seg[1], seg[1] + seg[2]).map((x) => x[0]);
    expect(kids.slice(0, 3)).toEqual([0x1549a966, 0x1654ae6b, 0x1c53bb6b]);
    // A cluster per keyframe: frames 0 and 60.
    expect(kids.filter((k) => k === 0x1f43b675)).toHaveLength(2);
  });

  it('points each cue at its cluster', () => {
    const seg = ebml(webm, 0, webm.length)[1]!;
    const kids = ebml(webm, seg[1], seg[1] + seg[2]);
    const cues = kids.find((k) => k[0] === 0x1c53bb6b)!;
    const clusters = kids.filter((k) => k[0] === 0x1f43b675);
    const points = ebml(webm, cues[1], cues[1] + cues[2]);
    expect(points).toHaveLength(2);
    points.forEach((p, i) => {
      const [time, positions] = ebml(webm, p[1], p[1] + p[2]);
      const pos = ebml(webm, positions![1], positions![1] + positions![2]).find((x) => x[0] === 0xf1)!;
      let v = 0;
      for (let k = 0; k < pos[2]; k++) v = v * 256 + webm[pos[1] + k]!;
      // The cluster's id starts at its position from the segment's data.
      const idAt = seg[1] + v;
      expect([...webm.subarray(idAt, idAt + 4)]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
      expect(idAt).toBeLessThan(clusters[i]![1]);
      let t = 0;
      for (let k = 0; k < time![2]; k++) t = t * 256 + webm[time![1] + k]!;
      expect(t).toBe(i === 0 ? 0 : 2000);
    });
  });

  it('keeps every frame, keyframes flagged, times relative to their cluster', () => {
    const seg = ebml(webm, 0, webm.length)[1]!;
    const clusters = ebml(webm, seg[1], seg[1] + seg[2]).filter((k) => k[0] === 0x1f43b675);
    const blocks = clusters.flatMap((c) => ebml(webm, c[1], c[1] + c[2]).filter((k) => k[0] === 0xa3));
    expect(blocks).toHaveLength(samples.length);
    const second = blocks[61]!;
    expect(webm[second[1]]).toBe(0x81);
    expect((webm[second[1] + 1]! << 8) | webm[second[1] + 2]!).toBe(33);
    expect(webm[second[1] + 3]).toBe(0);
    expect(webm[blocks[60]![1] + 3]).toBe(0x80);
    expect([...webm.subarray(second[1] + 4, second[1] + second[2])]).toEqual([...samples[61]!.data]);
  });

  it('names the codec and the container', () => {
    expect(containerFor('avc1.640028')).toEqual({ ext: 'mp4', mime: 'video/mp4' });
    expect(containerFor('vp8')).toEqual({ ext: 'webm', mime: 'video/webm' });
    expect(() => muxWebm({ codec: 'avc1.640028', width: 2, height: 2, fps }, samples)).toThrow();
  });
});
