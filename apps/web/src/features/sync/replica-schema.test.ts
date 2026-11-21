import { describe, expect, test } from 'bun:test';
import { ACTIONS_REPLICA_TABLES, effectReplicaProjection } from '@rpg/actions';
import { CONTENT_REPLICA_TABLES, replicaProjection } from '@rpg/content';
import { DICE_REPLICA_TABLES, diceReplicaProjection } from '@rpg/dice';
import { replicaSchema } from '@rpg/sync/browser';

/** Feature 16 task 04: the web composition's replica holds the content tables, untyped rows none. */
describe('web replica schema composition', () => {
  test('content entities and personal notes are typed replica tables with the stream columns', () => {
    const schema = replicaSchema({ privateAudit: false, tables: CONTENT_REPLICA_TABLES });
    for (const name of ['content_entities', 'content_personal_notes'] as const) {
      const table = schema.tables.find((item) => item.name === name);
      expect(table === undefined ? undefined : ['id', ...table.columns.map((c) => c.name)]).toEqual(
        replicaProjection(name),
      );
    }
  });

  test('effect applications are a typed replica table with the stream columns', () => {
    const schema = replicaSchema({ privateAudit: false, tables: ACTIONS_REPLICA_TABLES });
    const table = schema.tables.find((item) => item.name === 'effect_applications');
    expect(table === undefined ? undefined : ['id', ...table.columns.map((c) => c.name)]).toEqual(
      effectReplicaProjection(),
    );
  });

  test('rolls are a typed replica table with the stream columns', () => {
    const schema = replicaSchema({ privateAudit: false, tables: DICE_REPLICA_TABLES });
    const table = schema.tables.find((item) => item.name === 'dice_rolls');
    expect(table === undefined ? undefined : ['id', ...table.columns.map((c) => c.name)]).toEqual(
      diceReplicaProjection(),
    );
  });
});
