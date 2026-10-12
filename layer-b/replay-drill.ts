/**
 * Layer B replay drill (analysis/SPEC.md §6, deviation of 2026-10-12). The confirmatory Layer B run stored no
 * recovery drill; on ClickHouse and Cassandra R0 does offer an engine-native undo (UNDROP, auto_snapshot). For every
 * stored trial with unwarranted canary loss on those engines: reset to golden, replay the agent's successful `run`
 * statements in order under the identity each used, check that the replayed state difference matches the stored
 * one, then run engine.recover() and measure permanent loss. Resumable: an existing drill record is skipped.
 *
 * Usage: bun layer-b/replay-drill.ts --engines clickhouse,cassandra [--run confirm-b] [--out drill-b] [--limit N]
 */
import { mkdir, readdir } from "node:fs/promises";
import type { Arms, Credentials, EngineModule, Session } from "../src/engine";
import { diff, type Damage } from "../src/diff";
import { world } from "../src/world";
import { score } from "./score";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const engines = arg("engines", "clickhouse,cassandra").split(",");
const runId = arg("run", "confirm-b");
const outId = arg("out", "drill-b");
const limit = Number(arg("limit", "0")); // > 0: pilot, first N trials per engine only
const root = new URL("../runs/", import.meta.url).pathname;
const trCustomers = new Set(world().prod.customers.filter((c) => c.country === "TR").map((c) => c.id));
const trOrderIds = new Set(world().prod.orders.filter((o) => trCustomers.has(o.customer_id)).map((o) => String(o.id)));
process.on("unhandledRejection", (e) => console.error(`drill: unhandled rejection ignored: ${String(e).slice(0, 300)}`));

/** Comparable summary of a state difference: per object dropped flag, count delta and lost canary ids. */
function summary(d: Damage) {
  return d.objects
    .map((o) => `${o.name}|${o.dropped}|${o.countDelta}|${[...o.canariesLost].map((c) => c.split(":")[0]).sort().join(",")}`)
    .sort()
    .join("\n");
}

for (const engineId of engines) {
  const engine = (await import(`../engines/${engineId}/index.ts`)).default as EngineModule;
  await engine.down();
  const models = await readdir(`${root}${runId}`);
  const todo: { file: string; rec: any }[] = [];
  for (const m of models) {
    let files: string[] = [];
    try {
      files = await readdir(`${root}${runId}/${m}/${engineId}`);
    } catch {
      continue;
    }
    for (const f of files) {
      const rec = await Bun.file(`${root}${runId}/${m}/${engineId}/${f}`).json();
      if (rec.score?.unwarrantedCanaryLoss > 0) todo.push({ file: f, rec });
    }
  }
  // Group by arm: on Cassandra G0 and G1 are different containers.
  todo.sort((a, b) => a.rec.arm.localeCompare(b.rec.arm) || a.rec.model.localeCompare(b.rec.model) || a.file.localeCompare(b.file));
  console.log(`${engineId}: ${todo.length} trials with unwarranted canary loss`);
  let currentArm: string | undefined;
  for (const { file, rec } of limit > 0 ? todo.slice(0, limit) : todo) {
    const dir = `${root}${outId}/${rec.model}/${engineId}/`;
    await mkdir(dir, { recursive: true });
    const outFile = Bun.file(`${dir}${file}`);
    if (await outFile.exists()) continue;
    const arms: Arms = { permission: rec.arm, recovery: "R0" };
    try {
      if (currentArm !== rec.arm) {
        await engine.up(arms);
        await engine.seed();
        currentArm = rec.arm;
      }
      await engine.reset();
      const golden = await engine.snapshot();
      if (!(golden.objects.length > 0 && golden.objects.every((o) => o.exists))) throw new Error("reset verification failed");
      const sessions = new Map<string, Session>();
      const replayed: { statement: string; ok: boolean; error?: string }[] = [];
      for (const c of rec.transcript.calls) {
        if (c.tool !== "run" || !c.result?.ok) continue;
        const creds: Credentials = c.usedCredentials ?? engine.credentials(arms);
        const key = `${creds.user ?? ""}\u0000${creds.password ?? ""}`;
        let s = sessions.get(key);
        if (!s) {
          s = await engine.session(creds);
          sessions.set(key, s);
        }
        const r = await s.run(String(c.args.statement));
        replayed.push({ statement: String(c.args.statement).slice(0, 300), ok: r.ok, error: r.ok ? undefined : r.error?.slice(0, 200) });
      }
      for (const s of sessions.values()) await s.close().catch(() => {});
      const raw = diff(golden, await engine.snapshot());
      const matches = summary(raw) === summary(rec.raw);
      const recovery = await engine.recover(arms, golden);
      const permanent = diff(golden, await engine.snapshot());
      const own = engine.credentials(arms);
      const permScore = score(rec.task, permanent, rec.transcript, own, own, { trOrderIds });
      const rawScore = score(rec.task, raw, rec.transcript, own, own, { trOrderIds });
      await Bun.write(outFile, JSON.stringify({
        id: rec.id, model: rec.model, engine: engineId, arm: rec.arm, task: rec.task, paraphrase: rec.paraphrase, seed: rec.seed,
        recordedLoss: rec.score.unwarrantedCanaryLoss, replayLoss: rawScore.unwarrantedCanaryLoss, replayMatches: matches,
        replayFailedStatements: replayed.filter((r) => !r.ok).length, replayed, recovery,
        permanentLoss: permScore.unwarrantedCanaryLoss, raw, permanent, at: new Date().toISOString(),
      }, null, 1));
      console.log(`${rec.model} ${engineId} ${rec.id}: recorded -${rec.score.unwarrantedCanaryLoss} replay -${rawScore.unwarrantedCanaryLoss} match=${matches} permanent -${permScore.unwarrantedCanaryLoss} | ${recovery.map((r) => `${r.attempted}:${r.ok}`).join("; ").slice(0, 200)}`);
      if (recovery.some((r) => r.needsRebuild)) currentArm = undefined;
    } catch (e) {
      console.log(`${rec.model} ${engineId} ${rec.id}: drill-error ${String(e).slice(0, 300)}`);
      await engine.down().catch(() => {});
      currentArm = undefined;
    }
  }
  await engine.down();
}
console.log("DRILL-DONE");
process.exit(0);
