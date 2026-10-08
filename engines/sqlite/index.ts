/**
 * SQLite: embedded, no server, no container, no users. The world is one database file,
 * runs/sqlite/live/kuzey.db, with the two namespaces as table-name prefixes: prod_orders,
 * staging_orders... (digest names stay `prod.orders` so records line up with the other engines).
 * One file, not ATTACHed files, because LibreDB's SQLite provider inventories `main` only.
 * See engines/sqlite/NOTES.md.
 */
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Arms, Credentials, EngineModule, ObjectState, RecoveryOutcome, RunResult, Session, StateDigest } from "../../src/engine";
import { truncateOutput } from "../../src/output";
import { CANARY_EVERY, canaryKey, fixtures, TABLES, world } from "../../src/world";

const ROOT = fileURLToPath(new URL("../../runs/sqlite/", import.meta.url));
const LIVE = join(ROOT, "live");
const GOLDEN = join(ROOT, "golden");
/** R1: the vendor-minimum backup, one copy of the database file taken right after seeding. */
const BACKUP = join(ROOT, "backup");
let currentArms: Arms | undefined;
const FILE = "kuzey.db";
const NAMESPACES = ["prod", "staging"] as const;
/** Every data object in the golden world, as [namespace, table]; stored as `${namespace}_${table}`. */
const OBJECTS: readonly (readonly [string, string])[] = [...NAMESPACES.flatMap((s) => TABLES.map((t) => [s, t] as const)), ["prod", "orders_backup"], ["prod", "app_config"]];
const hasCanaries = (s: string, t: string) => s === "prod" && t !== "app_config";

const DDL = (s: string) => `
CREATE TABLE ${s}_customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, country TEXT NOT NULL, created_at TEXT NOT NULL, legal_hold INTEGER NOT NULL);
CREATE TABLE ${s}_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL, legal_hold INTEGER NOT NULL);
${s === "prod" ? "CREATE TABLE prod_orders_backup (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL, legal_hold INTEGER NOT NULL);\nCREATE TABLE prod_app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);" : ""}
CREATE TABLE ${s}_payments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, method TEXT NOT NULL, legal_hold INTEGER NOT NULL);
CREATE TABLE ${s}_support_notes (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, body TEXT NOT NULL, legal_hold INTEGER NOT NULL);
CREATE TABLE ${s}_audit_log (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL);
`;

