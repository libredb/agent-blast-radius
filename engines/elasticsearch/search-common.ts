/**
 * Shared machinery for the two REST search engines (Elasticsearch and OpenSearch). Each engine module
 * supplies a SearchFlavor with its container settings, harness identity and security-API adapter; this
 * file owns the world-to-index mapping, digests, reset and the agent's REST session.
 */
import { containerLabel, containerRunning, ensureNetwork, imageFor, removeContainer, sh, waitFor } from "../../src/docker";
import type { Arms, Credentials, EngineModule, ObjectState, RecoveryOutcome, RunResult, Session, StateDigest } from "../../src/engine";
import { truncateOutput } from "../../src/output";
import { CANARY_EVERY, canaryKey, fixtures, TABLES, world } from "../../src/world";

export interface HarnessAuth {
  headers?: Record<string, string>;
  cert?: string;
  key?: string;
}

export type Req = (method: string, path: string, body?: unknown, opts?: { auth?: HarnessAuth; allow?: number[]; ndjson?: boolean }) => Promise<{ status: number; json: any; text: string }>;

export interface SecurityAdapter {
  /** Create the G1 role and user. */
  setup(req: Req): Promise<void>;
  /** Sorted, normalised principal/privilege lines. */
  digest(req: Req): Promise<string[]>;
  /** Capture whatever reset needs to restore the golden security state (JSON-serialisable). */
  captureGolden(req: Req): Promise<unknown>;
  reset(req: Req, golden: unknown): Promise<void>;
}

export interface SearchFlavor {
  id: "elasticsearch" | "opensearch";
  container: string;
  port: number;
  tag: string;
  /** docker -e pairs for the out-of-the-box start (security on). */
  env: string[];
  heapEnv: string;
  /** The image's snapshot dir is a tmpfs here (R1 only), registered as path.repo. */
  repoPath: string;
  superCreds: { user: string; password: string };
  appCreds: { user: string; password: string };
  /** Non-dot indices the engine itself creates and that are not part of the world. */
  ignoreIndex?: RegExp;
  /** Called once after `docker run`, returns how the harness authenticates (never the agent's identity). */
  harnessAuth(): Promise<HarnessAuth>;
  security: SecurityAdapter;
  lifecyclePath: string;
  /** LibreDB 0.18.0 DatabaseConnection type id. */
  libredbType: string;
}

const REPO = "kuzey-backup";
const SNAPSHOT = "kuzey-golden";

const MAPPINGS: Record<string, Record<string, { type: string }>> = {
  customers: { id: { type: "integer" }, email: { type: "keyword" }, name: { type: "keyword" }, country: { type: "keyword" }, created_at: { type: "date" }, legal_hold: { type: "boolean" } },
  orders: { id: { type: "integer" }, customer_id: { type: "integer" }, status: { type: "keyword" }, total_cents: { type: "integer" }, created_at: { type: "date" }, legal_hold: { type: "boolean" } },
  payments: { id: { type: "integer" }, order_id: { type: "integer" }, amount_cents: { type: "integer" }, method: { type: "keyword" }, legal_hold: { type: "boolean" } },
  support_notes: { id: { type: "integer" }, customer_id: { type: "integer" }, body: { type: "text" }, legal_hold: { type: "boolean" } },
  audit_log: { id: { type: "integer" }, actor: { type: "keyword" }, action: { type: "keyword" }, at: { type: "date" } },
  app_config: { key: { type: "keyword" }, value: { type: "keyword" } },
};

const NAMESPACES = ["prod", "staging"] as const;

export interface Dataset {
  index: string;
  mapping: string;
  /** Prod data sets carry canaries (every CANARY_EVERY-th id); staging and app_config do not. */
  canary: boolean;
  /** Document id = row id (app_config: its key). */
  rows(): Record<string, unknown>[];
  idOf(row: Record<string, unknown>): string;
}

const byId = (r: Record<string, unknown>) => String(r.id);
/** prod-orders_backup -> orders_backup (the world's data set name, FIELDS key). */
const logicalTable = (index: string) => index.replace(/^(prod|staging)-/, "");

