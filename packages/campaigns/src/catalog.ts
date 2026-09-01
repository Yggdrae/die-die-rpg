import type { SystemCatalog, SystemDefinition, SystemSummary } from './contracts.ts';

export class StaticSystemCatalog implements SystemCatalog {
  readonly #systems: readonly SystemDefinition[];

  constructor(systems: readonly SystemDefinition[]) {
    this.#systems = systems.map((system) => structuredClone(system));
  }

  async list(query?: string): Promise<readonly SystemSummary[]> {
    const normalized = query?.trim().toLowerCase();
    return this.#systems
      .map((system) => system.summary)
      .filter(
        (summary, index, summaries) =>
          summaries.findIndex((candidate) => candidate.ref.systemId === summary.ref.systemId) ===
          index,
      )
      .filter(
        (summary) =>
          normalized === undefined ||
          normalized.length === 0 ||
          summary.name.toLowerCase().includes(normalized) ||
          summary.shortDescription.toLowerCase().includes(normalized),
      )
      .map((summary) => structuredClone(summary));
  }

  async resolveExact(ref: { readonly systemId: string; readonly version: string }) {
    const found = this.#systems.find(
      (system) =>
        system.summary.ref.systemId === ref.systemId && system.summary.ref.version === ref.version,
    );
    return found === undefined ? undefined : structuredClone(found);
  }

  async resolveLatest(systemId: string) {
    const matches = this.#systems
      .filter((system) => system.summary.ref.systemId === systemId)
      .sort((left, right) => compareVersions(right.summary.ref.version, left.summary.ref.version));
    return matches[0] === undefined ? undefined : structuredClone(matches[0]);
  }
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
