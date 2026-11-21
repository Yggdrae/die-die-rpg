import type { SessionQuickAction } from '@rpg/contracts';
import {
  type ContextEntity,
  type LogLine,
  matchPalette,
  type PaletteItem,
  type SessionRecord,
  type SessionStatus,
  scenesOf,
} from '@rpg/sessions';

/** Pure view helpers for Session Mode: labels, log text, and the palette's entries (D-12). */

export function statusLabel(status: SessionStatus): string {
  return status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Ended';
}

/** Wall-clock time of an instant, as the table reads it. */
export function timeText(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const STATUS_TEXT: Record<string, string> = {
  started: 'Session started',
  paused: 'Session paused',
  resumed: 'Session resumed',
  ended: 'Session ended',
};

/**
 * One log line as text. Names come from what this device holds, so a scene or a handout the device may not see is
 * never named (D-10).
 */
export function logLineText(line: LogLine, names: ReadonlyMap<string, string>): string {
  switch (line.kind) {
    case 'roll':
      return `${line.roll.name}: ${line.roll.result.modified}`;
    case 'effect':
      return `Applied ${line.effect.name}`;
    case 'entry': {
      const { entry } = line;
      const subject = entry.subjectId === undefined ? undefined : names.get(entry.subjectId);
      switch (entry.kind) {
        case 'note':
          return entry.text;
        case 'status':
          return STATUS_TEXT[entry.text] ?? 'Session changed';
        case 'scene':
          return subject === undefined ? 'The scene changed' : `Scene: ${subject}`;
        case 'reveal':
          return subject === undefined ? 'Revealed content' : `Revealed ${subject}`;
      }
    }
  }
}

/** Whether a log line is GM-only on this device (shown with a marker, never sent anywhere). */
export function gmOnlyLine(line: LogLine): boolean {
  if (line.kind === 'entry') return line.entry.visibility.mode === 'gm_only';
  if (line.kind === 'roll') return line.roll.visibility.mode === 'gm_only';
  return false;
}

/** D-11: an action shows when it needs nothing, or the pinned system declares what it needs. */
export function availableActions(
  actions: readonly SessionQuickAction[],
  capabilities: readonly string[],
): SessionQuickAction[] {
  return actions.filter(
    (action) => action.capability === undefined || capabilities.includes(action.capability),
  );
}

export type PaletteRun =
  | { readonly kind: 'quick'; readonly action: SessionQuickAction }
  | { readonly kind: 'pause' | 'resume' | 'end' }
  | { readonly kind: 'scene'; readonly sceneId: string }
  | { readonly kind: 'lookup'; readonly entityId: string }
  | { readonly kind: 'note'; readonly text: string }
  | { readonly kind: 'provided'; readonly subjectId?: string; readonly open?: () => void };

export interface PaletteEntry extends PaletteItem {
  readonly run: PaletteRun;
}

/** One entry a provider offers (D-12): `subjectId` names the record, `open` shows it in its own view. */
export interface ProvidedPaletteEntry extends PaletteItem {
  readonly subjectId?: string;
  open?(): void;
}

/**
 * D-12: a palette provider the app shell registers (feature 20 search, feature 14 rules). Session Mode never imports
 * one; with a provider present, its direct entity lookup gives way to the provider's results.
 */
export interface PaletteProvider {
  readonly id: string;
  entries(query: string): readonly ProvidedPaletteEntry[];
}

export const PROVIDED_LIMIT = 8;

/**
 * Every palette entry for an open session (D-12): quick actions, the session's operations, a "Set scene" per scene
 * the device holds, and a lookup per entity. Feature 20 and 14 providers add theirs through the shell later.
 */
export function paletteEntries(input: {
  readonly session: SessionRecord;
  readonly actions: readonly SessionQuickAction[];
  readonly entities: readonly ContextEntity[];
  /** The direct entity lookup; off when a provider searches instead (D-12). */
  readonly lookups?: boolean;
}): PaletteEntry[] {
  const { session } = input;
  const operations: PaletteEntry[] = [
    ...(session.status === 'active'
      ? [{ id: 'op.pause', label: 'Pause session', group: 'Session', run: { kind: 'pause' } }]
      : []),
    ...(session.status === 'paused'
      ? [
          {
            id: 'op.resume',
            label: 'Resume session',
            group: 'Session',
            run: { kind: 'resume' },
          },
        ]
      : []),
    { id: 'op.end', label: 'End session', group: 'Session', run: { kind: 'end' } },
  ] as PaletteEntry[];
  return [
    ...input.actions.map((action) => ({
      id: `action.${action.id}`,
      label: action.label,
      group: 'Action',
      run: { kind: 'quick' as const, action },
    })),
    ...operations,
    ...scenesOf(input.entities)
      .filter((scene) => scene.id !== session.currentSceneId)
      .map((scene) => ({
        id: `scene.${scene.id}`,
        label: `Set scene: ${scene.name}`,
        group: 'Scene',
        run: { kind: 'scene' as const, sceneId: scene.id },
      })),
    ...input.entities
      .filter((entity) => input.lookups !== false && entity.deletedAt === undefined)
      .map((entity) => ({
        id: `lookup.${entity.id}`,
        label: entity.name,
        group: entity.type,
        run: { kind: 'lookup' as const, entityId: entity.id },
      })),
  ];
}

/**
 * Matching entries, then what the providers offer for the query, plus "Add to log" for whatever was typed, so a note
 * is two keystrokes away.
 */
export function paletteResults(
  entries: readonly PaletteEntry[],
  query: string,
  providers: readonly PaletteProvider[] = [],
): PaletteEntry[] {
  const matched = matchPalette(entries, query, 12);
  const text = query.trim();
  const provided: PaletteEntry[] =
    text === ''
      ? []
      : providers
          .flatMap((provider) =>
            provider.entries(text).map((entry) => ({
              id: `provided:${provider.id}:${entry.id}`,
              label: entry.label,
              group: entry.group,
              run: {
                kind: 'provided' as const,
                ...(entry.subjectId === undefined ? {} : { subjectId: entry.subjectId }),
                ...(entry.open === undefined ? {} : { open: () => entry.open?.() }),
              },
            })),
          )
          .slice(0, PROVIDED_LIMIT);
  return text === ''
    ? matched
    : [
        ...matched,
        ...provided,
        {
          id: 'op.note',
          label: `Add to log: ${text}`,
          group: 'Log',
          run: { kind: 'note', text },
        },
      ];
}
