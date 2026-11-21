// Evaluates sync streams with the PowerSync Service's own sync-rules engine. Runs inside the
// `journeyapps/powersync-service:1.25.0` container, where this directory is mounted at /config:
//
//   docker exec -i rpg-powersync node /config/engine-check.mjs < input.json
//
// Input: { yaml, memberTable?, members?, parameterTables?, rowTable?, rows?, users?,
// subscriptions? }. Without `rows` it only
// compiles `yaml` and reports diagnostics. With rows it assigns data rows to buckets
// (evaluateRow), membership rows to the parameter index (evaluateParameterRow), and resolves each
// user's buckets (getBucketParameterQuerier), then prints which row ids each user would receive.
// `parameterTables` ([{ table, rows }]) feeds every joined relation; `subscriptions[userId]` is
// { stream: [parameters, ...] } for streams that are not subscribed by default. Used by
// `packages/sync/src/infra/powersync/sync-rules-engine.integration.test.ts` and
// `apps/api/src/modules/sync/audit-sync.integration.test.ts`.
import fs from 'node:fs';
import * as sqlite from 'node:sqlite';

const sr = await import('/app/packages/sync-rules/dist/index.js');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const parsed = sr.SqlSyncRules.fromYaml(input.yaml, {
  defaultSchema: 'public',
  throwOnError: false,
});
const diagnostics = (parsed.errors ?? []).map((error) => ({
  type: error.type,
  message: error.message,
}));
if (input.rows === undefined || diagnostics.some((item) => item.type === 'fatal')) {
  console.log(JSON.stringify({ diagnostics }));
  process.exit(0);
}

const hydrated = parsed.config.hydrate({
  hydrationState: sr.DEFAULT_HYDRATION_STATE,
  sqlite: sr.nodeSqlite(sqlite),
});
const ref = (name) => ({ connectionTag: 'default', schema: 'public', name });
const errors = [];

// `parameterTables` ([{ table, rows }]) feeds every joined relation (membership, target rows);
// `memberTable`/`members` is the single-relation shorthand.
const parameterTables = [
  ...(input.memberTable === undefined ? [] : [{ table: input.memberTable, rows: input.members }]),
  ...(input.parameterTables ?? []),
];
const index = new Map();
for (const { table, rows } of parameterTables) {
  for (const row of rows) {
    const evaluated = hydrated.evaluateParameterRowWithErrors(ref(table), row);
    errors.push(...evaluated.errors.map((error) => error.error));
    for (const result of evaluated.results) {
      const key = result.lookup.serializedRepresentation;
      index.set(key, [...(index.get(key) ?? []), ...result.bucketParameters]);
    }
  }
}

const bucketsOfRow = new Map();
for (const row of input.rows) {
  const evaluated = hydrated.evaluateRowWithErrors({
    sourceTable: ref(input.rowTable),
    record: row,
  });
  errors.push(...evaluated.errors.map((error) => error.error));
  bucketsOfRow.set(row.id, new Set(evaluated.results.map((result) => result.bucket)));
}

const delivered = {};
for (const userId of input.users) {
  const parameters = new sr.RequestParameters(
    { userIdJson: userId, parsedPayload: { sub: userId } },
    {},
  );
  const { querier, errors: querierErrors } = hydrated.getBucketParameterQuerier({
    globalParameters: parameters,
    hasDefaultStreams: true,
    // `subscriptions[userId]`: { stream: [parameters, ...] } explicit stream subscriptions.
    streams: Object.fromEntries(
      Object.entries(input.subscriptions?.[userId] ?? {}).map(([stream, list]) => [
        stream,
        list.map((parameters, opaque_id) => ({ parameters, opaque_id, priorityOverride: null })),
      ]),
    ),
  });
  errors.push(...querierErrors.map((error) => error.message));
  const dynamic = await querier.queryDynamicBucketDescriptions({
    getParameterSets: async (lookups) =>
      lookups.map((lookup) => ({ lookup, rows: index.get(lookup.serializedRepresentation) ?? [] })),
  });
  const buckets = new Set([...querier.staticBuckets, ...dynamic].map((bucket) => bucket.bucket));
  delivered[userId] = input.rows
    .filter((row) => [...bucketsOfRow.get(row.id)].some((bucket) => buckets.has(bucket)))
    .map((row) => row.id);
}
console.log(JSON.stringify({ diagnostics, errors, delivered }));
