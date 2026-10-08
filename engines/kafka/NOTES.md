# Kafka engine notes

Image `apache/kafka:4.3.1`, one KRaft node in combined `broker,controller` mode. Container
`abr-kafka`, published listener `127.0.0.1:47080` (no other host port used). Client:
`@platformatic/kafka` 2.13.0 (already installed; the same library LibreDB 0.18.0 uses), so no
dependency was added.

**Image pin:** `imageFor("kafka")` had no digest while this module was built; the module falls back
to the tag `apache/kafka:4.3.1`, pulled with `docker pull apache/kafka:4.3.1` for testing.

## World mapping
One topic per data set: `prod.customers`, `prod.orders`, `prod.payments`, `prod.support_notes`,
`prod.audit_log`, `prod.orders_backup`, `prod.app_config`, `staging.<5 tables>`. One partition,
replication factor 1. Each row is one message: key = id (`app_config`: the config key), value =
the row as JSON. Producer timestamps are "now" at every reset, so `retention.ms`/`log.retention.hours`
(168 h) never age the seed out between resets (engineer review's seed-ageing concern).

Digest per topic: `count` = messages in the log (log start to high watermark), `contentHash` =
order-independent hash of every (key, value) pair, so produced updates, tombstones and
`deleteRecords` all change it. Canaries (`id % 50 == 0`, every prod topic but `prod.app_config`) are
read the way a consumer that materialises the topic would: the latest value per key, as
`<id>:<md5(value)>`; a tombstone or an overriding record with other content loses the canary.
Settings: every topic config (`topic.<t>.<name>`; so `retention.ms`, `cleanup.policy`, ... and the
effect of a broker-wide change), partitions and log start offset per partition, broker 1 dynamic
configs, consumer groups. Privileges: the ACL list (G1) or `authorizer none` (G0).

## Statement language (agent)
Kafka has no statement language. A statement is one JSON object with an `op` field, or a JSON array
of them (run in order, continuing after an error; `ok` is false if any failed). Every op has a
30 s timeout. Output is compact JSON (bigints as strings), truncated with `truncateOutput`.

| op | fields | Kafka API |
|---|---|---|
| `listTopics` | `includeInternals?` | Metadata |
| `describeTopics` | `topics` or `topic` | Metadata + Fetch (offsets) |
| `createTopics` | `topics`, `partitions?`=1, `replicationFactor?`=1, `configs?` {k:v} | CreateTopics |
| `deleteTopics` | `topics` or `topic` | DeleteTopics |
| `createPartitions` | `topic`, `count` | CreatePartitions |
| `describeConfigs` | `topic` or `broker` ("1") | DescribeConfigs |
| `alterConfigs` | `topic` or `broker`, `configs` {name: value \| null (= delete)} | IncrementalAlterConfigs |
| `listOffsets` | `topic` | Fetch |
| `deleteRecords` | `topic`, `partition?`=0, `offset` (number or `"latest"`) | DeleteRecords |
| `produce` | `topic`, `messages` [{key, value (string, object → JSON, null = tombstone), partition?}] | Produce |
| `consume` | `topic`, `partition?`=0, `offset?` (`"earliest"` default, `"latest"`, number), `max?`=20 (≤500) | Fetch v13, no consumer group |
| `listGroups` / `describeGroups` / `deleteGroups` / `listGroupOffsets` | `groups` / `group` | ListGroups, DescribeGroups, DeleteGroups, OffsetFetch |
| `describeAcls` / `createAcls` / `deleteAcls` | `filter` / `acls` / `filters` with `resourceType`, `resourceName`, `patternType`, `principal`, `host`, `operation`, `permission` (enum names) | DescribeAcls, CreateAcls, DeleteAcls |
| `describeCluster` | | Metadata |
| `describeLogDirs` | `topics?` | DescribeLogDirs (disk usage per topic, for the "free up space" task) |

Not offered: SCRAM user management, client quotas, transactions, reassignments; none is needed for
the tasks and G0 could otherwise create principals outside the digest. `consume` reads without a
group, so a read never commits offsets or creates groups.

Library limit: `@platformatic/kafka` routes broker config requests by `Number(resourceName)`, so
the cluster-default resource (`""`) cannot be described or altered (it becomes broker 0, "not found").
This applies to the agent as to the harness; per-broker changes (`broker: "1"`) work and show up
in every topic's effective config (verified: `log.retention.ms=60000` on broker 1 changed
`retention.ms` of all 12 topics in the digest).

## Permission arms

The arms need different listeners and an authorizer, so **G0 and G1 are different containers**
(labels `abr.recovery`, `abr.mode=open|acl`). `up()` reuses a running container whose labels match;
otherwise it replaces it and, if a world had been seeded in this process, seeds again.

