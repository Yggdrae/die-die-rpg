/**
 * Architecture rules enforced by the build.
 *
 * Three rules, each traceable to a stated requirement. The guard cannot detect every
 * violation; it raises the cost of the obvious ones, which is enough to keep the pattern
 * visible in review (`.speckit/features/00-platform-foundation/tasks/task_09.md`).
 */

export interface SourceFile {
  /** Repository-relative, forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface Violation {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
  readonly remedy: string;
}

/**
 * Concrete system identifiers. Adding a system to the platform adds it here, which is the
 * point: the list should feel uncomfortable to grow.
 */
export const SYSTEM_IDS = [
  'cairn',
  'fate-core',
  'fate-accelerated',
  'fate-condensed',
  'mausritter',
  'mork-borg',
  'morkborg',
  'pathfinder',
  'dnd',
  'srd-5e',
  'dragonbane',
  'year-zero',
  'forbidden-lands',
  'symbaroum',
];

/**
 * The guard's own test fixtures are deliberate violations. Exempt from every rule, and
 * the only global exemption there is. Adding a second one is a finding, not a fix.
 */
const GLOBAL_EXEMPT = ['tools/guard/'];

/**
 * Additionally permitted to name a system.
 *
 * `systems/` is where system packages live. `packages/fixtures` is permitted because its
 * job includes asserting that the fixture system is neither MVP system.
 */
const SYSTEM_ID_EXEMPT = [...GLOBAL_EXEMPT, 'systems/', 'packages/fixtures/'];

function isGloballyExempt(path: string): boolean {
  return GLOBAL_EXEMPT.some((prefix) => path.startsWith(prefix));
}

/** Remove comments so prose about Cairn is not mistaken for a branch on Cairn. */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_match, prefix: string) => prefix);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/**
 * Rule 1 — no branch on system identity (`PRD.md` s.89).
 *
 * The central architectural criterion. A generic page reads `system.capabilities`; it
 * never asks which system this is. This is the rule most likely to be worked around under
 * deadline pressure in features 15, 18, and 19, so the message names the alternative.
 */
export function noSystemIdentity(file: SourceFile): Violation[] {
  if (SYSTEM_ID_EXEMPT.some((prefix) => file.path.startsWith(prefix))) {
    return [];
  }

  const code = stripComments(file.content);
  const violations: Violation[] = [];

  for (const systemId of SYSTEM_IDS) {
    const pattern = new RegExp(`['"\`]${systemId}[a-z0-9-]*['"\`]`, 'gi');
    for (const match of code.matchAll(pattern)) {
      violations.push({
        rule: 'no-system-identity',
        path: file.path,
        line: lineOf(code, match.index),
        message: `References the system identifier ${match[0]}.`,
        remedy:
          'Read system.capabilities instead. A generic screen must work with any conforming system (PRD.md s.89).',
      });
    }
  }

  return violations;
}

const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/g;

/**
 * Rule 2 — a feature never imports internals of another package.
 *
 * A workspace package is reachable through its published entry points only. A deep path
 * into another package `src/` couples two features to each other rather than to a
 * contract (`.speckit/features/_index.md`, rules 1 and 2).
 */
export function noDeepPackageImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path)) {
    return [];
  }

  const violations: Violation[] = [];
  const owner = file.path.split('/').slice(0, 2).join('/');

  for (const match of file.content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith('@rpg/')) {
      continue;
    }
    if (!specifier.includes('/src/')) {
      continue;
    }
    // A package reaching into its own source is not a cross-package violation.
    const targetPackage = specifier.split('/').slice(0, 2).join('/');
    if (owner.endsWith(targetPackage.replace('@rpg/', ''))) {
      continue;
    }

    violations.push({
      rule: 'no-deep-package-imports',
      path: file.path,
      line: lineOf(file.content, match.index),
      message: `Imports package internals: ${specifier}.`,
      remedy: 'Import the package entry point, or add what you need to its public contract.',
    });
  }

  return violations;
}

/**
 * Rule 3 — packages must not depend on applications.
 *
 * Dependencies point inward. `packages/contracts` in particular must not know about
 * Fastify, React, or any application (`docs/SPEC_GUIDELINE.md`, Architecture).
 */
export function noPackageToAppImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || !file.path.startsWith('packages/')) {
    return [];
  }

  const violations: Violation[] = [];
  for (const match of file.content.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    const importsApp =
      specifier.startsWith('@rpg/api') ||
      specifier.startsWith('@rpg/web') ||
      specifier.includes('../../apps/');
    if (!importsApp) {
      continue;
    }

    violations.push({
      rule: 'no-package-to-app-imports',
      path: file.path,
      line: lineOf(file.content, match.index),
      message: `Package imports an application: ${specifier}.`,
      remedy: 'Move the shared code into a package, or invert the dependency.',
    });
  }

  return violations;
}

