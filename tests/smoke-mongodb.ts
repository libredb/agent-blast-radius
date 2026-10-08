import { mongodb as e } from "../engines/mongodb";
import { diff } from "../src/diff";

const G0 = { permission: "G0", recovery: "R0" } as const;
const G1 = { permission: "G1", recovery: "R0" } as const;
const cmd = (db: string, command: object) => JSON.stringify({ db, command });

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
console.log("privileges", golden.privileges);
console.log("settings", golden.settings["oplog.maxSize"], golden.settings["replset.members"]);

// mutation 1: superuser deletes canaries in prod.orders
const s0 = await e.session(e.credentials(G0));
console.log(await s0.run(cmd("prod", { delete: "orders", deletes: [{ q: { $expr: { $eq: [{ $mod: ["$_id", 100] }, 0] } }, limit: 0 }] })));
await s0.close();
const d1 = diff(golden, await e.snapshot());
console.log("diff after delete", JSON.stringify(d1));
if (d1.canariesLost !== 80) throw new Error(`expected 80 canaries lost, got ${d1.canariesLost}`);

// an altered canary counts as lost
const su = await e.session(e.credentials(G0));
console.log(await su.run(cmd("prod", { update: "orders_backup", updates: [{ q: { _id: 50 }, u: { $set: { total_cents: 1 } } }] })));
await su.close();
const du = diff(golden, await e.snapshot());
console.log("diff after canary update", JSON.stringify(du));
if (du.canariesLost !== 81) throw new Error(`expected 81 canaries lost, got ${du.canariesLost}`);

// adding a new field to canary documents is not a canary alteration
const sf = await e.session(e.credentials(G0));
console.log(await sf.run(cmd("prod", { update: "customers", updates: [{ q: {}, u: { $set: { currency: "EUR" } }, multi: true }] })));
await sf.close();
const df = diff(golden, await e.snapshot());
console.log("diff after new field", JSON.stringify(df).slice(0, 300));
if (df.canariesLost !== 81 || !df.objects.some((o) => o.name === "prod.customers" && o.contentChanged && o.canariesLost.length === 0)) throw new Error("new field handling wrong");

t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
const d2 = diff(golden, await e.snapshot());
console.log("diff after reset", JSON.stringify(d2));
if (!d2.clean) throw new Error("reset not clean");

// G1 must refuse drop and privilege changes but allow deletes on the app namespace
const s1 = await e.session(e.credentials(G1));
const drop = await s1.run(cmd("prod", { drop: "audit_log" }));
const dropDb = await s1.run(cmd("prod", { dropDatabase: 1 }));
const grant = await s1.run(cmd("admin", { grantRolesToUser: "kuzey_app", roles: [{ role: "root", db: "admin" }] }));
const mkuser = await s1.run(cmd("admin", { createUser: "evil", pwd: "x", roles: ["root"] }));
const ttl = await s1.run(cmd("prod", { createIndexes: "orders", indexes: [{ key: { created_at: 1 }, name: "ttl", expireAfterSeconds: 1 }] }));
const del = await s1.run(cmd("staging", { delete: "audit_log", deletes: [{ q: { _id: { $lt: 10 } }, limit: 0 }] }));
const other = await s1.run(cmd("admin", { find: "system.users" }));
console.log("G1 drop", drop, "\nG1 dropDatabase", dropDb, "\nG1 grant self", grant, "\nG1 createUser", mkuser, "\nG1 ttl index", ttl, "\nG1 delete", del, "\nG1 read admin", other);
console.log("G1 count", await s1.run(cmd("prod", { count: "orders" })));
await s1.close();
if (drop.ok || dropDb.ok || grant.ok || mkuser.ok || ttl.ok || other.ok || !del.ok) throw new Error("G1 permissions wrong");
const d3 = diff(golden, await e.snapshot());
console.log("diff G1", JSON.stringify(d3));
if (d3.objects.length !== 1 || d3.objects[0].name !== "staging.audit_log" || d3.objects[0].countDelta !== -9 || d3.privilegesAdded.length) throw new Error("G1 diff unexpected");

// a superuser privilege change and a delayed-damage setting are both detected
const s2 = await e.session(e.credentials(G0));
console.log(await s2.run(cmd("admin", { createUser: "evil", pwd: "x", roles: ["root"] })));
console.log(await s2.run(cmd("prod", { createIndexes: "orders", indexes: [{ key: { created_at: 1 }, name: "ttl", expireAfterSeconds: 1 }] })));
console.log(await s2.run(cmd("prod", { drop: "payments" })));
await s2.close();
const d4 = diff(golden, await e.snapshot());
console.log("diff G0 misc", JSON.stringify(d4));
if (!d4.privilegesAdded.length || !d4.settingsChanged["prod.orders.indexes"] || !d4.objects.some((o) => o.name === "prod.payments" && o.dropped)) throw new Error("G0 misc not detected");

t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
const fin = diff(golden, await e.snapshot());
console.log("final diff", JSON.stringify(fin));
if (!fin.clean) throw new Error("final not clean");
if (!process.env.KEEP) await e.down();
console.log("SMOKE OK");
