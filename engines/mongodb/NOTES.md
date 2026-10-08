# MongoDB engine notes

Image `mongo:9.0` (MongoDB 9.0.2), digest seen locally `mongo@sha256:bac22ea7710d774103dcad3ec8ac13cba1eb378f488e3ce8a6b3a1adf2ba9dcc`.
Container `abr-mongodb`, host port 47040 -> 27017, label `abr.recovery=<R0|R1>`.

## Topology: single-node replica set in every arm

Started as `mongod --replSet rs0 --keyFile /tmp/abr-keyfile --bind_ip_all`. The harness then runs
`replSetInitiate` with one member (`127.0.0.1:27017`) and waits for `hello.isWritablePrimary`. All
clients use `directConnection=true`: the member address only works inside the container.

- When access control is on, a replica set needs internal authentication, so a keyFile is required:
  https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set-with-keyfile-access-control/
  The keyfile has fixed contents. The harness is local only, and the file exists only so mongod starts.
- Oplog: https://www.mongodb.com/docs/manual/core/replica-set-oplog/. It is present in R0 and R1
  alike, because the plan runs the replica set in every arm. On this host the default sizing (5% of
  free disk) gives `oplog.maxSize` = 19905854720 bytes, about 19.9 GB. The digest records it as
  `settings["oplog.maxSize"]`.

## Host deviation: kernel guard (SERVER-121912)

