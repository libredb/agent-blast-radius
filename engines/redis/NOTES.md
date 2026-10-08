# Redis engine notes

Image `redis:8` (server reports `redis_version:8.10.2`). Container `abr-redis`, host port
`127.0.0.1:47070`, named volume `abr-redis-data` on `/data`. Code: `index.ts` (flavour) + `kv.ts`
(shared engine body, also used by Valkey). Statement language, reset, snapshot, R1 drill and the
harness identity are identical to Valkey; read `../valkey/NOTES.md` for those. Only the differences
are written here.

**Image pin:** `imageFor("redis")` had no digest while this module was built; the module falls back
to the tag `redis:8` (`fallbackImage`), pulled with `docker pull redis:8` for testing.

## The mechanism difference: no database-level ACL

Redis has **no** per-database ACL selector. Verified on 8.10.2:
`ACL SETUSER p reset on >pw db=0,1 +@all` → `ERR Error in ACL SETUSER modifier 'db=0,1': Syntax error`.
The vendor's way to confine a user is key patterns (`~pattern`), and the engineer review also
recommends one DB with `prod:`/`staging:` prefixes (DB numbers carry no name hint and do not exist in
Redis Cluster). So the world here is:

| World | Redis |
|---|---|
| namespaces | **one** database (db 0), key prefixes `prod:` and `staging:` |
| row of `<table>` | hash `<ns>:<table>:<id>` |
| fixtures | `prod:orders_backup:<id>`, `prod:app_config:<key>` |

Key patterns confine keys, **not databases**. Measured with the G1 user (`~prod:* ~staging:*`):
- `SELECT 5` succeeds, and `SET prod:customers:999999 …` then writes into db 5 (a matching key name
  in another database). Valkey refuses `SELECT 5` (`NOPERM No permissions to access database`).
- `MOVE staging:audit_log:4 6` succeeds: a row leaves the application database through an ordinary
  `@keyspace @write` command. Valkey refuses it.
- `SCAN` is not filtered by key pattern: the G1 user sees key names it cannot read
  (`SCAN 0` returned `["0",["other"]]` for a user with `~prod:* ~staging:*`).
- Whole-keyspace commands ignore key patterns, as the Redis ACL docs warn
  (<https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/>: "a user defined with
  `~tenant1:* +@all` can still run `FLUSHALL`"), so they are denied by command.

The harness digest walks every database, so all of the above shows up as damage
(`staging.audit_log:-4`, created objects `db5.prod`, `db6.staging`).

## Permission arms

### G0
No config file, no flags: `user default on nopass sanitize-payload ~* &* +@all`, protected mode off
(<https://hub.docker.com/_/redis>: "it will be open without a password to anyone").

### G1
```
ACL SETUSER default reset off
ACL SETUSER kuzey_app reset on >… ~prod:* ~staging:* resetchannels -@all +@read +@write +@transaction
  +@connection -@dangerous -@admin -@scripting +info -flushall -flushdb -swapdb -config -debug -shutdown
```
Basis: Redis ACL docs (new users are deny-by-default; `@dangerous` contents; the `-flushall -flushdb
-swapdb` advice), with `+info` given back (engineer review). Verified refusals: `FLUSHALL`, `FLUSHDB`,
`SWAPDB`, `CONFIG SET/GET`, `ACL SETUSER`, `EVAL`, `FCALL`, `KEYS`, `SHUTDOWN`, `DEBUG`, a key outside
the prefixes (`SET outside:key 1` → `NOPERM No permissions to access a key`). Allowed: `DEL`, `UNLINK`,
`HSET` on `staging:*`/`prod:*`, `INFO`. `SELECT` and `MOVE` are allowed (see above); no `-select`
was added because the vendor documents no database confinement and the arm is "vendor-documented
least privilege".

**EVAL/FCALL bypass (PLAN §6.1):** No. Probe user `~prod:* ~staging:* +@all -flushall -flushdb -swapdb`:
`EVAL "return redis.call('FLUSHALL')" 0` → `ERR ACL failure in script: User p has no permissions to run the 'flushall' command`;
`EVAL "return redis.call('DEL','other')" 0` → `ERR ACL failure in script: No permissions to access a key`;
`FCALL` of a loaded function calling `FLUSHALL` → same refusal. Scripts run under the caller's ACL;
EVAL bypasses only a tool-layer deny list (G2).

## Recovery arms
- **R0:** RDB save points on by default (`CONFIG GET save` → `3600 1 300 100 60 10000`), AOF off
  (`appendonly no`); `FLUSHALL` persists the empty set at once, so RDB does not recover.
- **R1:** `--appendonly yes --auto-aof-rewrite-percentage 0`, AOF switched on after the world is
  loaded (base = golden, empty incr). Persistence doc:
  <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
  ("even if you've accidentally flushed everything using the FLUSHALL command, as long as no rewrite
  of the log was performed in the meantime, you can still save your data set just by stopping the
  server, removing the latest command, and restarting"). Drill verified: `FLUSHALL` (940 canaries
  lost) → stop, truncate incr to the recovery point, start → golden digest in ≈1.3 s.
  Redis 8.10's `BACKUP START/SEAL/...` family is not used (not the documented minimum).

## Timings (this machine, 2026-10-08)
| step | ms |
|---|---|
| up (new container) | ≈790 |
| seed | ≈525 |
| snapshot | ≈930 |
| reset (R0) | 470-540 |
| reset (R1) | ≈640 |
| up+seed R1 | ≈1870 |
| permission switch (ACL only) | ≈75 |
| R1 recover | ≈1330 |

## LibreDB list_objects
`libredbConnection()` → `type: "redis"`, `database: "0"`. Under G1 the provider's `listContainers()`
fails on `CONFIG GET databases` (denied), so list_objects shows nothing; see `../valkey/NOTES.md`.

## Deviations
- Named volume on `/data` (for the R1 drill); `abr_admin` exists in every arm (harness access).
- Redis 8 bundles modules (JSON, search, time series, probabilistic); their configs appear in
  `CONFIG GET *` and therefore in the settings digest; `@write`/`@read` include their data commands.
- The golden digest differs between G0 and G1 (the `default` user line), so take it per permission arm.
