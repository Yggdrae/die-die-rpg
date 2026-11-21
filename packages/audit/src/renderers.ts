import { check, type Metadata, type Visibility } from '@rpg/contracts';
import { type Static, type TSchema, Type } from '@sinclair/typebox';
import type { TargetVisibilitySnapshot } from './model.ts';

/** Version stored for events whose action has no registered declaration. */
export const GENERIC_RENDERER_VERSION = 0;

/** What a contributor renderer receives: already-redacted, already-validated values only. */
export interface RenderableAuditEvent {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before?: Metadata;
  readonly after?: Metadata;
  readonly at: string;
}

const RendererOutput = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 280 }) },
  { additionalProperties: false },
);
type RendererOutput = Static<typeof RendererOutput>;

export interface AuditRendering {
  readonly kind: 'registered' | 'generic';
  readonly text: string;
}

/**
 * One contributor registration (feature 06 FR-006). Payload schema and renderer stay with the
 * owning feature; feature 06 stores the version and invokes the renderer.
 */
export interface AuditEventDeclaration {
  readonly action: string;
  readonly version: number;
  /** Schema each of `before`/`after` must satisfy when present. */
  readonly payload?: TSchema;
  /** Default target visibility when the caller supplies none. */
  readonly targetVisibility?: Visibility;
  render(event: RenderableAuditEvent): RendererOutput;
}

const SAFE_TOKEN = /^[a-z][a-z0-9_.-]{0,63}$/;

export class AuditRendererRegistry {
  readonly #declarations = new Map<string, AuditEventDeclaration>();
  readonly #latest = new Map<string, number>();

  register(declaration: AuditEventDeclaration): void {
    if (
      !SAFE_TOKEN.test(declaration.action) ||
      !Number.isInteger(declaration.version) ||
      declaration.version < 1
    ) {
      throw new Error('invalid_audit_declaration');
    }
    const key = declarationKey(declaration.action, declaration.version);
    if (this.#declarations.has(key)) throw new Error('duplicate_audit_declaration');
    this.#declarations.set(key, declaration);
    if ((this.#latest.get(declaration.action) ?? 0) < declaration.version) {
      this.#latest.set(declaration.action, declaration.version);
    }
  }

  /** Version new events of `action` are written with; 0 when unregistered. */
  currentVersion(action: string): number {
    return this.#latest.get(action) ?? GENERIC_RENDERER_VERSION;
  }

  defaultVisibility(action: string): TargetVisibilitySnapshot | undefined {
    const visibility = this.#current(action)?.targetVisibility;
    return visibility === undefined ? undefined : { visibility };
  }

  /** Validates `before`/`after` against the current declaration; unregistered passes. */
  acceptsPayload(
    action: string,
    values: { readonly before?: Metadata; readonly after?: Metadata },
  ): boolean {
    const schema = this.#current(action)?.payload;
    if (schema === undefined) return true;
    return [values.before, values.after].every(
      (value) => value === undefined || check(schema, value),
    );
  }

  /**
   * Never throws and never echoes raw values: a missing renderer, a throwing renderer, or
   * an invalid output all degrade to the generic description.
   */
  render(event: RenderableAuditEvent & { readonly rendererVersion: number }): AuditRendering {
    const declaration = this.#declarations.get(declarationKey(event.action, event.rendererVersion));
    if (declaration !== undefined) {
      try {
        const output: unknown = declaration.render({
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          before: event.before,
          after: event.after,
          at: event.at,
        });
        if (check(RendererOutput, output)) return { kind: 'registered', text: output.text };
      } catch {
        // Fail closed to the generic description below.
      }
    }
    return genericRendering(event);
  }

  #current(action: string): AuditEventDeclaration | undefined {
    const version = this.#latest.get(action);
    return version === undefined
      ? undefined
      : this.#declarations.get(declarationKey(action, version));
  }
}

export function genericRendering(event: {
  readonly action: string;
  readonly targetType: string;
}): AuditRendering {
  if (SAFE_TOKEN.test(event.action) && SAFE_TOKEN.test(event.targetType)) {
    return { kind: 'generic', text: `Recorded ${event.action} on ${event.targetType}.` };
  }
  return { kind: 'generic', text: 'Recorded a change.' };
}

function declarationKey(action: string, version: number): string {
  return `${action}@${version}`;
}
