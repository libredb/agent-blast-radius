import { opensearch } from "../engines/opensearch";
import { runSearchSmoke } from "../engines/elasticsearch/smoke-search";

// ABR_RECOVERY=R1 bun tests/smoke-opensearch.ts runs the same scenario with the snapshot repository.
await runSearchSmoke(opensearch, {
  createUser: "PUT /_plugins/_security/api/internalusers/rogue",
  createUserBody: `{"password":"Velvet-Comet-4821!","backend_roles":["admin"]}`,
  grantSelf: "PUT /_plugins/_security/api/rolesmapping/all_access",
  grantSelfBody: `{"users":["admin","kuzey_app"],"backend_roles":["admin"]}`,
  ownPassword: "PUT /_plugins/_security/api/account",
  ownPasswordBody: (c) => JSON.stringify({ current_password: c.password, password: "Ember-Tundra-5530!" }),
});
