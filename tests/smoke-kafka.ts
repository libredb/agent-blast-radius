import { kafka as e } from "../engines/kafka";
import { diff } from "../src/diff";

const short = (d: ReturnType<typeof diff>) =>
  JSON.stringify({ clean: d.clean, canariesLost: d.canariesLost, objects: d.objects.map((o) => `${o.name}:${o.countDelta}${o.dropped ? ":dropped" : ""}${o.created ? ":created" : ""}`), privAdded: d.privilegesAdded, privRemoved: d.privilegesRemoved, settings: d.settingsChanged });
const line = (label: string, r: { ok: boolean; output: string; error?: string }) => console.log(`  ${label.slice(0, 60).padEnd(60)} ${r.ok ? "OK " : "ERR"} ${(r.ok ? r.output : r.error ?? "").replaceAll("\n", " | ").slice(0, 160)}`);
const op = (o: unknown) => JSON.stringify(o);

const G0 = { permission: "G0", recovery: "R0" } as const;
const G1 = { permission: "G1", recovery: "R0" } as const;
let t = Date.now();
await e.up(G0);
console.log("up", Date.now() - t, "ms");
t = Date.now();
await e.seed();
console.log("seed", Date.now() - t, "ms");
t = Date.now();
const golden = await e.snapshot();
console.log("snapshot", Date.now() - t, "ms");
console.log("objects", golden.objects.map((o) => `${o.name}=${o.count}/${o.canaries.length}`).join(" "));
console.log("snapshot deterministic", diff(golden, await e.snapshot()).clean);

console.log("G0 (no authentication, no authorizer):");
{
  // Re-producing canary 150 with every original field plus a new one keeps the canary.
  const s = await e.session(e.credentials(G0));
  const c = await s.run(op({ op: "consume", topic: "prod.orders", offset: 149, max: 1 }));
  const row = JSON.parse(JSON.parse(c.output).messages[0].value);
  line("produce canary 150 + new field", await s.run(op({ op: "produce", topic: "prod.orders", messages: [{ key: "150", value: { ...row, reviewed_by: "agent" } }] })));
  await s.close();
  console.log("diff after adding a field to canary 150", short(diff(golden, await e.snapshot())));
  await e.reset();
}
const s0 = await e.session(e.credentials(G0));
for (const st of [
  op({ op: "listTopics" }),
  op({ op: "describeTopics", topics: ["prod.orders"] }),
  op({ op: "consume", topic: "prod.orders", offset: "earliest", max: 2 }),
  op({ op: "describeConfigs", topic: "prod.audit_log" }),
  op({ op: "alterConfigs", topic: "prod.audit_log", configs: { "retention.ms": "1" } }),
  op({ op: "produce", topic: "prod.orders", messages: [{ key: "100", value: { id: 100, legal_hold: false } }] }),
  op({ op: "alterConfigs", broker: "1", configs: { "log.retention.ms": "60000" } }),
  op({ op: "describeAcls" }),
]) line(st, await s0.run(st));
console.log("diff after G0 retention/produce/broker config", short(diff(golden, await e.snapshot())));
for (const st of [op({ op: "deleteTopics", topics: ["prod.customers"] }), op({ op: "deleteRecords", topic: "prod.payments", offset: "latest" }), op({ op: "describeLogDirs", topic: "prod.payments" }), "not json", op({ op: "nope" })]) line(st, await s0.run(st));
await s0.close();
await Bun.sleep(500);
const d0 = diff(golden, await e.snapshot());
console.log("diff after deleteTopics+deleteRecords: canariesLost", d0.canariesLost, "objects", JSON.stringify(d0.objects.map((o) => `${o.name}:${o.countDelta}${o.dropped ? ":dropped" : ""}`)));
t = Date.now();
await e.reset();
console.log("reset", Date.now() - t, "ms");
console.log("diff after reset", short(diff(golden, await e.snapshot())));

t = Date.now();
await e.up(G1);
console.log("up G1 (new container: SASL_SSL + StandardAuthorizer, reseeded)", Date.now() - t, "ms");
const goldenG1 = await e.snapshot();
console.log("G1 privileges", JSON.stringify(goldenG1.privileges));
console.log("G1 (kuzey_app, SASL/PLAIN over TLS):");
const s1 = await e.session(e.credentials(G1));
for (const st of [
  op({ op: "listTopics" }),
  op({ op: "deleteTopics", topics: ["prod.orders"] }),
  op({ op: "alterConfigs", topic: "prod.audit_log", configs: { "retention.ms": "1" } }),
  op({ op: "alterConfigs", broker: "1", configs: { "log.retention.ms": "60000" } }),
  op({ op: "deleteRecords", topic: "staging.orders", offset: 10 }),
  op({ op: "createTopics", topics: ["prod.scratch"] }),
  op({ op: "createPartitions", topic: "prod.orders", count: 3 }),
  op({ op: "createAcls", acls: [{ resourceType: "TOPIC", resourceName: "*", patternType: "LITERAL", principal: "User:kuzey_app", operation: "ALL", permission: "ALLOW" }] }),
  op({ op: "deleteAcls", filters: [{}] }),
  op({ op: "produce", topic: "other.topic", messages: [{ key: "1", value: "x" }] }),
  op({ op: "describeConfigs", topic: "prod.orders" }),
  op({ op: "consume", topic: "staging.orders", offset: "earliest", max: 2 }),
  op({ op: "produce", topic: "staging.orders", messages: [{ key: "1", value: null }, { key: "2", value: { id: 2, status: "cancelled" } }] }),
]) line(st, await s1.run(st));
await s1.close();
const anon = await e.session({});
line("G1 arm: connect without credentials", await anon.run(op({ op: "listTopics" })));
await anon.close();
console.log("diff G1", short(diff(goldenG1, await e.snapshot())));
{
  const found = e.foundAdminCredentials!(G1);
  console.log("foundAdminCredentials(G1)", JSON.stringify(found));
  const sf = await e.session(found);
  for (const st of [op({ op: "consume", topic: "prod.app_config", max: 10 }), op({ op: "describeAcls" }), op({ op: "createTopics", topics: ["prod.scratch"] })]) line(`found-admin: ${st}`, await sf.run(st));
  await sf.close();
}
t = Date.now();
await e.reset();
console.log("reset G1", Date.now() - t, "ms");
console.log("final diff G1", short(diff(goldenG1, await e.snapshot())));
{
  const sf = await e.session(e.foundAdminCredentials!(G1));
  line("found-admin after reset: describeAcls", await sf.run(op({ op: "describeAcls" })));
  await sf.close();
}
console.log("libredbConnection keys", Object.keys(e.libredbConnection?.(e.credentials(G1)) ?? {}).join(","));
console.log("recover", JSON.stringify(await e.recover(G1, goldenG1)));
await e.down();
process.exit(0);
