# agent-blast-radius: harness architecture

Study design: the preregistration (https://osf.io/ms7ef, also in `protocol/`).

## Layers

- **Layer A (model-free):** a frozen library of canonical mistakes (`layer-a/mistakes/*.ts`), each
  expressed per engine in that engine's own statement language, applied by script to every
  engine × permission arm (G0/G1/G2, G1+G2) × recovery arm (R0/R1); then an engine-native recovery
  drill at fixed detection delays. Deterministic.
- **Layer B (live agent):** a minimal tool-calling agent (`layer-b/agent.ts`) driven by a local model
  served by `llama-server`, given tasks with hazards. Measures attempts, escalation, honesty, injection.

## Engine contract (`src/engine.ts`)

Every engine module under `engines/<id>/` implements `EngineModule`:

| Method | Purpose |
|---|---|
| `up(arms)` / `down()` | Start/stop the engine container(s) for a permission + recovery arm |
| `seed()` | Load the deterministic Kuzey Market world (prod + staging namespaces, canaries) |
| `snapshot()` | Return a `StateDigest`: per-object row/doc/key/message counts and content hashes, canary presence, roles/ACLs, relevant settings (retention, TTL), pending async work |
| `reset()` | Return to the golden seeded state (fastest engine-specific method) |
| `credentials(arm)` | The identity the agent/mistake runs as in that arm (G0 superuser, G1 least privilege) |
| `session(creds)` | A persistent client session over TCP from the client container, no shell; `run(statement)` |
| `recover(damage, delayMs)` | Engine-native recovery drill (no external backup in R0; vendor-minimum setup in R1) |

`StateDigest` comparison (`src/diff.ts`) yields: damage per object, canary loss, privilege changes,
delayed-damage markers. The diff is **mutation-tested** (`tests/mutation/`): known damage is injected
and must be detected.

## Isolation rules

- Engine containers are named `abr-<engine>`; host ports from the range 47000-47999; one engine at a
  time during runs.
- The agent's statements are executed by the harness process through each engine's own wire-protocol
  driver over TCP (never `docker exec` into the engine), in one persistent session per trial.
  The statement language is the engine's native textual language: SQL (PostgreSQL, MySQL, MariaDB,
  SQLite, ClickHouse), CQL (Cassandra), Redis/Valkey command lines, MongoDB database command
  documents (`runCommand` EJSON), REST `METHOD path body` (OpenSearch/Elasticsearch), and Kafka
  admin operations as JSON (Kafka has no statement language).
- No shell exists anywhere in the path, so there is nothing to escape to.

## Records

Every trial writes one JSONL record to `runs/<run-id>/<trial-id>.jsonl` before the next starts.
A rerun skips trial ids that already have a complete record. Manifest (image digests, model sha256,
llama.cpp build, LibreDB commit) is embedded in every record.
