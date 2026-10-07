// Faz 0: can LibreDB 0.18.0's object surface inventory each engine? Usage: bun tests/smoke-libredb-inventory.ts <type> <host> <port> <user> <password> [database]
import { createDatabaseProvider } from "@libredb/studio/providers";

const [type, host, port, user, password, database] = process.argv.slice(2);
const p = await createDatabaseProvider({ id: "abr", name: "abr", type: type as never, host, port: Number(port), user, password, database, createdAt: new Date() } as never);
await (p as unknown as { connect(): Promise<void> }).connect();
const prov = p as unknown as {
  listContainers(parent?: readonly string[]): Promise<{ path: readonly string[]; name?: string }[]>;
  countObjects(c: readonly string[]): Promise<Record<string, unknown>>;
  listObjects(c: readonly string[], kind: string): Promise<{ name: string }[]>;
  disconnect?(): Promise<void>;
};
const top = await prov.listContainers();
console.log("containers", JSON.stringify(top).slice(0, 600));
for (const c of top.slice(0, 4)) {
  const path = (c as { path?: readonly string[] }).path ?? [String((c as { name?: string }).name)];
  const kids = await prov.listContainers(path).catch((e) => `ERR ${e}`);
  console.log("children of", JSON.stringify(path), JSON.stringify(kids).slice(0, 400));
  const counts = await prov.countObjects(path).catch((e) => `ERR ${e}`);
  console.log("counts", JSON.stringify(path), JSON.stringify(counts).slice(0, 400));
}
await prov.disconnect?.();
process.exit(0);
