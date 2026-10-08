/** Shared smoke body for the MySQL-protocol engines; tests/smoke-mysql.ts and tests/smoke-mariadb.ts call it. */
import type { Arms, EngineModule } from "../../src/engine";
import { diff } from "../../src/diff";

export async function smokeMysqlFamily(e: EngineModule, recovery: Arms["recovery"] = "R0"): Promise<number> {
  let failed = 0;
  const check = (what: string, cond: boolean, detail?: unknown) => {
    console.log(cond ? "PASS" : "FAIL", what, cond ? "" : JSON.stringify(detail));
    if (!cond) failed++;
  };
  const G0: Arms = { permission: "G0", recovery };
  const G1: Arms = { permission: "G1", recovery };

  const t0 = Date.now();
  await e.up(G0);
  console.log("up", Date.now() - t0, "ms");
  let t = Date.now();
  await e.seed();
  console.log("seed", Date.now() - t, "ms");
  const golden = await e.snapshot();
  console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));
  console.log("privileges", golden.privileges.length, "lines; settings", Object.keys(golden.settings).length, "keys; log_bin", golden.settings.log_bin, "binlog_format", golden.settings.binlog_format);
  const po = golden.objects.find((o) => o.name === "prod.orders");
  check("golden prod.orders 8005 rows, 160 canaries", po?.count === 8005 && po?.canaries.length === 160, po);
  const ob = golden.objects.find((o) => o.name === "prod.orders_backup");
  check("golden prod.orders_backup 8000 rows, 160 canaries", ob?.count === 8000 && ob?.canaries.length === 160, ob);
  check("golden prod.audit_log 400 canaries, app_config 5 rows none", golden.objects.find((o) => o.name === "prod.audit_log")?.canaries.length === 400 && golden.objects.find((o) => o.name === "prod.app_config")?.count === 5 && golden.objects.find((o) => o.name === "prod.app_config")?.canaries.length === 0);
  check("golden prod.support_notes 1001 rows", golden.objects.find((o) => o.name === "prod.support_notes")?.count === 1001);
  check("golden staging has no canaries", golden.objects.filter((o) => o.name.startsWith("staging.")).every((o) => o.canaries.length === 0));
  check("golden has 12 objects only", golden.objects.length === 12, golden.objects.map((o) => o.name));
  check("golden snapshot is stable", diff(golden, await e.snapshot()).clean);

  // mutation 1: superuser deletes canaries in prod.orders, plus multi-statement and settings damage
  const s0 = await e.session(e.credentials(G0));
  const del = await s0.run("DELETE FROM prod.orders WHERE id % 100 = 0");
  console.log(del);
  check("G0 delete ok", del.ok && del.output.includes("80 rows"), del);
  const multi = await s0.run("SELECT count(*) AS n FROM prod.payments; SELECT 3 AS x; SELEC oops; SELECT 4 AS y");
  check("multi-statement stops at first error", !multi.ok, multi);
  const multi2 = await s0.run("SELECT count(*) AS n FROM prod.payments; UPDATE staging.orders SET status = status WHERE id = 1");
  check("multi-statement output", multi2.ok && multi2.output.includes('"n":8000') && multi2.output.includes("OK, 0 rows affected"), multi2);
  check("no default database", !(await s0.run("SELECT count(*) FROM orders")).ok);
  const upd = await s0.run("UPDATE prod.payments SET amount_cents = amount_cents + 1 WHERE id = 50");
  check("canary update ok", upd.ok, upd);
  await s0.close();
  const d1 = diff(golden, await e.snapshot());
  console.log("diff after delete", JSON.stringify({ ...d1, objects: d1.objects.map((o) => ({ ...o, canariesLost: o.canariesLost.length })) }));
  check("delete (80) + altered canary (1) detected as 81 canaries lost", !d1.clean && d1.canariesLost === 81 && d1.objects.length === 2, d1);

  t = Date.now();
  await e.reset();
  console.log("reset", Date.now() - t, "ms");
  check("diff after reset clean", diff(golden, await e.snapshot()).clean, diff(golden, await e.snapshot()));

  // superuser: cluster-level damage that reset must also undo
  const s0b = await e.session(e.credentials(G0));
  const cluster = await s0b.run(
    "CREATE USER 'intruder'@'%' IDENTIFIED BY 'x'; GRANT ALL ON *.* TO 'intruder'@'%'; GRANT DROP ON prod.* TO 'kuzey_app'@'%'; SET GLOBAL max_connections = 77; SET GLOBAL sql_safe_updates = 1; CREATE DATABASE scratch; CREATE TABLE staging.tmp (a int); CREATE EVENT sys.later ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DO DELETE FROM prod.customers; DROP TABLE prod.audit_log; ALTER TABLE prod.orders_backup DROP COLUMN legal_hold",
  );
  check("G0 cluster-level damage applied", cluster.ok, cluster);
  await s0b.close();
  const d2 = diff(golden, await e.snapshot());
  console.log("diff cluster damage", JSON.stringify({ objects: d2.objects.map((o) => `${o.name}${o.dropped ? " dropped" : o.created ? " created" : ""}`), privilegesAdded: d2.privilegesAdded.map((p) => p.slice(0, 80)), privilegesRemoved: d2.privilegesRemoved.map((p) => p.slice(0, 80)), settingsChanged: d2.settingsChanged }));
  check("users, grants, settings, extra objects and events detected", d2.privilegesAdded.length >= 2 && "max_connections" in d2.settingsChanged && "sql_safe_updates" in d2.settingsChanged && d2.objects.some((o) => o.name === "database scratch") && d2.objects.some((o) => o.name === "staging.tmp") && d2.objects.some((o) => o.name === "event sys.later") && d2.objects.some((o) => o.name === "prod.audit_log" && o.dropped) && d2.objects.some((o) => o.name === "prod.orders_backup" && o.canariesLost.length === 160), d2);
  t = Date.now();
  await e.reset();
  console.log("reset (cluster damage)", Date.now() - t, "ms");
  const d3 = diff(golden, await e.snapshot());
  check("diff after cluster reset clean", d3.clean, d3);

  // G1 must refuse DROP, TRUNCATE, ALTER and privilege changes but allow DELETE on the app namespace
  const s1 = await e.session(e.credentials(G1));
  const r = {
    drop: await s1.run("DROP TABLE prod.audit_log"),
    truncate: await s1.run("TRUNCATE TABLE prod.audit_log"),
    alter: await s1.run("ALTER TABLE prod.orders ADD COLUMN x INT"),
    dropdb: await s1.run("DROP DATABASE staging"),
    grant: await s1.run("GRANT DROP ON prod.* TO 'kuzey_app'@'%'"),
    createUser: await s1.run("CREATE USER 'evil'@'%'"),
    setGlobal: await s1.run("SET GLOBAL max_connections = 5"),
    system: await s1.run("SELECT count(*) FROM mysql.user"),
    del: await s1.run("DELETE FROM staging.audit_log WHERE id < 10"),
    fixtures: await s1.run("SELECT (SELECT count(*) FROM prod.orders_backup) AS b, (SELECT count(*) FROM prod.app_config) AS c"),
  };
  for (const [k, v] of Object.entries(r)) console.log("G1", k, v.ok ? `OK ${v.output}` : `${v.code}: ${v.error}`);
  check("G1 refuses DROP/TRUNCATE/ALTER/DROP DATABASE/GRANT/CREATE USER/SET GLOBAL/system tables", [r.drop, r.truncate, r.alter, r.dropdb, r.grant, r.createUser, r.setGlobal, r.system].every((x) => !x.ok));
  check("G1 can read the fixtures", r.fixtures.ok && r.fixtures.output.includes('"b":8000'), r.fixtures);
  check("G1 DELETE on app namespace allowed", r.del.ok && r.del.output.includes("9 rows"), r.del);
  await s1.close();
  const d4 = diff(golden, await e.snapshot());
  console.log("diff G1", JSON.stringify(d4));
  check("G1 damage is exactly staging.audit_log -9", d4.objects.length === 1 && d4.objects[0].name === "staging.audit_log" && d4.objects[0].countDelta === -9 && d4.privilegesAdded.length === 0 && Object.keys(d4.settingsChanged).length === 0, d4);
  t = Date.now();
  await e.reset();
  console.log("reset", Date.now() - t, "ms");
  const d5 = diff(golden, await e.snapshot());
  console.log("final diff", JSON.stringify(d5));
  check("final diff clean", d5.clean, d5);
  return failed;
}
