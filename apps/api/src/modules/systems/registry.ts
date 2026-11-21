import { FIXTURE_SYSTEM_PACKAGE } from '@rpg/fixtures';
import { ENGINE_VALIDATORS, INSTALLED_SYSTEM_PACKAGES } from '@rpg/installed-systems';
import { type SystemDefinition, SystemRegistry, systemDefinitionOf } from '@rpg/systems';

export { ENGINE_VALIDATORS };

/**
 * The API's composition of packages and engines (feature 10 D-11, shared with the browser through
 * `@rpg/installed-systems`). A package with a bad expression is refused at load and never reaches a table.
 */
export function createSystemRegistry(): SystemRegistry {
  return new SystemRegistry(ENGINE_VALIDATORS);
}

/** The fixture in development and tests, then every shipped package. */
export const DEFAULT_SYSTEM_PACKAGES: readonly unknown[] = [
  FIXTURE_SYSTEM_PACKAGE,
  ...INSTALLED_SYSTEM_PACKAGES,
];

/** A registry holding every package of `packages` that loads; a rejected one takes nothing else down. */
export function loadedRegistry(
  packages: readonly unknown[] = DEFAULT_SYSTEM_PACKAGES,
): SystemRegistry {
  const registry = createSystemRegistry();
  registry.loadAll(packages);
  return registry;
}

/** The campaign-facing projection of every installed package that loads (feature 08 BDD). */
export function installedSystemDefinitions(
  packages: readonly unknown[] = DEFAULT_SYSTEM_PACKAGES,
): readonly SystemDefinition[] {
  return loadedRegistry(packages).list().map(systemDefinitionOf);
}