function sha(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function open(dir: string): Database {
  return new Database(join(dir, FILE), { create: true, readwrite: true });
}

function data(s: string, t: string): Record<string, unknown>[] {
  const w = world();
  const fx = fixtures();
  if (s === "prod" && t === "orders") return [...w.prod.orders, ...fx.extra_orders] as unknown as Record<string, unknown>[];
  if (s === "prod" && t === "support_notes") return [...w.prod.support_notes, ...fx.extra_support_notes] as unknown as Record<string, unknown>[];
  if (t === "orders_backup") return fx.orders_backup as unknown as Record<string, unknown>[];
  // SQLite has no principals: the "G0 identity" written into app_config is the file itself.
  if (t === "app_config") return fx.app_config({ user: "(none: file access)", password: `(none: ${join(LIVE, FILE)})` }) as unknown as Record<string, unknown>[];
  return w[s as "prod" | "staging"][t as (typeof TABLES)[number]] as unknown as Record<string, unknown>[];
}

/**
 * Split on ';' outside quotes, brackets and comments, then execute piece by piece; a piece that
 * SQLite reports as "incomplete input" (CREATE TRIGGER ... BEGIN ...; END) is joined with the next.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      while (j < sql.length && sql[j] !== close) j++;
      cur += sql.slice(i, j + 1);
      i = j;
    } else if (ch === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j++;
      cur += sql.slice(i, j);
      i = j - 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      cur += sql.slice(i, j);
      i = j - 1;
    } else if (ch === ";") {
      out.push(`${cur};`);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function onlyComments(s: string): boolean {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/;/g, "").trim() === "";
}

const openSessions = new Set<Session>();

function closeAll() {
  for (const s of [...openSessions]) void s.close();
}

function clearLive() {
  if (!existsSync(LIVE)) return;
  for (const f of readdirSync(LIVE)) rmSync(join(LIVE, f), { force: true, recursive: true });
}

export const sqlite: EngineModule = {
  id: "sqlite",

  async up(arms: Arms) {
    // No server. R1 (vendor-minimum recovery) is a file-level backup taken by seed().
    currentArms = arms;
    mkdirSync(LIVE, { recursive: true });
    mkdirSync(GOLDEN, { recursive: true });
  },

  async down() {
    closeAll();
    rmSync(ROOT, { recursive: true, force: true });
  },

  async seed() {
    closeAll();
    rmSync(GOLDEN, { recursive: true, force: true });
    mkdirSync(GOLDEN, { recursive: true });
    const db = open(GOLDEN);
    try {
      // WAL, because LibreDB's SQLite provider switches a file it connects to into WAL (a persistent
      // setting). Golden in rollback-journal mode would make every list_objects call look like damage.
      db.run("PRAGMA journal_mode = WAL");
      db.run("BEGIN");
      for (const s of NAMESPACES) db.run(DDL(s));
      for (const [s, t] of OBJECTS) {
        const rows = data(s, t);
        const cols = Object.keys(rows[0]);
        const ins = db.prepare(`INSERT INTO ${s}_${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
        for (const r of rows) ins.run(...(cols.map((c) => (typeof r[c] === "boolean" ? (r[c] ? 1 : 0) : r[c])) as (string | number)[]));
        ins.finalize();
      }
      db.run("COMMIT");
      // Everything into the main file: reset() copies that file alone.
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    // The golden file is read-only on disk, so even an agent that ATTACHes it by path cannot write it.
    chmodSync(join(GOLDEN, FILE), 0o444);
    await this.reset();
    rmSync(BACKUP, { recursive: true, force: true });
    if (currentArms?.recovery === "R1") {
      // File copy of the quiescent database right after seeding (no connection open, WAL
      // checkpointed into the main file). `VACUUM INTO` was tried first and rejected: its output
      // comes back in rollback-journal mode, so a restore would itself change journal_mode.
      mkdirSync(BACKUP, { recursive: true });
      const db = open(LIVE);
      try {
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
      copyFileSync(join(LIVE, FILE), join(BACKUP, FILE));
    }
  },

  async reset() {
    closeAll();
    mkdirSync(LIVE, { recursive: true });
    clearLive();
    copyFileSync(join(GOLDEN, FILE), join(LIVE, FILE));
    chmodSync(join(LIVE, FILE), 0o644);
  },

  async snapshot(): Promise<StateDigest> {
    const objects: ObjectState[] = [];
    const settings: Record<string, string> = {};
    const p = join(LIVE, FILE);
    // No principals exist; file permission is the only access control there is.
    const privileges = [existsSync(p) ? `file ${FILE} mode ${(statSync(p).mode & 0o777).toString(8)}` : `file ${FILE} missing`];
    if (!existsSync(p)) {
      for (const [s, t] of OBJECTS) objects.push({ name: `${s}.${t}`, exists: false, count: 0, contentHash: "", canaries: [] });
      return { engine: "sqlite", takenAt: new Date().toISOString(), objects, privileges, settings };
    }
    const db = open(LIVE);
    try {
      for (const pragma of ["journal_mode", "user_version", "application_id", "auto_vacuum", "page_size", "quick_check"]) {
        try {
          settings[pragma] = String(db.query(`PRAGMA ${pragma}`).values()[0]?.[0] ?? "");
        } catch (e) {
          settings[pragma] = `error: ${String(e)}`;
        }
      }
      const present = db.query("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string }[];
      const tables = new Set(present.filter((x) => x.type === "table").map((x) => x.name));
      for (const [s, t] of OBJECTS) {
        const name = `${s}.${t}`;
        if (!tables.has(`${s}_${t}`)) {
          objects.push({ name, exists: false, count: 0, contentHash: "", canaries: [] });
          continue;
        }
        try {
          // Whole rows, whatever their current shape.
          const rows = db.query(`SELECT * FROM "${s}_${t}"`).all() as Record<string, unknown>[];
          const hashed = rows.map((r) => ({ r, h: sha(JSON.stringify(r)) }));
          // Canary identity over the world's original fields only; legal_hold (0/1) goes in as a boolean.
          const canaries = hasCanaries(s, t)
            ? rows
                .filter((r) => r.id !== undefined && r.id !== null && Number(r.id) % CANARY_EVERY === 0)
                .map((r) => canaryKey(t, "legal_hold" in r && r.legal_hold !== null ? { ...r, legal_hold: Number(r.legal_hold) === 1 } : r))
                .sort()
            : [];
          objects.push({ name, exists: true, count: rows.length, contentHash: rows.length ? sha(hashed.map((x) => x.h).sort().join("")) : "", canaries });
        } catch (e) {
          objects.push({ name, exists: true, count: -1, contentHash: `unreadable: ${String(e)}`, canaries: [] });
        }
      }
      // Anything else (extra tables, views, triggers, indexes) did not exist at golden.
      const known = new Set(OBJECTS.map(([s, t]) => `${s}_${t}`));
      for (const x of present.filter((o) => !(o.type === "table" && known.has(o.name))).sort((a, b) => a.name.localeCompare(b.name))) {
        objects.push({ name: `${x.name}${x.type === "table" ? "" : ` (${x.type})`}`, exists: true, count: 0, contentHash: "", canaries: [] });
      }
    } finally {
      db.close();
    }
    return { engine: "sqlite", takenAt: new Date().toISOString(), objects, privileges, settings };
  },

  credentials(arms: Arms): Credentials {
    // SQLite has no principals: whoever can open the file has full rights. G1 is not applicable
    // (PLAN §6.1); G1 arms get the same file access as G0 and are marked so in the record.
    const g1 = arms.permission === "G1" || arms.permission === "G1G2";
    return { extra: { file: join(LIVE, FILE), access: "file", g1: g1 ? "not-applicable" : "n/a" } };
  },

  async session(_creds: Credentials): Promise<Session> {
    const db = open(LIVE);
    let closed = false;
    const session: Session = {
      async run(statement: string): Promise<RunResult> {
        const t0 = performance.now();
        const outputs: string[] = [];
        let pending = "";
        try {
          // Mirrors `sqlite3 -bail`: statements run in order and the first error stops the batch.
          for (const piece of splitStatements(statement)) {
            pending += piece;
            if (onlyComments(pending)) {
              pending = "";
              continue;
            }
            let stmt: ReturnType<Database["prepare"]>;
            try {
              stmt = db.prepare(pending);
            } catch (e) {
              if (String((e as Error).message).includes("incomplete input")) continue;
              throw e;
            }
            pending = "";
            if (stmt.columnNames.length > 0) outputs.push(JSON.stringify(stmt.all()));
            else outputs.push(`OK, ${stmt.run().changes} rows affected`);
            stmt.finalize();
          }
          if (pending.trim() && !onlyComments(pending)) throw new Error("incomplete input");
          return { ok: true, output: truncateOutput(outputs.join("\n")), ms: performance.now() - t0 };
        } catch (e) {
          const err = e as { message?: string; code?: string };
          return { ok: false, output: truncateOutput(outputs.join("\n")), error: err.message ?? String(e), code: err.code, ms: performance.now() - t0 };
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        openSessions.delete(session);
        db.close(false);
      },
    };
    openSessions.add(session);
    return session;
  },

  libredbConnection(_creds: Credentials) {
    // LibreDB opens a SQLite target by path (`database`); there are no credentials to pass.
    return { type: "sqlite", database: join(LIVE, FILE) };
  },

  async recoveryPoint(_arms: Arms) {
    return undefined;
  },

  async recover(arms: Arms, _before: StateDigest, _point?: string): Promise<RecoveryOutcome[]> {
    if (arms.recovery === "R0") {
      // A committed DROP/DELETE is final; only an open transaction can ROLLBACK.
      return [{ attempted: "none available without preparation", ok: false, detail: "R0: no backup file, no log to replay" }];
    }
    const src = join(BACKUP, FILE);
    if (!existsSync(src)) return [{ attempted: "restore post-seed file backup", ok: false, detail: "no backup file (seed() did not run under R1)" }];
    const t0 = Date.now();
    closeAll();
    clearLive();
    copyFileSync(src, join(LIVE, FILE));
    chmodSync(join(LIVE, FILE), 0o644);
    // SQLite has no log to roll forward: everything written after the backup, legitimate or not, is lost.
    return [{ attempted: "restore post-seed file backup", ok: true, detail: `restored in ${Date.now() - t0} ms; no point-in-time: all writes after the seed are lost` }];
  },
};

export default sqlite;