export function noExternalMembershipStoreAccess(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    file.path.endsWith('.integration.test.ts') ||
    file.path.startsWith('packages/identity/') ||
    // Declared replica table for the current-user membership stream (feature 03 task 07).
    file.path === 'packages/sync/src/browser.ts'
  )
    return [];
  const pattern = /identity_campaign_memberships|membership-repository/gi;
  return [...file.content.matchAll(pattern)].map((match) => ({
    rule: 'no-external-membership-store-access',
    path: file.path,
    line: lineOf(file.content, match.index),
    message: 'Reads or writes identity membership storage outside feature 01.',
    remedy: 'Resolve roles through ActorResolver or use the narrow CampaignMembershipWriter.',
  }));
}

export function noExternalCampaignStoreAccess(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    file.path.endsWith('.integration.test.ts') ||
    file.path.startsWith('packages/campaigns/') ||
    file.path === 'packages/sync/src/browser.ts'
  )
    return [];
  const pattern =
    /campaign_(?:system_pins|module_pins|settings)|from\s+campaigns\b|into\s+campaigns\b/gi;
  return [...file.content.matchAll(pattern)].map((match) => ({
    rule: 'no-external-campaign-store-access',
    path: file.path,
    line: lineOf(file.content, match.index),
    message: 'Reads or writes campaign persistence outside feature 02.',
    remedy: 'Use CampaignContextResolver or the public campaign application boundary.',
  }));
}

/* ------------------------------------------------------------------------------------------
 * Feature 02 (campaign lifecycle) boundary rules.
 * Kept separate from other features' rules: names and helpers below are campaign-specific.
 * ---------------------------------------------------------------------------------------- */

const MODULE_SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/**
 * Campaign persistence internals: anything under `infra/` or a `schema` module of the
 * campaigns package, reached through a package subpath or a relative path into its `src/`.
 */
const CAMPAIGN_PERSISTENCE_SPECIFIER =
  /(?:^@rpg\/campaigns|(?:^|\/)campaigns\/src)\/(?:[^'"\n]*\/)?(?:infra(?:\/|$)|schema(?:\.[cm]?[jt]sx?)?$)/;

/**
 * Rule 4 (feature 02) — campaign persistence is imported only inside `packages/campaigns`.
 *
 * Other code reaches campaigns through the `@rpg/campaigns` entry point. Integration tests
 * elsewhere may name campaign tables in raw SQL (see `noExternalCampaignStoreAccess`), but
 * they may not import the repository or Drizzle schema modules.
 */
export function noCampaignPersistenceImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || file.path.startsWith('packages/campaigns/')) return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[2];
    if (specifier === undefined || !CAMPAIGN_PERSISTENCE_SPECIFIER.test(specifier)) continue;
    violations.push({
      rule: 'no-campaign-persistence-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Imports campaign persistence internals: ${specifier}.`,
      remedy:
        'Import from @rpg/campaigns, or use CampaignContextResolver and the public campaign application boundary.',
    });
  }
  return violations;
}

const TEST_FILE = /\.(?:test|e2e)\.tsx?$/;
const SYSTEM_ID_REFERENCE = String.raw`(?:\.|\b)(?:systemId|system\.id)\b`;
const SYSTEM_ID_BRANCH_PATTERNS: readonly RegExp[] = [
  // systemId === 'x', systemId !== `x`
  new RegExp(String.raw`${SYSTEM_ID_REFERENCE}\s*[!=]==?\s*['"\`]`, 'g'),
  // 'x' === ref.systemId
  /['"`]\s*[!=]==?\s*[\w.?]*\bsystemId\b/g,
  // switch (ref.systemId)
  /\bswitch\s*\([^)]*\bsystemId\b/g,
  // ['a', 'b'].includes(ref.systemId)
  /\.includes\(\s*[\w.?]*\bsystemId\s*\)/g,
  // layouts[ref.systemId]
  /\[\s*[\w.?]*\bsystemId\s*\]/g,
];

/**
 * Rule 5 (feature 02) — no branch on a system identifier value, whatever the identifier.
 *
 * `noSystemIdentity` catches known ids appearing as literals. This rule catches the branch
 * shape itself, so a newly added system cannot be special-cased without first being added
 * to a list. Comparing two ids (`a.systemId === b.systemId`) is identity matching and is
 * not flagged. Test files may compare against fixtures.
 */
export function noSystemIdBranch(file: SourceFile): Violation[] {
  if (SYSTEM_ID_EXEMPT.some((prefix) => file.path.startsWith(prefix)) || TEST_FILE.test(file.path))
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const pattern of SYSTEM_ID_BRANCH_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      violations.push({
        rule: 'no-system-id-branch',
        path: file.path,
        line: lineOf(code, match.index),
        message: 'Branches on a system identifier.',
        remedy:
          'Read declared manifest data (modes, options, capabilities). Only systems/ and the manifest layer may know a system id (PRD.md s.89).',
      });
    }
  }
  return violations;
}

