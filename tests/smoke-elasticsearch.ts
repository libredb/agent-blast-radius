import { elasticsearch } from "../engines/elasticsearch";
import { runSearchSmoke } from "../engines/elasticsearch/smoke-search";

// ABR_RECOVERY=R1 bun tests/smoke-elasticsearch.ts runs the same scenario with the snapshot repository.
await runSearchSmoke(elasticsearch, {
  createUser: "PUT /_security/user/rogue",
  createUserBody: `{"password":"rogue-pw-123","roles":["superuser"]}`,
  grantSelf: "PUT /_security/role/kuzey_app_role",
  grantSelfBody: `{"cluster":["all"],"indices":[{"names":["*"],"privileges":["all"]}]}`,
  ownPassword: "POST /_security/user/_password",
  ownPasswordBody: () => `{"password":"changed-by-agent-1"}`,
});
