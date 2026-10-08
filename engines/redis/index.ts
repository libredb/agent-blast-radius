import { makeKvEngine } from "./kv";

/**
 * Redis 8: no database-level ACL exists, so prod/staging are key prefixes (`prod:`, `staging:`)
 * in db 0 and G1 confines the application user with key patterns. See NOTES.md.
 */
export const redis = makeKvEngine({
  id: "redis",
  port: 47070,
  fallbackImage: "redis:8",
  layout: "prefix",
  appRules: [
    "~prod:*",
    "~staging:*",
    "resetchannels",
    "-@all",
    "+@read",
    "+@write",
    "+@transaction",
    "+@connection",
    "-@dangerous",
    "-@admin",
    "-@scripting",
    "+info",
    "-flushall",
    "-flushdb",
    "-swapdb",
    "-config",
    "-debug",
    "-shutdown",
  ],
});

export default redis;