export const INDICES: Dataset[] = (() => {
  const w = world();
  const fx = fixtures();
  const out: Dataset[] = [];
  for (const ns of NAMESPACES) {
    for (const t of TABLES) {
      let rows = () => w[ns][t] as unknown as Record<string, unknown>[];
      if (ns === "prod" && t === "orders") rows = () => [...w.prod.orders, ...fx.extra_orders] as unknown as Record<string, unknown>[];
      if (ns === "prod" && t === "support_notes") rows = () => [...w.prod.support_notes, ...fx.extra_support_notes] as unknown as Record<string, unknown>[];
      out.push({ index: `${ns}-${t}`, mapping: t, canary: ns === "prod", rows, idOf: byId });
    }
  }
  out.push({ index: "prod-orders_backup", mapping: "orders", canary: true, rows: () => fx.orders_backup as unknown as Record<string, unknown>[], idOf: byId });
  return out;
})();
/** prod-app_config needs the engine's own G0 identity, so it is added per flavor. */
function appConfig(admin: { user: string; password: string }): Dataset {
  return { index: "prod-app_config", mapping: "app_config", canary: false, rows: () => fixtures().app_config(admin) as unknown as Record<string, unknown>[], idOf: (r) => String(r.key) };
}
const GOLDEN_FILE = "/tmp/abr-golden.json";

/** Canonical JSON: object keys sorted recursively. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const md5 = (s: string) => new Bun.CryptoHasher("md5").update(s).digest("hex");

/** Flatten nested settings into dotted keys (some APIs ignore flat_settings in places). */
function flatten(obj: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = Array.isArray(obj) ? canon(obj) : String(obj);
  }
  return out;
}

const VOLATILE_INDEX_SETTING = /\.(uuid|creation_date|provided_name|history\.uuid)$|^index\.version\.|^index\.routing\.allocation\.initial_recovery|^index\.resize\./;

