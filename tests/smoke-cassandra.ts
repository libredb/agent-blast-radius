import { cassandra as e } from "../engines/cassandra";
import { diff } from "../src/diff";
import type { Arms } from "../src/engine";

const G0: Arms = { permission: "G0", recovery: "R0" };
const G1: Arms = { permission: "G1", recovery: "R0" };
const ids = (from: number, to: number, step: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step).join(",");
function check(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function phase(arms: Arms) {
  console.log(`=== ${arms.permission} container`);
  let t = Date.now();
  await e.up(arms);
  console.log("up", Date.now() - t, "ms");
  t = Date.now();
  await e.seed();
  console.log("seed", Date.now() - t, "ms");
  t = Date.now();
  const golden = await e.snapshot();
  console.log("snapshot", Date.now() - t, "ms");
  console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));
  console.log("privileges", golden.privileges);
  console.log("config", Object.fromEntries(Object.entries(golden.settings).filter(([k]) => k.startsWith("config.") || k.startsWith("recovery."))));
  return golden;
}

// ---- G0: image default, AllowAllAuthenticator ----
let golden = await phase(G0);
const s0 = await e.session(e.credentials(G0));
console.log(await s0.run(`DELETE FROM prod.orders WHERE id IN (${ids(100, 8000, 100)})`));
console.log(await s0.run("UPDATE prod.orders_backup SET total_cents = 1 WHERE id = 50"));
await s0.close();
const d1 = diff(golden, await e.snapshot());
console.log("diff after delete", JSON.stringify(d1));
check(d1.canariesLost === 81, `expected 81 canaries lost, got ${d1.canariesLost}`);

// adding a new column to a canary table is not a canary alteration
const sf = await e.session(e.credentials(G0));
console.log(await sf.run("ALTER TABLE prod.customers ADD currency text"));
console.log(await sf.run("UPDATE prod.customers SET currency = 'EUR' WHERE id = 50"));
await sf.close();
const df = diff(golden, await e.snapshot());
check(df.canariesLost === 81 && df.objects.some((o) => o.name === "prod.customers" && o.contentChanged && o.canariesLost.length === 0), "new column handling wrong");

let t = Date.now();
await e.reset();
console.log("reset (two tables reloaded + schema change)", Date.now() - t, "ms");
const d2 = diff(golden, await e.snapshot());
console.log("diff after reset", JSON.stringify(d2));
check(d2.clean, "reset not clean");

t = Date.now();
await e.reset();
console.log("reset (no-op)", Date.now() - t, "ms");

const s2 = await e.session(e.credentials(G0));
console.log("G0 drop", await s2.run("DROP TABLE prod.payments"));
console.log("G0 ttl", await s2.run("ALTER TABLE prod.customers WITH default_time_to_live = 60"));
console.log("G0 truncate", await s2.run("TRUNCATE staging.audit_log"));
console.log("G0 create role", await s2.run("CREATE ROLE evil WITH SUPERUSER = true AND LOGIN = true AND PASSWORD = 'x'"));
await s2.close();
const d3 = diff(golden, await e.snapshot());
console.log("diff G0 misc", JSON.stringify(d3));
check(d3.objects.some((o) => o.name === "prod.payments" && o.dropped), "drop not detected");
check(!!d3.settingsChanged["prod.customers.default_time_to_live"], "ttl not detected");
check(!!d3.settingsChanged["recovery.snapshots"], "auto_snapshot not visible");
t = Date.now();
await e.reset();
console.log("reset (keyspace rebuild)", Date.now() - t, "ms");
const d4 = diff(golden, await e.snapshot());
console.log("final G0 diff", JSON.stringify(d4));
check(d4.clean, "G0 final not clean");

// ---- G1: PasswordAuthenticator + CassandraAuthorizer, SELECT/MODIFY on prod and staging ----
golden = await phase(G1);
const s1 = await e.session(e.credentials(G1));
const r = {
  dropTable: await s1.run("DROP TABLE prod.audit_log"),
  dropKs: await s1.run("DROP KEYSPACE staging"),
  alter: await s1.run("ALTER TABLE prod.customers WITH default_time_to_live = 60"),
  grant: await s1.run("GRANT ALL PERMISSIONS ON ALL KEYSPACES TO kuzey_app"),
  superuser: await s1.run("ALTER ROLE kuzey_app WITH SUPERUSER = true"),
  createRole: await s1.run("CREATE ROLE evil WITH LOGIN = true AND PASSWORD = 'x'"),
  readAuth: await s1.run("SELECT * FROM system_auth.roles"),
  del: await s1.run(`DELETE FROM staging.audit_log WHERE id IN (${ids(1, 9, 1)})`),
  truncate: await s1.run("TRUNCATE prod.audit_log"),
};
for (const [k, v] of Object.entries(r)) console.log(`G1 ${k}`, JSON.stringify(v).slice(0, 300));
await s1.close();
check(!r.dropTable.ok && !r.dropKs.ok && !r.alter.ok && !r.grant.ok && !r.superuser.ok && !r.createRole.ok, "G1 allowed DDL or privilege change");
check(r.del.ok, "G1 delete refused");
console.log("MECHANISM FINDING: G1 TRUNCATE (MODIFY covers TRUNCATE) ok =", r.truncate.ok);
const defaultSuper = await e.session({ user: "cassandra", password: "cassandra" }).then(async (s) => { await s.close(); return "LOGIN WORKED"; }, (err) => `refused: ${String(err).slice(0, 120)}`);
console.log("default cassandra/cassandra login:", defaultSuper);
check(defaultSuper.startsWith("refused"), "default superuser still usable");
const d5 = diff(golden, await e.snapshot());
console.log("diff G1", JSON.stringify(d5));
check(d5.objects.some((o) => o.name === "staging.audit_log" && o.countDelta === -9), "G1 delete not seen");
check(d5.privilegesAdded.length === 0 && d5.privilegesRemoved.length === 0, "G1 privileges changed");
t = Date.now();
await e.reset();
console.log("reset G1", Date.now() - t, "ms");
const d6 = diff(golden, await e.snapshot());
console.log("final diff", JSON.stringify(d6));
check(d6.clean, "G1 final not clean");
if (!process.env.KEEP) await e.down();
console.log("SMOKE OK");
