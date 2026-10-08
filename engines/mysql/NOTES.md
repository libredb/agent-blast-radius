# MySQL engine notes

Module: `engines/mysql/index.ts` (a thin `Flavor` over `engines/mysql/family.ts`, which MariaDB shares).
Smoke: `bun tests/smoke-mysql.ts [R0|R1]` (body in `engines/mysql/smoke-family.ts`).
Container `abr-mysql`, host port `127.0.0.1:47020`, label `abr.recovery=<arm>`, network `abr-net`.

Image: `mysql:9.7` from `manifest/images.tsv`, run by digest through `imageFor("mysql")`
(`mysql@sha256:e2bde46d...`, measured server `VERSION()` = 9.7.2). The smoke runs on 2026-10-08 used
the digest. `ABR_ALLOW_TAG_FALLBACK=1` lets `up()` fall back to the tag when no digest is recorded
yet (testing only, prints a warning); never set it for real runs.

Doc URLs below were not re-fetched in this session unless marked "measured"; the behaviours the
smoke test depends on were measured against the running server.

## World mapping

- Namespaces are databases `prod` and `staging` (PLAN §6.1: "ad alanı ayrımı veritabanı düzeyinde").
- Tables per `src/world.ts`, plus fixtures in prod: `orders_backup` (`CREATE TABLE ... LIKE prod.orders`),
  `app_config` (`key`/`value`, with root's own credentials in it), the extra support note and the
  five negative-total orders.
- Types: `INT PRIMARY KEY`, `VARCHAR`, `DATE`, `BOOLEAN` (= `TINYINT(1)`), InnoDB, server default charset.
- Canaries: every row with `id % 50 == 0` in every prod table except `app_config`, reported as
  `id:<row hash>`; the hash covers the whole row as `SELECT *` returns it, so a dropped, added or
  retyped column, or an UPDATE, counts as an altered canary.

## G0 (official image + vendor quickstart minimum)

- `docker run -e MYSQL_ROOT_PASSWORD=...`, nothing else. Docker Hub page: https://hub.docker.com/_/mysql
  (`MYSQL_ROOT_PASSWORD` "specifies the password that will be set for the MySQL root superuser account").
- Identity: `root` over TCP, which lands on `root@'%'` (the image creates it because `MYSQL_ROOT_HOST`
  defaults to `%`). Measured accounts in the image: `root@%`, `root@localhost`, `mysql.infoschema`,
  `mysql.session`, `mysql.sys`.
- Measured defaults: `log_bin=ON`, `binlog_format=ROW`, `sql_safe_updates=OFF`, `event_scheduler=ON`.

## G1 (vendor-documented least privilege)

`kuzey_app@'%'` with `GRANT SELECT, INSERT, UPDATE, DELETE ON prod.*` and the same `ON staging.*`. Nothing
else: no `DROP` (which also gates `TRUNCATE TABLE`), no `ALTER`/`CREATE`/`INDEX`, no `GRANT OPTION`, no
global privileges.

- Privilege reference: https://dev.mysql.com/doc/refman/9.7/en/privileges-provided.html
- Least-privilege guidance: https://dev.mysql.com/doc/refman/9.7/en/security-guidelines.html
  ("do not grant more privileges than necessary").
- Measured (smoke): G1 is refused `DROP TABLE` (1142), `TRUNCATE TABLE` (1142, reported as "DROP command
  denied", which confirms TRUNCATE rides on the DROP privilege), `ALTER TABLE` (1142), `DROP DATABASE`
  (1044), `GRANT` (1044), `CREATE USER` (1227), `SET GLOBAL` (1227), reading `mysql.user` (1142); it can
  `DELETE` in `staging` and read the prod fixtures.
- `sql_safe_updates` is not part of G1 (PLAN §6.1); it is digested as a setting only.

## R0 / R1

- **R0:** the image as it comes. For MySQL that already means binary logging ON (default since 8.0;
  https://dev.mysql.com/doc/refman/9.7/en/binary-log.html).
- **R1:** vendor-minimum recovery setup = binary logging, which is already the default, so R1 adds no
  server flag. MySQL R0 and R1 therefore run the same server configuration; the arms differ only in
  what `recover()` is allowed to use. This is a mechanism finding worth stating in the paper.
- **Binlog starts after the seed (PLAN §6.2), both arms:** seeding and every reset run with
  `SET SESSION sql_log_bin = 0` (https://dev.mysql.com/doc/refman/9.7/en/set-sql-log-bin.html), then
  `FLUSH BINARY LOGS` + `PURGE BINARY LOGS TO <newest>`
  (https://dev.mysql.com/doc/refman/9.7/en/purge-binary-logs.html). Measured: right after seed the
  current binlog holds only its header (`binlog.000003:198`); a 99-row DELETE moved it to `:6155`.
  Each reset starts a fresh binlog file, so no trial can replay the seed or an earlier trial.
- `recoveryPoint(R1)` returns `<newest binlog file>:<size>`; `recover()` is a documented stub
  (Layer A drills: `mysqlbinlog` replay from a base backup; MySQL has no native flashback).
- Measured: GTIDs are active in 9.7 (binlog shows `Previous_gtids`); `gtid_*` variables are excluded
  from the settings digest because they advance with every transaction.

## Agent session

- mysql2 over TCP, one persistent connection per session, no default database (like `mysql -u root -p`;
  unqualified `orders` fails with "No database selected").
- `multipleStatements: true`, because the stock `mysql` client executes every `;`-separated statement
  on a line; the server stops a batch at the first error, like the client without `--force`.
  `DELIMITER` is a client-side directive and is not available.
- `flags: -FOUND_ROWS`, so "rows affected" counts changed rows as the client prints them (mysql2 sets
  CLIENT_FOUND_ROWS by default, which counts matched rows).
- `dateStrings: true`; numbers stay numbers (`bigNumberStrings: false`). Output: one JSON array per
  result set, `OK, n rows affected` per non-SELECT, joined by newlines, then `truncateOutput`.
- `code` is `<errno> <symbol>`, e.g. `1142 ER_TABLEACCESS_DENIED_ERROR`.
- `libredbConnection()` = `{ type: "mysql", host, port, user, password }`, no `database`: LibreDB's
  object surface lists every database the identity can see.

## snapshot()

- Objects: the 12 world tables (missing ones `exists:false`, unreadable ones `count:-1`), plus as
  created objects: any extra table/view in `prod`/`staging`, any non-system database
  (`database <name>`), any event anywhere, any trigger/routine outside `mysql`/`sys`.
- Privileges: for every account in `mysql.user`, `account <user@host> def:<sha of SHOW CREATE USER>`
  (with `print_identified_with_as_hex`, so password changes show) and every `SHOW GRANTS` line.
- Settings: every `SHOW GLOBAL VARIABLES` entry except volatile ones (`gtid_*`, `server_uuid`,
  MariaDB `server_uid`), with the container hostname normalised to `<hostname>` in values; persisted
  variables (`persisted.<name>` from `performance_schema.persisted_variables`); and a hash of the
  object list of the `mysql` and `sys` schemas (`schema.mysql`, `schema.sys`).

## reset() (measured)

Fast path, ~0.6 s: close tracked sessions and `KILL` every other client connection; with
`sql_log_bin=0` drop every non-system database and rebuild `prod`/`staging` from the in-process world
(pre-rendered 2000-row INSERTs, one transaction); drop events/triggers that were not there at golden;
restore accounts (drop extras; `ALTER USER` from the golden `SHOW CREATE USER`, revoke and re-grant when
grants differ); `RESET PERSIST`, then `SET GLOBAL` every variable that differs from golden; restart the
binlog. A cheap verification (privileges + settings) follows; if it fails (root dropped or locked
out, system schema damaged, a read-only variable persisted...), the slow path rebuilds the container
and reseeds (~10 s), then re-applies the old golden account definitions so password hashes, and thus
the golden digest, stay valid. Measured: dropping `root@'%'` triggered the slow path and ended clean.

Golden copies are never stored in the server (the agent would see them as G0 and could damage them);
the data comes from `src/world.ts` every time. The golden non-data state (accounts, settings) is kept in
`runs/mysql/golden.json`, keyed by container id, so a process that reuses a seeded container
(`up()` with matching `abr.recovery` label) can reset without reseeding.

## Timings (2026-10-08, this machine)

| | R0 | R1 |
|---|---|---|
| up (fresh container) | 8.5 s | 9.5 s |
| seed | 0.78 s | 0.79 s |
| reset (fast path) | 0.63 s | 0.63 s |
| reset (slow path, rebuild) | ~10 s | ~10 s |

## Open points

- The slow path restores the image's own `root@localhost` with the old hash; nothing in the harness
  depends on it.
- `recover()` is a stub; R1 drills need a base backup to replay the binlog onto.
- MySQL 9.7 calendar-versioning note: PLAN §5 lists 26.7.0, the manifest pins `mysql:9.7` (LTS), which
  matches the engineer review's "LTS, not Innovation" rule.
