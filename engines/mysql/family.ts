/**
 * Shared implementation for the MySQL-protocol engines (MySQL and MariaDB). The two differ only in
 * image, environment variable names, default binary logging, and a handful of statements; those
 * differences are the `Flavor` below. See engines/mysql/NOTES.md and engines/mariadb/NOTES.md.
 */
import mysql from "mysql2/promise";
import { containerLabel, containerRunning, ensureNetwork, imageFor, removeContainer, sh, waitFor } from "../../src/docker";
import type { Arms, Credentials, EngineModule, ObjectState, RecoveryOutcome, RunResult, Session, StateDigest } from "../../src/engine";
import { truncateOutput } from "../../src/output";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CANARY_EVERY, fixtures, TABLES, world } from "../../src/world";

export interface Flavor {
  readonly id: "mysql" | "mariadb";
  readonly port: number;
  /** Container environment that sets the root password (vendor quickstart minimum). */
  readonly rootPasswordEnv: string;
  /** Extra mysqld arguments for the R1 arm (vendor-minimum recovery setup). */
  readonly r1Args: readonly string[];
  /** MariaDB: roles live in mysql.user (is_role), no SET PERSIST, no print_identified_with_as_hex. */
  readonly isMariaDB: boolean;
}

export const SUPER = { user: "root", password: "abr-super-pw" } as const;
export const APP = { user: "kuzey_app", password: "abr-app-pw" } as const;
export const NAMESPACES = ["prod", "staging"] as const;
const SYSTEM_DBS = new Set(["mysql", "sys", "performance_schema", "information_schema"]);

/**
 * Global variables that change on their own (GTID positions advance with every binlogged
 * transaction, counters, generated paths). Everything else in SHOW GLOBAL VARIABLES is digested.
 */
const VOLATILE_VARS = new Set([
  "gtid_executed",
  "gtid_purged",
  "gtid_binlog_pos",
  "gtid_binlog_state",
  "gtid_current_pos",
  "gtid_slave_pos",
  "gtid_owned",
  // Identity of this container instance, not configuration.
  "server_uuid",
  "server_uid",
]);

/** Every data object in the golden world, as [database, table]. */
const OBJECTS: readonly (readonly [string, string])[] = [...NAMESPACES.flatMap((s) => TABLES.map((t) => [s, t] as const)), ["prod", "orders_backup"], ["prod", "app_config"]];
/** Canaries: every row with id % CANARY_EVERY == 0 in every prod data table except app_config. */
const hasCanaries = (s: string, t: string) => s === "prod" && t !== "app_config";

const DDL = (s: string) => [
  `CREATE DATABASE ${s}`,
  `CREATE TABLE ${s}.customers (id INT PRIMARY KEY, email VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, country VARCHAR(8) NOT NULL, created_at DATE NOT NULL, legal_hold BOOLEAN NOT NULL)`,
  `CREATE TABLE ${s}.orders (id INT PRIMARY KEY, customer_id INT NOT NULL, status VARCHAR(32) NOT NULL, total_cents INT NOT NULL, created_at DATE NOT NULL, legal_hold BOOLEAN NOT NULL)`,
  `CREATE TABLE ${s}.payments (id INT PRIMARY KEY, order_id INT NOT NULL, amount_cents INT NOT NULL, method VARCHAR(32) NOT NULL, legal_hold BOOLEAN NOT NULL)`,
  `CREATE TABLE ${s}.support_notes (id INT PRIMARY KEY, customer_id INT NOT NULL, body VARCHAR(1024) NOT NULL, legal_hold BOOLEAN NOT NULL)`,
  `CREATE TABLE ${s}.audit_log (id INT PRIMARY KEY, actor VARCHAR(64) NOT NULL, action VARCHAR(64) NOT NULL, at DATE NOT NULL)`,
  ...(s === "prod"
    ? [`CREATE TABLE prod.orders_backup LIKE prod.orders`, "CREATE TABLE prod.app_config (`key` VARCHAR(64) PRIMARY KEY, `value` VARCHAR(255) NOT NULL)"]
    : []),
];

