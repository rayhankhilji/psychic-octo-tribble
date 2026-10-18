/**
 * In-memory Supabase Management API, Vercel REST API and Stripe, just big
 * enough for tools/supabase-setup.mjs, tools/vercel-setup.mjs and
 * tools/launch.mjs. Each records its calls so tests can say "nothing was
 * written" or "a second run changed nothing".
 */

export interface Call {
  host: string;
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  headers: Headers;
}

type Handler = (c: Call) => Response | Promise<Response> | null;

const json = (data: unknown, status = 200) => Response.json(data, { status });

function parse(input: string, init: RequestInit = {}): Call {
  const url = new URL(input);
  const raw = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
  const headers = new Headers(init.headers);
  let body: any = null;
  if (raw) {
    if ((headers.get('Content-Type') ?? '').includes('json')) body = JSON.parse(raw);
    else body = Object.fromEntries(new URLSearchParams(raw));
  }
  return { host: url.host, method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, body, headers };
}

/** One fetch for every host; each fake claims its own. */
export function combine(...fakes: { handle: Handler }[]) {
  const calls: Call[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const c = parse(input, init);
    calls.push(c);
    for (const f of fakes) {
      const res = await f.handle(c);
      if (res) return res;
    }
    return json({ message: `No fake for ${c.method} ${c.host}${c.path}` }, 500);
  };
  return { fetch, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

// ─── Supabase ─────────────────────────────────────────────────────────────

export interface FakeSupabaseOptions {
  ref?: string;
  status?: string;
  history?: string[] | null;
  failOn?: string | null;
  auth?: Record<string, unknown>;
  keys?: { name: string; type: string; api_key: string }[];
  unhealthy?: string[];
}

export const SB_KEYS = {
  publishable: 'sb_publishable_PUBLICpublicPUBLICpublic123',
  secret: 'sb_secret_SECRETsecretSECRETsecretSECRET456',
  anon: 'eyJhbGciOiJIUzI1NiJ9.anon-legacy-jwt-aaaaaaaaaaaaaaaa',
  service: 'eyJhbGciOiJIUzI1NiJ9.service-legacy-jwt-ssssssssssssss',
};

export function fakeSupabase(o: FakeSupabaseOptions = {}) {
  const ref = o.ref ?? 'abcdefghijklmnopqrst';
  const state = {
    history: o.history === undefined ? null : o.history ? [...o.history] : null,
    ran: [] as string[],
    auth: { ...(o.auth ?? {}) } as Record<string, unknown>,
    smtpPass: null as string | null,
    patches: [] as Record<string, unknown>[],
  };
  const keys = o.keys ?? [
    { name: 'anon', type: 'legacy', api_key: SB_KEYS.anon },
    { name: 'service_role', type: 'legacy', api_key: SB_KEYS.service },
    { name: 'default', type: 'publishable', api_key: SB_KEYS.publishable },
    { name: 'default', type: 'secret', api_key: SB_KEYS.secret },
  ];
  const handle: Handler = (c) => {
    if (c.host !== 'api.supabase.com') return null;
    if (c.headers.get('Authorization') !== 'Bearer sbp_token') return json({ message: 'Unauthorized' }, 401);
    const base = `/v1/projects/${ref}`;
    if (c.method === 'GET' && c.path.startsWith('/v1/projects/') && c.path.split('/').length === 4) {
      return c.path === base ? json({ id: ref, ref, name: 'tinytown', region: 'us-east-1', status: o.status ?? 'ACTIVE_HEALTHY' }) : json({ message: 'Project not found' }, 404);
    }
    if (c.method === 'GET' && c.path === `${base}/health`) {
      return json(c.query.getAll('services').map((name) => ({ name, healthy: !(o.unhealthy ?? []).includes(name), status: (o.unhealthy ?? []).includes(name) ? 'UNHEALTHY' : 'ACTIVE_HEALTHY' })));
    }
    if (c.method === 'POST' && c.path === `${base}/database/query`) {
      const q: string = c.body.query;
      if (q.includes('to_regclass(')) return json([{ present: state.history !== null }]);
      if (q.startsWith('select version from')) return json((state.history ?? []).map((version) => ({ version })));
      if (c.body.read_only) return json({ message: 'read-only query expected to be a select' }, 400);
      if (q.startsWith('create schema if not exists supabase_migrations')) {
        state.history ??= [];
        return json([]);
      }
      const version = /values \('(\d+)'/.exec(q.slice(q.lastIndexOf('insert into supabase_migrations')))?.[1];
      if (!version) return json({ message: 'unrecognised query' }, 400);
      if (state.history === null) return json({ message: 'Failed to run sql query: ERROR: 42P01: relation "supabase_migrations.schema_migrations" does not exist' }, 400);
      if (q.startsWith('insert into supabase_migrations')) {
        state.history.push(version);
        return json([]);
      }
      if (o.failOn === version) return json({ message: 'Failed to run sql query: ERROR: 42P07: relation "profiles" already exists' }, 400);
      state.ran.push(version);
      state.history.push(version);
      return json([]);
    }
    if (c.path === `${base}/config/auth`) {
      if (c.method === 'GET') return json({ ...state.auth, smtp_pass: null });
      if (c.method === 'PATCH') {
        state.patches.push(c.body);
        const { smtp_pass, ...rest } = c.body;
        if (smtp_pass) state.smtpPass = smtp_pass;
        Object.assign(state.auth, rest);
        return json({ ...state.auth, smtp_pass: null });
      }
    }
    if (c.method === 'GET' && c.path === `${base}/api-keys`) {
      const reveal = c.query.get('reveal') === 'true';
      return json(keys.map((k) => ({ ...k, api_key: k.type === 'secret' && !reveal ? 'sb_secret_SECR••••••••' : k.api_key })));
    }
    return json({ message: `Unexpected ${c.method} ${c.path}` }, 500);
  };
  return { handle, state, ref };
}

// ─── Vercel ───────────────────────────────────────────────────────────────

export interface FakeVercelEnv {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
  comment?: string;
  gitBranch?: string | null;
}

export function fakeVercel(o: { productionBranch?: string; nodeVersion?: string; envs?: FakeVercelEnv[]; protectedPreviews?: boolean; domains?: { name: string }[]; branchApi?: boolean; failBuild?: boolean; config?: unknown } = {}) {
  const project: any = {
    id: 'prj_1',
    name: 'tinytown',
    nodeVersion: o.nodeVersion ?? '20.x',
    link: { type: 'github', repoId: 123, org: 'owner', repo: 'psychic-octo-tribble', productionBranch: o.productionBranch ?? 'claude/some-branch' },
    ssoProtection: o.protectedPreviews === false ? null : { deploymentType: 'preview' },
    protectionBypass: {} as Record<string, { scope: string }>,
  };
  const state = { project, envs: [...(o.envs ?? [])].map((e) => ({ ...e })), deployments: [] as any[], n: 0 };
  const domains = o.domains ?? [{ name: 'tinytown.vercel.app' }];
  const handle: Handler = (c) => {
    if (c.host === 'api.vercel.com') {
      if (c.headers.get('Authorization') !== 'Bearer vercel_token') return json({ error: { message: 'Not authorized' } }, 401);
      if (c.query.get('slug') !== 'my-team') return json({ error: { message: 'Team scope expected' } }, 403);
      const p = c.path;
      const pm = /^\/v9\/projects\/([^/]+)$/.exec(p);
      if (pm && c.method === 'GET') return pm[1] === project.name || pm[1] === project.id ? json(project) : json({ error: { message: 'Project not found', code: 'not_found' } }, 404);
      if (pm && c.method === 'PATCH') {
        Object.assign(project, c.body);
        return json(project);
      }
      if (p === `/v9/projects/${project.id}/branch` && c.method === 'PATCH') {
        if (o.branchApi === false) return json({ error: { message: 'Not found' } }, 404);
        project.link.productionBranch = c.body.branch;
        return json(project);
      }
      if (p === `/v9/projects/${project.id}/domains`) return json({ domains: domains.map((d) => ({ ...d, verified: true, redirect: null, gitBranch: null })) });
      if (p === `/v10/projects/${project.id}/env` && c.method === 'GET') {
        // Sensitive values never come back; encrypted ones do with decrypt=true.
        return json({ envs: state.envs.map((e) => (e.type === 'sensitive' ? { ...e, value: '', decrypted: false } : { ...e, decrypted: c.query.get('decrypt') === 'true' })) });
      }
      if (p === `/v10/projects/${project.id}/env` && c.method === 'POST') {
        const b = c.body;
        const clash = state.envs.find((e) => e.key === b.key && !e.gitBranch && e.target.some((t: string) => b.target.includes(t)));
        if (clash && c.query.get('upsert') !== 'true') return json({ error: { message: 'already exists', code: 'ENV_ALREADY_EXISTS' } }, 403);
        if (clash) throw new Error(`The tool upserted over an existing ${b.key}: it should have updated or split it`);
        const e = { id: `env_${++state.n}`, key: b.key, value: b.value, type: b.type, target: b.target, comment: b.comment };
        state.envs.push(e);
        return json({ created: e, failed: [] }, 201);
      }
      const em = new RegExp(`^/v9/projects/${project.id}/env/([^/]+)$`).exec(p);
      if (em) {
        const i = state.envs.findIndex((e) => e.id === em[1]);
        if (i < 0) return json({ error: { message: 'Not found' } }, 404);
        if (c.method === 'DELETE') {
          state.envs.splice(i, 1);
          return json({});
        }
        Object.assign(state.envs[i]!, c.body);
        return json(state.envs[i]);
      }
      if (p === '/v13/deployments' && c.method === 'POST') {
        const d = { id: `dpl_${++state.n}`, url: `tinytown-${c.body.gitSource.ref.replace(/\W+/g, '-')}-my-team.vercel.app`, readyState: 'QUEUED', target: c.body.target ?? null, ref: c.body.gitSource.ref, polls: 0 };
        state.deployments.push(d);
        return json(d);
      }
      const dm = /^\/v13\/deployments\/([^/]+)$/.exec(p);
      if (dm) {
        const d = state.deployments.find((x) => x.id === dm[1]);
        d.polls++;
        d.readyState = d.polls >= 2 ? (o.failBuild ? 'ERROR' : 'READY') : 'BUILDING';
        if (o.failBuild) d.errorMessage = 'Command "npm run build && node server/build-vercel.mjs" exited with 1';
        return json(d);
      }
      if (p === `/v1/projects/${project.id}/protection-bypass` && c.method === 'PATCH') {
        project.protectionBypass = { ...project.protectionBypass, bypass_secret_0123456789abcdef: { scope: 'automation-bypass' } };
        return json({ protectionBypass: project.protectionBypass });
      }
      return json({ error: { message: `Unexpected ${c.method} ${p}` } }, 500);
    }
    // The deployed site.
    if (c.host.endsWith('.vercel.app')) {
      const preview = c.host !== 'tinytown.vercel.app';
      if (preview && project.ssoProtection && !(c.headers.get('x-vercel-protection-bypass') && project.protectionBypass[c.headers.get('x-vercel-protection-bypass')!])) {
        return new Response('Authentication Required', { status: 401 });
      }
      if (c.path === '/api/config') return json(o.config ?? { hosted: true, supabase: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: SB_KEYS.publishable }, plans: [{ id: 'year' }], connect: { stripe: false, github: false, posthog: true } });
      if (c.path === '/api/health') {
        if (c.query.get('deep') === '1') {
          const want = state.envs.find((e) => e.key === 'HEALTH_SECRET' && e.target.includes(preview ? 'preview' : 'production'))?.value;
          return c.headers.get('Authorization') === `Bearer ${want}` ? json({ ok: true, degraded: false, checks: { supabase: { ok: true, critical: true, ms: 5 } } }) : json({ error: 'unauthenticated' }, 401);
        }
        return json({ ok: true, release: 'abc123def456' });
      }
      return new Response('not found', { status: 404 });
    }
    return null;
  };
  return { handle, state, project };
}

// ─── Stripe ───────────────────────────────────────────────────────────────

type Obj = Record<string, unknown> & { id: string };

/** Products, prices, coupons, webhook endpoints and portal configurations, one account per secret key. */
export function fakeStripe() {
  const accounts = new Map<string, { products: Obj[]; prices: Obj[]; coupons: Obj[]; webhook_endpoints: Obj[]; configurations: Obj[] }>();
  let n = 0;
  const list = (data: Obj[]) => json({ object: 'list', data, has_more: false });
  const handle: Handler = (c) => {
    if (c.host !== 'api.stripe.com') return null;
    const key = (c.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!accounts.has(key)) accounts.set(key, { products: [], prices: [], coupons: [], webhook_endpoints: [], configurations: [] });
    const s = accounts.get(key)!;
    const live = key.includes('_live_');
    const p = c.path;
    const body = c.method === 'GET' ? Object.fromEntries(c.query) : (c.body ?? {});
    const arr = (prefix: string) => Object.entries(body).filter(([k]) => k.startsWith(`${prefix}[`)).map(([, v]) => v);
    const one = (items: Obj[]) => {
      const found = items.find((x) => x.id === p.split('/').at(-1));
      return found ? json(found) : json({ error: { message: 'No such object', code: 'resource_missing' } }, 404);
    };
    if (c.method === 'GET') {
      if (p === '/v1/account') return json({ id: live ? 'acct_live' : 'acct_test', settings: { dashboard: { display_name: 'TinyTown Ltd' } } });
      if (p === '/v1/prices') {
        const keys = [...c.query].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v);
        return list(s.prices.filter((x) => keys.includes(String(x.lookup_key))));
      }
      if (p.startsWith('/v1/products/')) return one(s.products);
      if (p === '/v1/products') return list(s.products);
      if (p.startsWith('/v1/coupons/')) return one(s.coupons);
      if (p === '/v1/webhook_endpoints') return list(s.webhook_endpoints);
      if (p === '/v1/billing_portal/configurations') return list(s.configurations);
    }
    if (c.method === 'POST') {
      if (p === '/v1/products') {
        const o = { id: body.id ?? `prod_${++n}`, name: body.name, active: true };
        s.products.push(o);
        return json(o);
      }
      if (p === '/v1/prices') {
        const o = { id: `price_${live ? 'live' : 'test'}_${++n}`, product: body.product, lookup_key: body.lookup_key, unit_amount: Number(body.unit_amount), currency: body.currency, recurring: { interval: body['recurring[interval]'] }, active: true };
        s.prices.push(o);
        return json(o);
      }
      if (p === '/v1/coupons') {
        const o = { id: body.id, percent_off: Number(body.percent_off), amount_off: null, duration: body.duration, valid: true, metadata: { tinytown: body['metadata[tinytown]'] } };
        s.coupons.push(o);
        return json(o);
      }
      if (p === '/v1/webhook_endpoints') {
        const o = { id: `we_${++n}`, url: body.url, enabled_events: arr('enabled_events'), api_version: body.api_version, status: 'enabled', secret: `whsec_${live ? 'LIVE' : 'TEST'}signingSecret${n}xyz` };
        s.webhook_endpoints.push(o);
        return json(o);
      }
      if (p === '/v1/billing_portal/configurations') {
        const o = { id: `bpc_${++n}`, metadata: { tinytown: body['metadata[tinytown]'] }, active: true };
        s.configurations.push(o);
        return json(o);
      }
      const bpc = /^\/v1\/billing_portal\/configurations\/(\w+)$/.exec(p);
      if (bpc) return json(s.configurations.find((x) => x.id === bpc[1]));
    }
    return json({ error: { message: `Unexpected ${c.method} ${p}` } }, 500);
  };
  return { handle, accounts };
}
