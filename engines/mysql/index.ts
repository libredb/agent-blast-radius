import { mysqlFamily } from "./family";

/** MySQL 9.7 LTS (manifest/images.tsv). Binary logging is on by default, so R1 adds no server flag. */
export const mysqlEngine = mysqlFamily({
  id: "mysql",
  port: 47020,
  rootPasswordEnv: "MYSQL_ROOT_PASSWORD",
  r1Args: [],
  isMariaDB: false,
});

export default mysqlEngine;