export function noClientActorRoleClaims(file: SourceFile): Violation[] {
  // Tests forge a claim precisely to prove the server ignores it.
  if (isGloballyExempt(file.path) || TEST_FILE.test(file.path) || !file.path.startsWith('apps/'))
    return [];
  const pattern = /\b(?:actorRole|authenticatedRole|resolvedRole|campaignRole)\s*:/g;
  return [...file.content.matchAll(pattern)].map((match) => ({
    rule: 'no-client-actor-role-claims',
    path: file.path,
    line: lineOf(file.content, match.index),
    message: 'Declares a client-supplied role as actor identity.',
    remedy: 'Authenticate the user, then resolve the current role through ActorResolver.',
  }));
}

/* ------------------------------------------------------------------------------------------
 * Feature 01 (identity and membership) boundary rules.
 *
 * Together with `noExternalMembershipStoreAccess` (raw SQL naming the membership table) and
 * `noClientActorRoleClaims` (declaring a role claim), these leave `ActorResolver` as the only
 * supported way for code outside `packages/identity` to learn a user's campaign role:
 * the store cannot be read (SQL, import, or store class), and no client-controlled input
 * (header, body, query) can stand in for the answer.
 * ---------------------------------------------------------------------------------------- */

/** Overlapping patterns can describe the same defect; report each line once. */
function oneViolationPerLine(violations: Violation[]): Violation[] {
  const seen = new Set<number>();
  return violations.filter((violation) => !seen.has(violation.line) && seen.add(violation.line));
}

/**
 * Identity persistence internals: anything under `infra/` or a `schema` module of the
 * identity package, reached through a package subpath or a relative path into its `src/`.
 */
const IDENTITY_PERSISTENCE_SPECIFIER =
  /(?:^@rpg\/identity|(?:^|\/)identity\/src)\/(?:[^'"\n]*\/)?(?:infra(?:\/|$)|schema(?:\.[cm]?[jt]sx?)?$)/;

/**
 * Membership-store symbols (the narrow `PostgresCampaignMembershipWriter` is the declared
 * feature 02 creation boundary and is not listed). The `@rpg/identity` entry re-exports the PostgreSQL
 * repository so the composition root can build the runtime; nothing else may name it.
 */
const MEMBERSHIP_STORE_SYMBOLS = new Set([
  'PostgresMembershipRepository',
  'PostgresInvitationRepository',
  'identityCampaignMemberships',
  'identityInvitations',
  'identitySchema',
]);

const NAMED_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"][^'"\n]+['"]/g;

/**
 * Rule 6 (feature 01) — the membership store is imported only inside `packages/identity`.
 *
 * Integration tests elsewhere may name the table in raw SQL to observe persistence
 * (see `noExternalMembershipStoreAccess`); they may not import the repository, the Drizzle
 * schema, or any `infra/` module of the identity package.
 */
export function noMembershipStoreImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || file.path.startsWith('packages/identity/')) return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  const remedy =
    'Resolve roles through ActorResolver; the composition root builds the runtime with createPostgresIdentityRuntime.';

  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[2];
    if (specifier === undefined || !IDENTITY_PERSISTENCE_SPECIFIER.test(specifier)) continue;
    violations.push({
      rule: 'no-membership-store-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Imports identity persistence internals: ${specifier}.`,
      remedy,
    });
  }

  for (const match of code.matchAll(NAMED_IMPORT_PATTERN)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((part) => (part.trim().split(/\s+as\s+/)[0] ?? '').replace(/^type\s+/, '').trim())
      .filter((name) => MEMBERSHIP_STORE_SYMBOLS.has(name));
    for (const name of names) {
      violations.push({
        rule: 'no-membership-store-imports',
        path: file.path,
        line: lineOf(code, match.index),
        message: `Imports the membership store symbol ${name}.`,
        remedy,
      });
    }
  }
  return oneViolationPerLine(violations);
}

const ACTOR_ROLE_NAMES =
  'actorRole|callerRole|userRole|memberRole|authRole|currentRole|authenticatedRole|resolvedRole|campaignRole|membershipRole';