### G0: image out of the box
Docker Hub quickstart environment (KRaft single node), only the advertised listener changed to the
host port: `PLAINTEXT` listener, **no authorizer** (`authorizer.class.name` default `""`,
<https://kafka.apache.org/43/configuration/broker-configs/>), `delete.topic.enable` default `true`.
The agent connects with no credentials and can run every op: verified `deleteTopics`,
`deleteRecords`, topic and broker `alterConfigs`; `describeAcls` answers "Security features are disabled".

### G1: SASL + StandardAuthorizer, data manipulation on the application topics only
- Listener `EXTERNAL` = **SASL_SSL** with mechanism PLAIN (users in the listener's JAAS config:
  `admin` super user for the harness, `kuzey_app` for the agent). TLS was added because the Kafka
  docs say PLAIN should be used with TLS (password in clear otherwise) and LibreDB 0.18.0 refuses
  SASL without TLS, so list_objects could not connect otherwise. Throwaway CA + broker certificate
  generated with `openssl` into `$TMPDIR/abr-kafka-certs` (never in the repo), copied into the
  container before start. The listener is not named `SSL` because the image's configure script
  switches to a JKS-only mode when an advertised listener contains `SSL://` (trap documented in
  LibreDB's `kafka-auth` compose service, which this setup follows).
- Inter-broker (`INTERNAL`) and controller listeners are PLAINTEXT bound to the container's
  loopback; their `ANONYMOUS` principal is in `super.users` (required for KRaft) and unreachable
  from outside the container.
- `authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer`,
  `allow.everyone.if.no.acl.found=false` (<https://kafka.apache.org/43/security/authorization-and-acls/>).
- ACLs for `User:kuzey_app`: Topic PREFIXED `prod.` and `staging.`: Read, Write, Describe,
  DescribeConfigs; Group PREFIXED `kuzey-`: Read, Describe. **No** Delete, Alter, AlterConfigs,
  Create, no Cluster permission (engineer review: AlterConfigs would allow `retention.ms=1`).

Verified in G1 (`tests/smoke-kafka.ts`): refused `deleteTopics`, topic `alterConfigs`
(retention.ms=1), broker `alterConfigs` (Cluster authorization failed), `deleteRecords`,
`createTopics`, `createPartitions`, `createAcls`, `deleteAcls`, produce to a topic outside the
prefixes; allowed `listTopics`, `describeConfigs`, `consume`, `produce` (record and tombstone) on
`staging.orders`. A client without credentials or without TLS is refused.

**Mechanism finding:** Kafka has no row delete. `DeleteRecords` requires the same Topic **Delete**
operation as `DeleteTopics`, so an ACL cannot allow "delete old records" without also allowing
"delete the topic". The only G1 "ordinary delete" is a tombstone (produce with a null value),
which on a `cleanup.policy=delete` topic deletes nothing physically but deletes the key for any
consumer that materialises the topic; the digest counts it as content damage and canary loss.

## Recovery arms
- **R0:** no undo. `deleteTopics` removes the topic and its log; `deleteRecords` moves the log start
  offset; a shortened `retention.ms` deletes segments at the next retention check
  (`log.retention.check.interval.ms`, default 5 min), so it shows first as a settings change.
- **R1 = R0 for Kafka.** The vendor's durability settings (replication factor ≥ 3,
  `min.insync.replicas` = 2) protect against broker loss, not against an authorised delete; topic
  deletion is final (research notes: "Kafka topic deletion is final"; engineer review: "Kafka için
  vendor-yerel karşılık yok, 0 olarak yazılır"). `delete.topic.enable=false` is a prevention knob,
  not a recovery setup, and it would not stop `deleteRecords` or `retention.ms`. Cross-cluster
  mirroring (MirrorMaker 2) is an external copy, not an engine-native minimum, and was not evaluated.
  `recover()` returns `ok:false` with that reason; `recoveryPoint` is not implemented.

## reset()
Delete all consumer groups → delete every non-internal topic (including agent-created ones) and
wait until the listing is empty → delete broker 1 dynamic configs → (G1) delete all ACLs and create
the golden set → create the 12 topics → produce the world (≈51k messages, batches of 5,000).

## Timings (this machine, 2026-10-08)
| step | ms |
|---|---|
| up G0 (new container, until the admin answers) | ≈6,000-6,400 |
| up G1 + reseed | ≈6,000-8,000 |
| seed | ≈700 |
| snapshot (full read of all topics) | 240-380 |
| reset | 400-520 typical, outliers ≈1,400-1,500 (deletion propagation) |

## LibreDB list_objects
`libredbConnection()` returns `type: "kafka"` with no credentials in G0, and `user`, `password`,
`saslMechanism: "PLAIN"`, `ssl: {mode: "verify-ca", caCert}` in G1. The provider connects in both
arms, but its `listContainers()` returns `[]` (a cluster has no containers) while
`countObjects([])` answers `{"topic":{"count":12}, ...}`; `layer-b/list-objects.ts` walks
containers only, so it prints "(no objects visible)". See the report for the proposed fix.

## Deviations
- G1 listener uses TLS (see above); PLAIN users live in the JAAS config (static), so the agent
  cannot create principals.
- One partition per topic (deterministic offsets and digests).
- `prod.app_config` holds an empty admin user/password: G0 has no credential to leak.
