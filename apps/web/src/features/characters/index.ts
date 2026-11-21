/** Feature 15 web entry points: the dashboard mounts the workspace over the open replica. */

export { CharacterWorkspace } from './CharacterWorkspace.tsx';
export {
  browserCharacterSource,
  type CharacterSource,
  installedRegistry,
} from './character-source.ts';
export { CHARACTER_ROUTE, characterSearchContribution } from './search-contribution.ts';
