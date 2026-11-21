import {
  type CapabilityKey,
  err,
  ok,
  type Result,
  type SystemRef,
  systemRefToString,
} from '@rpg/contracts';
import { type ExpressionValidators, loadSystemPackage, type PackageLoadError } from './load.ts';
import { canonicalJson } from './plain-data.ts';
import type { SystemDefinition, SystemPackage, SystemSummary } from './schema.ts';

export interface RejectedPackage {
  /** Where the package sat in the list; a rejected package's own identity is not trustworthy. */
  readonly index: number;
  readonly errors: readonly PackageLoadError[];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Installed systems, by exact version (`PRD.md` s.66). It serves packages; which one a campaign uses
 * is feature 02's pin. A published version is immutable, so the same reference with other content is
 * a conflict and the original keeps being served.
 */
export class SystemRegistry {
  readonly #packages = new Map<string, { system: SystemPackage; canonical: string }>();

  constructor(private readonly validators: ExpressionValidators = {}) {}

  load(candidate: unknown): Result<SystemPackage, readonly PackageLoadError[]> {
    const loaded = loadSystemPackage(candidate, this.validators);
    if (!loaded.ok) return loaded;
    const reference = systemRefToString(loaded.value.manifest.ref);
    const canonical = canonicalJson(loaded.value);
    const existing = this.#packages.get(reference);
    if (existing === undefined) {
      this.#packages.set(reference, { system: loaded.value, canonical });
      return loaded;
    }
    if (existing.canonical === canonical) return ok(existing.system);
    return err([
      {
        code: 'version_conflict',
        path: '/manifest/ref',
        message: `${reference} is already installed with different content; publish a new version.`,
      },
    ]);
  }

  /** One bad package never takes the others down. */
  loadAll(candidates: readonly unknown[]): {
    readonly loaded: readonly SystemRef[];
    readonly rejected: readonly RejectedPackage[];
  } {
    const loaded: SystemRef[] = [];
    const rejected: RejectedPackage[] = [];
    candidates.forEach((candidate, index) => {
      const result = this.load(candidate);
      if (result.ok) loaded.push(result.value.manifest.ref);
      else rejected.push({ index, errors: result.error });
    });
    return { loaded, rejected };
  }

  /** Exactly this version, or `undefined`: never a substitute. */
  resolve(ref: SystemRef): SystemPackage | undefined {
    return this.#packages.get(systemRefToString(ref))?.system;
  }

  /** Each installed system once, at its highest version. */
  list(): readonly SystemPackage[] {
    const latest = new Map<string, SystemPackage>();
    for (const { system } of this.#packages.values()) {
      const { systemId, version } = system.manifest.ref;
      const current = latest.get(systemId);
      if (current === undefined || compareVersions(version, current.manifest.ref.version) > 0) {
        latest.set(systemId, system);
      }
    }
    return [...latest.values()];
  }
}

/** What a generic page asks instead of which system this is (`PRD.md` s.89). */
export function hasCapability(system: SystemPackage, key: CapabilityKey): boolean {
  return system.capabilities.includes(key);
}

export function systemSummaryOf(system: SystemPackage): SystemSummary {
  const { ref, name, shortDescription, complexity, rulesEntryPoint, integration } = system.manifest;
  return {
    ref: { ...ref },
    name,
    shortDescription,
    complexity,
    documentationStatus: integration.rulesTextIntegrated
      ? 'integrated'
      : integration.externalDocumentation !== undefined
        ? 'external'
        : 'unavailable',
    rulesEntryPoint,
    integration: { ...integration },
  };
}

export function systemDefinitionOf(system: SystemPackage): SystemDefinition {
  return {
    summary: systemSummaryOf(system),
    gameModes: system.gameModes.map((mode) => ({ ...mode })),
    options: structuredClone(system.options) as SystemDefinition['options'],
    compatibleModules: system.manifest.compatibleModules.map((module) => ({ ...module })),
  };
}
