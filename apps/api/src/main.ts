import { buildRuntimeApp } from './runtime.ts';

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? '0.0.0.0';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required');
}

const app = buildRuntimeApp({
  databaseUrl,
  allowedOrigin: process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? '5173'}`,
  production: process.env.NODE_ENV === 'production',
  powerSyncEndpoint: process.env.POWERSYNC_ENDPOINT ?? 'http://localhost:8080',
  powerSyncJwtSecret:
    process.env.POWERSYNC_JWT_SECRET ?? 'ZGV2ZWxvcG1lbnQtb25seS1wb3dlcnN5bmMta2V5LTMyIQ',
  version: process.env.APP_VERSION ?? '0.0.0',
});

await app.listen({ port, host });
