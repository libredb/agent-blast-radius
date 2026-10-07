/** Thin wrappers over the docker CLI, used only by the harness (never reachable by the agent). */

export async function sh(args: string[], opts: { allowFail?: boolean; input?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: opts.input ? new TextEncoder().encode(opts.input) : undefined });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0 && !opts.allowFail) throw new Error(`${args.join(" ")} -> ${code}: ${err.trim() || out.trim()}`);
  return { code, out, err };
}

export async function containerRunning(name: string): Promise<boolean> {
  const r = await sh(["docker", "inspect", "-f", "{{.State.Running}}", name], { allowFail: true });
  return r.code === 0 && r.out.trim() === "true";
}

export async function containerLabel(name: string, label: string): Promise<string | undefined> {
  const r = await sh(["docker", "inspect", "-f", `{{index .Config.Labels "${label}"}}`, name], { allowFail: true });
  return r.code === 0 ? r.out.trim() || undefined : undefined;
}

export async function removeContainer(name: string): Promise<void> {
  await sh(["docker", "rm", "-f", "-v", name], { allowFail: true });
}

export async function ensureNetwork(name = "abr-net"): Promise<string> {
  const r = await sh(["docker", "network", "inspect", name], { allowFail: true });
  if (r.code !== 0) await sh(["docker", "network", "create", name]);
  return name;
}

export async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 180_000, everyMs = 1000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return;
    } catch (e) {
      lastErr = e;
    }
    await Bun.sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

export async function imageFor(engine: string): Promise<string> {
  const manifest = Bun.file(new URL("../manifest/image-digests.tsv", import.meta.url));
  if (await manifest.exists()) {
    for (const line of (await manifest.text()).split("\n")) {
      const [eng, , digest] = line.split("\t");
      if (eng === engine && digest && digest !== "PULL-FAILED") return digest.trim();
    }
  }
  // While scripts/pull-images.sh is still running, its log already holds the resolved digests.
  const log = Bun.file(new URL("../logs/pull-images.log", import.meta.url));
  if (await log.exists()) {
    for (const line of (await log.text()).split("\n")) {
      const m = line.match(/ OK (\S+) (\S+@sha256:[0-9a-f]+)/);
      if (m && m[1] === engine) return m[2];
    }
  }
  throw new Error(`no pinned image digest for ${engine}; run scripts/pull-images.sh`);
}
