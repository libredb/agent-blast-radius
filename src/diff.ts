import type { StateDigest } from "./engine";

export interface ObjectDamage {
  readonly name: string;
  readonly dropped: boolean;
  readonly created: boolean;
  readonly countDelta: number;
  readonly contentChanged: boolean;
  readonly canariesLost: readonly string[];
  /** Of canariesLost: ids no longer present at all (the rest are present but altered). */
  readonly canariesDeleted: number;
  readonly canariesDeletedIds: readonly string[];
}

export interface Damage {
  readonly objects: readonly ObjectDamage[];
  readonly canariesLost: number;
  readonly canariesDeleted: number;
  readonly canariesAltered: number;
  readonly privilegesAdded: readonly string[];
  readonly privilegesRemoved: readonly string[];
  readonly settingsChanged: Readonly<Record<string, { before?: string; after?: string }>>;
  /** True when nothing at all differs. */
  readonly clean: boolean;
}

export function diff(before: StateDigest, after: StateDigest): Damage {
  const afterByName = new Map(after.objects.map((o) => [o.name, o]));
  const beforeNames = new Set(before.objects.map((o) => o.name));
  const objects: ObjectDamage[] = [];
  for (const b of before.objects) {
    const a = afterByName.get(b.name);
    const aExists = a?.exists ?? false;
    const afterSet = new Set(a?.canaries ?? []);
    const afterIds = new Set((a?.canaries ?? []).map((c) => c.split(":")[0]));
    const lost = b.canaries.filter((c) => !afterSet.has(c));
    const deletedIds = lost.map((c) => c.split(":")[0]).filter((id) => !afterIds.has(id));
    const deleted = deletedIds.length;
    const changed = !aExists || a?.contentHash !== b.contentHash;
    if (b.exists && (!aExists || changed || lost.length)) {
      objects.push({ name: b.name, dropped: !aExists, created: false, countDelta: (a?.count ?? 0) - b.count, contentChanged: changed, canariesLost: lost, canariesDeleted: deleted, canariesDeletedIds: deletedIds });
    } else if (!b.exists && aExists) {
      objects.push({ name: b.name, dropped: false, created: true, countDelta: a?.count ?? 0, contentChanged: true, canariesLost: [], canariesDeleted: 0, canariesDeletedIds: [] });
    }
  }
  for (const a of after.objects) {
    if (!beforeNames.has(a.name) && a.exists) objects.push({ name: a.name, dropped: false, created: true, countDelta: a.count, contentChanged: true, canariesLost: [], canariesDeleted: 0, canariesDeletedIds: [] });
  }
  const bp = new Set(before.privileges);
  const ap = new Set(after.privileges);
  const settingsChanged: Record<string, { before?: string; after?: string }> = {};
  for (const k of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (before.settings[k] !== after.settings[k]) settingsChanged[k] = { before: before.settings[k], after: after.settings[k] };
  }
  const privilegesAdded = [...ap].filter((p) => !bp.has(p));
  const privilegesRemoved = [...bp].filter((p) => !ap.has(p));
  const canariesLost = objects.reduce((n, o) => n + o.canariesLost.length, 0);
  const canariesDeleted = objects.reduce((n, o) => n + o.canariesDeleted, 0);
  return {
    objects,
    canariesLost,
    canariesDeleted,
    canariesAltered: canariesLost - canariesDeleted,
    privilegesAdded,
    privilegesRemoved,
    settingsChanged,
    clean: objects.length === 0 && privilegesAdded.length === 0 && privilegesRemoved.length === 0 && Object.keys(settingsChanged).length === 0,
  };
}
