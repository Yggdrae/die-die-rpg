import { connectAttachmentDatabase, PostgresAttachmentRepository } from '@rpg/attachments/postgres';
import { BunS3ObjectStorage, s3ConfigFromEnv } from '@rpg/attachments/s3';
import postgres from 'postgres';
import { attachmentApp, CAMPAIGN } from '../../../api/src/modules/attachments/test-support.ts';
import { noteId } from '../../../api/src/modules/authorization/test-fixture.ts';

/**
 * Bun helper for `attachments-acceptance.e2e.ts` (Playwright runs under Node; Fastify, the
 * PostgreSQL metadata store and `Bun.S3Client` run here). `serve <port>` starts the real
 * attachment routes over PostgreSQL and MinIO with the feature 04 fixture owner classes (no
 * production owner class exists) and prints one JSON line when listening. `cleanup` removes
 * the fixture campaign's rows and objects.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');
const storage = new BunS3ObjectStorage(s3ConfigFromEnv(process.env));
const [command, port = '4186'] = process.argv.slice(2);

if (command === 'serve') {
  const connection = connectAttachmentDatabase(databaseUrl);
  const harness = attachmentApp({
    storage,
    repository: new PostgresAttachmentRepository(connection.db),
  });
  harness.context.notes.put({ id: noteId(1), visibility: { mode: 'everyone' } });
  await harness.app.listen({ port: Number(port), host: '127.0.0.1' });
  console.log(JSON.stringify({ ready: true, campaignId: CAMPAIGN, ownerId: noteId(1) }));
} else if (command === 'cleanup') {
  const sql = postgres(databaseUrl, { max: 1 });
  const rows = await sql<{ object_key: string }[]>`
    select object_key from attachments where campaign_id = ${CAMPAIGN}`;
  for (const row of rows) await storage.delete(row.object_key);
  await sql`delete from attachments where campaign_id = ${CAMPAIGN}`;
  await sql.end({ timeout: 1 });
} else {
  throw new Error('usage: attachment-api-server.ts serve <port> | cleanup');
}
