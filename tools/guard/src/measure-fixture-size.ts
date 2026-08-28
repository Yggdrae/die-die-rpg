/**
 * Measures the on-disk cost of a campaign, to set the local database size budget
 * (feature 00 FR-013).
 *
 * The budget exists because features 03, 06 and 09 each choose their own retention policy.
 * Without a shared number they grow independently and the `PRD.md` s.79 cold-start target
 * is missed with no single feature at fault.
 *
 * Throwaway-adjacent: this runs once to produce a number for the freeze. It is kept in
 * tools/ rather than spike/ because the number should be re-measured when the fixture
 * campaign grows.
 */

import { FIXTURE_CAMPAIGN, FIXTURE_CHARACTER_SCHEMA, FIXTURE_ENTITIES } from '@rpg/fixtures';

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const entityBytes = bytes(FIXTURE_ENTITIES);
const perEntity = Math.round(entityBytes / FIXTURE_ENTITIES.length);
const schemaBytes = bytes(FIXTURE_CHARACTER_SCHEMA);
const campaignBytes = bytes(FIXTURE_CAMPAIGN);

/**
 * A "typical campaign" for the `PRD.md` s.79 measurement. Derived from what the source PRD
 * describes rather than invented: s.29 content types, s.43 sessions, s.82 sandbox scale.
 */
const TYPICAL = {
  entities: 400, // NPCs, locations, items, factions, notes across a long campaign
  characters: 6,
  sessions: 40,
  rollsPerSession: 120, // the highest-volume record in the product (feature 09)
  auditPerSession: 200,
};

const rolls = TYPICAL.sessions * TYPICAL.rollsPerSession;
const auditEvents = TYPICAL.sessions * TYPICAL.auditPerSession;

// Rough per-record sizes, measured where possible and estimated where the feature does not
// exist yet. Marked so nobody mistakes an estimate for a measurement.
const ROLL_BYTES = 320; // estimate: RollContext per PRD.md s.21
const AUDIT_BYTES = 400; // estimate: AuditEvent with before/after

const estimate = {
  entities: TYPICAL.entities * perEntity,
  characters: TYPICAL.characters * schemaBytes,
  rolls: rolls * ROLL_BYTES,
  audit: auditEvents * AUDIT_BYTES,
};

const totalJson = Object.values(estimate).reduce((a, b) => a + b, 0);

// SQLite pages, indexes and FTS roughly double raw JSON in practice; the spike measured
// 5000 rows of short text with an FTS index, which is the closest evidence available.
const SQLITE_OVERHEAD = 2.2;
const totalOnDisk = Math.round(totalJson * SQLITE_OVERHEAD);

const mb = (n: number) => (n / 1024 / 1024).toFixed(2);

console.log('--- measured from fixtures ---');
console.log(`campaign record            ${campaignBytes} B`);
console.log(
  `${FIXTURE_ENTITIES.length} entities                ${entityBytes} B  (${perEntity} B each)`,
);
console.log(`character schema           ${schemaBytes} B`);
console.log();
console.log('--- projected typical campaign ---');
console.log(
  `entities   ${TYPICAL.entities.toString().padStart(6)}  ${mb(estimate.entities)} MB   (measured per-entity)`,
);
console.log(
  `characters ${TYPICAL.characters.toString().padStart(6)}  ${mb(estimate.characters)} MB   (measured schema size)`,
);
console.log(
  `rolls      ${rolls.toString().padStart(6)}  ${mb(estimate.rolls)} MB   (ESTIMATE, ${ROLL_BYTES} B each)`,
);
console.log(
  `audit      ${auditEvents.toString().padStart(6)}  ${mb(estimate.audit)} MB   (ESTIMATE, ${AUDIT_BYTES} B each)`,
);
console.log();
console.log(`raw JSON total             ${mb(totalJson)} MB`);
console.log(`with SQLite overhead x${SQLITE_OVERHEAD}   ${mb(totalOnDisk)} MB`);
console.log();
console.log('Rolls and audit dominate. Both are append-only and both belong to features that');
console.log('choose their own retention (03 tombstones, 06 audit, 09 rolls).');
