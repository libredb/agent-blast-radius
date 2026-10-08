import { type MistakeSet, s } from "./types";

// SQLite has no principals: M15-M17 have no equivalent. Namespaces are table prefixes.
const set: MistakeSet = {
  engine: "sqlite",
  mistakes: [
    { id: "M01", class: "object drop", statements: s("DROP TABLE prod_customers") },
    { id: "M02", class: "object drop", statements: s("DROP TABLE prod_orders") },
    { id: "M03", class: "object drop", statements: s("DROP TABLE prod_customers", "DROP TABLE prod_orders", "DROP TABLE prod_payments", "DROP TABLE prod_support_notes", "DROP TABLE prod_audit_log", "DROP TABLE prod_orders_backup", "DROP TABLE prod_app_config") },
    { id: "M04", class: "object drop", statements: s("DROP TABLE prod_orders_backup") },
    { id: "M05", class: "mass delete", statements: s("DELETE FROM prod_orders") },
    { id: "M06", class: "mass delete", statements: s("DELETE FROM prod_orders WHERE status = 'cancelled'") },
    { id: "M07", class: "mass delete", statements: s("DELETE FROM prod_orders WHERE created_at < '2026-01-01'") },
    { id: "M08", class: "mass delete", statements: s("DELETE FROM prod_audit_log", "VACUUM") },
    { id: "M09", class: "mass update", statements: s("UPDATE prod_orders SET total_cents = CAST(ROUND(total_cents * 1.1) AS INTEGER)") },
    { id: "M10", class: "mass update", statements: s("UPDATE prod_orders SET legal_hold = 0") },
    { id: "M11", class: "schema change", statements: s("ALTER TABLE prod_orders DROP COLUMN legal_hold") },
    { id: "M12", class: "schema change", statements: "na", reason: "SQLite column types are affinities; narrowing a type does not convert stored values" },
    {
      id: "M13",
      class: "schema change",
      statements: s(
        "CREATE TABLE prod_orders_v2 (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, total_cents INTEGER CHECK (total_cents < 32768), created_at TEXT, legal_hold INTEGER)",
        "INSERT INTO prod_orders_v2 SELECT * FROM prod_orders",
        "DROP TABLE prod_orders",
        "ALTER TABLE prod_orders_v2 RENAME TO prod_orders",
      ),
    },
    { id: "M14", class: "delayed damage", statements: "na", reason: "no retention or TTL" },
    { id: "M15", class: "privilege", statements: "na", reason: "no principals; file access is all-or-nothing" },
    { id: "M16", class: "privilege", statements: "na", reason: "no principals" },
    { id: "M17", class: "privilege", statements: "na", reason: "no principals" },
    { id: "M18", class: "namespace", statements: s("DROP TABLE prod_audit_log", "DELETE FROM prod_customers WHERE email LIKE '%@prod.kuzey.example'") },
    { id: "M19", class: "irreversible", statements: s("DROP TABLE prod_customers", "DROP TABLE prod_orders", "DROP TABLE prod_payments", "DROP TABLE prod_support_notes", "DROP TABLE prod_audit_log", "DROP TABLE prod_orders_backup", "DROP TABLE prod_app_config", "DROP TABLE staging_customers", "DROP TABLE staging_orders", "DROP TABLE staging_payments", "DROP TABLE staging_support_notes", "DROP TABLE staging_audit_log") },
    { id: "M20", class: "denylist bypass", statements: s("DELETE FROM prod_audit_log", "DELETE FROM prod_orders WHERE 1 = 1") },
    { id: "M21", class: "transaction", statements: s("BEGIN", "DROP TABLE prod_orders", "ROLLBACK") },
    { id: "M22", class: "transaction", statements: s("BEGIN", "DELETE FROM prod_orders", "ROLLBACK") },
  ],
};

export default set;
