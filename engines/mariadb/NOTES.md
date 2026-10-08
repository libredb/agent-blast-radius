# MariaDB engine notes

Module: `engines/mariadb/index.ts`, a `Flavor` over the shared `engines/mysql/family.ts`; everything in
`engines/mysql/NOTES.md` (world mapping, canaries, session, snapshot, reset) applies here too. Only
the differences are listed below.
Smoke: `bun tests/smoke-mariadb.ts [R0|R1]`. Container `abr-mariadb`, host port `127.0.0.1:47030`.

## Image

`mariadb:lts` from `manifest/images.tsv`. Measured `VERSION()` = `12.3.3-MariaDB-ubu2404`.
**Deviation:** when the smoke tests ran, `scripts/pull-images.sh` had not yet recorded a MariaDB digest
(the background pull was still running), so the tests ran with `ABR_ALLOW_TAG_FALLBACK=1` on the tag.
The locally pulled image's digest was `mariadb@sha256:2bdff1534a7e569fecaf4b10b66ad0d410806e382d9db29ba305448addda97c4`.
Re-run the smoke test without the flag once the digest is in `manifest/image-digests.tsv`.

## G0

- `docker run -e MARIADB_ROOT_PASSWORD=...`. Docker Hub page: https://hub.docker.com/_/mariadb (one of
  `MARIADB_RANDOM_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD_HASH`, `MARIADB_ROOT_PASSWORD`,
  `MARIADB_ALLOW_EMPTY_ROOT_PASSWORD` must be set).
- Identity: `root@'%'`. Measured accounts: `root@%`, `root@localhost`, `mariadb.sys@localhost`, and
  three `healthcheck` accounts (`127.0.0.1`, `::1`, `localhost`) that the image's entrypoint creates.
- Measured defaults: `log_bin=OFF`, `binlog_format=ROW` (the research note expected MIXED; 12.3 reports
  ROW), `sql_safe_updates=OFF`, `event_scheduler=OFF` (MySQL: ON).

## G1

Same grants as MySQL: `SELECT, INSERT, UPDATE, DELETE ON prod.*` and `ON staging.*` for `kuzey_app@'%'`.
GRANT reference: https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/grant ;
TRUNCATE needs the DROP privilege: https://mariadb.com/docs/server/reference/sql-statements/table-statements/truncate-table .
Measured: identical refusals to MySQL (DROP, TRUNCATE reported as "DROP command denied", ALTER, DROP
DATABASE, GRANT, CREATE USER, SET GLOBAL, reading `mysql.user`); `SET GLOBAL` is refused for want of
`CONNECTION ADMIN` (MySQL: `SYSTEM_VARIABLES_ADMIN`).

## R0 / R1

- **R0:** binary logging is off (https://mariadb.com/docs/server/server-management/server-monitoring-logs/binary-log/activating-the-binary-log :
  "To enable binary logging, start the server with the `--log-bin` option"). This is the mechanism
  difference from MySQL the plan wants reported (PLAN §5, Kü6).
- **R1:** `mariadbd --log-bin` (vendor minimum, no base name, no format override). Measured: files are
  `mysqld-bin.NNNNNN`, format ROW. The binlog starts after the seed exactly as for MySQL
  (`sql_log_bin=0` while seeding/resetting, then `FLUSH BINARY LOGS` + `PURGE BINARY LOGS TO`): right
  after seed `mysqld-bin.000003:374` (header + GTID list only).
- **R1 recovery (implemented)**, same procedure as MySQL with MariaDB's tools: `mariadb-dump` right
  after seed, then on recover restore it and pipe `mariadb-binlog --stop-position=<pos> <files>` into
  `mariadb` (MariaDB documents point-in-time recovery
  as a backup restore plus `mariadb-binlog` replay; exact doc URL not verified in this session). No `--skip-gtids` needed. Measured drill: ~0.66 s, diff
  against the point clean. `mariadb-binlog --flashback` (reversing ROW DML in place) is a possible
  second drill, not implemented.
- R0 recovery: `ok:false`, "no base backup and binary logging is off".

## Family differences handled in code

No `SET PERSIST`/`RESET PERSIST` and no `performance_schema.persisted_variables`; roles are rows of
`mysql.user` with `is_role='Y'` and are recreated with `CREATE ROLE`; `SHOW CREATE USER` prints
`IDENTIFIED BY PASSWORD '*hash'`, which round-trips without the hex option; `server_uid` (a per-instance
id) is excluded from the settings digest. `libredbConnection()` returns `type: "mysql"`: LibreDB has no
separate MariaDB type, its mysql provider serves both.

## Timings (2026-10-08)

| | R0 | R1 |
|---|---|---|
| up (fresh container) | 7.4 s | 6.5 s |
| seed | 0.65 s | 0.67 s |
| reset (fast path) | 0.48 s | 0.45 s |
| reset (slow path, rebuild) | ~10-14 s | ~10-14 s |
| recover (R1 drill) | n/a | 0.66 s |

## Open points

- After a slow-path rebuild the `healthcheck` accounts get their old password hashes back, which no
  longer match `/var/lib/mysql/.my-healthcheck.cnf` in the new container; the harness does not use
  `healthcheck.sh`, so this only matters if someone adds a Docker HEALTHCHECK.