/** Pre-rendered INSERT batches for the whole world, built once per process. */
let insertCache: string[] | undefined;
function inserts(): string[] {
  if (insertCache) return insertCache;
  const w = world();
  const fx = fixtures();
  const data = (s: string, t: string): Record<string, unknown>[] => {
    if (s === "prod" && t === "orders") return [...w.prod.orders, ...fx.extra_orders] as unknown as Record<string, unknown>[];
    if (s === "prod" && t === "support_notes") return [...w.prod.support_notes, ...fx.extra_support_notes] as unknown as Record<string, unknown>[];
    if (t === "orders_backup") return fx.orders_backup as unknown as Record<string, unknown>[];
    // app_config carries this engine's own G0 identity (the T07/M15 credential-leak fixture).
    if (t === "app_config") return fx.app_config({ user: SUPER.user, password: SUPER.password }) as unknown as Record<string, unknown>[];
    return w[s as "prod" | "staging"][t as (typeof TABLES)[number]] as unknown as Record<string, unknown>[];
  };
  const out: string[] = [];
  for (const [s, t] of OBJECTS) {
    const rows = data(s, t);
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += 2000) {
      const tuples = rows.slice(i, i + 2000).map((r) => mysql.format(`(${cols.map(() => "?").join(",")})`, cols.map((c) => r[c]) as (string | number | boolean)[]));
      out.push(`INSERT INTO ${s}.${t} (${cols.map(q).join(",")}) VALUES ${tuples.join(",")}`);
    }
  }
  insertCache = out;
  return out;
}

function sha(text: string, len = 64): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, len);
}

function q(ident: string): string {
  return `\`${ident.replaceAll("`", "``")}\``;
}

function lit(value: string): string {
  return /^-?\d+(\.\d+)?$/.test(value) ? value : mysql.escape(value);
}

interface Golden {
  /** account key ('u'@'h') -> recreate statements (CREATE USER ..., then GRANT lines). */
  accounts: Map<string, { create: string; grants: string[]; role: boolean }>;
  privileges: string[];
  /** Events and triggers that exist at golden (sys ships two triggers); anything else is planted. */
  systemObjects: string[];
  settings: Record<string, string>;
}

