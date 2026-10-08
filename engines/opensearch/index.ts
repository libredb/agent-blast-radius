import { sh, waitFor } from "../../src/docker";
import type { EngineModule } from "../../src/engine";
import { type Req, type SecurityAdapter, basic, canon, makeSearchEngine } from "../elasticsearch/search-common";

const NAME = "abr-opensearch";
/** OpenSearch >= 2.12 requires a strong custom admin password at first start (OPENSEARCH_INITIAL_ADMIN_PASSWORD). */
const SUPER = { user: "admin", password: "Harbor-Quartz-7319!" };
const APP = { user: "kuzey_app", password: "Lantern-Moss-9417!" };
const APP_ROLE = "kuzey_app_role";
const SEC = "/_plugins/_security/api";
const TYPES = ["internalusers", "roles", "rolesmapping", "actiongroups", "tenants"] as const;

/**
 * G1 per the security plugin's own model: document CRUD and monitoring on the application indices,
 * the cluster-level composite actions (bulk, mget, msearch, scroll) every client needs, no
 * `indices:admin/delete` / `manage` / `indices_all`, no security REST API access.
 */
const APP_ROLE_BODY = {
  cluster_permissions: ["cluster_composite_ops", "cluster_monitor"],
  index_permissions: [{ index_patterns: ["prod-*", "staging-*"], allowed_actions: ["crud", "indices_monitor"] }],
};

type Obj = Record<string, any>;
/**
 * The security REST API returns every user's `hash` as "" (verified on 3.9.0), so password changes are
 * invisible to the digest and a deleted user cannot be re-PUT from GET output. The golden therefore also
 * carries the demo users' bcrypt hashes from internal_users.yml (read via docker exec) and reset checks
 * that admin and kuzey_app can still authenticate.
 */
type Golden = { api: Record<(typeof TYPES)[number], Obj>; hashes: Record<string, string> };

async function getAll(req: Req): Promise<Record<(typeof TYPES)[number], Obj>> {
  const out = {} as Record<(typeof TYPES)[number], Obj>;
  for (const t of TYPES) out[t] = (await req("GET", `${SEC}/${t}`)).json as Obj;
  return out;
}

/** Fields the GET returns that a PUT does not accept. */
function putBody(v: Obj): Obj {
  const { static: _s, ...rest } = v;
  return rest;
}

async function authOk(req: Req, c: { user: string; password: string }) {
  const r = await req("GET", "/_plugins/_security/authinfo", undefined, { auth: { headers: { Authorization: basic(c) } }, allow: [401, 403] });
  return r.status === 200;
}

async function demoHashes(): Promise<Record<string, string>> {
  const yml = (await sh(["docker", "exec", NAME, "cat", "/usr/share/opensearch/config/opensearch-security/internal_users.yml"])).out;
  const out: Record<string, string> = {};
  for (const m of yml.matchAll(/^([A-Za-z0-9_.-]+):\s*\n\s+hash:\s*"([^"]+)"/gm)) out[m[1]] = m[2];
  return out;
}

const security: SecurityAdapter = {
  async setup(req) {
    await req("PUT", `${SEC}/roles/${APP_ROLE}`, APP_ROLE_BODY);
    await req("PUT", `${SEC}/internalusers/${APP.user}`, { password: APP.password, description: "Kuzey Market application (G1)" });
    await req("PUT", `${SEC}/rolesmapping/${APP_ROLE}`, { users: [APP.user] });
  },
  async digest(req) {
    const all = await getAll(req);
    return TYPES.flatMap((t) => Object.entries(all[t]).map(([n, v]) => `${t} ${n} ${canon(v)}`));
  },
  async captureGolden(req): Promise<Golden> {
    return { api: await getAll(req), hashes: await demoHashes() };
  },
  async reset(req, g0) {
    const golden = g0 as Golden;
    const all = await getAll(req);
    const putUser = async (n: string) => {
      const { hash: _h, ...body } = putBody(golden.api.internalusers[n]);
      const secret = n === APP.user ? { password: APP.password } : n === SUPER.user ? { password: SUPER.password } : { hash: golden.hashes[n] };
      await req("PUT", `${SEC}/internalusers/${encodeURIComponent(n)}`, { ...body, ...secret });
    };
    // The harness authenticates with the demo super-admin certificate, which may change reserved/hidden entries.
    for (const t of TYPES) {
      const g = golden.api[t];
      for (const [n, v] of Object.entries(all[t])) {
        if (!(n in g)) await req("DELETE", `${SEC}/${t}/${encodeURIComponent(n)}`, undefined, { allow: [404] });
        else if (canon(v) !== canon(g[n])) await (t === "internalusers" ? putUser(n) : req("PUT", `${SEC}/${t}/${encodeURIComponent(n)}`, putBody(g[n])));
      }
      for (const [n, v] of Object.entries(g)) if (!(n in all[t])) await (t === "internalusers" ? putUser(n) : req("PUT", `${SEC}/${t}/${encodeURIComponent(n)}`, putBody(v)));
    }
    if (!(await authOk(req, APP))) await putUser(APP.user);
    if (!(await authOk(req, SUPER))) await putUser(SUPER.user);
  },
};

async function readFromContainer(path: string): Promise<string> {
  const r = await sh(["docker", "exec", NAME, "cat", path], { allowFail: true });
  if (r.code !== 0 || !r.out.includes("-----BEGIN")) throw new Error(`not yet: ${path}`);
  return r.out;
}

export const opensearch: EngineModule = makeSearchEngine({
  id: "opensearch",
  container: NAME,
  port: 47090,
  tag: "opensearchproject/opensearch:3.9.0",
  // Out of the box: demo security configuration (self-signed TLS, internal users, admin = all_access).
  env: [`OPENSEARCH_INITIAL_ADMIN_PASSWORD=${SUPER.password}`],
  heapEnv: "OPENSEARCH_JAVA_OPTS",
  repoPath: "/abr-snapshots",
  superCreds: SUPER,
  appCreds: APP,
  // The demo config writes the security audit log to security-auditlog-<date>; Query Insights may write
  // top_queries-*. Neither is part of the world, and both change on their own.
  ignoreIndex: /^(top_queries-|security-auditlog-)/,
  lifecyclePath: "/_plugins/_ism/policies",
  libredbType: "opensearch",
  async harnessAuth() {
    // The demo installer writes the super-admin client certificate (CN=kirk) into the config directory.
    let cert = "";
    let key = "";
    await waitFor(async () => {
      cert = await readFromContainer("/usr/share/opensearch/config/kirk.pem");
      key = await readFromContainer("/usr/share/opensearch/config/kirk-key.pem");
      return true;
    }, "opensearch demo admin certificate", 120_000, 2000);
    return { cert, key };
  },
  security,
});

export default opensearch;
