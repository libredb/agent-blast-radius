/**
 * Layer A runner: apply each canonical mistake to an engine under each arm, then run the recovery
 * drill and record raw and permanent damage. Resumable: a cell whose record exists is skipped.
 *
 * Usage: bun layer-a/runner.ts <engine> [--perm G0,G1,G2n,G2s,G1G2s] [--rec R0,R1] [--delay-ms 0] [--run <id>]
 */
import { mkdir } from "node:fs/promises";
import type { Arms, Credentials, EngineModule, PermissionArm, RunResult } from "../src/engine";
import { diff } from "../src/diff";
import { denied, type DenylistLevel } from "../src/denylist";
import { manifest } from "../src/manifest";
import type { MistakeSet } from "./mistakes/types";

type PermCode = "G0" | "G1" | "G2n" | "G2s" | "G1G2s";
const PERM: Record<PermCode, { arm: PermissionArm; deny?: DenylistLevel }> = {
  G0: { arm: "G0" },
  G1: { arm: "G1" },
  G2n: { arm: "G2", deny: "naive" },
  G2s: { arm: "G2", deny: "strong" },
  G1G2s: { arm: "G1G2", deny: "strong" },
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const engineId = process.argv[2];
if (!engineId) throw new Error("engine id required");
const perms = arg("perm", "G0,G1,G2n,G2s,G1G2s").split(",") as PermCode[];
const recs = arg("rec", "R0,R1").split(",") as ("R0" | "R1")[];
const delayMs = Number(arg("delay-ms", "0"));
const runId = arg("run", `layer-a-${new Date().toISOString().slice(0, 10)}`);

const engine = (await import(`../engines/${engineId}/index.ts`)).default as EngineModule;
// A container left over from a crashed run may carry damage that seed() would capture as golden.
await engine.down();
const mistakes = (await import(`./mistakes/${engineId}.ts`)).default as MistakeSet;
const dir = new URL(`../runs/${runId}/${engineId}/`, import.meta.url).pathname;
await mkdir(dir, { recursive: true });
const man = await manifest();

for (const rec of recs) {
  for (const perm of perms) {
    const { arm, deny } = PERM[perm];
    const arms: Arms = { permission: arm, recovery: rec };
    if (engine.id === "sqlite" && (arm === "G1" || arm === "G1G2")) continue; // G1 not applicable (PLAN §6.1)
    let seeded = false;
    for (const m of mistakes.mistakes) {
      const cell = `${m.id}.${perm}.${rec}.d${delayMs}`;
      const file = Bun.file(`${dir}${cell}.json`);
      if (await file.exists()) continue;
      if (m.statements === "na") {
        await Bun.write(file, JSON.stringify({ cell, engine: engine.id, mistake: m.id, perm, rec, applicable: false, reason: m.reason, manifest: man }, null, 1));
        continue;
      }
      if (!seeded) {
        await engine.up(arms);
        await engine.seed();
        seeded = true;
      }
      // Reset and verify against a fresh golden digest of this container lifetime.
      await engine.reset();
      const golden = await engine.snapshot();
      const point = await engine.recoveryPoint?.(arms);
      const own = engine.credentials(arms);
      const admin = engine.credentials({ permission: "G0", recovery: rec });
      const sessions = new Map<string, Awaited<ReturnType<EngineModule["session"]>>>();
      const results: { statement: string; as: string; result: RunResult | { ok: false; output: ""; error: string; ms: 0 } }[] = [];
      for (const st of m.statements) {
        const creds: Credentials = st.as === "found-admin" ? admin : own;
        const block = deny ? denied(st.text, deny) : undefined;
        if (block) {
          results.push({ statement: st.text, as: st.as ?? "own", result: { ok: false, output: "", error: block, ms: 0 } });
          continue;
        }
        const key = st.as ?? "own";
        let s = sessions.get(key);
        if (!s) {
          s = await engine.session(creds);
          sessions.set(key, s);
        }
        results.push({ statement: st.text, as: key, result: await s.run(st.text) });
      }
      for (const s of sessions.values()) await s.close();
      const afterMistake = await engine.snapshot();
      const raw = diff(golden, afterMistake);
      if (delayMs > 0) await Bun.sleep(delayMs);
      let recovery: Awaited<ReturnType<EngineModule["recover"]>> = [];
      let permanent = raw;
      if (!raw.clean) {
        recovery = await engine.recover(arms, golden, point);
        permanent = diff(golden, await engine.snapshot());
      }
      await Bun.write(file, JSON.stringify({ cell, engine: engine.id, mistake: m.id, class: m.class, perm, rec, delayMs, applicable: true, results, raw, recovery, permanent, at: new Date().toISOString(), manifest: man }, null, 1));
      console.log(`${cell}: raw canaries -${raw.canariesLost}${raw.clean ? " (clean)" : ""}, permanent -${permanent.canariesLost}${permanent.clean ? " (clean)" : ""}`);
      if (recovery.some((r) => r.needsRebuild)) {
        await engine.down();
        seeded = false;
      }
    }
  }
}
await engine.down();
process.exit(0);
