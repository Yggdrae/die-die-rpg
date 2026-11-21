/** Feature 20 web entry points (D-11): the app shell builds the service and mounts the screen. */

export { SearchWorkspace, useSearchService, useSearchVersion } from './SearchWorkspace.tsx';
export {
  createSearchService,
  type SearchActor,
  type SearchAnswer,
  type SearchContribution,
  type SearchResult,
  type SearchService,
} from './search-service.ts';
