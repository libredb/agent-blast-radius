import { mariadb as e } from "../engines/mariadb";
import { smokeMysqlFamily } from "../engines/mysql/smoke-family";

const recovery = process.argv[2] === "R1" ? "R1" : "R0";
let failed = 0;
try {
  failed = await smokeMysqlFamily(e, recovery);
} finally {
  if (!process.env.ABR_KEEP) await e.down();
}
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
