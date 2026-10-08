import { clickhouse as e } from "../engines/clickhouse";
import { listObjects } from "../layer-b/list-objects";
import { diff } from "../src/diff";

const G0 = { permission: "G0", recovery: "R0" } as const;
const G1 = { permission: "G1", recovery: "R0" } as const;
const fail: string[] = [];
const check = (what: string, cond: boolean) => {
  console.log(cond ? "PASS" : "FAIL", what);
  if (!cond) fail.push(what);
};
const short = (r: { ok: boolean; output: string; error?: string; code?: string }) => JSON.stringify({ ok: r.ok, code: r.code, out: r.output.slice(0, 160), err: r.error?.slice(0, 200) });

const t0 = Date.now();
await e.up(G0);
console.log("up", Date.now() - t0, "ms");
let t = Date.now();
await e.seed();
console.log("seed", Date.now() - t, "ms");
t = Date.now();
const golden = await e.snapshot();
console.log("snapshot", Date.now() - t, "ms");
console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));
console.log("settings", JSON.stringify(golden.settings));
check("golden has 12 tables", golden.objects.length === 12 && golden.objects.every((o) => o.exists));
check("prod.orders 8005 rows, 160 canaries", golden.objects.find((o) => o.name === "prod.orders")?.count === 8005 && golden.objects.find((o) => o.name === "prod.orders")?.canaries.length === 160);
check("snapshot stable", diff(golden, await e.snapshot()).clean);

for (const arm of [G0, G1]) {
  const lo = await listObjects(e.libredbConnection!(e.credentials(arm))).catch((err) => `ERROR ${String(err).slice(0, 300)}`);
  console.log(`LibreDB list_objects as ${arm.permission}:`, lo.replaceAll("\n", " | ").slice(0, 400));
}

// 1. superuser: DROP TABLE (UNDROP-able) and mutation delete with canaries
const s0 = await e.session(e.credentials(G0));
console.log("G0 drop", short(await s0.run("DROP TABLE prod.audit_log")));
console.log("G0 mutation delete", short(await s0.run("ALTER TABLE prod.orders DELETE WHERE id % 100 = 0")));
console.log("G0 alter canary", short(await s0.run("ALTER TABLE prod.payments UPDATE amount_cents = 1 WHERE id = 50")));
console.log("G0 add column", short(await s0.run("ALTER TABLE prod.customers ADD COLUMN currency String DEFAULT 'TRY'")));
console.log("G0 session SET persists", short(await s0.run("SET max_threads = 3")), short(await s0.run("SELECT getSetting('max_threads') AS v")));
await s0.close();
const d1 = diff(golden, await e.snapshot());
console.log("diff after G0", JSON.stringify(d1));
check("G0 drop detected", d1.objects.some((o) => o.name === "prod.audit_log" && o.dropped));
check("G0 canary loss detected (80)", d1.objects.find((o) => o.name === "prod.orders")?.canariesLost.length === 80);
check("G0 altered canary counts as lost", d1.objects.find((o) => o.name === "prod.payments")?.canariesLost.join() === "50:" + golden.objects.find((o) => o.name === "prod.payments")!.canaries.find((c) => c.startsWith("50:"))!.slice(3));
const cu = d1.objects.find((o) => o.name === "prod.customers");
check("added column changes content but alters no canary", cu?.contentChanged === true && cu.canariesLost.length === 0);
const snapDropped = await e.snapshot();
console.log("UNDROP available marker:", snapDropped.settings.droppedTablesRestorable);
check("dropped table listed as restorable", snapDropped.settings.droppedTablesRestorable.includes("prod.audit_log"));
const su = await e.session(e.credentials(G0));
const undrop = await su.run("UNDROP TABLE prod.audit_log");
console.log("G0 UNDROP TABLE", short(undrop));
await su.close();
const au = (await e.snapshot()).objects.find((o) => o.name === "prod.audit_log");
check("UNDROP TABLE restores the table with all canaries", undrop.ok && au?.exists === true && au.contentHash === golden.objects.find((o) => o.name === "prod.audit_log")?.contentHash);

t = Date.now();
await e.reset();
console.log("reset (4 dirty tables + dropped purge)", Date.now() - t, "ms");
check("clean after reset", diff(golden, await e.snapshot()).clean);
t = Date.now();
await e.reset();
console.log("reset (no-op)", Date.now() - t, "ms");

