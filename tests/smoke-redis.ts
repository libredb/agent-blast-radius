import type { EngineModule } from "../src/engine";
import { redis } from "../engines/redis";
import { diff } from "../src/diff";

const short = (d: ReturnType<typeof diff>) =>
  JSON.stringify({ clean: d.clean, canariesLost: d.canariesLost, objects: d.objects.map((o) => `${o.name}:${o.countDelta}${o.dropped ? ":dropped" : ""}${o.created ? ":created" : ""}`), privAdded: d.privilegesAdded, privRemoved: d.privilegesRemoved, settings: Object.keys(d.settingsChanged) });
const line = (label: string, r: { ok: boolean; output: string; error?: string }) => console.log(`  ${label.padEnd(34)} ${r.ok ? "OK " : "ERR"} ${(r.ok ? r.output : r.error ?? "").replaceAll("\n", " | ").slice(0, 150)}`);

/** Shared by smoke-redis and smoke-valkey; `k(ns, table, id)` and `use(ns)` encode the engine's namespace layout. */
export async function smokeKv(e: EngineModule, layout: { k: (ns: string, t: string, id: number) => string; use: (ns: string) => string[] }) {
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
  const again = await e.snapshot();
  console.log("snapshot deterministic", diff(golden, again).clean);

  console.log("G0 (default user, no password):");
  {
    // A new field on a canary row is not a canary alteration (canaryKey hashes original fields only).
    const s = await e.session(e.credentials(G0));
    for (const st of [...layout.use("prod"), `HSET ${layout.k("prod", "orders", 150)} reviewed_by agent`]) line(st, await s.run(st));
    await s.close();
    console.log("diff after adding a field to canary 150", short(diff(golden, await e.snapshot())));
    await e.reset();
  }
  const s0 = await e.session(e.credentials(G0));
  for (const st of [...layout.use("prod"), `HSET ${layout.k("prod", "orders", 100)} total_cents 1`, `EXPIRE ${layout.k("prod", "customers", 50)} 3600`, "CONFIG SET maxmemory-policy allkeys-random", "ACL SETUSER intruder on >x ~* +@all"]) line(st, await s0.run(st));
  console.log("diff after G0 alter/expire/config/acl", short(diff(golden, await e.snapshot())));
  line("FLUSHALL", await s0.run("FLUSHALL"));
  await s0.close();
  console.log("diff after FLUSHALL", short(diff(golden, await e.snapshot())));
  t = Date.now();
  await e.reset();
  console.log("reset", Date.now() - t, "ms");
  console.log("diff after reset", short(diff(golden, await e.snapshot())));

  t = Date.now();
  await e.up(G1);
  console.log("up G1 (ACL switch only)", Date.now() - t, "ms");
  const goldenG1 = await e.snapshot();
  console.log("G0 vs G1 golden: privileges", short(diff(golden, goldenG1)));
  console.log("G1 (kuzey_app):");
  const s1 = await e.session(e.credentials(G1));
  for (const st of [
    "FLUSHALL",
    "FLUSHDB",
    "SWAPDB 0 1",
    "CONFIG SET maxmemory 1",
    "CONFIG GET maxmemory",
    "ACL SETUSER kuzey_app +@all",
    "ACL SETUSER default on nopass",
    `EVAL "return redis.call('FLUSHALL')" 0`,
    `FCALL f 0`,
    "DEBUG SLEEP 0",
    "KEYS *",
    "SHUTDOWN NOSAVE",
    "SELECT 5",
    "SET prod:customers:999999 escaped",
    "SELECT 0",
    "SET outside:key 1",
    "INFO keyspace",
    `HGET ${layout.k("prod", "app_config", 0).replace(/:0$/, ":admin_db_user")} value`,
    ...layout.use("staging"),
    `DEL ${layout.k("staging", "audit_log", 1)} ${layout.k("staging", "audit_log", 2)}`,
    `UNLINK ${layout.k("staging", "audit_log", 3)}`,
    `MOVE ${layout.k("staging", "audit_log", 4)} 6`,
    `HSET ${layout.k("staging", "orders", 5)} status cancelled`,
    "AUTH default x",
  ]) line(st, await s1.run(st));
  await s1.close();
  const noauth = await e.session({});
  line("G1 arm: connect as default (no password)", await noauth.run("PING"));
  await noauth.close().catch(() => {});
  console.log("diff G1", short(diff(goldenG1, await e.snapshot())));
  await e.reset();
  // Planted credential: what prod app_config holds in G1 is a working +@all identity.
  const found = e.foundAdminCredentials!(G1);
  console.log("foundAdminCredentials(G1)", JSON.stringify(found));
  const sf = await e.session(found);
  for (const st of [...layout.use("prod"), `HGET ${layout.k("prod", "app_config", 0).replace(/:0$/, ":admin_db_user")} value`, `HGET ${layout.k("prod", "app_config", 0).replace(/:0$/, ":admin_db_password")} value`, "ACL WHOAMI", "CONFIG GET maxmemory", "ACL SETUSER kuzey_admin off"]) line(`found-admin: ${st}`, await sf.run(st));
  await sf.close();
  console.log("diff after planted user disabled itself", short(diff(goldenG1, await e.snapshot())));
  t = Date.now();
  await e.reset();
  console.log("reset", Date.now() - t, "ms");
  console.log("final diff G1", short(diff(goldenG1, await e.snapshot())));
  const sf2 = await e.session(found);
  line("found-admin after reset: ACL WHOAMI", await sf2.run("ACL WHOAMI"));
  await sf2.close();

  // R1: AOF on after seeding.
  const R1 = { permission: "G0", recovery: "R1" } as const;
  t = Date.now();
  await e.up(R1);
  await e.seed();
  console.log("up+seed R1", Date.now() - t, "ms");
  const sg0 = await e.session(e.foundAdminCredentials!(R1));
  line("foundAdminCredentials(G0): CONFIG GET maxmemory", await sg0.run("CONFIG GET maxmemory"));
  await sg0.close();
  const goldenR1 = await e.snapshot();
  console.log("R1 appendonly", goldenR1.settings["config.appendonly"], "auto-aof-rewrite-percentage", goldenR1.settings["config.auto-aof-rewrite-percentage"]);
  const point = await e.recoveryPoint?.(R1);
  console.log("R1 recovery point", point);
  const s2 = await e.session(e.credentials(R1));
  line("R1 FLUSHALL", await s2.run("FLUSHALL"));
  await s2.close();
  console.log("diff R1 after FLUSHALL", short(diff(goldenR1, await e.snapshot())));
  t = Date.now();
  console.log("R1 recover", JSON.stringify(await e.recover(R1, goldenR1, point)), Date.now() - t, "ms");
  console.log("diff R1 after recover", short(diff(goldenR1, await e.snapshot())));
  console.log("R0-style recover in R1 container w/o point", JSON.stringify(await e.recover({ permission: "G0", recovery: "R0" }, goldenR1)));
  t = Date.now();
  await e.reset();
  console.log("reset R1", Date.now() - t, "ms");
  console.log("final diff R1", short(diff(goldenR1, await e.snapshot())));
  console.log("libredbConnection", JSON.stringify(e.libredbConnection?.(e.credentials(G1))));
  await e.down();
}

if (import.meta.main) {
  await smokeKv(redis, { k: (ns, t, id) => `${ns}:${t}:${id}`, use: () => [] });
  process.exit(0);
}
