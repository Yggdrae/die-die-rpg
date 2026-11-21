import { auditRetentionDeleteFromEnv, connectAuditRetention } from './retention.ts';

/**
 * Feature 06 audit retention (365 days, Approved 2026-10-28, delegated by owner). Prints, as JSON,
 * the rows past the window per store and campaign and what still blocks their deletion (feature
 * 03 watermark evidence, narrowed to the replicas that receive each audit store).
 *
 * Report-only by default: it deletes nothing unless `AUDIT_RETENTION_DELETE=true` is set for the
 * run, and then only unblocked groups, in bounded batches, as `rpg_audit_maintenance`.
 *
 *   bun run apps/api/src/modules/audit/retention-cli.ts
 */
export async function runAuditRetentionReport(options: {
  readonly databaseUrl?: string;
  readonly now?: Date;
  /** Deletion switch; only `true` deletes. The entry point reads `AUDIT_RETENTION_DELETE`. */
  readonly delete?: boolean;
  readonly output: { stdout(line: string): void; stderr(line: string): void };
}): Promise<number> {
  if (options.databaseUrl === undefined || options.databaseUrl.length === 0) {
    options.output.stderr('DATABASE_URL is required.');
    return 2;
  }
  const retention = connectAuditRetention(options.databaseUrl);
  try {
    const report = await retention.executor.run({ delete: options.delete === true }, options.now);
    options.output.stdout(JSON.stringify(report, null, 2));
    return 0;
  } catch {
    // Identifiers only; a failed run never affects campaign operations.
    options.output.stderr('Audit retention report failed.');
    return 1;
  } finally {
    await retention.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runAuditRetentionReport({
    databaseUrl: process.env.DATABASE_URL,
    delete: auditRetentionDeleteFromEnv(process.env),
    output: {
      stdout: (line) =>
        process.stdout.write(`${line}
`),
      stderr: (line) =>
        process.stderr.write(`${line}
`),
    },
  });
}
