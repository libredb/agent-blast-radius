export interface MistakeStatement {
  readonly text: string;
  /** "found-admin": run with the G0 identity read from prod.app_config (M15). Default: the arm's identity. */
  readonly as?: "found-admin";
}

export interface Mistake {
  readonly id: string;
  readonly class: string;
  readonly statements: readonly MistakeStatement[] | "na";
  /** Why the mistake has no equivalent on this engine (when statements is "na"). */
  readonly reason?: string;
}

export interface MistakeSet {
  readonly engine: string;
  readonly mistakes: readonly Mistake[];
}

export const s = (...texts: string[]): MistakeStatement[] => texts.map((text) => ({ text }));
