/**
 * Layer B runner: one model (already served by scripts/serve-model.sh) × engines × arms × tasks ×
 * paraphrases × seeds. Resumable: a trial whose record exists is skipped.
 *
 * Usage: bun layer-b/runner.ts --model <id> --engines postgres,valkey --arms G0,G1 --tasks T01,C1 \
 *          [--paraphrases 0,1,2] [--seeds 11,23,37] [--run <id>] [--temperature 0.7]
 */
import { mkdir } from "node:fs/promises";
import type { Arms, EngineModule } from "../src/engine";
import { diff } from "../src/diff";
import { manifest } from "../src/manifest";
import { world } from "../src/world";
import { runTrial } from "./agent";
import { listObjects } from "./list-objects";
import { NOTES } from "./engine-notes";
import { score } from "./score";
import { SYSTEM_PROMPT, TASKS } from "./tasks";

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  if (def === undefined) throw new Error(`--${name} required`);
  return def;
}

const model = arg("model");
const engines = arg("engines").split(",");
const armList = arg("arms", "G0,G1").split(",") as ("G0" | "G1")[];
const taskIds = arg("tasks", TASKS.map((t) => t.id).join(",")).split(",");
const paraphrases = arg("paraphrases", "0,1,2").split(",").map(Number);
const seeds = arg("seeds", "11,23,37").split(",").map(Number);
const runId = arg("run", `layer-b-${new Date().toISOString().slice(0, 10)}`);
const temperature = process.env.ABR_TEMPERATURE ? Number(process.env.ABR_TEMPERATURE) : undefined;
const man = await manifest();
/** manifest/sampling.tsv: the model's published sampling; a run without a row is refused. */
const sampling: Record<string, number> = await (async () => {
  const rows = (await Bun.file(new URL("../manifest/sampling.tsv", import.meta.url)).text()).split("\n").filter((l) => l && !l.startsWith("#"));
  const row = rows.map((l) => l.split("\t")).find((c) => c[0] === model);
  if (!row) throw new Error(`no sampling row for ${model} in manifest/sampling.tsv`);
  const keys = ["temperature", "top_p", "top_k", "min_p", "presence_penalty"];
  return Object.fromEntries(keys.map((k, i) => [k, row[i + 1]]).filter(([, v]) => v !== "").map(([k, v]) => [k, Number(v)]));
})();
const trCustomers = new Set(world().prod.customers.filter((c) => c.country === "TR").map((c) => c.id));
const trCustomerCount = trCustomers.size;
const trOrderIds = new Set(world().prod.orders.filter((o) => trCustomers.has(o.customer_id)).map((o) => String(o.id)));

// A stray rejection inside a driver (seen once: a TimeoutError with no stack, 2026-10-10) must not end the block.
process.on("unhandledRejection", (e) => console.error(`harness: unhandled rejection ignored: ${String(e).slice(0, 300)}`));

for (const engineId of engines) {
  const engine = (await import(`../engines/${engineId}/index.ts`)).default as EngineModule;
// A container left over from a crashed run may carry damage that seed() would capture as golden.
await engine.down();
  const note = NOTES[engineId];
  const dir = new URL(`../runs/${runId}/${model}/${engineId}/`, import.meta.url).pathname;
  await mkdir(dir, { recursive: true });
  let up = false;
  for (const arm of armList) {
    if (engineId === "sqlite" && arm === "G1") continue;
    const arms: Arms = { permission: arm, recovery: "R0" };
    up = false; // each arm brings its own identity setup (ACLs, users, or a separate container)
    // Blocks are randomised by a fixed permutation so arm/task order is not confounded with time.
    const trials = TASKS.filter((t) => taskIds.includes(t.id) && t.arms.includes(arm)).flatMap((t) => paraphrases.flatMap((p) => seeds.map((seed) => ({ t, p, seed }))));
    trials.sort((a, b) => hash(`${a.t.id}${a.p}${a.seed}${arm}`) - hash(`${b.t.id}${b.p}${b.seed}${arm}`));
    for (const { t, p, seed } of trials) {
      const id = `${t.id}.p${p}.s${seed}.${arm}`;
      const file = Bun.file(`${dir}${id}.json`);
      if (await file.exists()) continue;
      try {
      if (!up) {
        await engine.up(arms);
        await engine.seed();
        up = true;
      }
      let verified = false;
      let golden;
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        await engine.reset();
        golden = await engine.snapshot();
        verified = golden.objects.length > 0 && golden.objects.every((o) => o.exists);
      }
      if (!verified || !golden) {
        await Bun.write(file, JSON.stringify({ id, excluded: "reset verification failed", manifest: man }));
        continue;
      }
      const creds = engine.credentials(arms);
      const user = t.prompts[p].replaceAll("{noun}", note.noun);
      const transcript = await runTrial({
        system: SYSTEM_PROMPT(note.name, note.language),
        user,
        engine,
        credentials: creds,
        // The inventory is read with the observer identity on every engine: it reveals object names only,
        // and some engines' least-privilege roles cannot list at all (Redis/Valkey need CONFIG GET).
        listObjects: () =>
          engine.libredbConnection
            ? listObjects(engine.libredbConnection(engine.credentials({ permission: "G0", recovery: "R0" }))).catch((e) => `error: object listing failed (${String(e).slice(0, 200)})`)
            : Promise.resolve("(object listing unavailable)"),
        temperature,
        sampling,
        seed,
      });
      const raw = diff(golden, await engine.snapshot());
      let recovery: Awaited<ReturnType<EngineModule["recover"]>> = [];
      let permanent = raw;
      if (!raw.clean) {
        recovery = await engine.recover(arms, golden);
        permanent = diff(golden, await engine.snapshot());
        if (recovery.some((r) => r.needsRebuild)) up = false;
      }
      const sc = score(t.id, raw, transcript, creds, engine.foundAdminCredentials?.(arms) ?? engine.credentials({ permission: "G0", recovery: "R0" }), { trCustomerCount, trOrderIds });
      await Bun.write(file, JSON.stringify({ id, model, engine: engineId, arm, task: t.id, paraphrase: p, seed, sampling, temperatureOverride: temperature ?? null, user, transcript, raw, recovery, permanent, score: sc, at: new Date().toISOString(), manifest: man }, null, 1));
      console.log(`${model} ${engineId} ${id}: ${transcript.stop} turns=${transcript.turns} ${Math.round(transcript.ms / 1000)}s canaries -${permanent.canariesLost} dangerous=${sc.attemptedDangerous} success=${sc.success}`);
      if (!up) await engine.down();
      } catch (e) {
        // A harness failure (reset, snapshot, recovery) leaves no record, so the catch-up pass reruns the trial on a
        // fresh container; it is logged, never scored.
        console.log(`${model} ${engineId} ${id}: harness-error ${String(e).slice(0, 300)}`);
        await engine.down().catch(() => {});
        up = false;
      }
    }
  }
  await engine.down();
}
process.exit(0);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
