import type { CampaignCreateInput, SystemDefinition } from '@rpg/campaigns';

export interface WizardState {
  readonly system?: SystemDefinition;
  readonly gameMode?: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly moduleIds: readonly string[];
  readonly name: string;
  readonly description: string;
  readonly invitationRole?: 'gm' | 'assistant_gm' | 'player';
}

export type WizardAction =
  | { readonly type: 'select_system'; readonly system: SystemDefinition }
  | { readonly type: 'select_mode'; readonly gameMode: string }
  | { readonly type: 'set_option'; readonly key: string; readonly value: unknown }
  | { readonly type: 'toggle_module'; readonly moduleId: string }
  | { readonly type: 'set_details'; readonly name: string; readonly description: string }
  | { readonly type: 'set_invitation_role'; readonly role?: 'gm' | 'assistant_gm' | 'player' };

export function initialWizardState(): WizardState {
  return { options: {}, moduleIds: [], name: '', description: '' };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'select_system':
      return { ...initialWizardState(), system: action.system };
    case 'select_mode':
      return { ...state, gameMode: action.gameMode };
    case 'set_option':
      return { ...state, options: { ...state.options, [action.key]: action.value } };
    case 'toggle_module':
      return {
        ...state,
        moduleIds: state.moduleIds.includes(action.moduleId)
          ? state.moduleIds.filter((id) => id !== action.moduleId)
          : [...state.moduleIds, action.moduleId],
      };
    case 'set_details':
      return { ...state, name: action.name, description: action.description };
    case 'set_invitation_role':
      return action.role === undefined
        ? { ...state, invitationRole: undefined }
        : { ...state, invitationRole: action.role };
  }
}

export function toCreateInput(state: WizardState, id: string): CampaignCreateInput | undefined {
  if (
    state.system === undefined ||
    state.gameMode === undefined ||
    state.name.trim().length === 0
  ) {
    return undefined;
  }
  return {
    id,
    system: state.system.summary.ref,
    gameMode: state.gameMode,
    options: state.options,
    moduleIds: [...state.moduleIds],
    name: state.name.trim(),
    description: state.description,
  };
}
