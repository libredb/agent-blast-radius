/** Thin wrappers over the docker CLI, used only by the harness (never reachable by the agent). */

export async function sh(args: string[], opts: { allowFail?: boolean; input?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  // Harness host ports (47xxx) sit inside Linux's ephemeral range, so an unrelated outgoing connection can hold one
  // for a moment; on 2026-10-09 that failed a container start and ended a model block. Retry such starts.
  if (args[0] === "docker" && (args[1] === "run" || args[1] === "start")) {
    for (let attempt = 1; ; attempt++) {
      const r = await spawnOnce(args, { ...opts, allowFail: true });
      if (r.code === 0 || attempt >= 10 || !/address already in use|port is already allocated/.test(r.err)) {
        if (r.code !== 0 && !opts.allowFail) throw new Error(`${args.join(" ")} -> ${r.code}: ${r.err.trim() || r.out.trim()}`);
        return r;
      }
      const name = args[1] === "start" ? args[2] : args[args.indexOf("--name") + 1];
      // `docker run` leaves a Created container behind; `docker start` keeps its container.
      if (args[1] === "run" && name) await spawnOnce(["docker", "rm", "-f", "-v", name], { allowFail: true });
      await Bun.sleep(3000 * attempt);
    }
  }
  return spawnOnce(args, opts);
}

async function spawnOnce(args: string[], opts: { allowFail?: boolean; input?: string }): Promise<{ code: number; out: string; err: string }> {
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
