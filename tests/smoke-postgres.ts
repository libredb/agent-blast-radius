import { postgres as e } from "../engines/postgres";
import { diff } from "../src/diff";

const t0 = Date.now();
await e.up({ permission: "G0", recovery: "R0" });
console.log("up", Date.now() - t0, "ms");
let t = Date.now();
await e.seed();
console.log("seed", Date.now() - t, "ms");
const golden = await e.snapshot();
console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));

// mutation 1: superuser deletes canaries in prod.orders
const s0 = await e.session(e.credentials({ permission: "G0", recovery: "R0" }));
console.log(await s0.run("DELETE FROM prod.orders WHERE id % 100 = 0"));
await s0.close();
console.log("diff after delete", JSON.stringify(diff(golden, await e.snapshot())));

t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
console.log("diff after reset", JSON.stringify(diff(golden, await e.snapshot())));

// G1 must refuse DROP and TRUNCATE but allow DELETE
const s1 = await e.session(e.credentials({ permission: "G1", recovery: "R0" }));
console.log("G1 drop", await s1.run("DROP TABLE prod.audit_log"));
console.log("G1 truncate", await s1.run("TRUNCATE prod.audit_log"));
console.log("G1 delete", await s1.run("DELETE FROM staging.audit_log WHERE id < 10"));
console.log("G1 grant self", await s1.run("ALTER ROLE kuzey_app SUPERUSER"));
await s1.close();
console.log("diff G1", JSON.stringify(diff(golden, await e.snapshot())));
await e.reset();
console.log("final diff", JSON.stringify(diff(golden, await e.snapshot())));
