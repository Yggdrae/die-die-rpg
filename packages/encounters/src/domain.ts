import { EMPTY_TARGET_STATE, type TargetState } from '@rpg/actions/engine';
import { displayNameField, initialCharacterState, type SheetEdit } from '@rpg/characters';
import { err, ok, type Result } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';
import {
  type EncounterRecord,
  MAX_ENVIRONMENT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PARTICIPANTS_PER_ADD,
  type ParticipantRecord,
} from './records.ts';

/**
 * Feature 19 pure model (`_techspec.md` "Device"): instance labels (D-04), the public split of an instance state
 * (D-05), controls from declarations (D-07), and the encounter's change rules (D-10). Nothing here reads a system's
 * identity: every answer comes from what the package declares (`PRD.md` s.89).
 */

/* -------------------------------------------------------------------------- */
/* Labels (D-04)                                                              */
/* -------------------------------------------------------------------------- */

function numbered(label: string, base: string): number | undefined {
  if (label === base) return 0;
  if (!label.startsWith(`${base} `)) return undefined;
  const rest = label.slice(base.length + 1);
  return /^[1-9]\d{0,3}$/.test(rest) ? Number(rest) : undefined;
}

/**
 * `count` labels for `base`: the base itself when it is new and alone, else `Base N` continuing after the highest
 * number present, so three bandits are Bandit 1, 2, and 3, and a fourth added later is Bandit 4.
 */
export function instanceLabels(
  existing: readonly string[],
  base: string,
  count: number,
): Result<readonly string[], 'invalid_label' | 'invalid_count'> {
  const trimmed = base.trim().replace(/\s+/g, ' ');
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PARTICIPANTS_PER_ADD) {
    return err('invalid_count');
  }
  if (trimmed === '' || trimmed.length > MAX_NAME_LENGTH - 5) return err('invalid_label');
  const taken = existing.flatMap((label) => {
    const n = numbered(label, trimmed);
    return n === undefined ? [] : [n];
  });
  if (taken.length === 0 && count === 1) return ok([trimmed]);
  const start = taken.length === 0 ? 1 : Math.max(1, ...taken) + 1;
  return ok(Array.from({ length: count }, (_, index) => `${trimmed} ${start + index}`));
}

/* -------------------------------------------------------------------------- */
/* Instance state (D-02, D-05)                                                */
/* -------------------------------------------------------------------------- */

/** Conditions a package declares `everyone`: the only part of an instance a player may hold. */
export function isPublicConditionPath(system: SystemPackage, path: string): boolean {
  const [root, key, extra] = path.split('.');
  return (
    root === 'conditions' &&
    extra === undefined &&
    system.mechanics.conditions.some((item) => item.key === key && item.visibility === 'everyone')
  );
}

const ROOTS = ['fields', 'resources', 'tracks', 'conditions', 'inventory', 'slots', 'entries'];

/** An instance state split into its public conditions (participant row) and the rest (`gm_only` state row). */
export function splitInstanceState(
  system: SystemPackage,
  state: TargetState,
): { readonly conditions: Readonly<Record<string, number>>; readonly secret: TargetState } {
  const conditions: Record<string, number> = {};
  const secret: Record<string, Record<string, unknown>> = {};
  for (const root of ROOTS) {
    const node =
      (state as unknown as Record<string, Record<string, unknown> | undefined>)[root] ?? {};
    secret[root] = {};
    for (const [key, value] of Object.entries(node)) {
      if (isPublicConditionPath(system, `${root}.${key}`) && typeof value === 'number') {
        conditions[key] = value;
      } else {
        (secret[root] as Record<string, unknown>)[key] = value;
      }
    }
  }
  return { conditions, secret: secret as unknown as TargetState };
}

/** The two rows read back as one state. */
export function mergeInstanceState(
  conditions: Readonly<Record<string, number>>,
  secret: TargetState | undefined,
): TargetState {
  const base = secret ?? EMPTY_TARGET_STATE;
  return { ...base, conditions: { ...base.conditions, ...conditions } };
}

/** D-02: an instance starts as the pinned package's new character, named by its label. */
export function initialInstance(system: SystemPackage, label: string) {
  return splitInstanceState(system, initialCharacterState(system, label));
}

/* -------------------------------------------------------------------------- */
/* Controls (D-07)                                                            */
/* -------------------------------------------------------------------------- */

export interface ControlButton {
  readonly label: string;
  readonly edit: SheetEdit;
  readonly pressed?: boolean;
}

export interface ParticipantControl {
  readonly key: string;
  readonly label: string;
  readonly buttons: readonly ControlButton[];
}

export interface ConditionControl {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly add: SheetEdit;
  readonly remove: SheetEdit;
}

/**
 * The tracker's one-interaction controls (FR-006): for each declared summary field, `-1`/`+1` on a pool, number, or
 * counter, and a toggle per box of a track. GM-only fields are left to the GM's sheet when `mayEditGmOnly` is false.
 */