const CLIENT_INPUT = String.raw`(?:request|req)\s*\.\s*(?:body|query|params|headers)`;
const CLIENT_ROLE_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  {
    // headers['x-role'], headers.campaignRole, headers.get('x-campaign-role')
    pattern:
      /\bheaders?\b\s*(?:\??\.\s*\w*role\w*|\??\.?\s*\[\s*['"`][^'"`\]]*role[^'"`\]]*['"`]\s*\])/gi,
    message: 'Reads a role from a request header.',
  },
  {
    // any literal naming a role header: 'x-role', "X-Campaign-Role"
    pattern: /['"`]x-[\w-]*role[\w-]*['"`]/gi,
    message: 'Names a role header, which would carry a client-supplied role.',
  },
  {
    pattern: new RegExp(String.raw`${CLIENT_INPUT}\s*\??\.\s*(?:${ACTOR_ROLE_NAMES})\b`, 'g'),
    message: 'Reads an actor role from request input.',
  },
  {
    // request.headers.role, request.query['role'] (a body `role` is a target, not an actor)
    pattern:
      /(?:request|req)\s*\.\s*(?:headers|query)\s*(?:\??\.\s*role\b|\[\s*['"`]role['"`]\s*\])/g,
    message: 'Reads a role from request headers or query.',
  },
  {
    // const { actorRole } = request.body; const { role } = request.query
    pattern: new RegExp(
      String.raw`\{[^}]*\b(?:${ACTOR_ROLE_NAMES})\b[^}]*\}\s*=\s*${CLIENT_INPUT}\b`,
      'g',
    ),
    message: 'Destructures an actor role from request input.',
  },
  {
    pattern: /\{[^}]*\brole\b[^}]*\}\s*=\s*(?:request|req)\s*\.\s*(?:headers|query)\b/g,
    message: 'Destructures a role from request headers or query.',
  },
  {
    // an actor assembled from request input: { userId, campaignId, role: request.body.x }
    pattern: new RegExp(String.raw`\b(?:role|${ACTOR_ROLE_NAMES})\s*:\s*${CLIENT_INPUT}\b`, 'g'),
    message: 'Builds an actor role from request input.',
  },
];

/**
 * Rule 7 (feature 01) — authorization never reads a role the client supplied.
 *
 * Applies to applications and to every package except identity (which owns invitation
 * target roles). Test files may send a forged role precisely to prove it is ignored.
 * A `role` in a request body is a *target* (invitation or role change) validated by the
 * identity contracts, so only actor-shaped names and header/query roles are flagged.
 */
export function noClientSuppliedRoleAuthority(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    file.path.startsWith('packages/identity/') ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  )
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const { pattern, message } of CLIENT_ROLE_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      violations.push({
        rule: 'no-client-supplied-role-authority',
        path: file.path,
        line: lineOf(code, match.index),
        message,
        remedy:
          'Authenticate the user from the session, then resolve the role with ActorResolver. A client-supplied role is never authority.',
      });
    }
  }
  return oneViolationPerLine(violations);
}

/**
 * Feature 01 task 12, criterion 5: no export or publication path may reach a credential-bearing
 * identity table or field. Feature 07 (import/export) has no implementation yet; this rule makes
 * the first one fail the build instead of relying on review. Applies to the sync package (the
 * publication boundary) and to any non-test source whose path names an export, publication, or
 * replication unit. Identity owns these tables, and its tests prove their exclusion.
 */
const CREDENTIAL_SURFACE_PATH =
  /(?:^|[/._-])(?:export|exports|publication|publications|replication)(?:[/._-]|$)/i;
const CREDENTIAL_SURFACE_PATTERN =
  /\b(?:identity_(?:password_credentials|sessions|recovery_tokens|invitations|bindings|users)|identity(?:PasswordCredentials|Sessions|RecoveryTokens|Invitations|Bindings|Users)|token_digest|tokenDigest|password_hash|passwordHash|credential_digest|credentialDigest)\b/g;

export function noCredentialSurfaceInExport(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    file.path.startsWith('packages/identity/') ||
    TEST_FILE.test(file.path) ||
    !(file.path.startsWith('packages/sync/') || CREDENTIAL_SURFACE_PATH.test(file.path))
  ) {
    return [];
  }
  const code = stripComments(file.content);
  return [...code.matchAll(CREDENTIAL_SURFACE_PATTERN)].map((match) => ({
    rule: 'no-credential-surface-in-export',
    path: file.path,
    line: lineOf(code, match.index),
    message: `Export or publication code references credential-bearing identity storage (${match[0]}).`,
    remedy:
      'Export only approved membership fields through the identity public API. Credential, session, recovery, invitation, binding, and user tables never leave the server.',
  }));
}

/* ------------------------------------------------------------------------------------------
 * Feature 04 (visibility and authorization) boundary rules.
 *
 * Authorization has one decision point (`AuthorizationService.decide`, reached through
 * `ContentAccess` in the API). These rules keep application and content code from growing a
 * second one: no local role comparisons, and no content route registered without the
 * sanctioned `ContentAccess` pre-handler. Direct membership access is covered by
 * `noExternalMembershipStoreAccess` and `noMembershipStoreImports` above.
 * ---------------------------------------------------------------------------------------- */

const ROLE_LITERAL = '[\'"`](?:owner|gm|assistant_gm|player|observer)[\'"`]';
const ROLE_REFERENCE = String.raw`[\w$.?]*[rR]ole\w*`;
const LOCAL_ROLE_CHECK_PATTERNS: readonly RegExp[] = [
  // actor.role === 'gm', role !== 'player'
  new RegExp(String.raw`${ROLE_REFERENCE}\s*[!=]==?\s*${ROLE_LITERAL}`, 'g'),
  // 'gm' === actor.role
  new RegExp(String.raw`${ROLE_LITERAL}\s*[!=]==?\s*${ROLE_REFERENCE}`, 'g'),
  // ['owner', 'gm'].includes(actor.role)
  new RegExp(
    String.raw`\[[^\]]*${ROLE_LITERAL}[^\]]*\]\s*\.\s*(?:includes|indexOf)\(\s*${ROLE_REFERENCE}`,
    'g',
  ),
  // switch (actor.role)
  new RegExp(String.raw`\bswitch\s*\(\s*${ROLE_REFERENCE}\s*\)`, 'g'),
];

