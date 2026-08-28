import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required to run database commands');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './packages/identity/src/infra/postgres/schema.ts',
  out: './packages/identity/drizzle',
  dbCredentials: { url: databaseUrl },
  strict: true,
  verbose: true,
});
