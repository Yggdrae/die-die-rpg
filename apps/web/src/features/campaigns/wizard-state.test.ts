import { describe, expect, test } from 'bun:test';
import { FIXTURE_SYSTEM_DEFINITION } from '@rpg/fixtures';
import { initialWizardState, toCreateInput, wizardReducer } from './wizard-state.ts';

describe('campaign wizard state', () => {
  test('changing system clears every dependent choice and persists no draft', () => {
    let state = wizardReducer(initialWizardState(), {
      type: 'select_system',
      system: FIXTURE_SYSTEM_DEFINITION,
    });
    state = wizardReducer(state, { type: 'select_mode', gameMode: 'standard' });
    state = wizardReducer(state, { type: 'set_option', key: 'old', value: true });
    state = wizardReducer(state, { type: 'toggle_module', moduleId: 'old-module' });
    state = wizardReducer(state, {
      type: 'select_system',
      system: {
        ...FIXTURE_SYSTEM_DEFINITION,
        summary: { ...FIXTURE_SYSTEM_DEFINITION.summary, name: 'Other' },
      },
    });

    expect(state.gameMode).toBeUndefined();
    expect(state.options).toEqual({});
    expect(state.moduleIds).toEqual([]);
  });

  test('cannot produce create input without system, mode, and non-empty name', () => {
    expect(toCreateInput(initialWizardState(), crypto.randomUUID())).toBeUndefined();
    let state = wizardReducer(initialWizardState(), {
      type: 'select_system',
      system: FIXTURE_SYSTEM_DEFINITION,
    });
    state = wizardReducer(state, { type: 'select_mode', gameMode: 'standard' });
    state = wizardReducer(state, { type: 'set_details', name: 'Road', description: '' });
    expect(toCreateInput(state, '11111111-1111-1111-1111-111111111111')).toMatchObject({
      name: 'Road',
      gameMode: 'standard',
    });
  });
});