/**
 * Narrow, reasoned exceptions. Add here only with a reason; each is a candidate for removal.
 */
const LOCAL_ROLE_CHECK_ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    'apps/web/src/features/identity/CampaignAdmin.tsx',
    'UI affordance hint for member administration; the server re-decides every action.',
  ],
  [
    'apps/web/src/features/visibility/visibility-model.ts',
    'Filters member rows (role of a listed member, not the actor) and the control hint; the server decides.',
  ],
]);

/**
 * Rule 8 (feature 04) — no local role checks in application or content code.
 *
 * `identity` owns role values and `authorization` owns the role-to-capability decision. Any other
 * code comparing a role to a literal is a second, drifting copy of that matrix. Tests may assert
 * on role values.
 */
export function noLocalRoleChecks(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    file.path.startsWith('packages/identity/') ||
    file.path.startsWith('packages/authorization/') ||
    LOCAL_ROLE_CHECK_ALLOWED.has(file.path) ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  )
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const pattern of LOCAL_ROLE_CHECK_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      violations.push({
        rule: 'no-local-role-checks',
        path: file.path,
        line: lineOf(code, match.index),
        message: `Compares a role locally (${match[0].trim()}) instead of using the authorization decision.`,
        remedy:
          'Ask AuthorizationService.decide through ContentAccess (requireResource/requireCollection, authorizeResource). Role values are owned by identity and the role matrix by @rpg/authorization.',
      });
    }
  }
  return oneViolationPerLine(violations);
}

const ROUTE_CALL_PATTERN =
  /\b[\w$]+\s*\.\s*(?:get|post|put|patch|delete|head|options|route)\s*(?:<[^>()]*>)?\s*\(/g;
const CONTENT_ROUTE_MARKER =
  /\/campaigns\/:campaignId\/resources\/|\/resources\/:\w+|\bcontentRoute\s*:\s*true\b/;
const SANCTIONED_HELPER_CALL = /\.\s*(?:requireResource|requireCollection)\s*\(/;

/** Text of the balanced `( ... )` that starts at `open`, ignoring parens inside string literals. */
function balancedCall(code: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return code.slice(open);
}

/**
 * Rule 9 (feature 04) — a campaign-content route is registered only with the sanctioned helper.
 *
 * Static complement to the runtime route inventory (`ContentAccess.inventory`, which fails
 * `app.ready()`). A route under `/campaigns/:campaignId/resources/` or marked
 * `config: { contentRoute: true }` must pass `contentAccess.requireResource(...)` or
 * `requireCollection(...)` in its `preHandler`. Tests build deliberately unguarded routes.
 */
export function noUnsanctionedContentRoutes(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    file.path.endsWith('test-fixture.ts') ||
    !file.path.startsWith('apps/api/')
  )
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(ROUTE_CALL_PATTERN)) {
    const open = match.index + match[0].length - 1;
    const call = balancedCall(code, open);
    if (!CONTENT_ROUTE_MARKER.test(call) || SANCTIONED_HELPER_CALL.test(call)) continue;
    violations.push({
      rule: 'no-unsanctioned-content-routes',
      path: file.path,
      line: lineOf(code, match.index),
      message:
        'Registers a campaign-content route without the sanctioned ContentAccess pre-handler.',
      remedy:
        'Add contentAccess.requireResource(...) or requireCollection(...) to the route preHandler (apps/api/src/modules/authorization/content-access.ts); the runtime inventory also fails startup.',
    });
  }
  return violations;
}

const OBJECT_STORAGE_ADAPTER_DIR = 'packages/attachments/src/infra/s3/';
const OBJECT_STORAGE_PROVIDER_PATTERN =
  /\bS3Client\b|\bBun\s*\.\s*s3\b|\b(?:from|import)\s*\(?\s*['"](?:@aws-sdk\/[^'"]*|minio|@?minio\/[^'"]*)['"]/g;

/**
 * Rule 10 (feature 05 FR-001) — no feature touches an object-storage provider directly.
 *
 * Every consumer depends on the `ObjectStorage` port from `@rpg/attachments`; only the adapter
 * directory may name a provider client or SDK, so swapping MinIO for S3 or R2 stays one adapter.
 */
export function noDirectObjectStorageProvider(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || file.path.startsWith(OBJECT_STORAGE_ADAPTER_DIR)) return [];
  const code = stripComments(file.content);
  return [...code.matchAll(OBJECT_STORAGE_PROVIDER_PATTERN)].map((match) => ({
    rule: 'no-direct-object-storage-provider',
    path: file.path,
    line: lineOf(code, match.index),
    message: `References an object-storage provider directly: ${match[0].trim()}.`,
    remedy:
      'Depend on the ObjectStorage port from @rpg/attachments; provider clients live only in packages/attachments/src/infra/s3/.',
  }));
}

const PORTABILITY_DIR = 'packages/campaign-portability/';
const PORTABILITY_ALLOWED_WORKSPACE = new Set(['@rpg/contracts']);