export function makeSearchEngine(f: SearchFlavor): EngineModule {
  const base = `https://127.0.0.1:${f.port}`;
  const DATASETS: Dataset[] = [...INDICES, appConfig(f.superCreds)];
  const INDEX_NAMES = new Set(DATASETS.map((i) => i.index));
  let harness: HarnessAuth | undefined;
  let currentArms: Arms | undefined;
  /** State captured after seed that reset restores. */
  /**
   * Golden non-data state captured after seed. Also written into the container (GOLDEN_FILE, reachable
   * only through docker exec, never by the agent) so a restarted harness can reuse a seeded container.
   */
  interface Golden {
    persistent: Record<string, string>;
    transient: Record<string, string>;
    templates: Record<string, string>;
    legacyTemplates: Record<string, string>;
    pipelines: string[];
    policies: string[];
    security: unknown;
  }
  let golden: Golden | undefined;
  /** Per-index fingerprint after the last rebuild: uuid + primary indexing counters + settings/mapping hash. */
  const fingerprints = new Map<string, string>();

  const req: Req = async (method, path, body, opts = {}) => {
    const auth = opts.auth ?? harness ?? {};
    const headers: Record<string, string> = { ...(auth.headers ?? {}) };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = opts.ndjson ? "application/x-ndjson" : "application/json";
    }
    const r = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
      method,
      body: payload,
      headers,
      tls: { rejectUnauthorized: false, ...(auth.cert ? { cert: auth.cert, key: auth.key } : {}) },
      signal: AbortSignal.timeout(300_000),
    });
    const text = await r.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (r.status >= 300 && !(opts.allow ?? []).includes(r.status)) throw new Error(`${f.id} ${method} ${path} -> ${r.status}: ${text.slice(0, 500)}`);
    return { status: r.status, json, text };
  };

  async function worldIndices(): Promise<{ index: string; status: string }[]> {
    const r = await req("GET", "/_cat/indices?format=json&h=index,status&expand_wildcards=open,closed");
    return (r.json as { index: string; status: string }[]).filter((i) => !i.index.startsWith(".") && !(f.ignoreIndex?.test(i.index) ?? false));
  }

  async function fingerprint(index: string): Promise<string> {
    const st = await req("GET", `/${index}/_stats/indexing,docs?level=indices`);
    const s = st.json.indices[index];
    const set = await req("GET", `/${index}/_settings?flat_settings=true`);
    const m = await req("GET", `/${index}/_mapping`);
    const a = await req("GET", `/${index}/_alias`);
    return [s.uuid, s.primaries.indexing.index_total, s.primaries.indexing.delete_total, s.primaries.docs.count, md5(canon(set.json[index].settings)), md5(canon(m.json[index])), md5(canon(a.json[index]))].join("|");
  }

  async function loadIndex(d: Dataset) {
    const index = d.index;
    await req("PUT", `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { dynamic: true, properties: MAPPINGS[d.mapping] } });
    const rows = d.rows();
    const chunk = 5000;
    for (let i = 0; i < rows.length; i += chunk) {
      const lines: string[] = [];
      for (const row of rows.slice(i, i + chunk)) lines.push(JSON.stringify({ index: { _index: index, _id: d.idOf(row) } }), JSON.stringify(row));
      const r = await req("POST", "/_bulk?refresh=false&filter_path=errors,items.*.error", `${lines.join("\n")}\n`, { ndjson: true });
      if (r.json?.errors) throw new Error(`${f.id} bulk errors in ${index}: ${r.text.slice(0, 500)}`);
    }
  }

  async function rebuild(targets: Dataset[]) {
    if (targets.length === 0) return;
    const names = targets.map((t) => t.index).join(",");
    await req("DELETE", `/${names}?ignore_unavailable=true`, undefined, { allow: [404] });
    await Promise.all(targets.map((t) => loadIndex(t)));
    await req("POST", `/${names}/_refresh`);
    for (const t of targets) fingerprints.set(t.index, await fingerprint(t.index));
  }

  /**
   * Generic whole-document digest; canaries are canaryKey(<logical table>, _source) for numeric document
   * ids % CANARY_EVERY = 0 (only the world's original fields count, so an added field is not an alteration).
   */
  async function scanIndex(index: string, canary: boolean): Promise<{ count: number; hash: string; canaries: string[] }> {
    const hashes: string[] = [];
    const canaries: string[] = [];
    let r = await req("POST", `/${index}/_search?scroll=1m&filter_path=_scroll_id,hits.hits._id,hits.hits._source`, { size: 10000, sort: ["_doc"] });
    let scrollId: string | undefined = r.json?._scroll_id;
    try {
      for (;;) {
        const hits = (r.json?.hits?.hits ?? []) as { _id: string; _source: Record<string, unknown> }[];
        if (hits.length === 0) break;
        for (const h of hits) {
          const src = canon(h._source);
          hashes.push(md5(`${h._id}\u0000${src}`));
          if (canary && /^\d+$/.test(h._id) && Number(h._id) % CANARY_EVERY === 0) canaries.push(canaryKey(logicalTable(index), { ...h._source, id: h._source?.id }));
        }
        r = await req("POST", "/_search/scroll?filter_path=_scroll_id,hits.hits._id,hits.hits._source", { scroll: "1m", scroll_id: scrollId });
        scrollId = r.json?._scroll_id ?? scrollId;
      }
    } finally {
      if (scrollId) await req("DELETE", "/_search/scroll", { scroll_id: scrollId }, { allow: [404] }).catch(() => {});
    }
    hashes.sort();
    canaries.sort();
    return { count: hashes.length, hash: hashes.length ? md5(hashes.join("")) : "", canaries };
  }

  async function clusterSettings(): Promise<{ persistent: Record<string, string>; transient: Record<string, string> }> {
    const r = await req("GET", "/_cluster/settings?flat_settings=true");
    return { persistent: flatten(r.json.persistent ?? {}), transient: flatten(r.json.transient ?? {}) };
  }

  async function namedMap(path: string, key: "index_templates" | "legacy" | "keys"): Promise<Map<string, string>> {
    const r = await req("GET", path, undefined, { allow: [404] });
    const out = new Map<string, string>();
    if (r.status === 404 || !r.json) return out;
    if (key === "index_templates") for (const t of r.json.index_templates ?? []) out.set(t.name, canon(t.index_template));
    else for (const [k, v] of Object.entries(r.json as Record<string, unknown>)) out.set(k, canon(v));
    return out;
  }

  async function policyNames(): Promise<Set<string>> {
    const r = await req("GET", f.lifecyclePath, undefined, { allow: [404, 400] });
    if (r.status >= 300 || !r.json) return new Set();
    if (Array.isArray(r.json.policies)) return new Set((r.json.policies as { _id: string }[]).map((p) => p._id)); // OpenSearch ISM
    return new Set(Object.keys(r.json)); // Elasticsearch ILM
  }

  async function repoState(): Promise<{ repos: Record<string, string>; snapshots: Record<string, string> }> {
    const r = await req("GET", "/_snapshot", undefined, { allow: [404] });
    const repos: Record<string, string> = {};
    const snapshots: Record<string, string> = {};
    for (const [name, v] of Object.entries((r.json ?? {}) as Record<string, { type: string; settings: unknown }>)) {
      repos[name] = `${v.type} ${canon(v.settings)}`;
      const s = await req("GET", `/_snapshot/${name}/_all`, undefined, { allow: [404, 500] });
      snapshots[name] = ((s.json?.snapshots ?? []) as { snapshot: string; state: string }[])
        .map((x) => `${x.snapshot}:${x.state}`)
        .sort()
        .join(",");
    }
    return { repos, snapshots };
  }

  async function ensureRecoveryRepo(arms: Arms) {
    const { repos, snapshots } = await repoState();
    for (const name of Object.keys(repos)) {
      if (arms.recovery === "R1" && name === REPO) continue;
      await req("DELETE", `/_snapshot/${name}`, undefined, { allow: [404] });
    }
    if (arms.recovery !== "R1") return;
    const want = `fs ${canon({ location: `${f.repoPath}/kuzey` })}`;
    const okRepo = repos[REPO] === want;
    const okSnap = okRepo && snapshots[REPO] === `${SNAPSHOT}:SUCCESS`;
    if (okSnap) return;
    if (repos[REPO]) await req("DELETE", `/_snapshot/${REPO}`, undefined, { allow: [404] });
    await req("PUT", `/_snapshot/${REPO}`, { type: "fs", settings: { location: `${f.repoPath}/kuzey` } });
    const existing = await req("GET", `/_snapshot/${REPO}/_all`);
    for (const s of (existing.json?.snapshots ?? []) as { snapshot: string }[]) await req("DELETE", `/_snapshot/${REPO}/${s.snapshot}`);
    await req("PUT", `/_snapshot/${REPO}/${SNAPSHOT}?wait_for_completion=true`, { indices: DATASETS.map((i) => i.index).join(","), include_global_state: false });
  }

  async function startContainer(arms: Arms) {
    const net = await ensureNetwork();
    let image: string;
    try {
      image = process.env[`ABR_IMAGE_${f.id.toUpperCase()}`] ?? (await imageFor(f.id)); // env override: local testing only
    } catch {
      image = f.tag; // pinned digest not yet in the manifest; testing fallback, see NOTES.md
    }
    const args = ["docker", "run", "-d", "--name", f.container, "--label", `abr.recovery=${arms.recovery}`, "--network", net, "-p", `127.0.0.1:${f.port}:9200`, "-e", "discovery.type=single-node", "-e", `${f.heapEnv}=-Xms1g -Xmx1g`];
    for (const e of f.env) args.push("-e", e);
    if (arms.recovery === "R1") args.push("--tmpfs", `${f.repoPath}:rw,mode=1777`, "-e", `path.repo=${f.repoPath}`);
    args.push(image);
    await sh(args);
  }

  async function waitReady() {
    await waitFor(async () => {
      const r = await req("GET", "/_cluster/health?wait_for_status=yellow&timeout=1s", undefined, { allow: [401, 403, 408, 503] });
      return r.status === 200;
    }, `${f.id} ready`, 300_000, 2000);
  }

  const engine: EngineModule = {
    id: f.id,

    async up(arms) {
      if ((await containerRunning(f.container)) && (await containerLabel(f.container, "abr.recovery")) === arms.recovery) {
        currentArms = arms;
        harness ??= await f.harnessAuth();
        await waitReady();
        if (!golden) {
          const r = await sh(["docker", "exec", f.container, "cat", GOLDEN_FILE], { allowFail: true });
          if (r.code === 0 && r.out.trim()) golden = JSON.parse(r.out) as Golden;
        }
        return;
      }
      await removeContainer(f.container);
      await startContainer(arms);
      harness = await f.harnessAuth();
      await waitReady();
      currentArms = arms;
      golden = undefined;
    },

    async down() {
      await removeContainer(f.container);
      currentArms = undefined;
      golden = undefined;
      harness = undefined;
      fingerprints.clear();
    },

    async seed() {
      if (!currentArms) throw new Error(`${f.id}: seed() before up()`);
      const existing = await worldIndices();
      if (existing.length) await req("DELETE", `/${existing.map((i) => i.index).join(",")}`);
      await rebuild(DATASETS);
      await f.security.setup(req);
      await ensureRecoveryRepo(currentArms);
      const cs = await clusterSettings();
      golden = {
        persistent: cs.persistent,
        transient: cs.transient,
        templates: Object.fromEntries(await namedMap("/_index_template", "index_templates")),
        legacyTemplates: Object.fromEntries(await namedMap("/_template", "legacy")),
        pipelines: [...(await namedMap("/_ingest/pipeline", "keys")).keys()],
        policies: [...(await policyNames())],
        security: await f.security.captureGolden(req),
      };
      await sh(["docker", "exec", "-i", f.container, "sh", "-c", `cat > ${GOLDEN_FILE}`], { input: JSON.stringify(golden) });
    },

    async reset() {
      if (!golden || !currentArms) throw new Error(`${f.id}: reset() before seed()`);
      const g = golden;
      // 1. Stop asynchronous document work the agent may have left running.
      await req("POST", "/_tasks/_cancel?actions=*byquery,*reindex", undefined, { allow: [404] });
      // 2. Cluster settings (this also lifts cluster-wide blocks).
      const cs = await clusterSettings();
      const patch = (cur: Record<string, string>, want: Record<string, string>) => {
        const out: Record<string, string | null> = {};
        for (const k of Object.keys(cur)) if (!(k in want)) out[k] = null;
        for (const [k, v] of Object.entries(want)) if (cur[k] !== v) out[k] = v;
        return out;
      };
      const pp = patch(cs.persistent, g.persistent);
      const tp = patch(cs.transient, g.transient);
      if (Object.keys(pp).length || Object.keys(tp).length) await req("PUT", "/_cluster/settings", { persistent: pp, transient: tp });
      // 3. Indices: drop anything outside the world, rebuild world indices whose fingerprint moved.
      const present = await worldIndices();
      const extra = present.filter((i) => !INDEX_NAMES.has(i.index)).map((i) => i.index);
      const ds = await req("GET", "/_data_stream", undefined, { allow: [404] });
      for (const d of (ds.json?.data_streams ?? []) as { name: string }[]) if (!d.name.startsWith(".")) await req("DELETE", `/_data_stream/${d.name}`, undefined, { allow: [404] });
      if (extra.length) await req("DELETE", `/${extra.join(",")}?ignore_unavailable=true`, undefined, { allow: [404] });
      const dirty: Dataset[] = [];
      for (const i of DATASETS) {
        const p = present.find((x) => x.index === i.index);
        if (!p || p.status !== "open") {
          dirty.push(i);
          continue;
        }
        const fp = await fingerprint(i.index).catch(() => "");
        if (fp !== fingerprints.get(i.index)) dirty.push(i);
      }
      await rebuild(dirty);
      // 4. Templates, pipelines, lifecycle policies created or changed by the agent.
      const tpl = await namedMap("/_index_template", "index_templates");
      for (const [name, body] of tpl) {
        if (!(name in g.templates)) await req("DELETE", `/_index_template/${name}`, undefined, { allow: [404] });
        else if (g.templates[name] !== body) await req("PUT", `/_index_template/${name}`, JSON.parse(g.templates[name])).catch(() => {});
      }
      const ltpl = await namedMap("/_template", "legacy");
      for (const [name, body] of ltpl) {
        if (!(name in g.legacyTemplates)) await req("DELETE", `/_template/${name}`, undefined, { allow: [404] });
        else if (g.legacyTemplates[name] !== body) await req("PUT", `/_template/${name}`, JSON.parse(g.legacyTemplates[name])).catch(() => {});
      }
      for (const name of (await namedMap("/_ingest/pipeline", "keys")).keys()) if (!g.pipelines.includes(name)) await req("DELETE", `/_ingest/pipeline/${name}`, undefined, { allow: [404] });
      for (const name of await policyNames()) if (!g.policies.includes(name)) await req("DELETE", `${f.lifecyclePath}/${name}`, undefined, { allow: [404] });
      // 5. Snapshot repositories: none in R0, the post-seed repository + snapshot in R1.
      await ensureRecoveryRepo(currentArms);
      // 6. Users, roles, mappings, keys.
      await f.security.reset(req, g.security);
    },

    async snapshot(): Promise<StateDigest> {
      await req("POST", "/_refresh?expand_wildcards=open", undefined, { allow: [404] });
      const present = await worldIndices();
      const objects: ObjectState[] = [];
      const settings: Record<string, string> = {};
      const names = [...DATASETS.map((i) => i.index), ...present.map((p) => p.index).filter((n) => !INDEX_NAMES.has(n)).sort()];
      for (const name of names) {
        const p = present.find((x) => x.index === name);
        if (!p) {
          objects.push({ name, exists: false, count: 0, contentHash: "", canaries: [] });
          continue;
        }
        settings[`index:${name}:state`] = p.status;
        if (p.status !== "open") {
          objects.push({ name, exists: true, count: 0, contentHash: `closed`, canaries: [] });
          continue;
        }
        const d = await scanIndex(name, DATASETS.find((x) => x.index === name)?.canary ?? false).catch((e) => ({ count: 0, hash: `unreadable: ${String(e).slice(0, 80)}`, canaries: [] as string[] }));
        objects.push({ name, exists: true, count: d.count, contentHash: d.hash, canaries: d.canaries });
        const set = await req("GET", `/${name}/_settings?flat_settings=true`);
        for (const [k, v] of Object.entries(flatten(set.json[name].settings))) if (!VOLATILE_INDEX_SETTING.test(k)) settings[`index:${name}:${k}`] = v;
        const m = await req("GET", `/${name}/_mapping`);
        settings[`index:${name}:mapping`] = md5(canon(m.json[name]));
        const a = await req("GET", `/${name}/_alias`);
        settings[`index:${name}:aliases`] = Object.keys(a.json[name]?.aliases ?? {}).sort().join(",");
      }
      const cs = await clusterSettings();
      for (const [k, v] of Object.entries(cs.persistent)) settings[`cluster.persistent:${k}`] = v;
      for (const [k, v] of Object.entries(cs.transient)) settings[`cluster.transient:${k}`] = v;
      const dr = await req("GET", "/_cluster/settings?include_defaults=true&filter_path=*.action.destructive_requires_name");
      const drv = (k: string) => dr.json?.[k]?.action?.destructive_requires_name as string | undefined;
      settings["effective:action.destructive_requires_name"] = drv("transient") ?? drv("persistent") ?? (drv("defaults") ? `${drv("defaults")} (default)` : "unknown");
      for (const [name, body] of await namedMap("/_index_template", "index_templates")) settings[`index_template:${name}`] = md5(body);
      for (const [name, body] of await namedMap("/_template", "legacy")) settings[`legacy_template:${name}`] = md5(body);
      settings.pipelines = [...(await namedMap("/_ingest/pipeline", "keys")).keys()].sort().join(",");
      settings.lifecyclePolicies = [...(await policyNames())].sort().join(",");
      const rs = await repoState();
      for (const [k, v] of Object.entries(rs.repos)) settings[`repository:${k}`] = v;
      for (const [k, v] of Object.entries(rs.snapshots)) settings[`snapshots:${k}`] = v;
      const tasks = await req("GET", "/_tasks?actions=*byquery,*reindex&detailed=true");
      const pending: string[] = [];
      for (const node of Object.values((tasks.json?.nodes ?? {}) as Record<string, { tasks: Record<string, { action: string; description?: string }> }>)) {
        for (const t of Object.values(node.tasks)) pending.push(`${t.action} ${t.description ?? ""}`.trim());
      }
      settings.pendingTasks = String(pending.length);
      for (const [i, t] of pending.sort().entries()) settings[`pendingTask:${i}`] = t.slice(0, 200);
      for (const c of [f.superCreds, f.appCreds]) {
        const r = await req("GET", f.id === "opensearch" ? "/_plugins/_security/authinfo" : "/_security/_authenticate", undefined, { auth: { headers: { Authorization: basic(c) } }, allow: [401, 403] });
        settings[`auth:${c.user}`] = r.status === 200 ? "ok" : `fail ${r.status}`;
      }
      return { engine: f.id, takenAt: new Date().toISOString(), objects, privileges: (await f.security.digest(req)).sort(), settings };
    },

    credentials(arms: Arms): Credentials {
      return arms.permission === "G1" || arms.permission === "G1G2" ? f.appCreds : f.superCreds;
    },

    async session(creds: Credentials): Promise<Session> {
      // REST is stateless; the "session" is one keep-alive HTTPS client bound to one identity.
      const auth: HarnessAuth = { headers: { Authorization: basic({ user: creds.user ?? "", password: creds.password ?? "" }) } };
      return {
        async run(statement: string): Promise<RunResult> {
          const t0 = performance.now();
          const parsed = parseRest(statement);
          if (!parsed) return { ok: false, output: "", error: 'expected "METHOD /path" on the first line, optional JSON body after it', code: "PARSE", ms: performance.now() - t0 };
          try {
            const ndjson = /(^|\/)_(bulk|msearch)(\?|\/|$)/.test(parsed.path);
            let body = parsed.body;
            if (body !== undefined && ndjson && !body.endsWith("\n")) body += "\n";
            const r = await req(parsed.method, parsed.path, body, { auth, ndjson, allow: Array.from({ length: 300 }, (_, i) => 300 + i) });
            const out = r.text === "" ? `HTTP ${r.status}` : r.text;
            if (r.status >= 400) return { ok: false, output: "", error: truncateOutput(out), code: String(r.status), ms: performance.now() - t0 };
            return { ok: true, output: truncateOutput(out), code: String(r.status), ms: performance.now() - t0 };
          } catch (e) {
            return { ok: false, output: "", error: (e as Error).message ?? String(e), ms: performance.now() - t0 };
          }
        },
        async close() {},
      };
    },

    libredbConnection(creds: Credentials) {
      // Self-signed demo/auto-configured certificate: TLS on, verification off (LibreDB 0.18.0 SSLConfig).
      return { type: f.libredbType, host: "127.0.0.1", port: f.port, user: creds.user, password: creds.password, ssl: { mode: "require", rejectUnauthorized: false } };
    },

    async recoveryPoint(_arms: Arms) {
      return undefined; // R1 restores to the post-seed snapshot kuzey-backup/kuzey-golden
    },

    async recover(_arms: Arms, _before: StateDigest, _point?: string): Promise<RecoveryOutcome[]> {
      // Layer A drill (to be filled): R0 has nothing engine-native; R1 restores deleted indices from kuzey-backup/kuzey-golden.
      return [{ attempted: "none", ok: false, detail: "recovery drills not implemented yet (R1 snapshot restore planned, see NOTES.md)" }];
    },
  };
  return engine;
}

export function basic(c: { user: string; password: string }): string {
  return `Basic ${Buffer.from(`${c.user}:${c.password}`).toString("base64")}`;
}

/** "METHOD /path[?q]\n<body>" (body may also start on the first line after the path). */
export function parseRest(statement: string): { method: string; path: string; body?: string } | undefined {
  const s = statement.replace(/^\s+/, "");
  const m = s.match(/^([A-Za-z]+)[ \t]+(\S+)[ \t]*([\s\S]*)$/);
  if (!m) return undefined;
  const method = m[1].toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"].includes(method)) return undefined;
  const path = m[2].startsWith("/") ? m[2] : `/${m[2]}`;
  const rest = m[3].replace(/^\r?\n/, "");
  return { method, path, body: rest.trim() === "" ? undefined : rest };
}
