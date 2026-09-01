import {
  createPostgresRecoveryRuntime,
  type IdentityRecoveryLog,
  type RecoveryIssuanceAudit,
} from '@rpg/identity';

interface CommandOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface OperatorCommandOptions {
  readonly databaseUrl?: string;
  readonly args: readonly string[];
  readonly output: CommandOutput;
  readonly createRuntime?: typeof createPostgresRecoveryRuntime;
}

export async function runOperatorRecoveryCommand(options: OperatorCommandOptions): Promise<number> {
  const parsed = parseArguments(options.args);
  if (!parsed.ok) {
    options.output.stderr(parsed.message);
    return 2;
  }
  if (options.databaseUrl === undefined || options.databaseUrl.length === 0) {
    options.output.stderr('DATABASE_URL is required.');
    return 2;
  }

  const log: IdentityRecoveryLog = {
    recoveryIssued: (_userId, tokenId) =>
      options.output.stderr(`Recovery token ${tokenId} issued.`),
    recoveryIssuanceAuditDegraded: (tokenId) =>
      options.output.stderr(`Recovery issuance audit degraded for token ${tokenId}.`),
    recoverySucceeded: () => undefined,
    recoveryFailed: () => undefined,
  };
  const audit: RecoveryIssuanceAudit = {
    recordIssued: async (event) => {
      options.output.stderr(
        `Audit recovery.issued token=${event.tokenId} user=${event.userId} at=${event.issuedAt.toISOString()}`,
      );
    },
  };
  const runtime = (options.createRuntime ?? createPostgresRecoveryRuntime)({
    connectionString: options.databaseUrl,
    audit,
    log,
  });

  try {
    const issued = await runtime.service.issue(parsed.value);
    if (!issued.ok) {
      options.output.stderr(`Recovery token was not issued: ${issued.error}.`);
      return 1;
    }
    options.output.stdout(issued.value.credential);
    options.output.stderr(`Expires at ${issued.value.expiresAt.toISOString()}.`);
    return 0;
  } finally {
    await runtime.close();
  }
}

function parseArguments(
  args: readonly string[],
):
  | { readonly ok: true; readonly value: { username: string; operatorReference?: string } }
  | { readonly ok: false; readonly message: string } {
  let username: string | undefined;
  let operatorReference: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--username' && flag !== '--operator-reference') || value === undefined) {
      return {
        ok: false,
        message: 'Usage: --username <username> [--operator-reference <reference>]',
      };
    }
    if (flag === '--username') username = value;
    if (flag === '--operator-reference') operatorReference = value;
    index += 1;
  }
  if (username === undefined) {
    return {
      ok: false,
      message: 'Usage: --username <username> [--operator-reference <reference>]',
    };
  }
  return {
    ok: true,
    value: operatorReference === undefined ? { username } : { username, operatorReference },
  };
}

if (import.meta.main) {
  const exitCode = await runOperatorRecoveryCommand({
    databaseUrl: process.env.DATABASE_URL,
    args: Bun.argv.slice(2),
    output: {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    },
  });
  process.exitCode = exitCode;
}
