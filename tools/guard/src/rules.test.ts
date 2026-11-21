import { describe, expect, test } from 'bun:test';
import { join, sep } from 'node:path';
import { CAPABILITY_KEYS } from '@rpg/contracts';
import {
  checkFile,
  noActionsPersistenceImports,
  noCampaignPersistenceImports,
  noClientActorRoleClaims,
  noClientSuppliedRoleAuthority,
  noContentPersistenceImports,
  noCredentialSurfaceInExport,
  noDeepPackageImports,
  noDicePersistenceImports,
  noDirectObjectStorageProvider,
  noEntityTypeBranch,
  noExternalCampaignStoreAccess,
  noExternalMembershipStoreAccess,
  noImpureActionEngineImports,
  noImpureEngineImports,
  noImpureSystemsImports,
  noLocalRoleChecks,
  noMembershipStoreImports,
  noPackageToAppImports,
  noPortabilityFeatureImports,
  noSearchFeatureImports,
  noSystemIdBranch,
  noSystemIdentity,
  noUnsanctionedContentRoutes,
  SYSTEM_IDS,
} from './rules.ts';

/**
 * Every rule is demonstrated failing against a deliberately violating fixture.
 * A guard that has never failed has not been tested (task 09).
 */

describe('rule: no-system-identity', () => {
  test('FAILS on a branch over a system id', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        export function sheet(system: { id: string }) {
          if (system.id === 'cairn-2e') {
            return renderCairnSheet();
          }
          return renderDefault();
        }
      `,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-system-identity');
    // The message must name the alternative, not only report a violation.
    expect(violations[0]?.remedy).toContain('system.capabilities');
  });

  test('FAILS on a lookup table keyed by system', () => {
    const violations = noSystemIdentity({
      path: 'packages/sheet-engine/src/layouts.ts',
      content: `const layouts = { 'fate-core': fateLayout, 'cairn': cairnLayout };`,
    });

    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  test('PASSES on capability-driven code', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        export function sheet(system: { capabilities: string[] }) {
          return system.capabilities.includes('inventory-slots') ? withSlots() : plain();
        }
      `,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES when a system is named in prose, not in code', () => {
    const violations = noSystemIdentity({
      path: 'apps/web/src/CharacterSheet.tsx',
      content: `
        // Validated against cairn and fate-core in wave 3.
        /* Neither cairn nor fate-core may be named below this line. */
        export const sheet = () => null;
      `,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES inside systems/, which is where a system may name itself', () => {
    const violations = noSystemIdentity({
      path: 'systems/cairn/src/manifest.ts',
      content: `export const manifest = { systemId: 'cairn-2e', version: '1.0.0' };`,
    });

    expect(violations).toEqual([]);
  });
});

describe('feature 01 and 02 persistence boundaries', () => {
  test('FAILS on membership SQL outside identity', () => {
    expect(
      noExternalMembershipStoreAccess({
        path: 'packages/content/src/repository.ts',
        content: 'select role from identity_campaign_memberships',
      }),
    ).toHaveLength(1);
  });

  test('PASSES only the declared sync read adapter for the replicated membership cache', () => {
    expect(
      noExternalMembershipStoreAccess({
        path: 'packages/sync/src/browser.ts',
        content: 'identity_campaign_memberships: new Table({ role: column.text })',
      }),
    ).toEqual([]);
    expect(
      noExternalMembershipStoreAccess({
        path: 'packages/sync/src/bun-sqlite.ts',
        content: 'select role from identity_campaign_memberships',
      }),
    ).toHaveLength(1);
  });

  test('FAILS on campaign SQL outside campaigns', () => {
    expect(
      noExternalCampaignStoreAccess({
        path: 'packages/identity/src/read.ts',
        content: 'select * from campaigns',
      }),
    ).toHaveLength(1);
  });

  test('PASSES only the declared sync read adapter for replicated campaign tables', () => {
    expect(
      noExternalCampaignStoreAccess({
        path: 'packages/sync/src/browser.ts',
        content: 'campaign_settings: new Table({ campaign_id: column.text })',
      }),
    ).toEqual([]);
    expect(
      noExternalCampaignStoreAccess({
        path: 'packages/sync/src/authority.ts',
        content: 'select * from campaign_settings',
      }),
    ).toHaveLength(1);
  });

  test('PASSES a forged actor-role claim only inside a test that proves it is ignored', () => {
    const forged = 'const body = { targetRole: "player", actorRole: "owner" };';
    expect(
      noClientActorRoleClaims({
        path: 'apps/api/src/identity.integration.test.ts',
        content: forged,
      }),
    ).toEqual([]);
    expect(
      noClientActorRoleClaims({ path: 'apps/web/e2e/identity.e2e.ts', content: forged }),
    ).toEqual([]);
    expect(noClientActorRoleClaims({ path: 'apps/web/src/api.ts', content: forged })).toHaveLength(
      1,
    );
  });

  test('FAILS on a client actor-role claim', () => {
    expect(
      noClientActorRoleClaims({
        path: 'apps/api/src/bad-route.ts',
        content: 'const Body = Type.Object({ actorRole: Type.String() });',
      }),
    ).toHaveLength(1);
  });
});

describe('feature 01 identity boundary rules', () => {
  describe('rule: no-membership-store-imports', () => {
    const run = (path: string, content: string) =>
      noMembershipStoreImports({ path, content }).map((violation) => violation.rule);

    test.each([
      [
        "import { PostgresMembershipRepository } from '@rpg/identity/src/infra/postgres/membership-repository.ts';",
      ],
      ["import { identityCampaignMemberships } from '@rpg/identity/infra/postgres/schema';"],
      ["import { identityUsers } from '@rpg/identity/schema.ts';"],
      [
        "import { identityCampaignMemberships } from '../../identity/src/infra/postgres/schema.ts';",
      ],
      [
        "export { PostgresMembershipRepository } from '../../../identity/src/infra/postgres/membership-repository.ts';",
      ],
      ["const store = await import('@rpg/identity/src/infra/postgres/membership-repository.ts');"],
      ["const store = require('../../identity/src/infra/postgres/repositories');"],
      ["import { PostgresMembershipRepository } from '@rpg/identity';"],
      ["import { type PostgresInvitationRepository as Invitations } from '@rpg/identity';"],
      [
        "import { createPostgresIdentityRuntime, identityCampaignMemberships } from '@rpg/identity';",
      ],
    ])('FAILS on %s', (content) => {
      expect(run('apps/api/src/modules/content/routes.ts', content)).toEqual([
        'no-membership-store-imports',
      ]);
    });

    test('FAILS in an integration test outside identity, though raw SQL is allowed there', () => {
      expect(
        run(
          'packages/campaigns/src/infra/postgres/repository.integration.test.ts',
          "import { identityCampaignMemberships } from '../../../../identity/src/infra/postgres/schema.ts';",
        ),
      ).toEqual(['no-membership-store-imports']);
      expect(
        noExternalMembershipStoreAccess({
          path: 'packages/campaigns/src/infra/postgres/repository.integration.test.ts',
          content: 'select role from identity_campaign_memberships',
        }),
      ).toEqual([]);
    });

    test('PASSES on the published API: runtime builder, services, ActorResolver, writer contract', () => {
      expect(
        run(
          'packages/campaigns/src/infra/postgres/repository.integration.test.ts',
          "import { PostgresCampaignMembershipWriter } from '@rpg/identity';",
        ),
      ).toEqual([]);
      expect(
        run(
          'apps/api/src/runtime.ts',
          "import { createPostgresIdentityRuntime, type ActorResolver, type CampaignMembershipWriter, MembershipService } from '@rpg/identity';",
        ),
      ).toEqual([]);
    });

    test('PASSES inside packages/identity and ignores prose in comments', () => {
      expect(
        run(
          'packages/identity/src/main/postgres-identity.ts',
          "import { PostgresMembershipRepository } from '../infra/postgres/membership-repository.ts';",
        ),
      ).toEqual([]);
      expect(
        run(
          'apps/api/src/runtime.ts',
          "// import { PostgresMembershipRepository } from '@rpg/identity/src/infra/postgres/schema.ts';",
        ),
      ).toEqual([]);
    });
  });

  describe('rule: no-client-supplied-role-authority', () => {
    const run = (content: string, path = 'apps/api/src/modules/content/routes.ts') =>
      noClientSuppliedRoleAuthority({ path, content }).map((violation) => violation.rule);

    test.each([
      ["const role = request.headers['x-campaign-role'];"],
      ['const role = request.headers.campaignRole;'],
      ['const role = req.headers.get("x-role");'],
      ["const role = request.header('X-Role');"],
      ["const role = request.headers['role'];"],
      ['const role = request.headers.role;'],
      ['const role = request.query.role;'],
      ["const role = request.query['role'];"],
      ['const actor = request.body.actorRole;'],
      ['const actor = request.body?.callerRole;'],
      ['const actor = request.params.currentRole;'],
      ['const { actorRole } = request.body;'],
      ['const { userId, role } = request.query;'],
      ['const actor = { userId, campaignId, role: request.body.role };'],
      ['const actor = { userId, campaignId, role: req.headers.x };'],
      ["await fetch('/campaigns', { headers: { 'X-Campaign-Role': 'owner' } });"],
    ])('FAILS on %s', (content) => {
      expect(run(content).length).toBeGreaterThanOrEqual(1);
      expect(new Set(run(content))).toEqual(new Set(['no-client-supplied-role-authority']));
    });

    test('FAILS in web code that sends a role claim', () => {
      expect(
        run(
          "apiRequest('/campaigns', { headers: { 'x-actor-role': 'owner' } });",
          'apps/web/src/features/campaigns/CampaignDashboard.tsx',
        ),
      ).toEqual(['no-client-supplied-role-authority']);
    });

    test('FAILS in a non-identity package', () => {
      expect(run('const r = request.headers.role;', 'packages/sync/src/authority.ts')).toEqual([
        'no-client-supplied-role-authority',
      ]);
    });

    test('PASSES on the supported path: session user, then ActorResolver', () => {
      expect(
        run(`
          const user = request.authenticatedUser;
          const actor = await actors.resolve(user.userId, request.params.campaignId);
          if (!actor.ok) return reply.status(404).send(hidden);
          return service.update(actor.value, request.body);
        `),
      ).toEqual([]);
    });

    test('PASSES on a target role in a validated body and on the web role selector', () => {
      expect(
        run(`
          const result = await services.memberships.changeRole(
            user.userId, request.params.campaignId, request.params.userId, request.body.role);
          const issued = await invitations.issue(user.userId, id, request.body);
        `),
      ).toEqual([]);
      expect(
        run(
          "const role = String(new FormData(form).get('role')); apiRequest(url, { body: JSON.stringify({ targetRole: role }) });",
          'apps/web/src/features/identity/CampaignAdmin.tsx',
        ),
      ).toEqual([]);
    });

    test('PASSES inside packages/identity, tests, and comments', () => {
      const forged = "const role = request.headers['x-campaign-role'];";
      expect(run(forged, 'packages/identity/src/application/x.ts')).toEqual([]);
      expect(run(forged, 'apps/api/src/app.test.ts')).toEqual([]);
      expect(run(forged, 'apps/web/e2e/identity.e2e.ts')).toEqual([]);
      expect(run(`// ${forged}`)).toEqual([]);
    });
  });

  test('ActorResolver is the only supported role-read path', () => {
    const attempts: readonly (readonly [path: string, content: string])[] = [
      ['packages/content/src/read.ts', 'select role from identity_campaign_memberships'],
      [
        'packages/content/src/read.ts',
        "import { PostgresMembershipRepository } from '@rpg/identity';",
      ],
      [
        'packages/content/src/read.ts',
        "import { identityCampaignMemberships } from '../../identity/src/infra/postgres/schema.ts';",
      ],
      ['apps/api/src/modules/content/routes.ts', "const role = request.headers['x-role'];"],
      ['apps/api/src/modules/content/routes.ts', 'const { actorRole } = request.body;'],
      [
        'apps/api/src/modules/content/routes.ts',
        'const Body = Type.Object({ actorRole: Type.String() });',
      ],
      ['apps/web/src/api.ts', "fetch(url, { headers: { 'x-campaign-role': 'owner' } });"],
    ];
    for (const [path, content] of attempts) {
      expect(checkFile({ path, content }).length).toBeGreaterThanOrEqual(1);
    }
    expect(
      checkFile({
        path: 'packages/content/src/read.ts',
        content: `
          import type { ActorResolver } from '@rpg/identity';
          export async function load(actors: ActorResolver, userId: string, campaignId: string) {
            const actor = await actors.resolve(userId, campaignId);
            return actor.ok ? actor.value.role : undefined;
          }
        `,
      }),
    ).toEqual([]);
  });
});

describe('feature 02 campaign boundary rules', () => {
  describe('rule: no-campaign-persistence-imports', () => {
    const run = (path: string, content: string) =>
      noCampaignPersistenceImports({ path, content }).map((violation) => violation.rule);

    test.each([
      [
        "import { PostgresCampaignRepository } from '@rpg/campaigns/src/infra/postgres/repository.ts';",
      ],
      ["import { campaigns } from '@rpg/campaigns/infra/postgres/schema';"],
      ["import { campaigns } from '@rpg/campaigns/schema.ts';"],
      ["import { campaigns } from '../../campaigns/src/infra/postgres/schema.ts';"],
      ["export { campaigns } from '../../../campaigns/src/infra/postgres/schema.ts';"],
      ["const schema = await import('@rpg/campaigns/src/infra/postgres/schema.ts');"],
      ["const schema = require('../../campaigns/src/infra/postgres/repository');"],
    ])('FAILS on %s', (content) => {
      expect(run('apps/api/src/modules/campaigns/routes.ts', content)).toEqual([
        'no-campaign-persistence-imports',
      ]);
    });

    test('FAILS in an integration test outside the package, even though raw SQL is allowed there', () => {
      expect(
        run(
          'packages/identity/src/infra/postgres/ownership.integration.test.ts',
          "import { campaigns } from '../../../../campaigns/src/infra/postgres/schema.ts';",
        ),
      ).toEqual(['no-campaign-persistence-imports']);
      expect(
        noExternalCampaignStoreAccess({
          path: 'packages/identity/src/infra/postgres/ownership.integration.test.ts',
          content: 'insert into campaigns (id) values ($1)',
        }),
      ).toEqual([]);
    });

    test('PASSES on the package entry point and unrelated infra', () => {
      expect(
        run('apps/api/src/runtime.ts', "import { CampaignService } from '@rpg/campaigns';"),
      ).toEqual([]);
      expect(
        run(
          'apps/api/src/runtime.ts',
          "import { x } from '@rpg/sync/postgres'; import { y } from '../infra/db.ts';",
        ),
      ).toEqual([]);
      expect(
        run(
          'apps/web/src/features/campaigns/Dashboard.tsx',
          "import { z } from './infra/client.ts'; import { s } from './schema.ts';",
        ),
      ).toEqual([]);
    });

    test('PASSES inside packages/campaigns and ignores prose in comments', () => {
      expect(
        run('packages/campaigns/src/index.ts', "export * from './infra/postgres/repository.ts';"),
      ).toEqual([]);
      expect(
        run(
          'apps/api/src/runtime.ts',
          "// import { x } from '@rpg/campaigns/src/infra/postgres/schema.ts';",
        ),
      ).toEqual([]);
    });
  });

  describe('rule: no-system-id-branch', () => {
    const run = (content: string, path = 'packages/campaigns/src/domain.ts') =>
      noSystemIdBranch({ path, content }).map((violation) => violation.rule);

    test.each([
      ["if (campaign.system.systemId === 'some-future-system') return special();"],
      ['if (ref.systemId !== `other-system`) return;'],
      ["const special = 'future-system' === ref.systemId;"],
      ['switch (campaign.system.systemId) { case "a": return 1; }'],
      ["if (['a', 'b'].includes(ref.systemId)) return;"],
      ['const layout = layouts[ref.systemId];'],
    ])('FAILS on %s', (content) => {
      expect(run(content)).toEqual(['no-system-id-branch']);
    });

    test('PASSES on identity matching between two references', () => {
      expect(
        run('return a.summary.ref.systemId === b.systemId && ref.version === other.version;'),
      ).toEqual([]);
    });

    test('PASSES in systems/, fixtures, test files, and comments', () => {
      const branch = "if (ref.systemId === 'x') return;";
      expect(run(branch, 'systems/x/src/manifest.ts')).toEqual([]);
      expect(run(branch, 'packages/fixtures/src/campaign.ts')).toEqual([]);
      expect(run(branch, 'packages/campaigns/src/domain.test.ts')).toEqual([]);
      expect(run("// if (ref.systemId === 'x') return;")).toEqual([]);
    });
  });

  test('current campaign-facing code shape passes both rules', () => {
    const file = {
      path: 'apps/web/src/features/campaigns/CampaignDashboard.tsx',
      content: `
        import type { CampaignView } from '@rpg/campaigns';
        const match = candidate.summary.ref.systemId === summary.ref.systemId;
      `,
    };
    expect(noCampaignPersistenceImports(file)).toEqual([]);
    expect(noSystemIdBranch(file)).toEqual([]);
  });
});

describe('rule: no-deep-package-imports', () => {
  test('FAILS on reaching into another package src', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.tsx',
      content: `import { secret } from '@rpg/contracts/src/internal/secret.ts';`,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-deep-package-imports');
  });

  test('PASSES on importing a package entry point', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.tsx',
      content: `import { EntityEnvelope } from '@rpg/contracts';`,
    });

    expect(violations).toEqual([]);
  });

  test('PASSES on a declared subpath export', () => {
    const violations = noDeepPackageImports({
      path: 'apps/web/src/Session.test.tsx',
      content: `import { InMemoryRepository } from '@rpg/contracts/testing';`,
    });

    expect(violations).toEqual([]);
  });
});

