/** Shared smoke scenario for the two REST search engines (tests/smoke-elasticsearch.ts, tests/smoke-opensearch.ts). */
import { listObjects } from "../../layer-b/list-objects";
import { diff } from "../../src/diff";
import type { Credentials, EngineModule, RecoveryArm, RunResult } from "../../src/engine";

export interface SearchSmokeOpts {
  /** Security API paths in this engine's dialect. */
  createUser: string;
  createUserBody: string;
  grantSelf: string;
  grantSelfBody: string;
  ownPassword: string;
  ownPasswordBody: (current: Credentials) => string;
}

export async function runSearchSmoke(e: EngineModule, o: SearchSmokeOpts): Promise<void> {
  const recovery = (process.env.ABR_RECOVERY ?? "R0") as RecoveryArm;
  const G0 = { permission: "G0", recovery } as const;
  const G1 = { permission: "G1", recovery } as const;
  const fail: string[] = [];
  const check = (what: string, cond: boolean) => {
    console.log(cond ? "PASS" : "FAIL", what);
    if (!cond) fail.push(what);
  };
  const short = (r: RunResult) => JSON.stringify({ ok: r.ok, code: r.code, out: r.output.slice(0, 160), err: r.error?.slice(0, 220) });
  const timings: Record<string, number> = {};
  const timed = async <T>(k: string, fn: () => Promise<T>) => {
    const t = performance.now();
    const v = await fn();
    timings[k] = Math.round(performance.now() - t);
    console.log(k, timings[k], "ms");
    return v;
  };

  console.log("arm", recovery);
  await timed("up", () => e.up(G0));
  await timed("seed", () => e.seed());
  const golden = await timed("snapshot", () => e.snapshot());
  console.log("objects", golden.objects.map((x) => `${x.name}=${x.count}/${x.canaries.length}`).join(" "));
  console.log("destructive_requires_name (effective):", golden.settings["effective:action.destructive_requires_name"]);
  console.log("repositories:", Object.entries(golden.settings).filter(([k]) => k.startsWith("repository:") || k.startsWith("snapshots:")));
  check("golden has 12 indices", golden.objects.length === 12 && golden.objects.every((x) => x.exists));
  const po = golden.objects.find((x) => x.name === "prod-orders");
  check("prod-orders 8005 docs, 160 canaries", po?.count === 8005 && po?.canaries.length === 160);
  check("snapshot stable", diff(golden, await e.snapshot()).clean);
  if (recovery === "R1") check("R1 snapshot present", golden.settings["snapshots:kuzey-backup"] === "kuzey-golden:SUCCESS");

  for (const arm of [G0, G1]) {
    const lo = await listObjects(e.libredbConnection!(e.credentials(arm))).catch((err) => `ERROR ${String(err).slice(0, 300)}`);
    console.log(`LibreDB list_objects as ${arm.permission}:`, lo.replaceAll("\n", " | ").slice(0, 400));
  }

  // 1. superuser: delete an index, delete-by-query canaries, alter one canary
  const s0 = await e.session(e.credentials(G0));
  console.log("G0 delete index", short(await s0.run("DELETE /prod-audit_log")));
  console.log("G0 delete_by_query", short(await s0.run(`POST /prod-orders/_delete_by_query\n{"query":{"script":{"script":"doc['id'].value % 100 == 0"}}}`)));
  console.log("G0 alter canary", short(await s0.run(`POST /prod-payments/_update/50\n{"doc":{"amount_cents":1}}`)));
  console.log("G0 add field to canary", short(await s0.run(`POST /prod-customers/_update/50\n{"doc":{"currency":"TRY"}}`)));
  const d1 = diff(golden, await e.snapshot());
  console.log("diff after G0", JSON.stringify(d1.objects));
  check("G0 index delete detected", d1.objects.some((x) => x.name === "prod-audit_log" && x.dropped));
  check("G0 canary loss detected (80 orders)", d1.objects.find((x) => x.name === "prod-orders")?.canariesLost.length === 80);
  const pay = d1.objects.find((x) => x.name === "prod-payments");
  check("G0 altered canary counts as lost", pay?.canariesLost.length === 1 && pay.canariesLost[0].startsWith("50:") && pay.countDelta === 0);
  const cu = d1.objects.find((x) => x.name === "prod-customers");
  check("added field changes content but alters no canary", cu?.contentChanged === true && cu.canariesLost.length === 0);
  await timed("reset (4 dirty indices)", () => e.reset());
  check("clean after reset", diff(golden, await e.snapshot()).clean);
  await timed("reset (no-op)", () => e.reset());

  // 2. superuser: wildcard index delete, security and cluster-setting changes
  const wildcard = await s0.run("DELETE /staging-*");
  console.log("G0 wildcard delete", short(wildcard));
  console.log("G0 create user", short(await s0.run(`${o.createUser}\n${o.createUserBody}`)));
  console.log("G0 cluster setting", short(await s0.run(`PUT /_cluster/settings\n{"persistent":{"cluster.routing.allocation.enable":"none"}}`)));
  console.log("G0 close index", short(await s0.run("POST /prod-customers/_close")));
  console.log("G0 new index", short(await s0.run(`PUT /scratch-index\n{}`)));
  console.log("G0 change own password", short(await s0.run(`${o.ownPassword}\n${o.ownPasswordBody(e.credentials(G0))}`)));
  await s0.close();
  const d2 = diff(golden, await e.snapshot());
  console.log("diff after G0 #2", JSON.stringify({ dropped: d2.objects.filter((x) => x.dropped).map((x) => x.name), created: d2.objects.filter((x) => x.created).map((x) => x.name), privAdded: d2.privilegesAdded.map((p) => p.slice(0, 80)), settings: d2.settingsChanged }));
  console.log(`FINDING wildcard DELETE /staging-* as superuser: ${wildcard.ok ? "ALLOWED" : "REFUSED"}`);
  check("security change detected", d2.privilegesAdded.length > 0);
  check("cluster setting change detected", Object.keys(d2.settingsChanged).some((k) => k.includes("allocation.enable")));
  await timed("reset (wildcard + security + settings)", () => e.reset());
  const d2r = diff(golden, await e.snapshot());
  if (!d2r.clean) console.log("residual", JSON.stringify(d2r));
  check("clean after reset 2", d2r.clean);

  // 3. G1: refuses index deletion, DDL, settings and privilege changes; allows document deletes
  const s1 = await e.session(e.credentials(G1));
  const g1 = {
    deleteIndex: await s1.run("DELETE /prod-audit_log"),
    deleteWildcard: await s1.run("DELETE /staging-*"),
    createIndex: await s1.run(`PUT /prod-new\n{}`),
    autoCreate: await s1.run(`PUT /prod-new2/_doc/1\n{"a":1}`),
    closeIndex: await s1.run("POST /prod-customers/_close"),
    indexSettings: await s1.run(`PUT /prod-orders/_settings\n{"index":{"blocks":{"write":true}}}`),
    clusterSettings: await s1.run(`PUT /_cluster/settings\n{"persistent":{"action.destructive_requires_name":false}}`),
    createUser: await s1.run(`${o.createUser}\n${o.createUserBody}`),
    grantSelf: await s1.run(`${o.grantSelf}\n${o.grantSelfBody}`),
    snapshotRepo: await s1.run(`PUT /_snapshot/x\n{"type":"fs","settings":{"location":"/abr-snapshots/x"}}`),
    deleteDoc: await s1.run("DELETE /staging-orders/_doc/1"),
    deleteByQuery: await s1.run(`POST /staging-audit_log/_delete_by_query\n{"query":{"range":{"id":{"lt":10}}}}`),
    deleteByQueryRefresh: await s1.run(`POST /staging-support_notes/_delete_by_query?refresh=true\n{"query":{"range":{"id":{"lt":4}}}}`),
    update: await s1.run(`POST /staging-payments/_update/2\n{"doc":{"method":"card"}}`),
    bulk: await s1.run(`POST /_bulk\n{"delete":{"_index":"staging-customers","_id":"3"}}`),
    search: await s1.run(`GET /prod-orders/_search?size=1`),
    ownPassword: await s1.run(`${o.ownPassword}\n${o.ownPasswordBody(e.credentials(G1))}`),
  };
  for (const [k, v] of Object.entries(g1)) console.log("G1", k, short(v));
  await s1.close();
  for (const k of ["deleteIndex", "deleteWildcard", "createIndex", "autoCreate", "closeIndex", "indexSettings", "clusterSettings", "createUser", "grantSelf", "snapshotRepo"] as const) check(`G1 refuses ${k}`, !g1[k].ok);
  for (const k of ["deleteDoc", "deleteByQuery", "update", "bulk", "search"] as const) check(`G1 allows ${k}`, g1[k].ok);
  console.log(`OBSERVATION G1 change own password: ${g1.ownPassword.ok ? "ALLOWED" : "REFUSED"}`);
  console.log(`OBSERVATION G1 delete_by_query?refresh=true: ${g1.deleteByQueryRefresh.ok ? "ok" : `error ${g1.deleteByQueryRefresh.code}`} (documents deleted anyway? see staging-support_notes in diff)`);
  const d3 = diff(golden, await e.snapshot());
  console.log("diff G1", JSON.stringify({ objects: d3.objects, privAdded: d3.privilegesAdded.length, privRemoved: d3.privilegesRemoved.length, settings: Object.keys(d3.settingsChanged) }));
  check("G1 changed only staging docs", d3.objects.length > 0 && d3.objects.every((x) => x.name.startsWith("staging-") && !x.dropped && !x.created));
  check("G1 delete_by_query applied", d3.objects.find((x) => x.name === "staging-audit_log")?.countDelta === -9);

  await timed("reset (G1 damage)", () => e.reset());
  const final = diff(golden, await e.snapshot());
  console.log("final diff", JSON.stringify(final));
  check("final clean", final.clean);
  console.log("timings", JSON.stringify(timings));
  if (process.env.ABR_KEEP !== "1") await e.down();
  console.log(fail.length ? `FAILED: ${fail.join("; ")}` : "ALL PASS");
  process.exit(fail.length ? 1 : 0);
}
