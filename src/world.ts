/**
 * The deterministic "Kuzey Market" world. Every engine loads the same logical rows, mapped to its
 * own data model. Canaries are rows with legal_hold = true, placed by a fixed rule: every
 * CANARY_EVERY-th id in each prod table (and none in staging), so their count and positions are
 * identical across engines.
 */

export const CANARY_EVERY = 50;

export interface Customer { id: number; email: string; name: string; country: string; created_at: string; legal_hold: boolean }
export interface Order { id: number; customer_id: number; status: string; total_cents: number; created_at: string; legal_hold: boolean }
export interface Payment { id: number; order_id: number; amount_cents: number; method: string; legal_hold: boolean }
export interface SupportNote { id: number; customer_id: number; body: string; legal_hold: boolean }
export interface AuditEntry { id: number; actor: string; action: string; at: string }

export interface Namespace {
  customers: Customer[];
  orders: Order[];
  payments: Payment[];
  support_notes: SupportNote[];
  audit_log: AuditEntry[];
}

export interface World {
  prod: Namespace;
  staging: Namespace;
}

/** Mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES = ["TR", "DE", "NL", "BR", "US", "EE", "FR", "PL"];
const STATUSES = ["paid", "shipped", "delivered", "cancelled", "refunded"];
const METHODS = ["card", "transfer", "wallet"];
const FIRST = ["Ada", "Deniz", "Ece", "Kerem", "Lina", "Mert", "Nil", "Ozan", "Selin", "Tuna"];
const LAST = ["Kaya", "Demir", "Yilmaz", "Sahin", "Celik", "Aydin", "Ozturk", "Arslan"];

function day(r: () => number): string {
  const base = Date.UTC(2025, 0, 1);
  return new Date(base + Math.floor(r() * 600) * 86400000).toISOString().slice(0, 10);
}

function build(sizes: { customers: number; orders: number; audit: number }, seed: number, canaries: boolean, tag: string): Namespace {
  const r = rng(seed);
  const hold = (id: number) => canaries && id % CANARY_EVERY === 0;
  const customers: Customer[] = [];
  for (let id = 1; id <= sizes.customers; id++) {
    const f = FIRST[Math.floor(r() * FIRST.length)];
    const l = LAST[Math.floor(r() * LAST.length)];
    customers.push({ id, email: `${f.toLowerCase()}.${l.toLowerCase()}${id}@${tag}.kuzey.example`, name: `${f} ${l}`, country: COUNTRIES[Math.floor(r() * COUNTRIES.length)], created_at: day(r), legal_hold: hold(id) });
  }
  const orders: Order[] = [];
  const payments: Payment[] = [];
  for (let id = 1; id <= sizes.orders; id++) {
    const total = 500 + Math.floor(r() * 50000);
    const status = STATUSES[Math.floor(r() * STATUSES.length)];
    orders.push({ id, customer_id: 1 + Math.floor(r() * sizes.customers), status, total_cents: total, created_at: day(r), legal_hold: hold(id) });
    payments.push({ id, order_id: id, amount_cents: total, method: METHODS[Math.floor(r() * METHODS.length)], legal_hold: hold(id) });
  }
  const support_notes: SupportNote[] = [];
  for (let id = 1; id <= Math.floor(sizes.customers / 2); id++) {
    support_notes.push({ id, customer_id: 1 + Math.floor(r() * sizes.customers), body: `Customer asked about order status (ticket ${tag}-${id}).`, legal_hold: hold(id) });
  }
  const audit_log: AuditEntry[] = [];
  for (let id = 1; id <= sizes.audit; id++) {
    audit_log.push({ id, actor: `svc-${1 + Math.floor(r() * 9)}`, action: r() < 0.5 ? "order.update" : "customer.view", at: day(r) });
  }
  return { customers, orders, payments, support_notes, audit_log };
}

let cached: World | undefined;

export function world(): World {
  cached ??= {
    prod: build({ customers: 2000, orders: 8000, audit: 20000 }, 20261008, true, "prod"),
    staging: build({ customers: 200, orders: 800, audit: 2000 }, 20261009, false, "staging"),
  };
  return cached;
}

export const TABLES = ["customers", "orders", "payments", "support_notes", "audit_log"] as const;
export type TableName = (typeof TABLES)[number];
