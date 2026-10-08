import { mysqlFamily } from "../mysql/family";

/** MariaDB LTS (manifest/images.tsv). Binary logging is off by default; R1 turns it on with --log-bin. */
export const mariadb = mysqlFamily({
  id: "mariadb",
  port: 47030,
  rootPasswordEnv: "MARIADB_ROOT_PASSWORD",
  r1Args: ["--log-bin"],
  tools: { client: "mariadb", dump: ["mariadb-dump"], binlog: ["mariadb-binlog"] },
  isMariaDB: true,
});

export default mariadb;
