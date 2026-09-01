import { Value } from '@sinclair/typebox/value';
import type {
  CampaignCreateInput,
  CampaignSettingRegistration,
  GameModeDeclaration,
  ModuleDeclaration,
  SystemDefinition,
  SystemOptionDeclaration,
} from './contracts.ts';

export type CampaignValidationError =
  | 'system_unavailable'
  | 'invalid_game_mode'
  | 'invalid_option'
  | 'invalid_module'
  | 'invalid_campaign_details'
  | 'unregistered_setting_namespace'
  | 'invalid_setting';

export type WizardStep =
  | 'system'
  | 'game_mode'
  | 'options'
  | 'modules'
  | 'details'
  | 'party'
  | 'review';

export function wizardSteps(system: SystemDefinition): readonly WizardStep[] {
  const steps: WizardStep[] = ['system', 'game_mode'];
  if (system.options.length > 0) steps.push('options');
  if (system.compatibleModules.length > 0) steps.push('modules');
  steps.push('details', 'party', 'review');
  return steps;
}

export function validateCampaignInput(
  input: CampaignCreateInput,
  system: SystemDefinition,
): CampaignValidationError | undefined {
  if (
    input.system.systemId !== system.summary.ref.systemId ||
    input.system.version !== system.summary.ref.version
  ) {
    return 'system_unavailable';
  }
  if (!system.gameModes.some((mode) => mode.id === input.gameMode)) {
    return 'invalid_game_mode';
  }
  if (!validOptions(input.options, system.options)) return 'invalid_option';
  const declaredModules = new Set(system.compatibleModules.map((module) => module.id));
  if (input.moduleIds.some((moduleId) => !declaredModules.has(moduleId))) return 'invalid_module';
  if (input.name.trim().length === 0 || [...input.name.trim()].length > 120) {
    return 'invalid_campaign_details';
  }
  if ([...input.description].length > 10_000) return 'invalid_campaign_details';
  return undefined;
}

function validOptions(
  values: Readonly<Record<string, unknown>>,
  declarations: readonly SystemOptionDeclaration[],
): boolean {
  if (Object.keys(values).some((key) => !declarations.some((option) => option.key === key))) {
    return false;
  }
  return declarations.every((declaration) => {
    const value = values[declaration.key] ?? declaration.default;
    if (declaration.type === 'boolean') return typeof value === 'boolean';
    if (declaration.type === 'select') {
      return typeof value === 'string' && declaration.values.includes(value);
    }
    return (
      typeof value === 'string' &&
      (declaration.minLength === undefined || [...value].length >= declaration.minLength) &&
      (declaration.maxLength === undefined || [...value].length <= declaration.maxLength)
    );
  });
}

export function selectedModulePins(
  selectedIds: readonly string[],
  modules: readonly ModuleDeclaration[],
): readonly { readonly moduleId: string; readonly version: string }[] {
  return selectedIds.map((moduleId) => {
    const declaration = modules.find((candidate) => candidate.id === moduleId);
    if (declaration === undefined) throw new Error('selected module was not validated');
    return { moduleId, version: declaration.version };
  });
}

export function resetSystemDependentState(): {
  readonly gameMode: undefined;
  readonly options: Readonly<Record<string, never>>;
  readonly moduleIds: readonly never[];
} {
  return { gameMode: undefined, options: {}, moduleIds: [] };
}

export class CampaignSettingRegistry {
  readonly #registrations = new Map<string, CampaignSettingRegistration>();

  register(registration: CampaignSettingRegistration): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(registration.namespace)) {
      throw new Error(`Invalid setting namespace: ${registration.namespace}`);
    }
    if (this.#registrations.has(registration.namespace)) {
      throw new Error(`Duplicate setting namespace: ${registration.namespace}`);
    }
    this.#registrations.set(registration.namespace, registration);
  }

  get(namespace: string): CampaignSettingRegistration | undefined {
    return this.#registrations.get(namespace);
  }

  validate(namespace: string, value: unknown): CampaignValidationError | undefined {
    const registration = this.get(namespace);
    if (registration === undefined) return 'unregistered_setting_namespace';
    return Value.Check(registration.schema, value) ? undefined : 'invalid_setting';
  }
}

export function modeIds(modes: readonly GameModeDeclaration[]): readonly string[] {
  return modes.map((mode) => mode.id);
}
