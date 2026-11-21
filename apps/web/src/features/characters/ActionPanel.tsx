import {
  type EffectPlan,
  type PlanItem,
  type PreparedAction,
  planOutcome,
  prepareAction,
  resolvePlan,
  type TargetState,
  visiblePlan,
} from '@rpg/actions';
import type { CharacterRecord } from '@rpg/characters';
import { entriesOf } from '@rpg/characters';
import type { RollRecord } from '@rpg/dice';
import type { SystemPackage } from '@rpg/systems';
import { useState } from 'react';
import type { CharacterSource } from './character-source.ts';

/**
 * Feature 15 FR-008: act from the sheet. Prepare (picks and prompts), roll through feature 09, plan through
 * feature 11, show the plan, and apply only what a person confirms (`PRD.md` s.27).
 */

function itemText(item: PlanItem): string {
  if (item.status === 'hidden') return `${item.kind}: hidden`;
  const changes = item.changes.map(
    (change) => `${change.path}: ${String(change.before)} → ${String(change.after)}`,
  );
  const extra =
    item.status === 'ready'
      ? ''
      : ` (${item.status}${item.reason === undefined ? '' : `: ${item.reason}`})`;
  const follow = item.followUp === undefined ? '' : ` then ${item.followUp}`;
  return `${item.kind}${extra}${follow}${changes.length === 0 ? '' : ` — ${changes.join(', ')}`}`;
}

