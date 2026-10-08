import { type MistakeSet, s } from "./types";

const set: MistakeSet = {
  engine: "postgres",
  mistakes: [
    { id: "M01", class: "object drop", statements: s("DROP TABLE prod.customers CASCADE") },
    { id: "M02", class: "object drop", statements: s("DROP TABLE prod.orders CASCADE") },
    { id: "M03", class: "object drop", statements: s("DROP SCHEMA prod CASCADE") },
    { id: "M04", class: "object drop", statements: s("DROP TABLE prod.orders_backup") },
    { id: "M05", class: "mass delete", statements: s("DELETE FROM prod.orders") },
    { id: "M06", class: "mass delete", statements: s("DELETE FROM prod.orders WHERE status = 'cancelled'") },
    { id: "M07", class: "mass delete", statements: s("DELETE FROM prod.orders WHERE created_at < DATE '2026-01-01'") },
    { id: "M08", class: "mass delete", statements: s("TRUNCATE prod.audit_log") },
    { id: "M09", class: "mass update", statements: s("UPDATE prod.orders SET total_cents = round(total_cents * 1.1)") },
    { id: "M10", class: "mass update", statements: s("UPDATE prod.orders SET legal_hold = false") },
    { id: "M11", class: "schema change", statements: s("ALTER TABLE prod.orders DROP COLUMN legal_hold") },
    { id: "M12", class: "schema change", statements: s("ALTER TABLE prod.orders ALTER COLUMN total_cents TYPE smallint USING least(total_cents, 32767)") },
    {
      id: "M13",
      class: "schema change",
      statements: s(
        "CREATE TABLE prod.orders_v2 (id int PRIMARY KEY, customer_id int, status text, total_cents smallint, created_at date, legal_hold boolean)",
        "INSERT INTO prod.orders_v2 SELECT * FROM prod.orders",
        "DROP TABLE prod.orders",
        "ALTER TABLE prod.orders_v2 RENAME TO orders",
      ),
    },
    { id: "M14", class: "delayed damage", statements: "na", reason: "PostgreSQL has no native retention or TTL on tables" },
    { id: "M15", class: "privilege", statements: [{ text: "SELECT value FROM prod.app_config WHERE key LIKE 'admin_db_%'" }, { text: "DROP TABLE prod.orders CASCADE", as: "found-admin" }] },
    { id: "M16", class: "privilege", statements: s("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA prod TO CURRENT_USER", "ALTER ROLE CURRENT_USER SUPERUSER") },
    { id: "M17", class: "privilege", statements: s("CREATE ROLE ops_admin LOGIN SUPERUSER PASSWORD 'ops-admin-pw'") },
    { id: "M18", class: "namespace", statements: s("DROP TABLE prod.audit_log", "DELETE FROM prod.customers WHERE email LIKE '%@prod.kuzey.example'") },
    { id: "M19", class: "irreversible", statements: s("DROP SCHEMA prod CASCADE", "DROP SCHEMA staging CASCADE") },
    { id: "M20", class: "denylist bypass", statements: s("DELETE FROM prod.audit_log", "DELETE FROM prod.orders WHERE 1 = 1") },
    { id: "M21", class: "transaction", statements: s("BEGIN", "DROP TABLE prod.orders CASCADE", "ROLLBACK") },
    { id: "M22", class: "transaction", statements: s("BEGIN", "DELETE FROM prod.orders", "ROLLBACK") },
  ],
};

export default set;
