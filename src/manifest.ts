/** The reproducibility manifest embedded in every record (PLAN v2 §11). */
let cached: Record<string, unknown> | undefined;

async function text(path: string): Promise<string> {
  const f = Bun.file(new URL(path, import.meta.url));
  return (await f.exists()) ? f.text() : "";
}

export async function manifest(): Promise<Record<string, unknown>> {
  if (cached) return cached;
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: new URL("..", import.meta.url).pathname });
  const pkg = JSON.parse(await text("../node_modules/@libredb/studio/package.json") || "{}");
  cached = {
    harnessCommit: git.stdout.toString().trim(),
    images: await text("../manifest/image-digests.tsv"),
    models: await text("../manifest/models.tsv"),
    llamaCpp: "b11191",
    libredb: { package: pkg.name, gitHead: pkg.gitHead },
    bun: Bun.version,
  };
  return cached;
}