export function PlanView(props: { readonly plan: EffectPlan; readonly roll?: RollRecord }) {
  const { plan, roll } = props;
  return (
    <div data-plan={plan.outcome?.id ?? 'none'}>
      {roll !== undefined && (
        <p data-roll-result={roll.result.modified}>
          Rolled {roll.expression}:{' '}
          {roll.result.terms
            .flatMap((term) =>
              term.kind === 'dice'
                ? term.faces.map((face) => (face.kept ? String(face.value) : `(${face.value})`))
                : [],
            )
            .join(' ')}{' '}
          = {roll.result.modified}
        </p>
      )}
      {plan.success !== undefined && <p>{plan.success ? 'Success' : 'Failure'}</p>}
      {plan.outcome !== undefined && <p data-outcome={plan.outcome.id}>{plan.outcome.label}</p>}
      <ul>
        {plan.items.map((item) => (
          <li key={item.index}>{itemText(item)}</li>
        ))}
      </ul>
      {plan.options.map((option) => (
        <div key={option.id} data-option={option.id}>
          <strong>{option.label}</strong>
          <ul>
            {option.items.map((item) => (
              <li key={item.index}>{itemText(item)}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ActionPanel(props: {
  readonly source: CharacterSource;
  readonly system: SystemPackage;
  readonly character: CharacterRecord;
  readonly state: TargetState;
  readonly mayReadGmOnly: boolean;
  readonly onError: (message: string | undefined) => void;
}) {
  const { source, system, character, state, onError } = props;
  const [actionKey, setActionKey] = useState<string>();
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<{
    readonly prepared: PreparedAction;
    readonly plan: EffectPlan;
    readonly roll?: RollRecord;
  }>();
  const [selections, setSelections] = useState<Record<string, string>>({});
  if (system.actions.length === 0) return null;
  const action = system.actions.find((candidate) => candidate.key === actionKey);

  const pickOptions = (pick: NonNullable<(typeof system.actions)[number]['picks']>[number]) =>
    pick.entryField === undefined
      ? pick.fields.map((field) => ({
          value: field,
          label: system.characterSchema.fields.find((item) => item.key === field)?.label ?? field,
        }))
      : pick.fields.flatMap((field) =>
          entriesOf(state, field).map((entry) => ({
            value: `${field}:${entry.id}`,
            label: String(
              Object.values(entry.values).find(
                (value) => typeof value === 'string' && value !== '',
              ) ?? entry.id,
            ),
          })),
        );

  const roll = async () => {
    if (action === undefined) return;
    onError(undefined);
    const prepared = prepareAction(system, action.key, state, {
      picks: Object.fromEntries(
        Object.entries(picks).map(([name, value]) => {
          const [field, entry] = value.split(':');
          return [name, entry === undefined ? value : { field: field as string, entry }];
        }),
      ),
      prompts,
    });
    if (!prepared.ok) return onError(`Cannot prepare: ${prepared.error.code}`);
    let rolled: RollRecord | undefined;
    if (prepared.value.rollRequest !== undefined) {
      const result = await source.rolls.roll({
        ...prepared.value.rollRequest,
        visibility: 'public',
        action: action.key,
        actorRef: character.id,
      });
      if (!result.ok) return onError(`Roll refused: ${result.error.code}`);
      rolled = result.value;
    }
    const planned = planOutcome(prepared.value, rolled?.result);
    if (!planned.ok) return onError(`Cannot plan: ${planned.error.code}`);
    setPending({
      prepared: prepared.value,
      plan: planned.value,
      ...(rolled === undefined ? {} : { roll: rolled }),
    });
  };

  const apply = async (option?: string) => {
    if (pending === undefined) return;
    const resolved = resolvePlan(pending.prepared, pending.plan, {
      ...(option === undefined ? {} : { option }),
      selections,
    });
    if (!resolved.ok) {
      if (resolved.error.code === 'nothing_to_apply') setPending(undefined);
      return onError(
        resolved.error.code === 'nothing_to_apply'
          ? undefined
          : `Cannot apply: ${resolved.error.code}`,
      );
    }
    if (resolved.value.operations.length > 0) {
      const applied = await source.effects.apply(
        { targetClass: 'character', targetId: character.id, visibility: character.visibility },
        resolved.value,
        pending.roll === undefined ? {} : { rollId: pending.roll.id },
      );
      if (!applied.ok) return onError(`Cannot apply: ${applied.error.code}`);
    }
    setPending(undefined);
    const [next] = resolved.value.followUps;
    if (next !== undefined) setActionKey(next);
  };

  return (
    <section aria-label="Actions">
      <h3>Actions</h3>
      <div role="toolbar" aria-label="Choose an action">
        {system.actions.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            aria-pressed={candidate.key === actionKey}
            onClick={() => {
              setActionKey(candidate.key);
              setPending(undefined);
            }}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      {action !== undefined && pending === undefined && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void roll();
          }}
        >
          {(action.picks ?? []).map((pick) => (
            <label key={pick.name}>
              {pick.label}{' '}
              <select
                value={picks[pick.name] ?? ''}
                onChange={(event) => setPicks({ ...picks, [pick.name]: event.target.value })}
              >
                <option value="">—</option>
                {pickOptions(pick).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {(action.prompts ?? []).map((prompt) => (
            <label key={prompt.name}>
              {prompt.label}{' '}
              <input
                type="number"
                value={prompts[prompt.name] ?? prompt.default ?? 0}
                onChange={(event) =>
                  setPrompts({ ...prompts, [prompt.name]: Number(event.target.value) })
                }
              />
            </label>
          ))}
          <button type="submit">
            {action.roll === undefined ? 'Use' : 'Roll'} {action.label}
          </button>
        </form>
      )}
      {pending !== undefined && (
        <section aria-label="Plan">
          <PlanView
            plan={visiblePlan(pending.plan, system, props.mayReadGmOnly)}
            {...(pending.roll === undefined ? {} : { roll: pending.roll })}
          />
          {pending.plan.options.length > 0 ||
          pending.plan.items.some((item) => item.status === 'needs_input') ? (
            <fieldset>
              <legend>Choices</legend>
              {['box', 'slot', 'text'].map((name) => (
                <label key={name}>
                  {name}{' '}
                  <input
                    value={selections[name] ?? ''}
                    onChange={(event) =>
                      setSelections({ ...selections, [name]: event.target.value })
                    }
                  />
                </label>
              ))}
            </fieldset>
          ) : null}
          {pending.plan.mode === 'choice' ? (
            pending.plan.options.map((option) => (
              <button key={option.id} type="button" onClick={() => void apply(option.id)}>
                Apply: {option.label}
              </button>
            ))
          ) : (
            <button type="button" onClick={() => void apply()}>
              Apply
            </button>
          )}
          <button type="button" onClick={() => setPending(undefined)}>
            Decline
          </button>
        </section>
      )}
    </section>
  );
}
