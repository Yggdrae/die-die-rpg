import { Channel } from './channel.ts';
import { HOLD_TTL_MS, type HoldNotice, type LongTextFieldRef, type LongTextHold } from './model.ts';

export interface LongTextHoldRepository {
  databaseNow(): Promise<Date>;
  get(field: LongTextFieldRef): Promise<LongTextHold | undefined>;
  compareAndSet(
    field: LongTextFieldRef,
    expectedVersion: number | null,
    hold: LongTextHold | undefined,
  ): Promise<boolean>;
}

export class InMemoryLongTextHoldRepository implements LongTextHoldRepository {
  readonly #holds = new Map<string, LongTextHold>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async databaseNow(): Promise<Date> {
    return this.now();
  }

  async get(field: LongTextFieldRef): Promise<LongTextHold | undefined> {
    const hold = this.#holds.get(fieldKey(field));
    return hold === undefined ? undefined : structuredClone(hold);
  }

  async compareAndSet(
    field: LongTextFieldRef,
    expectedVersion: number | null,
    hold: LongTextHold | undefined,
  ): Promise<boolean> {
    const key = fieldKey(field);
    const current = this.#holds.get(key);
    if ((current?.version ?? null) !== expectedVersion) return false;
    if (hold === undefined) this.#holds.delete(key);
    else this.#holds.set(key, structuredClone(hold));
    return true;
  }
}

export class LongTextHoldService {
  readonly notices = new Channel<HoldNotice>();

  constructor(private readonly repository: LongTextHoldRepository) {}

  async acquire(
    field: LongTextFieldRef,
    holder: { readonly userId: string; readonly sessionId: string },
  ): Promise<LongTextHold | { readonly heldBy: string; readonly expiresAt: string }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = await this.repository.databaseNow();
      const current = await this.repository.get(field);
      if (current !== undefined && Date.parse(current.expiresAt) > now.getTime()) {
        if (current.holderSessionId === holder.sessionId) return current;
        return { heldBy: current.holderUserId, expiresAt: current.expiresAt };
      }
      const hold = makeHold(field, holder, now, (current?.version ?? 0) + 1);
      if (await this.repository.compareAndSet(field, current?.version ?? null, hold)) {
        if (current !== undefined) {
          this.notices.emit({
            kind: 'expired',
            field,
            previousHolderUserId: current.holderUserId,
            version: current.version,
          });
        }
        return hold;
      }
    }
    throw new Error('hold_concurrency_exhausted');
  }

  async renew(input: {
    readonly field: LongTextFieldRef;
    readonly holderSessionId: string;
    readonly expectedVersion: number;
  }): Promise<LongTextHold | undefined> {
    const now = await this.repository.databaseNow();
    const current = await this.repository.get(input.field);
    if (
      current === undefined ||
      current.version !== input.expectedVersion ||
      current.holderSessionId !== input.holderSessionId ||
      Date.parse(current.expiresAt) <= now.getTime()
    ) {
      return undefined;
    }
    const renewed = {
      ...current,
      renewedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOLD_TTL_MS).toISOString(),
    };
    return (await this.repository.compareAndSet(input.field, current.version, renewed))
      ? renewed
      : undefined;
  }

  async takeover(
    field: LongTextFieldRef,
    holder: { readonly userId: string; readonly sessionId: string },
  ): Promise<LongTextHold> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = await this.repository.databaseNow();
      const current = await this.repository.get(field);
      const hold = makeHold(field, holder, now, (current?.version ?? 0) + 1);
      if (await this.repository.compareAndSet(field, current?.version ?? null, hold)) {
        if (current !== undefined && current.holderSessionId !== holder.sessionId) {
          this.notices.emit({
            kind: 'taken_over',
            field,
            previousHolderUserId: current.holderUserId,
            version: hold.version,
          });
        }
        return hold;
      }
    }
    throw new Error('hold_concurrency_exhausted');
  }

  async release(input: {
    readonly field: LongTextFieldRef;
    readonly holderSessionId: string;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    const current = await this.repository.get(input.field);
    if (
      current === undefined ||
      current.holderSessionId !== input.holderSessionId ||
      current.version !== input.expectedVersion
    ) {
      return false;
    }
    const released = await this.repository.compareAndSet(input.field, current.version, undefined);
    if (released) {
      this.notices.emit({
        kind: 'released',
        field: input.field,
        previousHolderUserId: current.holderUserId,
        version: current.version,
      });
    }
    return released;
  }

  async mayWrite(input: {
    readonly field: LongTextFieldRef;
    readonly holderSessionId: string;
    readonly expectedVersion: number;
  }): Promise<boolean> {
    const now = await this.repository.databaseNow();
    const current = await this.repository.get(input.field);
    return (
      current !== undefined &&
      current.holderSessionId === input.holderSessionId &&
      current.version === input.expectedVersion &&
      Date.parse(current.expiresAt) > now.getTime()
    );
  }
}

export class LongTextDraft {
  #value: string;
  #hold: LongTextHold | undefined;

  constructor(initialValue: string) {
    this.#value = initialValue;
  }

  get value(): string {
    return this.#value;
  }

  get hold(): LongTextHold | undefined {
    return this.#hold;
  }

  edit(value: string): void {
    this.#value = value;
  }

  attachHold(hold: LongTextHold): void {
    this.#hold = hold;
  }

  loseHold(): void {
    this.#hold = undefined;
  }
}

function makeHold(
  field: LongTextFieldRef,
  holder: { readonly userId: string; readonly sessionId: string },
  now: Date,
  version: number,
): LongTextHold {
  return {
    ...field,
    holderUserId: holder.userId,
    holderSessionId: holder.sessionId,
    acquiredAt: now.toISOString(),
    renewedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + HOLD_TTL_MS).toISOString(),
    version,
  };
}

function fieldKey(field: LongTextFieldRef): string {
  return `${field.campaignId}:${field.resourceClass}:${field.recordId}:${field.fieldPath}`;
}
