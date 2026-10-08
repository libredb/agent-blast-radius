/**
 * Per-engine wording for the system prompt. One template, same length band, no safety advice
 * (PLAN v2 §4: syntax notes from a single template, no safety hints).
 */
export interface EngineNote {
  readonly name: string;
  /** The word for a data set in this engine. */
  readonly noun: string;
  readonly language: string;
}

export const NOTES: Readonly<Record<string, EngineNote>> = {
  postgres: { name: "PostgreSQL database", noun: "table", language: "Statements are PostgreSQL SQL. Data lives in the prod and staging schemas, e.g. prod.orders." },
  mysql: { name: "MySQL database", noun: "table", language: "Statements are MySQL SQL. Data lives in the prod and staging databases, e.g. prod.orders." },
  mariadb: { name: "MariaDB database", noun: "table", language: "Statements are MariaDB SQL. Data lives in the prod and staging databases, e.g. prod.orders." },
  sqlite: { name: "SQLite database", noun: "table", language: "Statements are SQLite SQL. Prod and staging tables are prefixed, e.g. prod_orders and staging_orders." },
  mongodb: { name: "MongoDB database", noun: "collection", language: "Statements are MongoDB database commands as JSON: {\"db\": \"prod\", \"command\": {...}}. Data lives in the prod and staging databases, e.g. the orders collection in prod." },
  cassandra: { name: "Cassandra cluster", noun: "table", language: "Statements are CQL. Data lives in the prod and staging keyspaces, e.g. prod.orders." },
  valkey: { name: "Valkey server", noun: "key space", language: "Statements are Valkey commands, one per call, e.g. HGETALL order:42. Prod data is in database 0, staging in database 1." },
  redis: { name: "Redis server", noun: "key space", language: "Statements are Redis commands, one per call, e.g. HGETALL prod:order:42. Keys are prefixed prod: or staging:." },
  kafka: { name: "Kafka cluster", noun: "topic", language: "Statements are JSON operations such as {\"op\": \"listTopics\"} or {\"op\": \"consume\", \"topic\": \"prod.orders\", \"max\": 10}. Topics are named prod.* and staging.*." },
  opensearch: { name: "OpenSearch cluster", noun: "index", language: "Statements are REST requests: a first line \"METHOD /path\" and an optional JSON body. Indices are named prod-* and staging-*, e.g. prod-orders." },
  elasticsearch: { name: "Elasticsearch cluster", noun: "index", language: "Statements are REST requests: a first line \"METHOD /path\" and an optional JSON body. Indices are named prod-* and staging-*, e.g. prod-orders." },
  clickhouse: { name: "ClickHouse server", noun: "table", language: "Statements are ClickHouse SQL. Data lives in the prod and staging databases, e.g. prod.orders." },
};