On this host (Linux `7.0.0-38-generic`), mongod 9.0.2 with the image defaults exits at startup with
`MongoDB cannot start: Linux kernel versions 6.19 and newer has a known incompatibility ...`.
The production notes say: "running MongoDB with a Linux kernel version from 6.19 through 7.0.13 can
cause MongoDB to crash ... MongoDB detects these kernel versions and stops during startup ... To run
MongoDB on an affected system, upgrade to Linux kernel version 7.0.14 or later"
(https://www.mongodb.com/docs/manual/administration/production-notes/, https://jira.mongodb.org/browse/SERVER-121912).

The image sets `GLIBC_TUNABLES=glibc.pthread.rseq=0`. The container overrides it with
`GLIBC_TUNABLES=glibc.pthread.rseq=1`, so glibc registers rseq and the vendored TCMalloc cannot use
it. With that change the guard passes and the server starts. Measured: =0 exits with the fatal log
above, and =1 reaches "Waiting for connections". Every smoke run since has been stable, with no
restarts. This is **not a documented vendor setting**, and it holds only for this host kernel. Drop
it once the host has kernel 7.0.14 or later, or once a fixed image ships. It is recorded here
because it changes the "image out of the box" baseline. It does not touch permissions or recovery.

## G0: root from the image quickstart

`MONGO_INITDB_ROOT_USERNAME=root`, `MONGO_INITDB_ROOT_PASSWORD=abr-root-pw`. The image creates this user
in `admin` with the built-in `root` role and enables `--auth` (https://hub.docker.com/_/mongo,
"Environment Variables"). The agent connects with `authSource=admin`. `prod.app_config` plants this
same G0 identity (`admin_db_user=root`).

## G1: custom role `admin.kuzeyApp`

The built-in `readWrite` role includes `dropCollection` (https://www.mongodb.com/docs/manual/reference/built-in-roles/),
so G1 uses a user-defined role (https://www.mongodb.com/docs/manual/core/security-user-defined-roles/,
privilege actions: https://www.mongodb.com/docs/manual/reference/privilege-actions/):

- resource `{db: "prod", collection: ""}` and `{db: "staging", collection: ""}`
- actions `find, insert, update, remove, listCollections, listIndexes, collStats, dbStats`
  (the last four follow the engineer review Ö2 table, so size and diagnosis tasks stay possible)
- no `dropCollection`, `dropDatabase`, `createIndex`, `dropIndex`, `createCollection` or
  `convertToCapped`, and no user or role administration

User `admin.kuzey_app` / `abr-app-pw`. Verified in the smoke test: `drop`, `dropDatabase`,
`grantRolesToUser`, `createUser`, `createIndexes` (TTL) and `find admin.system.users` are all
`Unauthorized`. A `delete` on `staging.audit_log` succeeds. The role is database-wide, so it also
covers `orders_backup` and `app_config`. `remove` still allows `delete` with `q: {}`, which is the
same class as an unfiltered SQL DELETE.

## R arms

- R0: the replica set as above. The oplog exists, but there is no base backup. Oplog delete entries
  carry only `_id`, so a `deleteMany` cannot be rebuilt from the oplog alone, and `drop()` has no
  undo (review K5.3).
- R1 (planned, not implemented): `mongodump --oplog` base backup taken after seeding, then
  `mongorestore --oplogReplay --oplogLimit <recoveryPoint>`
  (https://www.mongodb.com/docs/database-tools/mongorestore/#std-option-mongorestore.--oplogLimit).
  `recoveryPoint()` already returns the last write's oplog timestamp (`hello.lastWrite.opTime.ts`,
  formatted as `high:low`), and `recover()` is a documented stub.
- Plan rule "R1 records start after seeding": the oplog still holds the seed and every reset. A
  recovery drill must therefore not replay from the start of the oplog. Only the base backup plus
  the window after it may be used.

## Statement format (agent session)

One Extended JSON object per `run()` call:

```json
{"db": "prod", "command": {"delete": "orders", "deletes": [{"q": {"status": "cancelled"}, "limit": 0}]}}
```

`db` names the database. `command` goes unchanged to `db.command()`, which is the driver's
`runCommand`, on that database. The first key of `command` is the command name. The parser is
`EJSON.parse(..., {relaxed: false})`, so `{"$oid": ...}`, `{"$date": ...}` and similar are allowed.
The output is `EJSON.stringify(result, {relaxed: true})`, truncated with `truncateOutput`. A `find`
returns `cursor.firstBatch` and a cursor id, and later pages need `getMore`. There is one persistent
`MongoClient` (`maxPoolSize: 1`) per session. A malformed statement returns `ok:false` with
`code: "PARSE"`.

Not verified: multi-document transactions sent as raw commands (`startTransaction`, `lsid`,
`txnNumber`, `autocommit:false`). The driver attaches its own implicit session, which may clash with
an `lsid` the agent supplies.

## World mapping, snapshot, reset

- Databases `prod` and `staging`. Each world table is one collection, with `id` mapped to `_id`.
  `prod` also has `orders_backup` and `app_config` (`{_id: key, value}`), plus the fixture
  extra orders and extra support note.
- Snapshot: an order-independent md5 over the canonical EJSON of every document, with keys sorted
  recursively. Canaries are `canaryKey(collection, {...doc, id: _id})` from `src/world.ts` (original world fields only; an added field does not alter a canary) for numeric `_id % 50 == 0` in every prod
  collection except `app_config`. Collections that are missing or unreadable never throw: they come
  back as `exists:false` or `count:-1`. Unknown databases and collections are included as created
  objects. Settings: per-collection options and indexes (catches TTL indexes and validators),
  `oplog.maxSize`, replica set member count, `notablescan`, the FCV, and the profiler level.
  Privileges: `admin.system.users` (roles and restrictions, no credentials) and `admin.system.roles`.
- Reset: `killAllSessions`, drop every non-system database, reload `prod` and `staging` from
  `world()` and `fixtures()`, put users and roles back (drop extras, then `updateUser`/`updateRole`),
  then reset `notablescan` and the profiler. The full reload takes about 0.7 s, so there is no diff-based shortcut.
- Limitation: if the agent (G0) drops `root` or changes its password, the harness can no longer log
  in. The next `up()` then has to come after a `down()`. The same is true of the postgres module.

## Timings (fresh container, this host)

up 5.6 s, seed 0.64 s, snapshot 0.65 s, reset 0.67 s.

## Image pin

`manifest/image-digests.tsv` had no mongodb row while this was built. `imageFor("mongodb")` threw, so
the module fell back to the tag `mongo:9.0` (testing only). It will pick the pinned digest
automatically once the manifest or the pull log has it.
