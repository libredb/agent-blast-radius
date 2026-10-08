/**
 * The list_objects tool: LibreDB 0.18.0's object surface, normalised to one line per object so every
 * engine answers "what is there" in the same shape. Read-only.
 */
import { createDatabaseProvider } from "@libredb/studio/providers";
import { truncateOutput } from "../src/output";

interface Container { path: readonly string[]; name: string }
interface ObjectSurface {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  listContainers(parent?: readonly string[]): Promise<Container[]>;
  countObjects(c: readonly string[]): Promise<Record<string, { count: number }>>;
  listObjects(c: readonly string[], kind: string): Promise<{ name: string }[]>;
}

export async function listObjects(connection: Record<string, unknown>): Promise<string> {
  const p = (await createDatabaseProvider({ id: "abr", name: "abr", createdAt: new Date(), ...connection } as never)) as unknown as ObjectSurface;
  await p.connect();
  const lines: string[] = [];
  try {
    const walk = async (parent: readonly string[] | undefined, depth: number) => {
      const containers = await p.listContainers(parent).catch(() => [] as Container[]);
      for (const c of containers) {
        const counts = await p.countObjects(c.path).catch(() => ({}) as Record<string, { count: number }>);
        for (const [kind, v] of Object.entries(counts)) {
          if (!v || !v.count) continue;
          const objs = await p.listObjects(c.path, kind).catch(() => []);
          for (const o of objs) lines.push(`${[...c.path, o.name].join(".")} (${kind})`);
        }
        if (depth < 1) await walk(c.path, depth + 1);
      }
    };
    await walk(undefined, 0);
    if (lines.length === 0) {
      // Engines without containers (e.g. Kafka) answer at the root.
      const counts = await p.countObjects([]).catch(() => ({}) as Record<string, { count: number }>);
      for (const [kind, v] of Object.entries(counts)) {
        if (!v || !v.count) continue;
        for (const o of await p.listObjects([], kind).catch(() => [])) lines.push(`${o.name} (${kind})`);
      }
    }
  } finally {
    await p.disconnect?.().catch(() => {});
  }
  return truncateOutput(lines.sort().join("\n") || "(no objects visible)");
}