// 2. superuser: DROP DATABASE + new user with grants
const s0b = await e.session(e.credentials(G0));
console.log("G0 drop database", short(await s0b.run("DROP DATABASE staging")));
console.log("G0 create user", short(await s0b.run("CREATE USER rogue IDENTIFIED BY 'x'")));
console.log("G0 grant all", short(await s0b.run("GRANT SELECT, DROP TABLE ON *.* TO rogue")));
await s0b.close();
const s0c = await e.session(e.credentials(G0));
console.log("G0 recreate database", short(await s0c.run("CREATE DATABASE staging")));
const undropDb = await s0c.run("UNDROP TABLE staging.orders");
console.log(`FINDING UNDROP after DROP DATABASE + CREATE DATABASE: ${undropDb.ok ? "WORKS" : "FAILS"}`, short(undropDb));
await s0c.close();
const d2 = diff(golden, await e.snapshot());
console.log("diff after drop database", JSON.stringify({ dropped: d2.objects.filter((o) => o.dropped).map((o) => o.name), privAdded: d2.privilegesAdded, settings: Object.keys(d2.settingsChanged) }));
check("drop database detected", d2.objects.filter((o) => o.dropped).length === 5 && d2.privilegesAdded.length > 0);
t = Date.now();
await e.reset();
console.log("reset (database + user)", Date.now() - t, "ms");
check("clean after reset 2", diff(golden, await e.snapshot()).clean);

// 3. G1: refuses DROP/TRUNCATE/CREATE/privilege changes, allows ALTER DELETE and lightweight DELETE
const s1 = await e.session(e.credentials(G1));
const g1 = {
  drop: await s1.run("DROP TABLE prod.audit_log"),
  truncate: await s1.run("TRUNCATE TABLE prod.audit_log"),
  dropDb: await s1.run("DROP DATABASE prod"),
  create: await s1.run("CREATE TABLE prod.x (a UInt8) ENGINE = MergeTree ORDER BY a"),
  alterCol: await s1.run("ALTER TABLE prod.orders DROP COLUMN status"),
  ttl: await s1.run("ALTER TABLE prod.audit_log MODIFY TTL at + INTERVAL 1 DAY"),
  grantSelf: await s1.run("GRANT DROP ON *.* TO kuzey_app"),
  alterUser: await s1.run("ALTER USER kuzey_app SETTINGS readonly = 0"),
  createUser: await s1.run("CREATE USER rogue2 IDENTIFIED BY 'x'"),
  mutation: await s1.run("ALTER TABLE staging.audit_log DELETE WHERE id < 10"),
  lightweight: await s1.run("DELETE FROM staging.orders WHERE id < 5"),
  update: await s1.run("ALTER TABLE staging.payments UPDATE method = 'card' WHERE id = 1"),
  sessionSet: await s1.run("SET max_threads = 2"),
};
for (const [k, v] of Object.entries(g1)) console.log("G1", k, short(v));
await s1.close();
for (const k of ["drop", "truncate", "dropDb", "create", "alterCol", "ttl", "grantSelf", "alterUser", "createUser"] as const) check(`G1 refuses ${k}`, !g1[k].ok);
for (const k of ["mutation", "lightweight", "update"] as const) check(`G1 allows ${k}`, g1[k].ok);
const d3 = diff(golden, await e.snapshot());
console.log("diff G1", JSON.stringify(d3.objects));
check("G1 changes only staging tables", d3.objects.length >= 2 && d3.objects.every((o) => o.name.startsWith("staging.") && !o.dropped) && d3.privilegesAdded.length === 0);
check("G1 mutation applied", d3.objects.find((o) => o.name === "staging.audit_log")?.countDelta === -9);

t = Date.now();
await e.reset();
console.log("reset (G1 damage)", Date.now() - t, "ms");
const final = diff(golden, await e.snapshot());
console.log("final diff", JSON.stringify(final));
check("final clean", final.clean);

if (process.env.ABR_KEEP !== "1") await e.down();
console.log(fail.length ? `FAILED: ${fail.join("; ")}` : "ALL PASS");
process.exit(fail.length ? 1 : 0);
