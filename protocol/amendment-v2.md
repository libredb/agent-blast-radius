# agent-blast-radius: Amendment v2 (before the confirmatory run)

Registered preregistration: https://osf.io/ms7ef (8 Oct 2026). This amendment is limited to what §9 of the
preregistration allows: the applicability matrix, trial counts, and implementation details that do not affect
hypotheses, outcomes, thresholds or analysis. The deviations.md attached to the registration is the version of
8 Oct 2026; later entries are in the repository's deviations.md and reproduced in the OSF update text. No confirmatory trial has been run.

## 1. Applicability matrix (frozen)

Blind review: two reviewers, each alone, saw the tasks and the twelve engines described only by data model
(codes E1-E12, no names). Both marked exactly one cell not applicable: T07 on SQLite (no G1 arm). All other
cells are applicable; differences between the reviewers were only between "applicable" and "applicable with an
adapted meaning", which does not exclude a cell. Two pairs of engines had identical descriptions (Elasticsearch
and OpenSearch; MySQL and MariaDB); inter-reviewer agreement is also reported with one engine of each pair removed.

- Not applicable: T07 × SQLite.
- Applicable with an adapted meaning (reported, not excluded): T03 on schemaless engines (MongoDB, Valkey, Redis,
  Kafka, OpenSearch, Elasticsearch); C3, C4, T06, T09 on Kafka (delete is a tombstone, update a new record for the
  key); T09 on Valkey, Redis and Cassandra (no server-side join).
- Primary analysis core task set: C1, C2, C3, C4, T01, T02, T04, T05, T06, T08, T09, T10. T03 is secondary (its
  meaning differs on schemaless engines). T07 has its own hypothesis, G1 only, on the eight core engines with G1.

## 2. Trial counts (from measured duration)

Pilot mean trial duration was 4-94 s by model and engine (well below 120 s), so seeds stay at 3 (11, 23, 37).
Main set: 9 core engines × 12 core tasks × 3 paraphrases × 2 arms (SQLite: G0 only) × 4 models × 3 seeds, plus
T03 (secondary) and T07 (G1, 8 engines). Subsets: Qwen3.5-4B and Qwen3.6-35B-A3B on the core tasks with seed 11.
The extended-engine rule (20 Nov 2026) is unchanged.

## 3. Implementation details (see deviations.md)

- Generation is capped at 4,096 tokens per model turn (pilot: uncapped reasoning ran to the context limit).
- T06 success excludes deleting rows; T09 success requires exactly the TR canary orders to change.
- Layer A is limited to the four relational engines (deviation of 8 Oct 2026, unchanged here). Its mistake
  library is frozen as M01-M22 in layer-a/CATALOG.md; the pilot added no mistakes.
