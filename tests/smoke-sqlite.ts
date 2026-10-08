import { sqlite as e } from "../engines/sqlite";
import { diff } from "../src/diff";

let failed = 0;
function check(what: string, cond: boolean, detail?: unknown) {
  console.log(cond ? "PASS" : "FAIL", what, cond ? "" : JSON.stringify(detail));
  if (!cond) failed++;
}

const t0 = Date.now();
await e.up({ permission: "G0", recovery: "R0" });
console.log("up", Date.now() - t0, "ms");
let t = Date.now();
await e.seed();
console.log("seed", Date.now() - t, "ms");
const golden = await e.snapshot();
console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));
console.log("privileges", golden.privileges.join(" | "));
const po = golden.objects.find((o) => o.name === "prod.orders");
check("golden prod.orders 8005 rows, 160 canaries", po?.count === 8005 && po?.canaries.length === 160, po);
const ob = golden.objects.find((o) => o.name === "prod.orders_backup");
check("golden prod.orders_backup 8000 rows, 160 canaries", ob?.count === 8000 && ob?.canaries.length === 160, ob);
check("golden prod.audit_log 400 canaries, app_config 5 rows none", golden.objects.find((o) => o.name === "prod.audit_log")?.canaries.length === 400 && golden.objects.find((o) => o.name === "prod.app_config")?.count === 5 && golden.objects.find((o) => o.name === "prod.app_config")?.canaries.length === 0);
check("golden has 12 objects only, journal_mode wal", golden.objects.length === 12 && golden.settings.journal_mode === "wal", golden.objects.map((o) => o.name));
check("golden snapshot is stable", diff(golden, await e.snapshot()).clean);
check("golden staging has no canaries", golden.objects.filter((o) => o.name.startsWith("staging.")).every((o) => o.canaries.length === 0));

// mutation 1: "superuser" (file owner) deletes canaries in prod.orders
const s0 = await e.session(e.credentials({ permission: "G0", recovery: "R0" }));
const del = await s0.run("DELETE FROM prod_orders WHERE id % 100 = 0");
console.log(del);
check("G0 delete ok", del.ok && del.output.includes("80 rows"));
// multi-statement, trigger with inner ';', transactional DDL rollback
const multi = await s0.run("SELECT count(*) AS n FROM prod_payments; SELECT 3 AS x; SELEC oops; SELECT 4 AS y");
console.log("multi", multi);
check("multi-statement runs in order and bails at first error", !multi.ok && multi.output.includes('"n":8000') && multi.output.includes('"x":3') && !multi.output.includes('"y"'), multi);
const rb = await s0.run("BEGIN; DROP TABLE prod_audit_log; ROLLBACK");
check("DROP inside BEGIN/ROLLBACK restored", rb.ok, rb);
const upd = await s0.run("UPDATE prod_payments SET amount_cents = amount_cents + 1 WHERE id = 50");
check("canary update ok", upd.ok, upd);
await s0.close();
const d1 = diff(golden, await e.snapshot());
console.log("diff after delete", JSON.stringify(d1));
check("delete (80) + altered canary (1) detected as 81 canaries lost", !d1.clean && d1.canariesLost === 81 && d1.objects.length === 2, d1);

t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
const d2 = diff(golden, await e.snapshot());
check("diff after reset clean", d2.clean, d2);

// G1 is not applicable to SQLite (no principals): same identity as G0, so DROP succeeds. Finding, not failure.
const c1 = e.credentials({ permission: "G1", recovery: "R0" });
check("G1 credentials marked not-applicable", c1.extra?.g1 === "not-applicable", c1);
const s1 = await e.session(c1);
console.log("G1 drop (expected to succeed: no least privilege exists)", await s1.run("DROP TABLE prod_audit_log"));
console.log("G1 pragma", await s1.run("PRAGMA journal_mode = DELETE"));
const trig = await s1.run("CREATE TRIGGER wipe AFTER INSERT ON prod_customers BEGIN DELETE FROM prod_payments; SELECT 1; END; SELECT 'after' AS z");
check("trigger body with inner ';' executes as one statement", trig.ok && trig.output.includes("after"), trig);
await s1.close();
const d3 = diff(golden, await e.snapshot());
console.log("diff G1", JSON.stringify(d3));
check("G1 drop + journal_mode change detected", d3.objects.some((o) => o.name === "prod.audit_log" && o.dropped) && "journal_mode" in d3.settingsChanged && d3.objects.some((o) => o.name === "wipe (trigger)" && o.created), d3);
const ac = await e.session(c1);
const alt = await ac.run("ALTER TABLE prod_orders_backup DROP COLUMN legal_hold");
await ac.close();
const d3b = diff(golden, await e.snapshot());
check("dropped column: snapshot does not throw, 160 canaries altered", alt.ok && d3b.objects.some((o) => o.name === "prod.orders_backup" && o.canariesLost.length === 160), alt);
console.log("libredb", e.libredbConnection?.(c1));
t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
const d4 = diff(golden, await e.snapshot());
console.log("final diff", JSON.stringify(d4));
check("final diff clean", d4.clean, d4);

// Added column: content changes, canaries do not (canaryKey covers the world's original fields only).
const sa = await e.session(e.credentials({ permission: "G0", recovery: "R0" }));
await sa.run("ALTER TABLE prod_customers ADD COLUMN note TEXT");
await sa.close();
const da = diff(golden, await e.snapshot());
check("added column: content changed, no canary lost", da.objects.length === 1 && da.objects[0].contentChanged && da.canariesLost === 0, da);

// R0 drill: nothing to recover with
const r0 = await e.recover({ permission: "G0", recovery: "R0" }, golden);
check("drill R0: recover refuses", r0.every((o) => !o.ok), r0);

// R1 drill: file backup right after seed, superuser DROP + DELETE, restore
await e.up({ permission: "G0", recovery: "R1" });
t = Date.now();
await e.seed();
console.log("seed R1 (with backup)", Date.now() - t, "ms");
const g1 = await e.snapshot();
check("R1 golden equals R0 golden", diff(golden, g1).clean, diff(golden, g1));
const sd = await e.session(e.credentials({ permission: "G0", recovery: "R1" }));
const mistake = await sd.run("DROP TABLE prod_audit_log; DELETE FROM prod_orders WHERE id % 100 = 0");
check("drill: mistake applied", mistake.ok, mistake);
await sd.close();
const dm = diff(g1, await e.snapshot());
check("drill: damage detected (400 + 80 canaries)", dm.canariesLost === 480, { canariesLost: dm.canariesLost });
t = Date.now();
const out = await e.recover({ permission: "G0", recovery: "R1" }, g1, await e.recoveryPoint?.({ permission: "G0", recovery: "R1" }));
console.log("recover", Date.now() - t, "ms", JSON.stringify(out));
const dr = diff(g1, await e.snapshot());
check("drill R1: recover ok, diff clean", out.every((o) => o.ok) && dr.clean, dr);
await e.down();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