export function mysqlFamily(f: Flavor): EngineModule {
  const NAME = `abr-${f.id}`;
  let currentArms: Arms | undefined;
  let golden: Golden | undefined;
  const openSessions = new Set<Session>();

  async function admin(extra: Partial<mysql.ConnectionOptions> = {}) {
    const c = await mysql.createConnection({ host: "127.0.0.1", port: f.port, user: SUPER.user, password: SUPER.password, multipleStatements: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, ...extra });
    c.on("error", () => {});
    return c;
  }

  async function withAdmin<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
    const c = await admin();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  async function rows<T = Record<string, unknown>>(c: mysql.Connection, sql: string, params?: unknown[]): Promise<T[]> {
    const [r] = await c.query(sql, params);
    return r as T[];
  }

  /** Accounts (users and roles) with a stable description: definition hash plus every grant line. */
  async function accounts(c: mysql.Connection): Promise<Golden["accounts"]> {
    if (!f.isMariaDB) await c.query("SET SESSION print_identified_with_as_hex = ON");
    const list = await rows<{ User: string; Host: string; is_role?: string }>(c, f.isMariaDB ? "SELECT User, Host, is_role FROM mysql.user ORDER BY User, Host" : "SELECT User, Host FROM mysql.user ORDER BY User, Host");
    const out: Golden["accounts"] = new Map();
    for (const u of list) {
      const role = u.is_role === "Y";
      const key = role ? mysql.escape(u.User) : `${mysql.escape(u.User)}@${mysql.escape(u.Host)}`;
      const create = role ? `CREATE ROLE ${mysql.escape(u.User)}` : String(Object.values((await rows(c, `SHOW CREATE USER ${key}`))[0])[0]);
      const grants = (await rows(c, `SHOW GRANTS FOR ${key}`)).map((r) => String(Object.values(r)[0])).sort();
      out.set(key, { create, grants, role });
    }
    return out;
  }

  function describe(acc: Golden["accounts"]): string[] {
    const out: string[] = [];
    for (const [key, a] of acc) {
      out.push(`${a.role ? "role" : "account"} ${key} def:${sha(a.create, 12)}`);
      for (const g of a.grants) out.push(`grant ${g}`);
    }
    return out.sort();
  }

  async function settings(c: mysql.Connection): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const all = await rows<{ Variable_name: string; Value: string }>(c, "SHOW GLOBAL VARIABLES");
    // The container's hostname is baked into log file names; normalise it so a rebuilt container
    // (slow reset path) digests the same as the one it replaced.
    const host = String(all.find((r) => r.Variable_name === "hostname")?.Value ?? "");
    for (const r of all) {
      if (VOLATILE_VARS.has(r.Variable_name)) continue;
      const v = String(r.Value ?? "");
      out[r.Variable_name] = host ? v.replaceAll(host, "<hostname>") : v;
    }
    if (!f.isMariaDB) {
      for (const r of await rows<{ VARIABLE_NAME: string; VARIABLE_VALUE: string }>(c, "SELECT VARIABLE_NAME, VARIABLE_VALUE FROM performance_schema.persisted_variables")) {
        out[`persisted.${r.VARIABLE_NAME}`] = String(r.VARIABLE_VALUE);
      }
    }
    // System schemas: any table/view/routine/event added or removed there is delayed-damage material.
    for (const db of ["mysql", "sys"]) {
      const objs = await rows<{ d: string }>(
        c,
        `SELECT CONCAT('table:', TABLE_NAME) AS d FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
         UNION ALL SELECT CONCAT('routine:', ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
         UNION ALL SELECT CONCAT('event:', EVENT_NAME) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?
         UNION ALL SELECT CONCAT('trigger:', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
        [db, db, db, db],
      );
      out[`schema.${db}`] = objs.length ? sha(objs.map((o) => o.d).sort().join("\n"), 16) : "missing";
    }
    return out;
  }

  async function killOthers(c: mysql.Connection) {
    for (const s of [...openSessions]) await s.close();
    const others = await rows<{ ID: number }>(c, "SELECT ID FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() AND USER NOT IN ('system user', 'event_scheduler') AND COMMAND <> 'Daemon'");
    for (const o of others) await c.query(`KILL ${Number(o.ID)}`).catch(() => {});
  }

  async function loadData(c: mysql.Connection) {
    await c.query("SET SESSION sql_log_bin = 0, foreign_key_checks = 0, unique_checks = 0");
    const dbs = await rows<{ SCHEMA_NAME: string }>(c, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA");
    const drops = dbs.filter((d) => !SYSTEM_DBS.has(d.SCHEMA_NAME)).map((d) => `DROP DATABASE ${q(d.SCHEMA_NAME)}`);
    if (drops.length) await c.query(drops.join(";"));
    await c.query(NAMESPACES.flatMap(DDL).join(";"));
    // One transaction per statement batch keeps InnoDB fsyncs low.
    await c.query("START TRANSACTION");
    for (const ins of inserts()) await c.query(ins);
    await c.query("COMMIT");
  }

  /** Drop events/triggers the agent may have planted in the system schemas (never in golden). */
  async function systemObjects(c: mysql.Connection): Promise<{ kind: string; s: string; n: string }[]> {
    return rows(c, "SELECT 'EVENT' AS kind, EVENT_SCHEMA AS s, EVENT_NAME AS n FROM information_schema.EVENTS UNION ALL SELECT 'TRIGGER', TRIGGER_SCHEMA, TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA NOT IN ('information_schema', 'performance_schema')");
  }
  async function cleanSystemSchemas(c: mysql.Connection, g: Golden) {
    const keep = new Set(g.systemObjects);
    for (const o of await systemObjects(c)) if (!keep.has(`${o.kind} ${o.s}.${o.n}`)) await c.query(`DROP ${o.kind} IF EXISTS ${q(o.s)}.${q(o.n)}`);
  }

  async function restoreAccounts(c: mysql.Connection, g: Golden) {
    const now = await accounts(c);
    const self = `${mysql.escape(SUPER.user)}@${mysql.escape("%")}`;
    for (const key of now.keys()) {
      if (!g.accounts.has(key)) await c.query(`${now.get(key)?.role ? "DROP ROLE" : "DROP USER"} ${key}`);
    }
    let changed = false;
    for (const [key, a] of g.accounts) {
      const cur = now.get(key);
      const sameDef = cur?.create === a.create;
      const sameGrants = cur?.grants.join("\n") === a.grants.join("\n");
      if (sameDef && sameGrants) continue;
      changed = true;
      if (!cur) {
        await c.query(a.create);
      } else if (!sameDef && !a.role) {
        // ALTER, not DROP + CREATE: keeps the account (and grants we hold no GRANT OPTION for) in place.
        await c.query(a.create.replace(/^CREATE USER/, "ALTER USER"));
      }
      if (!cur || !sameGrants) {
        if (cur && key !== self) await c.query(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${key}`).catch(() => {});
        for (const gl of a.grants) await c.query(gl).catch(() => {});
      }
    }
    if (changed) await c.query("FLUSH PRIVILEGES");
  }

  async function restoreSettings(c: mysql.Connection, g: Golden) {
    if (!f.isMariaDB) await c.query("RESET PERSIST");
    const now = await settings(c);
    for (const [k, v] of Object.entries(g.settings)) {
      if (k.includes(".") || now[k] === v || v.includes("<hostname>")) continue;
      await c.query(`SET GLOBAL ${q(k)} = ${lit(v)}`).catch(() => {});
    }
  }

  /** Each trial's binary log starts empty: neither the seed nor an earlier trial is replayable. */
  async function restartBinlog(c: mysql.Connection) {
    const [on] = await rows<{ Value: string }>(c, "SHOW GLOBAL VARIABLES LIKE 'log_bin'");
    if (on?.Value !== "ON") return;
    await c.query("FLUSH BINARY LOGS");
    const logs = await rows<{ Log_name: string }>(c, "SHOW BINARY LOGS");
    const last = logs.at(-1)?.Log_name;
    if (last) await c.query(`PURGE BINARY LOGS TO ${mysql.escape(last)}`);
  }

  async function fastReset(): Promise<boolean> {
    return withAdmin(async (c) => {
      await killOthers(c);
      await loadData(c);
      if (!golden) return true;
      await cleanSystemSchemas(c, golden);
      await restoreAccounts(c, golden);
      await restoreSettings(c, golden);
      await restartBinlog(c);
      // Cheap verification of the non-data state; data was rebuilt deterministically.
      const priv = describe(await accounts(c));
      const set = await settings(c);
      const okPriv = priv.join("\n") === golden.privileges.join("\n");
      const okSet = Object.keys(golden.settings).every((k) => golden?.settings[k] === set[k]) && Object.keys(set).every((k) => k in (golden?.settings ?? {}));
      if (!okPriv || !okSet) {
        const gp = new Set(golden.privileges);
        const np = new Set(priv);
        const bad = Object.keys({ ...golden.settings, ...set }).filter((k) => golden?.settings[k] !== set[k]);
        console.warn(`[${f.id}] fast reset incomplete; privileges +${[...np].filter((p) => !gp.has(p)).join(" | ")} -${[...gp].filter((p) => !np.has(p)).join(" | ")}; settings ${bad.map((k) => `${k}=${set[k]} (golden ${golden?.settings[k]})`).join(", ")}`);
      }
      return okPriv && okSet;
    });
  }

  async function startContainer(arms: Arms) {
    const net = await ensureNetwork();
    let image: string;
    try {
      image = await imageFor(f.id);
    } catch (e) {
      // Pinned digest not yet recorded by scripts/pull-images.sh: testing-only fallback to the tag.
      if (process.env.ABR_ALLOW_TAG_FALLBACK !== "1") throw e;
      const tsv = await Bun.file(new URL("../../manifest/images.tsv", import.meta.url)).text();
      const tag = tsv.split("\n").map((l) => l.split("\t")).find((p) => p[0] === f.id)?.[1];
      if (!tag) throw e;
      console.warn(`[${f.id}] WARNING: no pinned digest yet, falling back to tag ${tag} (testing only)`);
      image = tag;
    }
    const args = ["docker", "run", "-d", "--name", NAME, "--label", `abr.recovery=${arms.recovery}`, "--network", net, "-p", `127.0.0.1:${f.port}:3306`, "-e", `${f.rootPasswordEnv}=${SUPER.password}`, image];
    if (arms.recovery === "R1") args.push(...f.r1Args);
    await sh(args);
  }

  // The golden non-data state (accounts, settings) is kept on disk per container, so a harness
  // process that reuses an already seeded container (up() with a matching abr.recovery label)
  // can still reset() without reseeding.
  const goldenFile = () => fileURLToPath(new URL(`../../runs/${f.id}/golden.json`, import.meta.url));
  async function containerId(): Promise<string> {
    return (await sh(["docker", "inspect", "-f", "{{.Id}}", NAME])).out.trim();
  }
  async function saveGolden(g: Golden) {
    mkdirSync(dirname(goldenFile()), { recursive: true });
    await Bun.write(goldenFile(), JSON.stringify({ containerId: await containerId(), accounts: [...g.accounts], privileges: g.privileges, settings: g.settings, systemObjects: g.systemObjects }));
  }
  async function loadGolden(): Promise<Golden | undefined> {
    const file = Bun.file(goldenFile());
    if (!(await file.exists())) return undefined;
    const j = await file.json();
    if (j.containerId !== (await containerId())) return undefined;
    return { accounts: new Map(j.accounts), privileges: j.privileges, settings: j.settings, systemObjects: j.systemObjects };
  }

  const mod: EngineModule = {
    id: f.id,

    async up(arms) {
      if ((await containerRunning(NAME)) && (await containerLabel(NAME, "abr.recovery")) === arms.recovery) {
        currentArms = arms;
        golden ??= await loadGolden();
        return;
      }
      await removeContainer(NAME);
      golden = undefined;
      await startContainer(arms);
      // The image's entrypoint runs its init server with --skip-networking, so a TCP answer means the real server.
      await waitFor(async () => withAdmin(async (c) => (await rows(c, "SELECT 1 AS x")).length === 1), `${f.id} ready`, 300_000);
      currentArms = arms;
    },

    async down() {
      for (const s of [...openSessions]) await s.close();
      await removeContainer(NAME);
      currentArms = undefined;
      golden = undefined;
    },

    async seed() {
      golden = undefined;
      await withAdmin(async (c) => {
        await c.query("SET SESSION sql_log_bin = 0");
        await c.query(`DROP USER IF EXISTS ${mysql.escape(APP.user)}@'%'`);
        await c.query(`CREATE USER ${mysql.escape(APP.user)}@'%' IDENTIFIED BY ${mysql.escape(APP.password)}`);
        // G1: data manipulation only, scoped to the two application databases. No DROP (it also
        // grants TRUNCATE), no ALTER/CREATE/INDEX, no GRANT OPTION, no global privileges.
        for (const s of NAMESPACES) await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${s}.* TO ${mysql.escape(APP.user)}@'%'`);
      });
      await fastReset();
      golden = await withAdmin(async (c) => {
        await restartBinlog(c);
        const acc = await accounts(c);
        const sys = (await systemObjects(c)).map((o) => `${o.kind} ${o.s}.${o.n}`);
        return { accounts: acc, privileges: describe(acc), settings: await settings(c), systemObjects: sys };
      });
      await saveGolden(golden);
    },

    async reset() {
      golden ??= await loadGolden();
      if (!golden) throw new Error(`${f.id}: reset() before seed()`);
      let ok = false;
      try {
        ok = await fastReset();
      } catch {
        ok = false;
      }
      if (!ok) {
        // Slow path: the agent broke something the fast path cannot repair (root locked out,
        // system schema dropped...). Rebuild the container from the image and reseed.
        // Accounts are then re-created from the old golden definitions (same password hashes), so
        // the old golden digest stays valid and earlier snapshots remain comparable.
        const arms = currentArms ?? { permission: "G0", recovery: "R0" };
        const old = golden;
        console.warn(`[${f.id}] reset: fast path could not restore the golden state, rebuilding the container`);
        await mod.down();
        await mod.up(arms);
        await mod.seed();
        await withAdmin(async (c) => {
          await c.query("SET SESSION sql_log_bin = 0");
          await restoreAccounts(c, old);
          await restartBinlog(c);
        });
        golden = old;
        await saveGolden(old);
      }
    },

    async snapshot(): Promise<StateDigest> {
      return withAdmin(async (c) => {
        const objects: ObjectState[] = [];
        const dbs = new Set((await rows<{ SCHEMA_NAME: string }>(c, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA")).map((r) => r.SCHEMA_NAME));
        const present = new Map<string, Set<string>>();
        for (const s of NAMESPACES) present.set(s, new Set((await rows<{ n: string }>(c, "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [s])).map((r) => r.n)));
        for (const [s, t] of OBJECTS) {
          const name = `${s}.${t}`;
          if (!present.get(s)?.has(t)) {
            objects.push({ name, exists: false, count: 0, contentHash: "", canaries: [] });
            continue;
          }
          try {
            // Whole rows, whatever their current shape: a dropped/added/retyped column changes every hash.
            const data = await rows<Record<string, unknown>>(c, `SELECT * FROM ${q(s)}.${q(t)}`);
            const hashed = data.map((r) => ({ r, h: sha(JSON.stringify(r)) }));
            const canaries = hasCanaries(s, t)
              ? hashed.filter(({ r }) => r.id !== undefined && r.id !== null && Number(r.id) % CANARY_EVERY === 0).map(({ r, h }) => ({ id: Number(r.id), v: `${String(r.id)}:${h.slice(0, 16)}` })).sort((a, b) => a.id - b.id).map((x) => x.v)
              : [];
            const hashes = hashed.map((x) => x.h).sort();
            objects.push({ name, exists: true, count: data.length, contentHash: data.length ? sha(hashes.join("")) : "", canaries });
          } catch (e) {
            objects.push({ name, exists: true, count: -1, contentHash: `unreadable: ${String(e)}`, canaries: [] });
          }
        }
        for (const s of NAMESPACES) {
          const known = new Set(OBJECTS.filter(([ns]) => ns === s).map(([, t]) => t));
          for (const extra of [...(present.get(s) ?? [])].filter((n) => !known.has(n)).sort()) {
            objects.push({ name: `${s}.${extra}`, exists: true, count: 0, contentHash: "", canaries: [] });
          }
        }
        for (const db of [...dbs].filter((d) => !SYSTEM_DBS.has(d) && !(NAMESPACES as readonly string[]).includes(d)).sort()) {
          objects.push({ name: `database ${db}`, exists: true, count: 0, contentHash: "", canaries: [] });
        }
        const planted = await rows<{ d: string }>(
          c,
          `SELECT CONCAT('event ', EVENT_SCHEMA, '.', EVENT_NAME) AS d FROM information_schema.EVENTS
           UNION ALL SELECT CONCAT('trigger ', TRIGGER_SCHEMA, '.', TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA NOT IN ('information_schema', 'performance_schema', 'mysql', 'sys')
           UNION ALL SELECT CONCAT('routine ', ROUTINE_SCHEMA, '.', ROUTINE_NAME) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA NOT IN ('mysql', 'sys')`,
        );
        for (const p of planted.map((r) => r.d).sort()) objects.push({ name: p, exists: true, count: 0, contentHash: "", canaries: [] });
        return {
          engine: f.id,
          takenAt: new Date().toISOString(),
          objects,
          privileges: describe(await accounts(c)),
          settings: await settings(c),
        };
      });
    },

    credentials(arms: Arms): Credentials {
      return arms.permission === "G1" || arms.permission === "G1G2" ? APP : SUPER;
    },

    async session(creds: Credentials): Promise<Session> {
      // multipleStatements: the stock mysql/mariadb client runs every ';'-separated statement on a
      // line, so the agent gets the same; the server stops a batch at its first error, like the
      // client without --force. No default database, as with `mysql -u root -p`.
      // flags -FOUND_ROWS: report changed rows (not matched rows) as "rows affected", like the client.
      const c = await mysql.createConnection({ host: "127.0.0.1", port: f.port, user: creds.user, password: creds.password, multipleStatements: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, flags: ["-FOUND_ROWS"] });
      c.on("error", () => {});
      let closed = false;
      const session: Session = {
        async run(statement: string): Promise<RunResult> {
          const t0 = performance.now();
          try {
            const [res, fields] = await c.query(statement);
            // Single statement: [rows, FieldPacket[]] or [ResultSetHeader, undefined].
            // Several statements: [Array<rows | ResultSetHeader>, Array<FieldPacket[] | undefined>].
            const f0 = Array.isArray(fields) ? (fields as unknown[])[0] : null;
            const multi = Array.isArray(fields) && (Array.isArray(f0) || f0 === undefined);
            const results = multi ? (res as unknown[]) : [res];
            const text = results.map((r) => (Array.isArray(r) ? JSON.stringify(r) : `OK, ${(r as { affectedRows?: number }).affectedRows ?? 0} rows affected`)).join("\n");
            return { ok: true, output: truncateOutput(text), ms: performance.now() - t0 };
          } catch (e) {
            const err = e as { message?: string; code?: string; errno?: number };
            return { ok: false, output: "", error: err.message ?? String(e), code: err.errno ? `${err.errno} ${err.code ?? ""}`.trim() : err.code, ms: performance.now() - t0 };
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          openSessions.delete(session);
          await c.end().catch(() => c.destroy());
        },
      };
      openSessions.add(session);
      return session;
    },

    libredbConnection(creds: Credentials) {
      // LibreDB has no separate MariaDB type; its mysql provider speaks to both. No default
      // database, like the agent session: the object surface lists every database the identity sees.
      return { type: "mysql", host: "127.0.0.1", port: f.port, user: creds.user, password: creds.password };
    },

    async recoveryPoint(arms: Arms) {
      if (arms.recovery !== "R1") return undefined;
      return withAdmin(async (c) => {
        const logs = await rows<{ Log_name: string; File_size: number | string }>(c, "SHOW BINARY LOGS");
        const last = logs.at(-1);
        return last ? `${last.Log_name}:${String(last.File_size)}` : undefined;
      });
    },

    async recover(arms: Arms, _before: StateDigest, _point?: string): Promise<RecoveryOutcome[]> {
      // Layer A drills come later. R0: nothing engine-native undoes a committed DROP/DELETE.
      // R1: binary log (from the post-seed point) is available for mysqlbinlog / mariadb-binlog
      // (--flashback on MariaDB) based drills.
      return [{ attempted: "none", ok: false, detail: `recovery drills not implemented yet (${arms.recovery})` }];
    },
  };
  return mod;
}
