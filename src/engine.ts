/**
 * The contract every engine module implements. See ARCHITECTURE.md.
 */

export type PermissionArm = "G0" | "G1" | "G2" | "G1G2";
export type RecoveryArm = "R0" | "R1";
export interface Arms {
  readonly permission: PermissionArm;
  readonly recovery: RecoveryArm;
}

export interface Credentials {
  readonly user?: string;
  readonly password?: string;
  /** Free-form extra fields an engine needs (e.g. SASL mechanism). */
  readonly extra?: Readonly<Record<string, string>>;
}

export interface RunResult {
  readonly ok: boolean;
  /** Rows/documents/values returned, already truncated by the session. */
  readonly output: string;
  /** Engine error text when ok is false. */
  readonly error?: string;
  /** Engine error code when the driver exposes one (e.g. SQLSTATE). */
  readonly code?: string;
  readonly ms: number;
}

export interface Session {
  run(statement: string): Promise<RunResult>;
  close(): Promise<void>;
}

/** One logical object (table, collection, keyspace prefix, index, topic). */
export interface ObjectState {
  readonly name: string;
  readonly exists: boolean;
  /** Rows / documents / keys / messages. */
  readonly count: number;
  /** Order-independent content hash; equal iff content equal (for our seeded data). */
  readonly contentHash: string;
  /** Canary ids still present in this object. */
  readonly canaries: readonly string[];
}

export interface StateDigest {
  readonly engine: string;
  readonly takenAt: string;
  readonly objects: readonly ObjectState[];
  /** Sorted, normalised description of principals and their privileges. */
  readonly privileges: readonly string[];
  /** Settings that can cause delayed damage (retention, TTL, pending mutations...). */
  readonly settings: Readonly<Record<string, string>>;
}

export interface RecoveryOutcome {
  readonly attempted: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly needsRebuild?: boolean;
}

export interface EngineModule {
  readonly id: string;
  /** Start containers for the given arms; must be idempotent. */
  up(arms: Arms): Promise<void>;
  down(): Promise<void>;
  /** Load the golden world; called once per container lifetime. */
  seed(): Promise<void>;
  snapshot(): Promise<StateDigest>;
  /** Return to the golden state; must make snapshot() equal the golden digest. */
  reset(): Promise<void>;
  credentials(arms: Arms): Credentials;
  session(creds: Credentials): Promise<Session>;
  /**
   * Called right before a mistake (Layer A) or a trial (Layer B) in R1: returns an opaque marker of
   * "the moment before", e.g. a WAL LSN or a timestamp, that recover() restores to.
   */
  recoveryPoint?(arms: Arms): Promise<string | undefined>;
  /**
   * Engine-native recovery attempt after damage, no external backup unless the arm is R1. May leave
   * the engine in a state that needs down()/up()/seed() before the next trial; it says so by
   * returning `needsRebuild: true` in any outcome.
   */
  recover(arms: Arms, before: StateDigest, point?: string): Promise<RecoveryOutcome[]>;
  /**
   * Optional: the LibreDB 0.18.0 connection object (type, host, port, user, password, database...)
   * the list_objects tool uses to inventory this engine as the given identity.
   */
  libredbConnection?(creds: Credentials): Record<string, unknown>;
}
