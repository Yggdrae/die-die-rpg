import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required to run database commands');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './packages/identity/src/infra/postgres/schema.ts',
    './packages/campaigns/src/infra/postgres/schema.ts',
    './packages/sync/src/infra/postgres/schema.ts',
    './packages/audit/src/infra/postgres/schema.ts',
    './packages/attachments/src/infra/postgres/schema.ts',
    './packages/campaign-portability/src/infra/postgres/schema.ts',
    './packages/content/src/infra/postgres/schema.ts',
    './packages/dice/src/infra/postgres/schema.ts',
    './packages/actions/src/infra/postgres/schema.ts',
    './packages/characters/src/infra/postgres/schema.ts',
    './packages/sessions/src/infra/postgres/schema.ts',
    './packages/encounters/src/infra/postgres/schema.ts',
    './packages/rules/src/infra/postgres/schema.ts',
  ],
  out: './packages/identity/drizzle',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
