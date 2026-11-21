import { check, Id, ImportCode, ImportWarning } from '@rpg/contracts';
import { canonicalJson, parseBoundedJson, utf8 } from './canonical.ts';
import { importableOf } from './importer.ts';
import { isChunkVersion, isModuleId } from './paths.ts';
import type { ExportRegistration } from './registry.ts';
import { scanForbiddenData } from './scanner.ts';

/**
 * Contributor conformance kit (`_techspec.md`, Testing: contributor schema/version/export/import
 * and forbidden-data scanner). Run by every composition that registers contributors, over a
 * campaign seeded with representative data. Returns problems instead of asserting, so any test
 * runner can use it.
 */
export async function exportContributorProblems(
  registration: ExportRegistration,
  campaignId: string,
  options: { readonly expectedRecords?: number } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const moduleId = registration.module.moduleId;
  if (!isModuleId(moduleId)) return [`module id ${JSON.stringify(moduleId)} is not a safe id`];

  const first = await registration.module.export(campaignId);
  if (first.moduleId !== moduleId) problems.push('chunk moduleId differs from the registration');
  if (!isChunkVersion(first.chunkVersion)) problems.push('chunk version is not a safe version');
  let canonical: string | undefined;
  try {
    canonical = canonicalJson(first.payload);
  } catch {
    problems.push('payload is not plain JSON data');
  }
  if (canonical !== undefined && !parseBoundedJson(utf8(canonical)).ok) {
    problems.push('payload exceeds the package JSON limits');
  }
  const finding = scanForbiddenData(first.payload);
  if (finding !== undefined)
    problems.push(`forbidden data at ${finding.pointer} (${finding.rule})`);

  const second = await registration.module.export(campaignId);
  if (canonical !== undefined && canonicalJson(second.payload) !== canonical) {
    problems.push('export is not deterministic for unchanged data');
  }
  if (second.chunkVersion !== first.chunkVersion) problems.push('chunk version is not stable');

  if (registration.countRecords !== undefined) {
    const count = registration.countRecords(first.payload);
    if (!Number.isInteger(count) || count < 0)
      problems.push('record count is not a natural number');
    else if (options.expectedRecords !== undefined && count !== options.expectedRecords) {
      problems.push(`record count ${count} differs from expected ${options.expectedRecords}`);
    }
  }

  // The frozen import must answer a hostile chunk with a value, never by throwing.
  try {
    const hostile = await registration.module.import(campaignId, {
      moduleId,
      chunkVersion: first.chunkVersion,
      payload: { unexpected: ['shape'] },
    });
    if (hostile.ok) problems.push('import accepted a payload of the wrong shape');
  } catch {
    problems.push('import threw on a hostile chunk');
  }
  return problems;
}

/**
 * Transaction-aware import conformance (contract note 2026-10-27): a module that registers an
 * `ImportableModule` must accept its own export in `validate`, list that chunk version, answer a
 * hostile chunk with a safe error code instead of throwing, and report only valid warnings and
 * definitions. `validate` runs without a transaction, so it cannot write.
 */
export async function importContributorProblems(
  registration: ExportRegistration,
  campaignId: string,
): Promise<string[]> {
  const module = importableOf(registration);
  if (module === undefined)
    return ['module is not transaction-aware (contributor_not_transactional)'];
  const problems: string[] = [];
  if (module.moduleId !== registration.module.moduleId) problems.push('importer module id differs');
  const own = await registration.module.export(campaignId);
  if (!module.importChunkVersions.includes(own.chunkVersion)) {
    problems.push(`own chunk version ${own.chunkVersion} is not importable`);
  }
  const validated = await module.validate(own);
  if (!validated.ok) {
    problems.push(`own export does not validate (${String(validated.error)})`);
  } else {
    if (!validated.value.warnings.every((warning) => check(ImportWarning, warning))) {
      problems.push('validate reported an invalid warning');
    }
    if (!validated.value.defines.every((entry) => check(Id, entry.sourceId))) {
      problems.push('validate defined a source id that is not an Id');
    }
  }
  for (const payload of [{ unexpected: ['shape'] }, null, 'x'.repeat(100), [1, 2, 3]]) {
    try {
      const hostile = await module.validate({
        moduleId: module.moduleId,
        chunkVersion: own.chunkVersion,
        payload,
      });
      if (hostile.ok) problems.push('validate accepted a payload of the wrong shape');
      else if (!check(ImportCode, hostile.error))
        problems.push('validate error is not a safe code');
    } catch {
      problems.push('validate threw on a hostile chunk');
    }
  }
  return problems;
}
