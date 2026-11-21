/**
 * Feature 06 public entry point. Contributors register declarations and record through
 * `AuditRecorder`; they never write audit tables or control sequence and retention.
 */
export * from './acknowledgement.ts';
export * from './infra/postgres/repositories.ts';
export * from './infra/postgres/schema.ts';
export * from './main/postgres-audit.ts';
export * from './model.ts';
export * from './query.ts';
export * from './recorder.ts';
export * from './renderers.ts';
export * from './retention.ts';
export * from './retention-executor.ts';
