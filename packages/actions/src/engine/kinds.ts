import type { SystemPackage } from '@rpg/systems';

/**
 * The closed effect kinds (`_techspec.md` D-06). Adding one is a contract change driven by a named system.
 */

export type EffectParameter = 'declared' | 'selectable' | 'optional';

export interface EffectKind {
  /** `declared` must be in the package; `selectable` may come from the caller when it runs. */
  readonly parameters: Readonly<Record<string, EffectParameter>>;
  /** Declared in the contract, refused at execution until its feature exists (FR-004). */
  readonly deferred?: true;
}

const POOL_CHANGE = { resource: 'declared', amount: 'declared' } as const;
const BOX = { resource: 'declared', box: 'selectable' } as const;
const SLOT = { field: 'declared', slot: 'selectable' } as const;

export const EFFECT_KINDS: ReadonlyMap<string, EffectKind> = new Map<string, EffectKind>([
  ['apply_damage', { parameters: POOL_CHANGE }],
  ['heal', { parameters: POOL_CHANGE }],
  ['gain_resource', { parameters: { ...POOL_CHANGE, temporary: 'optional' } }],
  ['spend_resource', { parameters: POOL_CHANGE }],
  ['modify_field', { parameters: { field: 'declared', amount: 'optional', value: 'optional' } }],
  ['add_condition', { parameters: { condition: 'declared' } }],
  ['remove_condition', { parameters: { condition: 'declared' } }],
  [
    'move_inventory_item',
    { parameters: { inventory: 'declared', item: 'selectable', slot: 'selectable' } },
  ],
  ['execute_roll', { parameters: { action: 'declared' } }],
  ['mark_box', { parameters: BOX }],
  ['clear_box', { parameters: BOX }],
  ['fill_slot', { parameters: { ...SLOT, text: 'selectable' } }],
  ['clear_slot', { parameters: SLOT }],
  ['advance_clock', { parameters: {}, deferred: true }],
  ['trigger_event', { parameters: {}, deferred: true }],
  ['reveal_knowledge', { parameters: {}, deferred: true }],
]);

/** `ExpressionValidators.effect`: an error message, or `undefined` when the kind exists. */
export function checkEffectKind(kind: string): string | undefined {
  return EFFECT_KINDS.has(kind) ? undefined : `The effect kind ${kind} does not exist.`;
}

interface EffectLocation {
  readonly path: string;
  readonly effect: SystemPackage['actions'][number]['outcomes'][number]['resolution'] extends infer R
    ? R extends { effects: readonly (infer E)[] }
      ? E
      : never
    : never;
}

function effectsOf(system: SystemPackage): readonly EffectLocation[] {
  return system.actions.flatMap((action, actionIndex) =>
    action.outcomes.flatMap((outcome, outcomeIndex) => {
      const base = `/actions/${actionIndex}/outcomes/${outcomeIndex}/resolution`;
      const { resolution } = outcome;
      return resolution.mode === 'apply'
        ? resolution.effects.map((effect, index) => ({ path: `${base}/effects/${index}`, effect }))
        : resolution.options.flatMap((option, optionIndex) =>
            option.effects.map((effect, index) => ({
              path: `${base}/options/${optionIndex}/effects/${index}`,
              effect,
            })),
          );
    }),
  );
}

/**
 * `ExpressionValidators.effects`: the package-level rules a kind implies. Formula text is feature 10's;
 * the kind itself is `checkEffectKind`'s, so an unknown kind is reported once, by that check.
 */
export function checkSystemEffects(
  system: SystemPackage,
): readonly { readonly path: string; readonly message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const pools = new Set(
    system.resources.flatMap((resource) => (resource.shape === 'pool' ? [resource.key] : [])),
  );
  const tracks = new Set(
    system.resources.flatMap((resource) => (resource.shape === 'track' ? [resource.key] : [])),
  );
  const conditions = new Set(system.mechanics.conditions.map((condition) => condition.key));
  const actions = new Set(system.actions.map((action) => action.key));
  const fields = new Map(system.characterSchema.fields.map((field) => [field.key, field]));
  const inventory = system.mechanics.inventory?.key;

  for (const { path, effect } of effectsOf(system)) {
    const kind = EFFECT_KINDS.get(effect.effect);
    if (kind === undefined || kind.deferred === true) continue;
    const refuse = (message: string) => issues.push({ path, message });
    for (const name of Object.keys(effect.params)) {
      if (!Object.hasOwn(kind.parameters, name)) {
        refuse(`The effect ${effect.effect} takes no parameter ${name}.`);
      }
    }
    for (const [name, rule] of Object.entries(kind.parameters)) {
      if (rule === 'declared' && !Object.hasOwn(effect.params, name)) {
        refuse(`The effect ${effect.effect} needs the parameter ${name}.`);
      }
    }
    const amount = effect.params.amount;
    if (amount !== undefined && typeof amount !== 'object' && !Number.isSafeInteger(amount)) {
      refuse('An amount is a whole number or a formula.');
    }
    const named = (name: string) => {
      const value = effect.params[name];
      return typeof value === 'string' ? value : undefined;
    };
    switch (effect.effect) {
      case 'apply_damage':
      case 'heal':
      case 'gain_resource':
      case 'spend_resource': {
        const resource = named('resource');
        if (resource !== undefined && !pools.has(resource)) {
          refuse(`The effect ${effect.effect} needs a declared pool, not ${resource}.`);
        }
        break;
      }
      case 'mark_box':
      case 'clear_box': {
        const resource = named('resource');
        if (resource !== undefined && !tracks.has(resource)) {
          refuse(`The effect ${effect.effect} needs a declared track, not ${resource}.`);
        }
        break;
      }
      case 'fill_slot':
      case 'clear_slot': {
        const name = named('field');
        const field = name === undefined ? undefined : fields.get(name);
        if (name !== undefined && (field?.type !== 'repeater' || field.slots === undefined)) {
          refuse(`The effect ${effect.effect} needs a repeater with slots, not ${name}.`);
        }
        break;
      }
      case 'modify_field': {
        const name = named('field');
        const field = name === undefined ? undefined : fields.get(name);
        const hasAmount = Object.hasOwn(effect.params, 'amount');
        const hasValue = Object.hasOwn(effect.params, 'value');
        if (name !== undefined && field === undefined) {
          refuse(`The field ${name} is not declared.`);
        }
        if (hasAmount === hasValue) refuse('modify_field takes exactly one of amount or value.');
        const numeric = field?.type === 'number' || field?.type === 'counter';
        if (field !== undefined && hasAmount && !numeric) {
          refuse(`The field ${name} is not numeric, so it takes a value.`);
        }
        if (field !== undefined && hasValue && numeric) {
          refuse(`The field ${name} is numeric, so it takes an amount.`);
        }
        break;
      }
      case 'add_condition':
      case 'remove_condition': {
        const condition = named('condition');
        if (condition !== undefined && !conditions.has(condition)) {
          refuse(`The condition ${condition} is not declared.`);
        }
        break;
      }
      case 'move_inventory_item':
        if (named('inventory') !== inventory || inventory === undefined) {
          refuse('move_inventory_item needs the declared inventory.');
        }
        break;
      case 'execute_roll': {
        const action = named('action');
        if (action !== undefined && !actions.has(action)) {
          refuse(`The action ${action} is not declared.`);
        }
        break;
      }
      default:
        break;
    }
  }
  return issues;
}