describe('rule: no-package-to-app-imports', () => {
  test('FAILS when a package imports an app', () => {
    const violations = noPackageToAppImports({
      path: 'packages/contracts/src/entity.ts',
      content: `import { buildApp } from '@rpg/api';`,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-package-to-app-imports');
  });

  test('FAILS on a relative climb into apps', () => {
    const violations = noPackageToAppImports({
      path: 'packages/fixtures/src/index.ts',
      content: `import { App } from '../../apps/web/src/App.tsx';`,
    });

    expect(violations).toHaveLength(1);
  });

  test('PASSES when an app imports a package', () => {
    const violations = noPackageToAppImports({
      path: 'apps/api/src/app.ts',
      content: `import { ApiError } from '@rpg/contracts';`,
    });

    expect(violations).toEqual([]);
  });
});

describe('rule: no-credential-surface-in-export (feature 01 task 12)', () => {
  const run = (path: string, content: string) =>
    noCredentialSurfaceInExport({ path, content }).map((violation) => violation.rule);

  test.each([
    ['packages/import-export/src/export.ts', 'select token_digest from identity_invitations'],
    ['modules/export/campaign-export.ts', 'db.select().from(identitySessions)'],
    [
      'packages/sync/src/bun-sqlite.ts',
      "const sql = 'select * from identity_password_credentials'",
    ],
    ['apps/api/src/modules/export/routes.ts', 'row.passwordHash'],
    ['packages/sync/src/publication.ts', 'columns: [identity_bindings.subject]'],
    [
      'packages/campaigns/src/replication.ts',
      'select credential_digest from identity_recovery_tokens',
    ],
  ])('FAILS on %s', (path, content) => {
    expect(run(path, content)).toContain('no-credential-surface-in-export');
  });

  test('PASSES membership-only export, tests, identity itself, and prose comments', () => {
    expect(
      run('packages/import-export/src/export.ts', 'select role, version from members'),
    ).toEqual([]);
    expect(
      run(
        'packages/sync/src/publication.integration.test.ts',
        "expect(t).not.toContain('identity_sessions')",
      ),
    ).toEqual([]);
    expect(run('packages/identity/src/export.ts', 'identity_sessions')).toEqual([]);
    expect(run('packages/sync/src/export.ts', '// never export identity_sessions')).toEqual([]);
    expect(run('apps/api/src/modules/auth/routes.ts', 'identity_sessions')).toEqual([]);
  });

  test('is part of the full rule set', () => {
    const rules = checkFile({
      path: 'packages/import-export/src/export.ts',
      content: 'select token_digest from identity_invitations',
    }).map((violation) => violation.rule);
    expect(rules).toContain('no-credential-surface-in-export');
  });
});

describe('checkFile', () => {
  test('reports violations from every rule at once', () => {
    const violations = checkFile({
      path: 'packages/sheet-engine/src/bad.ts',
      content: `
        import { buildApp } from '@rpg/api';
        import { x } from '@rpg/contracts/src/internal.ts';
        export const layout = { 'cairn-2e': 1 };
      `,
    });

    const rules = new Set(violations.map((violation) => violation.rule));
    expect(rules).toEqual(
      new Set(['no-system-identity', 'no-deep-package-imports', 'no-package-to-app-imports']),
    );
  });
});

describe('feature 04 authorization boundary rules', () => {
  describe('rule: no-local-role-checks', () => {
    const path = 'apps/api/src/modules/notes/service.ts';
    const names = (content: string, filePath = path) =>
      noLocalRoleChecks({ path: filePath, content });

    test('FAILS on role literal comparisons and names file, rule and boundary', () => {
      const cases = [
        `if (actor.role === 'gm') reveal();`,
        `if (role !== "player") return;`,
        `if ('owner' === membership.role) allow();`,
        `const ok = ['owner', 'gm'].includes(actor.role);`,
        `switch (actor.role) { default: break; }`,
      ];
      for (const content of cases) {
        const violations = names(content);
        expect(violations).toHaveLength(1);
        expect(violations[0]?.rule).toBe('no-local-role-checks');
        expect(violations[0]?.path).toBe(path);
        expect(violations[0]?.remedy).toContain('AuthorizationService.decide');
        expect(violations[0]?.remedy).toContain('ContentAccess');
      }
    });

    test('FAILS in packages (not only apps)', () => {
      expect(names(`if (actor.role === 'gm') x();`, 'packages/notes/src/a.ts')).toHaveLength(1);
    });

    test('PASSES in tests, identity, authorization, and narrow allowlisted files', () => {
      const content = `if (actor.role === 'gm') x();`;
      for (const filePath of [
        'apps/api/src/modules/notes/service.test.ts',
        'apps/web/e2e/a.e2e.ts',
        'packages/identity/src/domain/roles.ts',
        'packages/authorization/src/authorization.ts',
        'apps/web/src/features/identity/CampaignAdmin.tsx',
        'tools/guard/src/fixture.ts',
      ]) {
        expect(names(content, filePath)).toEqual([]);
      }
    });

    test('PASSES on decision-based code and on comments', () => {
      expect(
        names(`
          // role === 'gm' is decided by authorization
          const decision = access.decide(facts, 'read');
          if (decision.allowed) show();
          const roleLabel = labels[role];
        `),
      ).toEqual([]);
    });
  });

  describe('direct membership access outside identity (feature 01 rules, feature 04 fixtures)', () => {
    test('FAILS content code that queries the membership table or imports its store', () => {
      const sql = noExternalMembershipStoreAccess({
        path: 'apps/api/src/modules/notes/repository.ts',
        content: 'select role from identity_campaign_memberships where user_id = $1',
      });
      expect(sql).toHaveLength(1);
      expect(sql[0]?.remedy).toContain('ActorResolver');

      const imports = noMembershipStoreImports({
        path: 'apps/api/src/modules/notes/repository.ts',
        content: `import { identityCampaignMemberships } from '@rpg/identity';`,
      });
      expect(imports).toHaveLength(1);
      expect(imports[0]?.rule).toBe('no-membership-store-imports');
      expect(imports[0]?.remedy).toContain('ActorResolver');
    });

    test('PASSES inside identity', () => {
      expect(
        noExternalMembershipStoreAccess({
          path: 'packages/identity/src/infra/x.ts',
          content: 'select 1 from identity_campaign_memberships',
        }),
      ).toEqual([]);
    });
  });

  describe('rule: no-unsanctioned-content-routes', () => {
    const path = 'apps/api/src/modules/notes/routes.ts';
    const run = (content: string, filePath = path) =>
      noUnsanctionedContentRoutes({ path: filePath, content });

    test('FAILS a content route without the helper and names the boundary', () => {
      const violations = run(`
        app.get('/campaigns/:campaignId/resources/notes/:resourceId', async () => ({}));
      `);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe('no-unsanctioned-content-routes');
      expect(violations[0]?.path).toBe(path);
      expect(violations[0]?.remedy).toContain('requireResource');
      expect(violations[0]?.remedy).toContain('content-access.ts');
    });

    test('FAILS a route marked contentRoute and a route with only a session hook', () => {
      expect(
        run(`app.get('/notes', { config: { contentRoute: true } }, async () => ({}));`),
      ).toHaveLength(1);
      expect(
        run(
          `app.patch('/campaigns/:campaignId/resources/x/:id', { preHandler: [requireAuthenticatedUser] }, h);`,
        ),
      ).toHaveLength(1);
    });

    test('PASSES with requireResource or requireCollection', () => {
      expect(
        run(`
          app.get('/campaigns/:campaignId/resources/notes', {
            preHandler: [requireAuthenticatedUser, access.requireCollection({ capability: 'read', resourceClass: 'note' })],
          }, h);
          app.patch('/campaigns/:campaignId/resources/:class/:resourceId/visibility', {
            preHandler: [access.requireResource({ capability: 'reveal', resourceClass: pick })],
          }, h);
        `),
      ).toEqual([]);
    });

    test('PASSES on non-content routes, tests, and outside apps/api', () => {
      expect(run(`app.get('/health', async () => ({}));`)).toEqual([]);
      expect(
        run(`app.get('/campaigns/:campaignId/resources/x', h);`, 'apps/api/src/a.test.ts'),
      ).toEqual([]);
      expect(run(`app.get('/campaigns/:campaignId/resources/x', h);`, 'apps/web/src/a.ts')).toEqual(
        [],
      );
    });
  });
});

describe('rule: no-direct-object-storage-provider (feature 05 FR-001)', () => {
  const run = (content: string, path = 'apps/api/src/modules/attachments/routes.ts') =>
    noDirectObjectStorageProvider({ path, content });

  test('FAILS on a provider client or SDK outside the adapter', () => {
    expect(run('const s3 = new Bun.S3Client({ bucket });')).toHaveLength(1);
    expect(run('const file = Bun.s3.file(key);')).toHaveLength(1);
    expect(run(`import { S3Client } from '@aws-sdk/client-s3';`)).toHaveLength(2);
    expect(run(`import * as Minio from 'minio';`)).toHaveLength(1);
    expect(run(`const m = await import('minio');`, 'packages/campaigns/src/x.ts')).toHaveLength(1);
    const [violation] = run('new Bun.S3Client({})');
    expect(violation?.rule).toBe('no-direct-object-storage-provider');
    expect(violation?.remedy).toContain('ObjectStorage port');
  });

  test('PASSES inside the adapter directory, in comments, and through the port', () => {
    expect(
      run('new Bun.S3Client({})', 'packages/attachments/src/infra/s3/bun-s3-storage.ts'),
    ).toEqual([]);
    expect(run('// MinIO behind Bun.S3Client is an adapter detail.\nconst a = 1;')).toEqual([]);
    expect(
      run(`import type { ObjectStorage } from '@rpg/attachments';\nconst minioPort = 9000;`),
    ).toEqual([]);
  });
});

describe('rule: no-portability-feature-imports (feature 07 FR-003)', () => {
  const run = (content: string, path = 'packages/campaign-portability/src/orchestrator.ts') =>
    noPortabilityFeatureImports({ path, content });

  test('FAILS when the orchestrator imports a content feature', () => {
    expect(run(`import { AttachmentManifestExporter } from '@rpg/attachments';`)).toHaveLength(1);
    expect(run(`import type { CampaignRecord } from '@rpg/campaigns';`)).toHaveLength(1);
    expect(run(`import { identityUsers } from '@rpg/identity/postgres';`)).toHaveLength(1);
    const [violation] = run(`import { x } from '@rpg/sync';`);
    expect(violation?.rule).toBe('no-portability-feature-imports');
    expect(violation?.remedy).toContain('ExportableModule');
  });

  test('PASSES for contracts, external libraries, relative files, and other packages', () => {
    expect(run(`import type { ExportableModule } from '@rpg/contracts';`)).toEqual([]);
    expect(run(`import { Type } from '@sinclair/typebox';\nimport { x } from './zip.ts';`)).toEqual(
      [],
    );
    expect(run(`// Feature 05 (@rpg/attachments) registers itself.\nconst a = 1;`)).toEqual([]);
    expect(
      run(
        `import { AttachmentManifestExporter } from '@rpg/attachments';`,
        'apps/api/src/runtime.ts',
      ),
    ).toEqual([]);
  });
});

describe('rule: no-search-feature-imports (feature 20 FR-001)', () => {
  test('FAILS when search imports a content feature', () => {
    const [violation] = noSearchFeatureImports({
      path: 'packages/search/src/search-index.ts',
      content: `import { ContentSearchIndexer } from '@rpg/content';`,
    });
    expect(violation?.rule).toBe('no-search-feature-imports');
    expect(violation?.remedy).toContain('SearchIndexer');
    expect(
      noSearchFeatureImports({
        path: 'packages/search/src/search-index.ts',
        content: `import { visibilityAdmits } from '@rpg/authorization';`,
      }),
    ).toHaveLength(1);
    for (const content of [
      `import { browserContentSource } from '../content/index.ts';`,
      `import type { CharacterRecord } from '@rpg/characters';`,
    ]) {
      expect(
        noSearchFeatureImports({
          path: 'apps/web/src/features/search/SearchWorkspace.tsx',
          content,
        }),
      ).toHaveLength(1);
    }
  });

  test('PASSES for allowed imports, tests, the harness, and the shell', () => {
    const web = 'apps/web/src/features/search/search-service.ts';
    expect(
      noSearchFeatureImports({
        path: web,
        content: `import { SearchIndex } from '@rpg/search';
import { visibilityAdmits } from '@rpg/authorization';
import type { SearchIndexer } from '@rpg/contracts';
import { x } from './search-model.ts';
import { routeHref } from '../../routes.ts';`,
      }),
    ).toEqual([]);
    const foreign = `import { browserContentSource } from '../content/index.ts';`;
    for (const path of [
      'apps/web/src/features/search/search.test.tsx',
      'apps/web/src/features/search/e2e-harness.tsx',
      'apps/web/src/features/campaigns/CampaignDashboard.tsx',
    ]) {
      expect(noSearchFeatureImports({ path, content: foreign })).toEqual([]);
    }
  });
});

describe('rule: no-impure-engine-imports (features 09 and 10)', () => {
  test('FAILS for persistence, UI, runtime imports, and the other engine', () => {
    for (const [path, specifier] of [
      ['packages/formula/src/parser.ts', 'drizzle-orm'],
      ['packages/formula/src/parser.ts', 'node:fs'],
      ['packages/formula/src/parser.ts', '@rpg/dice'],
      ['packages/dice/src/engine/parser.ts', '@rpg/formula'],
      ['packages/dice/src/engine/parser.ts', '@rpg/systems'],
      ['packages/dice/src/engine/parser.ts', 'react'],
    ] as const) {
      const [violation] = noImpureEngineImports({
        path,
        content: `import { x } from '${specifier}';`,
      });
      expect(violation?.rule).toBe('no-impure-engine-imports');
    }
  });

  test('PASSES for contracts, relative files, tests, and code outside the engines', () => {
    const run = (content: string, path = 'packages/dice/src/engine/parser.ts') =>
      noImpureEngineImports({ path, content });
    expect(run(`import { ok } from '@rpg/contracts';`)).toEqual([]);
    expect(run(`import { x } from './model.ts';`)).toEqual([]);
    expect(run(`import { x } from 'node:fs';`, 'packages/dice/src/engine/a.test.ts')).toEqual([]);
    expect(run(`import { x } from 'drizzle-orm';`, 'packages/dice/src/records.ts')).toEqual([]);
  });
});

describe('rule: no-impure-action-engine-imports (feature 11)', () => {
  const run = (specifier: string, path = 'packages/actions/src/engine/planner.ts') =>
    noImpureActionEngineImports({ path, content: `import { x } from '${specifier}';` });

  test('FAILS for persistence, UI, runtime, and the dice package root', () => {
    for (const specifier of ['drizzle-orm', 'react', 'node:fs', '@rpg/sync', '@rpg/dice']) {
      expect(run(specifier)[0]?.rule).toBe('no-impure-action-engine-imports');
    }
  });

  test('PASSES for contracts, the engines it composes, tests, and code outside the engine', () => {
    for (const specifier of [
      '@rpg/contracts',
      '@rpg/formula',
      '@rpg/systems',
      '@rpg/dice/engine',
    ]) {
      expect(run(specifier)).toEqual([]);
    }
    expect(run('node:fs', 'packages/actions/src/engine/a.test.ts')).toEqual([]);
    expect(run('drizzle-orm', 'packages/actions/src/records.ts')).toEqual([]);
  });
});

describe('rule: no-actions-persistence-imports (feature 11)', () => {
  test('FAILS for a value import from another feature', () => {
    const [violation] = noActionsPersistenceImports({
      path: 'packages/content/src/application.ts',
      content: `import { EffectApplicationService } from '@rpg/actions/postgres';`,
    });
    expect(violation?.rule).toBe('no-actions-persistence-imports');
  });

  test('PASSES for the feature, its composition, tests, and a target owner type import', () => {
    const run = (path: string, content = `import { x } from '@rpg/actions/postgres';`) =>
      noActionsPersistenceImports({ path, content });
    expect(run('packages/actions/src/application.ts')).toEqual([]);
    expect(run('apps/api/src/runtime.ts')).toEqual([]);
    expect(run('apps/api/src/modules/sync/a.test.ts')).toEqual([]);
    expect(
      run(
        'packages/characters/src/adapter.ts',
        `import type { EffectTargetAdapter } from '@rpg/actions/postgres';`,
      ),
    ).toEqual([]);
  });
});

describe('rule: no-dice-persistence-imports (feature 09)', () => {
  const run = (path: string) =>
    noDicePersistenceImports({ path, content: `import { x } from '@rpg/dice/postgres';` });

  test('FAILS for any other feature or screen', () => {
    for (const path of [
      'packages/content/src/application.ts',
      'apps/web/src/features/dice/roll-source.ts',
      'apps/api/src/modules/content/routes.ts',
    ]) {
      expect(run(path)[0]?.rule).toBe('no-dice-persistence-imports');
    }
  });

  test('PASSES for the feature, its composition root, tests, and the published root', () => {
    expect(run('packages/dice/src/application.ts')).toEqual([]);
    expect(run('apps/api/src/modules/dice/appliers.ts')).toEqual([]);
    expect(run('apps/api/src/runtime.ts')).toEqual([]);
    expect(run('apps/api/src/modules/sync/a.test.ts')).toEqual([]);
    expect(
      noDicePersistenceImports({
        path: 'apps/web/src/a.ts',
        content: `import { x } from '@rpg/dice';`,
      }),
    ).toEqual([]);
  });
});

describe('rule: no-impure-systems-imports (feature 08)', () => {
  const run = (content: string, path = 'packages/systems/src/registry.ts') =>
    noImpureSystemsImports({ path, content });

  test('FAILS for persistence, UI, feature, and runtime imports', () => {
    for (const specifier of ['drizzle-orm', 'react', '@rpg/campaigns', 'node:fs']) {
      const [violation] = run(`import { x } from '${specifier}';`);
      expect(violation?.rule).toBe('no-impure-systems-imports');
    }
  });

  test('PASSES for contracts, TypeBox, relative files, tests, and other packages', () => {
    expect(run(`import { SystemRef } from '@rpg/contracts';`)).toEqual([]);
    expect(run(`import { Value } from '@sinclair/typebox/value';`)).toEqual([]);
    expect(run(`import { load } from './load.ts';`)).toEqual([]);
    expect(
      run(`import { readFileSync } from 'node:fs';`, 'packages/systems/src/a.test.ts'),
    ).toEqual([]);
    expect(run(`import { x } from 'drizzle-orm';`, 'packages/campaigns/src/a.ts')).toEqual([]);
  });
});

describe('closed capability registry (feature 08)', () => {
  test('no capability key names a system', () => {
    for (const key of Object.keys(CAPABILITY_KEYS)) {
      for (const systemId of SYSTEM_IDS) {
        expect(key.replaceAll('_', '-')).not.toContain(systemId);
      }
    }
  });
});

describe('rule: no-entity-type-branch (feature 16 ADR-001)', () => {
  const run = (content: string, path = 'packages/content/src/application.ts') =>
    noEntityTypeBranch({ path, content }).map((violation) => violation.rule);

  test.each([
    ["if (entity.type === 'npc') return special();"],
    ['if (record.type !== `vehicle`) return;'],
    ["const special = 'location' === entity.type;"],
    ['switch (entity.type) { case "a": return 1; }'],
    ["if (['npc', 'creature'].includes(entity.type)) return;"],
    ['const Screen = screens[entity.type];'],
    ["if (typeId === 'faction') return;"],
    ["const quick = { type: 'npc', name };"],
    ['const label = "scene";'],
  ])('FAILS in the content scope on %s', (content) => {
    expect(run(content)).toEqual(['no-entity-type-branch']);
  });

  test('FAILS in content routes and web content screens too', () => {
    const branch = "if (entity.type === 'item') return;";
    expect(run(branch, 'apps/api/src/modules/content/routes.ts')).toEqual([
      'no-entity-type-branch',
    ]);
    expect(run(branch, 'apps/web/src/features/content/EntityDetail.tsx')).toEqual([
      'no-entity-type-branch',
    ]);
  });

  test('FAILS elsewhere on a branch over an entityType reference', () => {
    expect(
      run("if (reference.entityType === 'npc') return;", 'apps/web/src/features/session/Q.tsx'),
    ).toEqual(['no-entity-type-branch']);
    expect(
      run("switch (ref.entityType) { case 'x': break; }", 'packages/encounters/src/a.ts'),
    ).toEqual(['no-entity-type-branch']);
  });

  test('PASSES on configuration reads, identity matching, typeof checks, and other `.type` uses', () => {
    expect(
      run(`
        const definition = config.type(entity.type);
        if (definition === undefined || !definition.enabled) return err('unknown_type');
        if (typeof typeId !== 'string') return err('invalid_type');
        const same = left.type === right.type;
      `),
    ).toEqual([]);
    // Outside the content scope `.type` is generic (settings, mutations, events).
    expect(
      run("if (declaration.type === 'boolean') return;", 'packages/campaigns/src/domain.ts'),
    ).toEqual([]);
    // Words that merely contain a type id are not type literals.
    expect(run("const title = 'Add location'; const k = 'notes';")).toEqual([]);
  });

  test('PASSES in the configuration file, tests, and comments', () => {
    const branch = "if (entity.type === 'npc') return; const t = 'scene';";
    expect(run(branch, 'packages/content/src/types.ts')).toEqual([]);
    expect(run(branch, 'packages/content/src/domain.test.ts')).toEqual([]);
    expect(run(branch, 'apps/web/e2e/content.e2e.ts')).toEqual([]);
    expect(run("// if (entity.type === 'npc') return;\n/* 'scene' */ const a = 1;")).toEqual([]);
  });

  test('the current content package passes', async () => {
    const root = join(import.meta.dir, '../../../packages/content/src');
    const glob = new Bun.Glob('**/*.ts');
    let checked = 0;
    for await (const relative of glob.scan({ cwd: root })) {
      const path = `packages/content/src/${relative.split(sep).join('/')}`;
      const content = await Bun.file(join(root, relative)).text();
      expect({ path, violations: noEntityTypeBranch({ path, content }) }).toEqual({
        path,
        violations: [],
      });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('rule: no-content-persistence-imports (feature 16 task 10)', () => {
  const run = (content: string, path = 'apps/api/src/modules/sessions/routes.ts') =>
    noContentPersistenceImports({ path, content });

  test('FAILS when another feature imports feature 16 persistence', () => {
    const [violation] = run(`import { PostgresEntityRepository } from '@rpg/content/postgres';`);
    expect(violation?.rule).toBe('no-content-persistence-imports');
    expect(violation?.remedy).toContain('EntityDirectory');
    expect(run(`const m = await import('@rpg/content/postgres');`)).toHaveLength(1);
    expect(
      run(`import type { EntityService } from '@rpg/content/postgres';`, 'packages/sessions/a.ts'),
    ).toHaveLength(1);
    expect(
      run(`import { x } from '@rpg/content/postgres';`, 'apps/web/src/features/sessions/A.tsx'),
    ).toHaveLength(1);
  });

  test('PASSES for the root entry point, feature 16, its composition root, tests, comments', () => {
    expect(run(`import { EntityDirectory } from '@rpg/content';`)).toEqual([]);
    const persistence = `import { EntityService } from '@rpg/content/postgres';`;
    expect(run(persistence, 'packages/content/src/directory.ts')).toEqual([]);
    expect(run(persistence, 'apps/api/src/modules/content/appliers.ts')).toEqual([]);
    expect(run(persistence, 'apps/api/src/runtime.ts')).toEqual([]);
    expect(run(persistence, 'apps/api/src/modules/sessions/routes.integration.test.ts')).toEqual(
      [],
    );
    expect(run(`// never import '@rpg/content/postgres' here\nconst a = 1;`)).toEqual([]);
  });
});
