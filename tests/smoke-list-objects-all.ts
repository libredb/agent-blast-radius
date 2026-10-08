// list_objects on every engine given on the command line (observer identity). Usage: bun tests/smoke-list-objects-all.ts mysql mongodb ...
import type { EngineModule } from "../src/engine";
import { listObjects } from "../layer-b/list-objects";
for (const id of process.argv.slice(2)) {
  const e = (await import(`../engines/${id}/index.ts`)).default as EngineModule;
  await e.down();
  await e.up({ permission: "G0", recovery: "R0" });
  await e.seed();
  const out = await listObjects(e.libredbConnection!(e.credentials({ permission: "G0", recovery: "R0" }))).catch((x) => `ERROR ${x}`);
  console.log(`== ${id}\n${out.split("\n").slice(0, 16).join("\n")}`);
  await e.down();
}
process.exit(0);
