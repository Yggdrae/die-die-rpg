/** Feature 14 web entry points: the app shell mounts the library, offers the preview, and lists the contribution. */

export { RulesLibrary, RulesPreview, RulesView } from './RulesLibrary.tsx';
export { browserRulesSource, type PinnedRules, type RulesSource } from './rules-source.ts';
export { RULES_ROUTE, rulesSearchContribution } from './search-contribution.ts';
