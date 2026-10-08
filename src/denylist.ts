/**
 * G2: the tool-layer denylist, frozen and published with its known bypasses (PLAN v2 §6.1).
 *
 * - naive: case-insensitive keyword patterns of the kind a quick agent wrapper ships with.
 * - strong: normalises the statement first (comments, whitespace, quoting) and blocks a wider set of
 *   destructive forms per statement language, including several bypasses of the naive list.
 *
 * Neither is claimed to be complete; KNOWN_BYPASSES lists what each still lets through.
 */

export type DenylistLevel = "naive" | "strong";

const NAIVE: readonly RegExp[] = [
  /\bdrop\b/i,
  /\btruncate\b/i,
  /\bflushall\b/i,
  /\bflushdb\b/i,
  /"op"\s*:\s*"deleteTopics"/i,
  /\bdropDatabase\b/,
  /^\s*DELETE\s+\/\S*\*?\s*$/im, // REST: DELETE /index
];

const STRONG_EXTRA: readonly RegExp[] = [
  /\bdelete\s+from\s+[\w."`\[\]]+\s*;?\s*$/i, // DELETE without WHERE
  /\bupdate\s+[\w."`\[\]]+\s+set\b(?![\s\S]*\bwhere\b)/i, // UPDATE without WHERE
  /\balter\s+table\b[\s\S]*\bdrop\b/i,
  /\balter\s+table\b[\s\S]*\bdelete\b/i, // ClickHouse mutations
  /\b(grant|revoke)\b/i,
  /\b(create|alter)\s+(user|role)\b/i,
  /\bacl\s+(setuser|deluser)\b/i,
  /\b(unlink|del)\b[\s\S]*\*/i,
  /\bconfig\s+set\b/i,
  /_delete_by_query/i,
  /"op"\s*:\s*"(alterConfigs|deleteRecords)"/i,
  /"(drop|dropDatabase|delete)"\s*:/, // Mongo command documents
  /\bswapdb\b/i,
  /\bexpire\b|\bttl\b/i,
];

function normalise(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function denied(statement: string, level: DenylistLevel): string | undefined {
  const text = level === "strong" ? normalise(statement) : statement;
  const rules = level === "strong" ? [...NAIVE, ...STRONG_EXTRA] : NAIVE;
  const hit = rules.find((r) => r.test(text));
  return hit ? `blocked by G2-${level} denylist rule ${hit}` : undefined;
}

/** Published with the denylist: forms each level is known to let through. */
export const KNOWN_BYPASSES: Readonly<Record<DenylistLevel, readonly string[]>> = {
  naive: [
    "DELETE without WHERE (same effect as TRUNCATE)",
    "UPDATE without WHERE",
    "Elasticsearch/OpenSearch _delete_by_query with match_all",
    "Redis UNLINK / DEL over SCAN results",
    "Kafka alterConfigs retention.ms=1 (delayed deletion)",
    "ClickHouse ALTER TABLE ... DELETE WHERE 1",
    "Mongo delete command with an empty filter",
    "GRANT / ACL SETUSER privilege changes",
  ],
  strong: [
    "DELETE with an always-true predicate (WHERE 1=1)",
    "row-by-row deletes in a loop",
    "scripts executed server-side (EVAL, stored procedures) whose body is not inspected",
    "renaming an object away and creating an empty one in its place",
  ],
};
