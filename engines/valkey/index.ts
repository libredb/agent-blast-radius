import { makeKvEngine } from "../redis/kv";

/**
 * Valkey 9.1: db 0 = prod, db 1 = staging; G1 confines the application user to those two
 * logical databases with the database-level ACL selector `db=0,1`. See NOTES.md.
 */
export const valkey = makeKvEngine({
  id: "valkey",
  port: 47060,
  fallbackImage: "valkey/valkey:9.1",
  layout: "db",
  appRules: [
    "~*",
    "db=0,1",
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

export default valkey;
