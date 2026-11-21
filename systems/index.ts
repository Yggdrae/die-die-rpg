import { checkEffectKind, checkSystemEffects } from '@rpg/actions/engine';
import { checkDiceSource } from '@rpg/dice/engine';
import { checkFormulaCycles, checkFormulaSource } from '@rpg/formula';
import { type ExpressionValidators, SystemRegistry } from '@rpg/systems';
import cairn from './cairn-2e/system.json' with { type: 'json' };
import fate from './fate-core/system.json' with { type: 'json' };

/**
 * Every system package the application ships, as untrusted data: nothing here is a `SystemPackage` until
 * the registry has loaded it (`PRD.md` s.75). This is the one place outside the packages themselves that
 * knows which systems exist, so generic code never names one (`PRD.md` s.89).
 */
export const INSTALLED_SYSTEM_PACKAGES: readonly unknown[] = [cairn, fate];

/**
 * Where the engines meet the package contract (feature 10 D-11). `@rpg/systems` stays pure and knows no
 * engine; the API and the browser both load packages through these validators, so a bad expression, a
 * formula cycle, or an effect the engine cannot apply refuses the package wherever it is loaded.
 */
export const ENGINE_VALIDATORS: ExpressionValidators = {
  dice: checkDiceSource,
  formula: checkFormulaSource,
  formulaCycles: checkFormulaCycles,
  effect: checkEffectKind,
  effects: checkSystemEffects,
};

/** A registry holding `extra` (the fixture, in tests and development) and every shipped package. */
export function createInstalledRegistry(extra: readonly unknown[] = []): SystemRegistry {
  const registry = new SystemRegistry(ENGINE_VALIDATORS);
  registry.loadAll([...extra, ...INSTALLED_SYSTEM_PACKAGES]);
  return registry;
}
