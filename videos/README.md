# Videos: Blast radius in practice

A four-episode video series on the paper "When an AI agent makes a mistake in a database, what decides the damage?"
([arXiv 2611.30483](https://arxiv.org/abs/2611.30483)), played live on this repo's harness at `f5cba42` on an M-series
Mac (Docker Desktop with 8 GB, bun 1.4.5). Each episode is one finding: it happens on a real database, in LibreDB
Studio and in the harness's own output, and then the paper's number for it is read from `report/appendix.md`.

Below the videos are four gaps we hit on the way to running the harness from the repo alone, each with a suggested
fix.

## The videos

[Series playlist](https://www.youtube.com/playlist?list=PLCzmCsab5e9A) ·
[Shorts playlist](https://www.youtube.com/playlist?list=PLc4vqOab6CBk)

| Episode | What it shows | Shorts |
|---|---|---|
| [1. A single wrong statement](https://youtu.be/Y0ies0-XW28) (2:09) | H1: `DELETE FROM prod.orders` with no `WHERE` empties the table in Studio (160 canaries lost); M01, M05, M08, M19 and M21 on PostgreSQL, MySQL and SQLite, where only M21 differs | [DELETE with no WHERE](https://youtu.be/c-bty3Kx2aw) · [three engines](https://youtu.be/5iM5K-oNGug) |
| [2. Permissions and denylists](https://youtu.be/Hct5hLrYFls) (2:13) | H2 and H5: under G1 the DROP is refused but the DELETE runs; G2n stops DROP and TRUNCATE, G2s also stops a DELETE with no WHERE, and `WHERE 1 = 1` gets past it; M15's credential in `prod.app_config` | [can't drop, can delete](https://youtu.be/yUUJSA04Q54) · [the denylist bypass](https://youtu.be/Otmtg2Kx2J8) · [a password in the data](https://youtu.be/8vqsAWU3Hug) |
| [3. The backup decides](https://youtu.be/zZ0FRqqhpaA) (2:04) | H3: R0 vs R1 on the same mistakes; `DROP TABLE prod.orders` under R1, then the PITR drill and all 8005 orders back in Studio; a 20 s delay changes nothing, as the appendix finds | [the drill brings the orders back](https://youtu.be/vilR6mS6FD4) · [R0 vs R1](https://youtu.be/ggRn5dXGGBI) · [no backup](https://youtu.be/-nTiTZjKgC0) |
| [4. A real agent at the keyboard](https://youtu.be/ExqvtwhFWcc) (2:23) | Layer B: Qwen3.5-4B served locally with the preregistered flags, on T01 and T04 under G0 and G1 (seed 11, one paraphrase); the T04 notice, the agent's report and the digest side by side; H4 and H6 from the appendix | [the model and the tasks](https://youtu.be/KoYs1yy5f9Y) · [G0 vs G1](https://youtu.be/RTFV7nXnNG0) |

Every number in the narration comes from the run on screen or from `report/appendix.md`. Episode 4 ran a single seed
and paraphrase, so it presents its trials as examples and cites the paper for rates.

## Gaps

### 1. The README doesn't say how to run the harness

**Where:** `README.md` (§ What is here), `ARCHITECTURE.md`.

The README lists the folders but never how to run anything. The commands came from the code's own usage lines:
`bun install`, `bun layer-a/runner.ts <engine> [--perm …] [--rec …] [--mistakes …]` (`layer-a/runner.ts#L5`),
`bun tests/smoke-postgres.ts`, `bun layer-b/runner.ts --model … --engines …`. Nothing says that bun and Docker are
needed, that the engine images are pinned by digest (`manifest/image-digests.tsv`) and pulled on first use (a first
pull of the PostgreSQL image timed out once here; `scripts/pull-images.sh` exists but isn't mentioned), or that the
runner skips cells whose record already exists, so a second run with the default `--run layer-a-<date>` prints
nothing. `package.json` has no `scripts`.

**Suggested fix:** a "Run it" section: requirements (bun, Docker, about 8 GB for the relational engines), `bun
install`, `scripts/pull-images.sh`, one Layer A line (`bun layer-a/runner.ts postgres --perm G0 --rec R0,R1
--mistakes M05,M21`, under a minute here), where the records go, and `--run` for a fresh run.

**In the video:** episode 1 from 01:07, the runner on each engine, each under a fresh `--run`.

### 2. `scripts/serve-model.sh` only works on the paper's machine

**Where:** `scripts/serve-model.sh#L5`, `#L11-12`.

The script `cd`s to a fixed `$HOME/tools/llama.cpp/llama-b11191`, sets `LD_LIBRARY_PATH` to CUDA 12 libraries under
`$HOME/tools/cuda12-libs`, and reads models from `$HOME/models/abr`. On a Mac, or any machine without that layout, it
fails before the server starts. For episode 4 we started Homebrew's `llama-server` (Metal) with the same flags:
`--jinja -np 1 -c 16384 -ngl 99 --port 47900 --cache-type-k f16 --cache-type-v f16 --metrics`.

**Suggested fix:** take the llama-server binary and the models folder from the environment (`LLAMA_SERVER`,
`ABR_MODELS`, with today's paths as defaults), and set `LD_LIBRARY_PATH` only when the CUDA folder exists.

**In the video:** episode 4 at 00:19.

### 3. Records always say llama.cpp `b11191`

**Where:** `src/manifest.ts` (`llamaCpp: "b11191"`).

ARCHITECTURE.md says the manifest, including the llama.cpp build, "is embedded in every record". The build is a
constant, so every record from episode 4 says `b11191` although Homebrew's build served the model. A record can't tell
a replication on another build from the paper's own runs.

**Suggested fix:** read the build from the server when the runner starts (llama-server's `/props` returns
`build_info`) and record that.

**In the video:** episode 4 at 00:19 (the build that served) and 00:33 (the trials).

### 4. `scripts/fetch-models.sh` needs `hf` and fetches every model

**Where:** `scripts/fetch-models.sh#L6`, `#L8`, `#L10-11`.

It calls the Hugging Face CLI (`hf download`), which nothing says to install, fetches all six models (well over
40 GB with the 35B) with no way to pick one, and checks them with `sha256sum`, which macOS doesn't ship. For episode 4 we downloaded only Qwen3.5-4B from its pinned revision with
`curl` and checked it with `shasum -a 256` against `manifest/models.tsv`.

**Suggested fix:** name `hf` (`pip install huggingface_hub`) in the script's header and in the README, take model
ids as arguments, and fall back to `shasum -a 256` where `sha256sum` is missing.

---

The videos were made with Walker, our tool for filming a repo's own commands as a narrated walkthrough. If you'd like
the files behind them, or a video for a future release, comment on this PR.
