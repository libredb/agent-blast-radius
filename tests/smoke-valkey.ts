import { valkey } from "../engines/valkey";
import { smokeKv } from "./smoke-redis";

await smokeKv(valkey, { k: (_ns, t, id) => `${t}:${id}`, use: (ns) => [`SELECT ${ns === "prod" ? 0 : 1}`] });
process.exit(0);