/**
 * Rule 11 (feature 07 FR-003, feature 00 FR-009) — the export/import orchestrator knows no content
 * feature. Contributors reach it only through the frozen `ExportableModule` registry, so
 * `packages/campaign-portability` may import `@rpg/contracts` and no other workspace package.
 */
export function noPortabilityFeatureImports(file: SourceFile): Violation[] {
  if (isGloballyExempt(file.path) || !file.path.startsWith(PORTABILITY_DIR)) return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.startsWith('@rpg/')) continue;
    const name = specifier.split('/').slice(0, 2).join('/');
    if (PORTABILITY_ALLOWED_WORKSPACE.has(name)) continue;
    violations.push({
      rule: 'no-portability-feature-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `The campaign export/import orchestrator imports ${specifier}.`,
      remedy:
        'Register the feature as an ExportableModule contributor in the composition root (apps/api runtime or the web export composition); the orchestrator depends on @rpg/contracts only.',
    });
  }
  return violations;
}

const SEARCH_PACKAGE_DIR = 'packages/search/';
const SEARCH_WEB_DIR = 'apps/web/src/features/search/';
const SEARCH_PACKAGE_ALLOWED = new Set(['@rpg/contracts']);
const SEARCH_WEB_ALLOWED = new Set(['@rpg/contracts', '@rpg/search', '@rpg/authorization']);
const RELATIVE_FEATURE_IMPORT = /^\.\.\/(?!\.\.\/)[^/]+\//;

/**
 * Feature 20 FR-001 and D-01 — search knows no content feature. Contributors reach it only through the frozen
 * `SearchIndexer` registry, composed in the app shell: `packages/search` imports `@rpg/contracts` only, and the web
 * search feature imports contracts, the index, feature 04's predicate, and no other feature folder. The Playwright
 * harness composes like the shell and is exempt.
 */
export function noSearchFeatureImports(file: SourceFile): Violation[] {
  const web = file.path.startsWith(SEARCH_WEB_DIR);
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    file.path.endsWith('/e2e-harness.tsx') ||
    (!web && !file.path.startsWith(SEARCH_PACKAGE_DIR))
  ) {
    return [];
  }
  const allowed = web ? SEARCH_WEB_ALLOWED : SEARCH_PACKAGE_ALLOWED;
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    const name = specifier.split('/').slice(0, 2).join('/');
    const foreign = specifier.startsWith('@rpg/')
      ? !allowed.has(name)
      : web && RELATIVE_FEATURE_IMPORT.test(specifier);
    if (!foreign) continue;
    violations.push({
      rule: 'no-search-feature-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Global search imports ${specifier}.`,
      remedy:
        'Export a SearchIndexer contribution from the owning feature and list it in the app shell; search depends on @rpg/contracts (and, on the web, @rpg/search and @rpg/authorization) only.',
    });
  }
  return violations;
}

const SYSTEMS_DIR = 'packages/systems/src/';
const SYSTEMS_ALLOWED_IMPORTS = new Set(['@rpg/contracts', '@sinclair/typebox']);

/**
 * Feature 08: the package contract is pure, so the API and the browser load the same code and
 * packages stay declarations (`PRD.md` s.15, s.75). No persistence, UI, feature, or runtime API.
 */
export function noImpureSystemsImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    !file.path.startsWith(SYSTEMS_DIR) ||
    /.test(-support)?.ts$/.test(file.path)
  ) {
    return [];
  }
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || specifier.startsWith('.')) continue;
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    if (SYSTEMS_ALLOWED_IMPORTS.has(name)) continue;
    violations.push({
      rule: 'no-impure-systems-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `The system package contract imports ${specifier}.`,
      remedy:
        'Keep @rpg/systems pure: consumers depend on it, it depends on @rpg/contracts and TypeBox only.',
    });
  }
  return violations;
}

/**
 * Feature 16 content scope: code that handles campaign entities of every configured type. Inside
 * it, `.type` refers to an entity type; outside it, only `entityType`/`typeId` do.
 */
const CONTENT_SCOPE = [
  'packages/content/',
  'apps/api/src/modules/content/',
  'apps/web/src/features/content/',
];
/** The only production file that may name an entity type identifier (ADR-001). */
const ENTITY_TYPE_CONFIGURATION = 'packages/content/src/types.ts';
/**
 * The MVP type identifiers (feature 16 D-02). A type added later is caught by the branch shapes
 * below, not by this list, so it does not have to grow with the configuration.
 */
const ENTITY_TYPE_IDS = ['npc', 'creature', 'location', 'item', 'faction', 'note', 'scene'];
const ENTITY_TYPE_LITERAL = new RegExp(
  String.raw`['"\`](?:${ENTITY_TYPE_IDS.join('|')})['"\`]`,
  'g',
);

