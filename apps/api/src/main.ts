import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import { CONTENT_ATTACHMENT_OWNER_CLASSES } from '@rpg/content';
import { auditRetentionDeleteFromEnv } from './modules/audit/retention.ts';
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
  attachments: {
    storage: new BunS3ObjectStorage(s3ConfigFromEnv(process.env)),
    // Feature 16 FR-009: entities take attachments; personal notes do not (D-15).
    ownerClasses: CONTENT_ATTACHMENT_OWNER_CLASSES,
  },
  // Feature 06: audit retention deletes nothing unless AUDIT_RETENTION_DELETE=true.
  auditRetention: { delete: auditRetentionDeleteFromEnv(process.env) },
});

await app.listen({ port, host });
