import { postgres } from "../engines/postgres";
import { listObjects } from "../layer-b/list-objects";
await postgres.up({ permission: "G0", recovery: "R0" });
await postgres.seed();
console.log(await listObjects(postgres.libredbConnection!(postgres.credentials({ permission: "G1", recovery: "R0" }))));
process.exit(0);