function entityTypeBranchPatterns(reference: string): RegExp[] {
  return [
    // entity.type === 'npc', typeId !== `scene` (not `typeof x !== 'string'`)
    new RegExp(String.raw`(?<!typeof\s+)${reference}\s*[!=]==?\s*['"\`]`, 'g'),
    // 'npc' === entity.type
    new RegExp(String.raw`['"\`]\s*[!=]==?\s*[\w.?]*${reference}`, 'g'),
    // switch (entity.type)
    new RegExp(String.raw`\bswitch\s*\([^)]*${reference}`, 'g'),
    // ['npc', 'item'].includes(entity.type)
    new RegExp(String.raw`\.includes\(\s*[\w.?]*${reference}\s*\)`, 'g'),
    // screens[entity.type]
    new RegExp(String.raw`\[\s*[\w.?]*${reference}\s*\]`, 'g'),
  ];
}
const ENTITY_TYPE_BRANCH_IN_SCOPE = entityTypeBranchPatterns(
  String.raw`(?:\b(?:entityType|typeId)\b|\.type\b)`,
);
const ENTITY_TYPE_BRANCH_ELSEWHERE = entityTypeBranchPatterns(String.raw`\b(?:entityType)\b`);

/**
 * Rule (feature 16, ADR-001) — one implementation for every entity type. A type differs only by
 * its configuration in `packages/content/src/types.ts`; no screen, route, applier, or rule may
 * branch on which type a record is (mirror of `no-system-id-branch`). Inside the content scope a
 * type-identifier literal is also rejected outside the configuration file. Tests may name types.
 */
export function noEntityTypeBranch(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    file.path === ENTITY_TYPE_CONFIGURATION ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  )
    return [];
  const inScope = CONTENT_SCOPE.some((prefix) => file.path.startsWith(prefix));
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  const report = (index: number, message: string) =>
    violations.push({
      rule: 'no-entity-type-branch',
      path: file.path,
      line: lineOf(code, index),
      message,
      remedy:
        'Read the type configuration (CONTENT_CONFIGURATION.type(id), labels, quickCreate) instead. Only packages/content/src/types.ts may name an entity type (feature 16 ADR-001).',
    });
  for (const pattern of inScope ? ENTITY_TYPE_BRANCH_IN_SCOPE : ENTITY_TYPE_BRANCH_ELSEWHERE) {
    for (const match of code.matchAll(pattern)) {
      report(match.index, `Branches on an entity type (${match[0].trim()}).`);
    }
  }
  if (inScope) {
    for (const match of code.matchAll(ENTITY_TYPE_LITERAL)) {
      report(match.index, `Names the entity type identifier ${match[0]}.`);
    }
  }
  return oneViolationPerLine(violations);
}

const CONTENT_PERSISTENCE_SPECIFIER = /^@rpg\/content\/postgres(?:$|\/)/;
/** Feature 16 itself and its composition root; everyone else uses the published directory. */
const CONTENT_PERSISTENCE_ALLOWED = [
  'packages/content/',
  'apps/api/src/modules/content/',
  'apps/api/src/runtime.ts',
];

/**
 * Rule (feature 16 task 10, FR-016) — other features reach campaign entities through the
 * `@rpg/content` root (`EntityDirectory` on the server, `EntityLocalRepository` on the device),
 * never through the feature's persistence entry point `@rpg/content/postgres` (tables,
 * repositories, services). Deep `src/` paths are already `no-deep-package-imports`. Tests may
 * seed through the repository.
 */
export function noContentPersistenceImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    CONTENT_PERSISTENCE_ALLOWED.some((prefix) => file.path.startsWith(prefix)) ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  )
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[2];
    if (specifier === undefined || !CONTENT_PERSISTENCE_SPECIFIER.test(specifier)) continue;
    violations.push({
      rule: 'no-content-persistence-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Imports feature 16 persistence: ${specifier}.`,
      remedy:
        'Resolve or list entities through EntityDirectory (server) or EntityLocalRepository (device), exported from @rpg/content.',
    });
  }
  return violations;
}

const ENGINE_DIRS = ['packages/formula/src/', 'packages/dice/src/engine/'];
const ENGINE_ALLOWED_IMPORTS = new Set(['@rpg/contracts']);

/**
 * Features 09 and 10: the engines are pure and independent of each other (`PRD.md` s.20, s.24, s.75).
 * They import contracts only: no persistence, UI, feature, runtime API, or the other engine.
 */
export function noImpureEngineImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    !ENGINE_DIRS.some((directory) => file.path.startsWith(directory)) ||
    TEST_FILE.test(file.path)
  ) {
    return [];
  }
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || specifier.startsWith('.')) continue;
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    if (ENGINE_ALLOWED_IMPORTS.has(name)) continue;
    violations.push({
      rule: 'no-impure-engine-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `An engine imports ${specifier}.`,
      remedy:
        'Keep the dice and formula engines pure: they depend on @rpg/contracts only, and a caller supplies every value.',
    });
  }
  return violations;
}

const ACTIONS_ENGINE_DIR = 'packages/actions/src/engine/';
const ACTIONS_ENGINE_ALLOWED = new Set([
  '@rpg/contracts',
  '@rpg/dice',
  '@rpg/formula',
  '@rpg/systems',
]);

