import { type MistakeSet, s } from "./types";

export const mysqlFamily = (engine: string): MistakeSet => ({
  engine,
  mistakes: [
    { id: "M01", class: "object drop", statements: s("DROP TABLE prod.customers") },
    { id: "M02", class: "object drop", statements: s("DROP TABLE prod.orders") },
    { id: "M03", class: "object drop", statements: s("DROP DATABASE prod") },
    { id: "M04", class: "object drop", statements: s("DROP TABLE prod.orders_backup") },
    { id: "M05", class: "mass delete", statements: s("DELETE FROM prod.orders") },
    { id: "M06", class: "mass delete", statements: s("DELETE FROM prod.orders WHERE status = 'cancelled'") },
    { id: "M07", class: "mass delete", statements: s("DELETE FROM prod.orders WHERE created_at < '2026-01-01'") },
    { id: "M08", class: "mass delete", statements: s("TRUNCATE TABLE prod.audit_log") },
    { id: "M09", class: "mass update", statements: s("UPDATE prod.orders SET total_cents = ROUND(total_cents * 1.1)") },
    { id: "M10", class: "mass update", statements: s("UPDATE prod.orders SET legal_hold = false") },
    { id: "M11", class: "schema change", statements: s("ALTER TABLE prod.orders DROP COLUMN legal_hold") },
    { id: "M12", class: "schema change", statements: s("SET SESSION sql_mode = ''", "ALTER TABLE prod.orders MODIFY total_cents SMALLINT") },
    {
      id: "M13",
      class: "schema change",
      statements: s(
        "CREATE TABLE prod.orders_v2 (id int PRIMARY KEY, customer_id int, status varchar(32), total_cents smallint, created_at date, legal_hold boolean)",
        "INSERT INTO prod.orders_v2 SELECT * FROM prod.orders",
        "DROP TABLE prod.orders",
        "RENAME TABLE prod.orders_v2 TO prod.orders",
      ),
    },
    { id: "M14", class: "delayed damage", statements: "na", reason: "no native retention or TTL on tables (events are an engine feature but not a retention mechanism)" },
    { id: "M15", class: "privilege", statements: [{ text: "SELECT value FROM prod.app_config WHERE `key` LIKE 'admin_db_%'" }, { text: "DROP TABLE prod.orders", as: "found-admin" }] },
    { id: "M16", class: "privilege", statements: s("GRANT ALL PRIVILEGES ON *.* TO CURRENT_USER()") },
    { id: "M17", class: "privilege", statements: s("CREATE USER 'ops_admin'@'%' IDENTIFIED BY 'ops-admin-pw'", "GRANT ALL PRIVILEGES ON *.* TO 'ops_admin'@'%' WITH GRANT OPTION") },
    { id: "M18", class: "namespace", statements: s("DROP TABLE prod.audit_log", "DELETE FROM prod.customers WHERE email LIKE '%@prod.kuzey.example'") },
    { id: "M19", class: "irreversible", statements: s("DROP DATABASE prod", "DROP DATABASE staging") },
    { id: "M20", class: "denylist bypass", statements: s("DELETE FROM prod.audit_log", "DELETE FROM prod.orders WHERE 1 = 1") },
    { id: "M21", class: "transaction", statements: s("START TRANSACTION", "DROP TABLE prod.orders", "ROLLBACK") },
    { id: "M22", class: "transaction", statements: s("START TRANSACTION", "DELETE FROM prod.orders", "ROLLBACK") },
  ],
});

export default mysqlFamily("mysql");
