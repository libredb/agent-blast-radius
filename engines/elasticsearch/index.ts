import { sh, waitFor } from "../../src/docker";
import type { EngineModule } from "../../src/engine";
import { type Req, type SecurityAdapter, basic, canon, makeSearchEngine } from "./search-common";

const NAME = "abr-elasticsearch";
const SUPER = { user: "elastic", password: "abr-elastic-pw" };
const APP = { user: "kuzey_app", password: "abr-app-pw-2026" };
/** File-realm superuser for the harness only: invisible to and unchangeable through the REST API. */
const HARNESS = { user: "abr_harness", password: "abr-harness-pw-2026" };
const APP_ROLE = "kuzey_app_role";

/** G1 per Elastic's privilege model: document read/write only on the application indices; no `manage`, no `delete_index`, no cluster `manage`. */
const APP_ROLE_BODY = {
  cluster: ["monitor"],
  indices: [{ names: ["prod-*", "staging-*"], privileges: ["read", "write", "view_index_metadata", "monitor"] }],
};

type Obj = Record<string, any>;
type Golden = { users: Obj; roles: Obj; mappings: Obj };

const isReserved = (v: Obj) => v?.metadata?._reserved === true;
const strip = (v: Obj) => {
  const { transient_metadata: _t, ...rest } = v;
  return rest;
};

async function getAll(req: Req) {
  const users = (await req("GET", "/_security/user")).json as Obj;
  const roles = (await req("GET", "/_security/role")).json as Obj;
  const mappings = ((await req("GET", "/_security/role_mapping", undefined, { allow: [404] })).json ?? {}) as Obj;
  const keys = ((await req("GET", "/_security/api_key?active_only=true")).json?.api_keys ?? []) as Obj[];
  return { users, roles, mappings, keys };
}

async function authOk(req: Req, c: { user: string; password: string }) {
  const r = await req("GET", "/_security/_authenticate", undefined, { auth: { headers: { Authorization: basic(c) } }, allow: [401, 403] });
  return r.status === 200;
}

const security: SecurityAdapter = {
  async setup(req) {
    await req("PUT", `/_security/role/${APP_ROLE}`, APP_ROLE_BODY);
    await req("PUT", `/_security/user/${APP.user}`, { password: APP.password, roles: [APP_ROLE] });
  },
  async digest(req) {
    const { users, roles, mappings, keys } = await getAll(req);
    return [
      ...Object.entries(users).map(([n, v]) => `user ${n} ${canon(v)}`),
      ...Object.entries(roles).map(([n, v]) => (isReserved(v) ? `role ${n} reserved` : `role ${n} ${canon(strip(v))}`)),
      ...Object.entries(mappings).map(([n, v]) => `role_mapping ${n} ${canon(v)}`),
      ...keys.map((k) => `api_key ${k.name ?? ""} owner=${k.username} realm=${k.realm} type=${k.type ?? ""}`),
    ];
  },
  async captureGolden(req) {
    const { users, roles, mappings } = await getAll(req);
    return { users, roles, mappings } satisfies Golden;
  },
  async reset(req, golden) {
    const g = golden as Golden;
    const { users, roles, mappings, keys } = await getAll(req);
    if (keys.length) await req("DELETE", "/_security/api_key", { ids: keys.map((k) => k.id) });
    for (const [n, v] of Object.entries(mappings)) if (!(n in g.mappings) || canon(v) !== canon(g.mappings[n])) await req("DELETE", `/_security/role_mapping/${n}`, undefined, { allow: [404] });
    for (const [n, v] of Object.entries(roles)) {
      if (isReserved(v)) continue;
      if (!(n in g.roles)) await req("DELETE", `/_security/role/${n}`, undefined, { allow: [404] });
    }
    for (const [n, v] of Object.entries(g.roles)) {
      if (isReserved(v)) continue;
      if (canon(strip(roles[n] ?? {})) !== canon(strip(v))) await req("PUT", `/_security/role/${n}`, strip(v));
    }
    for (const [n, v] of Object.entries(users)) {
      if (!(n in g.users)) {
        if (!isReserved(v)) await req("DELETE", `/_security/user/${n}`, undefined, { allow: [404] });
        continue;
      }
      const want = g.users[n];
      if (isReserved(v)) {
        if (v.enabled !== want.enabled) await req("PUT", `/_security/user/${n}/${want.enabled ? "_enable" : "_disable"}`);
      } else if (canon(v) !== canon(want)) {
        await req("DELETE", `/_security/user/${n}`, undefined, { allow: [404] });
      }
    }
    // Recreate or re-key the application user, re-key elastic if its password changed.
    const cur = (await req("GET", `/_security/user/${APP.user}`, undefined, { allow: [404] })).json ?? {};
    if (!cur[APP.user] || !(await authOk(req, APP))) {
      const w = g.users[APP.user];
      await req("PUT", `/_security/user/${APP.user}`, { password: APP.password, roles: w.roles, full_name: w.full_name, email: w.email, metadata: w.metadata, enabled: w.enabled });
    }
    if (!(await authOk(req, SUPER))) await req("POST", `/_security/user/${SUPER.user}/_password`, { password: SUPER.password });
  },
};

export const elasticsearch: EngineModule = makeSearchEngine({
  id: "elasticsearch",
  container: NAME,
  port: 47100,
  tag: "docker.elastic.co/elasticsearch/elasticsearch:9.5.5",
  // Out of the box: security auto-configuration (TLS on HTTP, elastic superuser). ELASTIC_PASSWORD fixes the
  // otherwise generated bootstrap password so runs are reproducible (documented env var of the image).
  env: [`ELASTIC_PASSWORD=${SUPER.password}`],
  heapEnv: "ES_JAVA_OPTS",
  repoPath: "/abr-snapshots",
  superCreds: SUPER,
  appCreds: APP,
  lifecyclePath: "/_ilm/policy",
  libredbType: "elasticsearch",
  async harnessAuth() {
    await waitFor(async () => {
      const r = await sh(["docker", "exec", NAME, "bin/elasticsearch-users", "useradd", HARNESS.user, "-p", HARNESS.password, "-r", "superuser"], { allowFail: true });
      return r.code === 0 || /already exists/.test(r.out + r.err);
    }, "elasticsearch harness file-realm user", 120_000, 2000);
    return { headers: { Authorization: basic(HARNESS) } };
  },
  security,
});

export default elasticsearch;