export function participantControls(
  system: SystemPackage,
  state: TargetState,
): readonly ParticipantControl[] {
  const nameKey = displayNameField(system);
  return system.characterSchema.summaryFields.flatMap((key): ParticipantControl[] => {
    if (key === nameKey) return [];
    const field = system.characterSchema.fields.find((candidate) => candidate.key === key);
    if (field === undefined || field.gmOnly === true) return [];
    if (field.type === 'number' || field.type === 'counter') {
      return [
        {
          key,
          label: field.label,
          buttons: [
            { label: '-1', edit: { kind: 'adjust_field', field: key, by: -1 } },
            { label: '+1', edit: { kind: 'adjust_field', field: key, by: 1 } },
          ],
        },
      ];
    }
    if (field.type !== 'resource') return [];
    const resource = system.resources.find((item) => item.key === field.resourceKey);
    if (resource === undefined || resource.visibility === 'gm_only') return [];
    if (resource.shape === 'pool') {
      return [
        {
          key,
          label: field.label,
          buttons: [
            { label: '-1', edit: { kind: 'adjust_resource', resource: resource.key, by: -1 } },
            { label: '+1', edit: { kind: 'adjust_resource', resource: resource.key, by: 1 } },
          ],
        },
      ];
    }
    return [
      {
        key,
        label: field.label,
        buttons: resource.boxes.map((box) => ({
          label: box.label,
          pressed: state.tracks[resource.key]?.[box.id] === true,
          edit: { kind: 'toggle_box', resource: resource.key, box: box.id },
        })),
      },
    ];
  });
}

/** Every declared condition with its count (D-06). `publicOnly` keeps the ones a player may see. */
export function conditionControls(
  system: SystemPackage,
  state: TargetState,
  publicOnly = false,
): readonly ConditionControl[] {
  return system.mechanics.conditions
    .filter((item) => !publicOnly || item.visibility === 'everyone')
    .map((item) => ({
      key: item.key,
      label: item.label,
      count: Number(state.conditions[item.key] ?? 0),
      add: { kind: 'adjust_condition', condition: item.key, by: 1 },
      remove: { kind: 'adjust_condition', condition: item.key, by: -1 },
    }));
}

/** The conditions present on a participant, by label, from the state this device holds. */
export function activeConditions(
  system: SystemPackage,
  conditions: Readonly<Record<string, number>>,
): readonly string[] {
  return system.mechanics.conditions.flatMap((item) => {
    const count = Number(conditions[item.key] ?? 0);
    if (count <= 0) return [];
    return [count > 1 ? `${item.label} ×${count}` : item.label];
  });
}

/* -------------------------------------------------------------------------- */
/* Encounter changes (D-10)                                                   */
/* -------------------------------------------------------------------------- */

export type EncounterChange =
  | { readonly kind: 'environment'; readonly environment: string; readonly locationId?: string }
  | { readonly kind: 'end' };

export type EncounterChangeError = 'ended' | 'too_long';

export function changeEncounter(
  current: EncounterRecord,
  change: EncounterChange,
  now: string,
): Result<EncounterRecord, EncounterChangeError> {
  if (current.status === 'ended') return err('ended');
  if (change.kind === 'end') {
    const endedAt = Date.parse(now) < Date.parse(current.startedAt) ? current.startedAt : now;
    return ok({ ...current, status: 'ended', endedAt });
  }
  if (change.environment.length > MAX_ENVIRONMENT_LENGTH) return err('too_long');
  const { locationId: _old, ...rest } = current;
  return ok({
    ...rest,
    environment: change.environment,
    ...(change.locationId === undefined ? {} : { locationId: change.locationId }),
  });
}

/** What an authority update changes; anything outside D-10 is invalid. */
export function classifyEncounterUpdate(
  current: EncounterRecord,
  next: EncounterRecord,
): Result<'ended' | 'details' | 'none', 'invalid'> {
  if (current.status === 'ended') return err('invalid');
  const fixed: (keyof EncounterRecord)[] = ['name', 'sessionId', 'startedAt', 'campaignId'];
  if (fixed.some((key) => current[key] !== next[key])) return err('invalid');
  if (next.status === 'ended') return ok('ended');
  if (next.endedAt !== undefined) return err('invalid');
  return ok(
    current.environment !== next.environment || current.locationId !== next.locationId
      ? 'details'
      : 'none',
  );
}

/** The open encounters first, newest first: what the tracker shows. */
export function orderEncounters(records: readonly EncounterRecord[]): EncounterRecord[] {
  return [...records].sort(
    (left, right) =>
      Number(left.status === 'ended') - Number(right.status === 'ended') ||
      right.startedAt.localeCompare(left.startedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function orderParticipants(records: readonly ParticipantRecord[]): ParticipantRecord[] {
  return [...records].sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}
