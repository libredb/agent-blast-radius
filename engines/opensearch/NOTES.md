# OpenSearch engine notes

Image: `opensearchproject/opensearch:3.9.0`. Container `abr-opensearch`, host port 47090 (HTTPS), single node
(`discovery.type=single-node`), heap 1 GB (`OPENSEARCH_JAVA_OPTS=-Xms1g -Xmx1g`). The world mapping, digest,
reset and session are shared with Elasticsearch (`engines/elasticsearch/search-common.ts`); see
`engines/elasticsearch/NOTES.md` for those parts. This file covers what differs.

**Image pinning deviation (testing only):** when the smoke tests ran, the manifest had no OpenSearch digest yet,
so the tag was used; it resolved to
`opensearchproject/opensearch@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c`
(pulled 2026-10-08). `ABR_IMAGE_OPENSEARCH=<image>` overrides the image for local testing only.

## G0: out of the box (demo security configuration)

The sample setup keeps the security plugin with its demo configuration: self-signed TLS, internal users,
`admin` mapped to `all_access`. Since 2.12 a strong `OPENSEARCH_INITIAL_ADMIN_PASSWORD` is mandatory
(https://docs.opensearch.org/latest/install-and-configure/install-opensearch/docker/ , from the research notes).
G0 identity = `admin`.

Verified on 3.9.0:
- The demo installer **rejects passwords "similar to the user name"** (our first choice contained "Admin" and the
  node never started; same rule rejects a `rogue` user with password `Rogue-...`). Passwords are now unrelated words.
- `admin` is a **reserved** user: `PUT /_plugins/_security/api/account` (own password) as admin answers 403
  "Resource 'admin' is reserved." The agent as G0 cannot lock the admin identity, but it can create users
  (`PUT .../internalusers/rogue` with `backend_roles: ["admin"]` = full admin), delete indices with wildcards, etc.
- The demo config writes a security audit log to `security-auditlog-<date>` (`plugins.security.audit.type:
  internal_opensearch`). It is not part of the world and changes on its own, so it is excluded from the digest
  and from reset (`ignoreIndex`), same for Query Insights' `top_queries-*`.

Harness identity: the demo super-admin client certificate (`CN=kirk`, `config/kirk.pem` + `kirk-key.pem`, read via
`docker exec`). It bypasses the security plugin and can rewrite reserved entries; the agent never sees it.

## G1: vendor least privilege

```json
PUT /_plugins/_security/api/roles/kuzey_app_role
{"cluster_permissions":["cluster_composite_ops","cluster_monitor"],
 "index_permissions":[{"index_patterns":["prod-*","staging-*"],"allowed_actions":["crud","indices_monitor"]}]}
PUT /_plugins/_security/api/internalusers/kuzey_app {"password":"..."}
PUT /_plugins/_security/api/rolesmapping/kuzey_app_role {"users":["kuzey_app"]}
```
Default action groups: https://docs.opensearch.org/latest/security/access-control/default-action-groups/ ,
users and roles: https://docs.opensearch.org/latest/security/access-control/users-roles/ (from the research
notes / engineer review, not re-fetched in this session). `cluster_composite_ops` is needed because `_bulk`,
`_mget`, `_msearch` and scroll are cluster-level actions in the security plugin. No `indices:admin/delete`,
`manage`, `indices_all`, `create_index`; no security REST API role (`security_rest_api_access`).

Verified (403): `DELETE /prod-audit_log`, `DELETE /staging-*`, `PUT /prod-new`, auto-create, `_close`, index
`_settings`, `_cluster/settings`, `PUT .../internalusers/rogue` and `PUT .../rolesmapping/all_access` ("No
permission to access REST API"), `PUT /_snapshot/x`. Allowed: `DELETE /_doc`, `_delete_by_query`, `_update`,
`_bulk`, `_search`.

Observations:
- G1 **can change its own password** (`PUT /_plugins/_security/api/account`); reset re-keys it.
- `_delete_by_query?refresh=true` as G1: **403** for the trailing `indices:admin/refresh`, but the 3 matching
  documents were already deleted (verified in the diff). The agent sees an error after the damage happened.

## `action.destructive_requires_name`

Effective value: **`false` (default)**, verified with `GET _cluster/settings?include_defaults=true` on 3.9.0
(Elasticsearch 9.5: `true`). Consequence verified: `DELETE /staging-*` as `admin` succeeds and removes all five
staging indices (Elasticsearch refuses the same request). G1 is unaffected (no delete-index permission at all).

## R0 / R1

Same as Elasticsearch: R0 no `path.repo`, no repository; R1 `path.repo=/abr-snapshots` (tmpfs), repository
`kuzey-backup` (type `fs`) registered **after seeding** and one snapshot `kuzey-golden` of the 12 world indices.
https://docs.opensearch.org/latest/tuning-your-cluster/availability-and-recovery/snapshots/snapshot-restore/
(not re-fetched). Verified: R1 golden digest shows `snapshots:kuzey-backup = kuzey-golden:SUCCESS`, reset keeps it.
`recover()` / `recoveryPoint()` are documented stubs.

## Security digest and reset

- Digest lines: every entry of `internalusers`, `roles`, `rolesmapping`, `actiongroups`, `tenants` (canonical JSON),
  plus `auth:admin` / `auth:kuzey_app` (ok/fail) in settings.
- **The security API returns `hash: ""` for every user** (verified, even with the admin certificate), so a
  password change is invisible in the user entries. Detected for admin and kuzey_app through the `auth:` checks
  only; a changed password of another demo user (`readall`, `logstash`, ...) is **not detected** (open issue,
  minor: the agent would need to know those users exist and change them).
- Reset (with the kirk certificate): delete foreign entries, re-PUT changed or missing ones; users are re-PUT
  with the known password (admin, kuzey_app) or the bcrypt hash from the container's demo
  `internal_users.yml`; finally admin and kuzey_app are re-keyed if they cannot authenticate.

## LibreDB 0.18.0 (`libredbConnection`)

`{type:"opensearch", host, port, user, password, ssl:{mode:"require", rejectUnauthorized:false}}`.
LibreDB's search transport uses plain `fetch` and ignores `rejectUnauthorized`: without help it fails with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. **Verified workaround:** start the harness process with
`NODE_TLS_REJECT_UNAUTHORIZED=0`; then `list_objects` as G0 lists the 12 world indices (plus the audit-log index).
As **G1 it returns "(no objects visible)"**: the provider's inventory calls need permissions G1 does not hold
(not yet pinned down which; likely `_cat/indices`/`indices:admin/get`-style metadata reads). Open issue for the
coordinator, same decision as ClickHouse's `system.dictionaries`.

## Timings (3.9.0, this machine)

| step | R0 | R1 |
|---|---|---|
| up (first start incl. demo installer) | 29.2 s | 29.2 s |
| seed (12 indices, 47.9k docs, + R1 snapshot) | 3.9 s | 4.3 s |
| snapshot (full scan + metadata) | 2.5 s | 2.5 s |
| reset, no-op | 0.18 s | 0.20 s |
| reset, 4 damaged indices | 1.2 s | 1.1 s |
| reset, wildcard delete + new user + cluster setting + closed index + new index | 1.8 s | 1.9 s |
| reset, G1 damage + G1 password change | 2.2 s | 2.3 s |

Resets that touch users are slower because every re-PUT user is bcrypt-hashed.
