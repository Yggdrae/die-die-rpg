import type { SystemRef } from '@rpg/contracts';
import type { SystemPackage } from '@rpg/systems';

/**
 * Feature 14 library model (`_techspec.md` D-03, D-04, D-07): what a package's `rules` declaration renders as, with
 * no system-specific code (`PRD.md` s.89). Text is shown only when the licence allows it exactly, even if a section
 * carries it: load already refuses that contradiction, and this is the second gate (FR-010, `PRD.md` s.14).
 */

export type RulesState = 'integrated' | 'reference' | 'empty';
export type ReferenceReason = 'forbidden' | 'review_required' | 'not_integrated';

export const REFERENCE_REASON_TEXT: Readonly<Record<ReferenceReason, string>> = {
  forbidden: 'The licence does not permit including this text in the app.',
  review_required: 'Including this text in the app awaits licence review.',
  not_integrated: 'This text is not included in the app yet.',
};

export interface RulesSectionLink {
  readonly id: string;
  readonly title: string;
}

export interface RulesSection {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly categoryLabel: string;
  /** The quick rule, when declared and licence-allowed (FR-007). */
  readonly summary?: string;
  /** The full text, when declared and licence-allowed. */
  readonly body?: string;
  /** Declared references that resolve, in declared order (FR-004). */
  readonly references: readonly RulesSectionLink[];
}

export interface RulesGroup {
  readonly category: string;
  readonly label: string;
  readonly sections: readonly RulesSection[];
}

export interface RulesAttribution {
  readonly license: string;
  readonly attribution: string;
  readonly source: string;
}

export interface RulesLibraryModel {
  readonly ref: SystemRef;
  readonly name: string;
  readonly state: RulesState;
  /** Why no text is shown, for a `reference` library. */
  readonly reason?: ReferenceReason;
  readonly externalDocumentation?: string;
  readonly attribution: RulesAttribution;
  readonly groups: readonly RulesGroup[];
  /** Every section in tree order. */
  readonly sections: readonly RulesSection[];
  section(id: string): RulesSection | undefined;
}

/** `core_mechanics` → "Core mechanics" (D-03). */
export function categoryLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced === '' ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function referenceReason(permission: string): ReferenceReason {
  if (permission === 'forbidden') return 'forbidden';
  if (permission === 'review-required') return 'review_required';
  return 'not_integrated';
}

export function rulesLibrary(system: SystemPackage): RulesLibraryModel {
  const { manifest } = system;
  const permission = manifest.license.assets.rulesText;
  const textAllowed = permission === 'allowed';
  const declared = system.rules.sections;
  const titles = new Map(declared.map((section) => [section.id, section.title]));

  const order: string[] = [];
  const byCategory = new Map<string, RulesSection[]>();
  for (const declaredSection of declared) {
    const section: RulesSection = {
      id: declaredSection.id,
      title: declaredSection.title,
      category: declaredSection.category,
      categoryLabel: categoryLabel(declaredSection.category),
      ...(textAllowed && declaredSection.summary !== undefined
        ? { summary: declaredSection.summary }
        : {}),
      ...(textAllowed && declaredSection.body !== undefined ? { body: declaredSection.body } : {}),
      references: declaredSection.references.flatMap((id) => {
        const title = titles.get(id);
        return title === undefined || id === declaredSection.id ? [] : [{ id, title }];
      }),
    };
    let group = byCategory.get(section.category);
    if (group === undefined) {
      group = [];
      byCategory.set(section.category, group);
      order.push(section.category);
    }
    group.push(section);
  }
  const groups = order.map((category) => ({
    category,
    label: categoryLabel(category),
    sections: byCategory.get(category) ?? [],
  }));
  const sections = groups.flatMap((group) => group.sections);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const showsText = sections.some(
    (section) => section.body !== undefined || section.summary !== undefined,
  );
  const state: RulesState =
    sections.length === 0 ? 'empty' : showsText ? 'integrated' : 'reference';
  const external = manifest.integration.externalDocumentation;

  return {
    ref: manifest.ref,
    name: manifest.name,
    state,
    ...(state === 'reference' ? { reason: referenceReason(permission) } : {}),
    ...(external === undefined ? {} : { externalDocumentation: external }),
    attribution: {
      license: manifest.license.license,
      attribution: manifest.license.attribution,
      source: manifest.license.source,
    },
    groups,
    sections,
    section: (id) => byId.get(id),
  };
}

/** The rules text one package ships, in UTF-8 bytes (D-02 offline budget). */
export function rulesTextBytes(system: SystemPackage): number {
  const encoder = new TextEncoder();
  return system.rules.sections.reduce(
    (total, section) =>
      total +
      encoder.encode(section.title).length +
      encoder.encode(section.summary ?? '').length +
      encoder.encode(section.body ?? '').length,
    0,
  );
}