/**
 * Feature 11: planning is pure. It reads declarations and state and writes nothing, so its engine imports
 * only contracts and the engines it composes. No persistence, UI, or runtime API.
 */
export function noImpureActionEngineImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    !file.path.startsWith(ACTIONS_ENGINE_DIR) ||
    TEST_FILE.test(file.path)
  ) {
    return [];
  }
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier === undefined || specifier.startsWith('.')) continue;
    const name = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : (specifier.split('/')[0] ?? specifier);
    // Only the pure half of the dice package: its root also carries records.
    if (name === '@rpg/dice' && specifier !== '@rpg/dice/engine') {
      violations.push({
        rule: 'no-impure-action-engine-imports',
        path: file.path,
        line: lineOf(code, match.index),
        message: `The action engine imports ${specifier}.`,
        remedy: 'Import @rpg/dice/engine: planning takes a result and rolls nothing.',
      });
      continue;
    }
    if (ACTIONS_ENGINE_ALLOWED.has(name)) continue;
    violations.push({
      rule: 'no-impure-action-engine-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `The action engine imports ${specifier}.`,
      remedy: 'Keep planning pure: declarations and state in, a plan out.',
    });
  }
  return violations;
}

const ACTIONS_PERSISTENCE_SPECIFIER = /^@rpg\/actions\/postgres(?:$|\/)/;
const ACTIONS_PERSISTENCE_ALLOWED = [
  'packages/actions/',
  'apps/api/src/modules/actions/',
  'apps/api/src/runtime.ts',
];

/**
 * Rule (feature 11, FR-013): other features plan and apply through the `@rpg/actions` root. The one
 * exception a target's owner needs is the adapter type, and it imports that as a type.
 */
export function noActionsPersistenceImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    ACTIONS_PERSISTENCE_ALLOWED.some((prefix) => file.path.startsWith(prefix)) ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  ) {
    return [];
  }
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[2];
    if (specifier === undefined || !ACTIONS_PERSISTENCE_SPECIFIER.test(specifier)) continue;
    const statement = code.slice(code.lastIndexOf('import', match.index), match.index);
    if (/^import\s+type\b/.test(statement)) continue;
    violations.push({
      rule: 'no-actions-persistence-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Imports feature 11 persistence: ${specifier}.`,
      remedy: 'Plan and apply through @rpg/actions; a target owner imports the adapter as a type.',
    });
  }
  return violations;
}

const DICE_PERSISTENCE_SPECIFIER = /^@rpg\/dice\/postgres(?:$|\/)/;
/** Feature 09 itself and its composition root; everyone else uses the published device API. */
const DICE_PERSISTENCE_ALLOWED = [
  'packages/dice/',
  'apps/api/src/modules/dice/',
  'apps/api/src/runtime.ts',
];

/**
 * Rule (feature 09, FR-012) — other features reach rolls through the `@rpg/dice` root
 * (`RollLocalRepository`), never through its persistence entry point. A roll is written only through the
 * applier, so its checks cannot be stepped around. Tests may seed through the repository.
 */
export function noDicePersistenceImports(file: SourceFile): Violation[] {
  if (
    isGloballyExempt(file.path) ||
    TEST_FILE.test(file.path) ||
    DICE_PERSISTENCE_ALLOWED.some((prefix) => file.path.startsWith(prefix)) ||
    !(file.path.startsWith('apps/') || file.path.startsWith('packages/'))
  )
    return [];
  const code = stripComments(file.content);
  const violations: Violation[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[2];
    if (specifier === undefined || !DICE_PERSISTENCE_SPECIFIER.test(specifier)) continue;
    violations.push({
      rule: 'no-dice-persistence-imports',
      path: file.path,
      line: lineOf(code, match.index),
      message: `Imports feature 09 persistence: ${specifier}.`,
      remedy: 'Roll and read through RollLocalRepository, exported from @rpg/dice.',
    });
  }
  return violations;
}

export const RULES = [
  noSystemIdentity,
  noDeepPackageImports,
  noPackageToAppImports,
  noExternalMembershipStoreAccess,
  noExternalCampaignStoreAccess,
  noCampaignPersistenceImports,
  noSystemIdBranch,
  noClientActorRoleClaims,
  noMembershipStoreImports,
  noClientSuppliedRoleAuthority,
  noCredentialSurfaceInExport,
  noLocalRoleChecks,
  noUnsanctionedContentRoutes,
  noDirectObjectStorageProvider,
  noPortabilityFeatureImports,
  noSearchFeatureImports,
  noImpureSystemsImports,
  noEntityTypeBranch,
  noContentPersistenceImports,
  noImpureEngineImports,
  noDicePersistenceImports,
  noImpureActionEngineImports,
  noActionsPersistenceImports,
];

export function checkFile(file: SourceFile): Violation[] {
  return RULES.flatMap((rule) => rule(file));
}

export function checkAll(files: readonly SourceFile[]): Violation[] {
  return files.flatMap(checkFile);
}
