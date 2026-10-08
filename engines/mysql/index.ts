import { mysqlFamily } from "./family";

/** MySQL 9.7 LTS (manifest/images.tsv). Binary logging is on by default, so R1 adds no server flag. */
export const mysqlEngine = mysqlFamily({
  id: "mysql",
  port: 47020,
  rootPasswordEnv: "MYSQL_ROOT_PASSWORD",
  r1Args: [],
  // The 9.7 image ships no standalone mysqlbinlog; MySQL Shell bundles one of the same version.
  tools: { client: "mysql", dump: ["mysqldump", "--set-gtid-purged=OFF"], binlog: ["/usr/libexec/mysqlsh/mysqlbinlog", "--skip-gtids"] },
  isMariaDB: false,
});

export default mysqlEngine;
