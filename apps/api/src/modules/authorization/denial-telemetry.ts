import type { ContentDenialReason } from './content-access.ts';

/**
 * Aggregated authorization denials (feature 04 task 07). Counts per resource class and reason
 * code only. The recorder accepts no actor, user, campaign or record identifier, so per-actor
 * surveillance is impossible by construction; the type of `record` is the boundary.
 */

export interface DenialCount {
  readonly resourceClass: string;
  readonly reason: ContentDenialReason;
  readonly count: number;
}

/** Bound on distinct class labels so hostile path input cannot grow the map without limit. */
const MAX_CLASS_LABELS = 256;
const OVERFLOW_CLASS = '__other__';

export class DenialTelemetry {
  readonly #counts = new Map<string, Map<ContentDenialReason, number>>();

  /** Shaped as `ContentAccess`'s `onDenied` hook. */
  readonly record = (resourceClass: string, reason: ContentDenialReason): void => {
    const label =
      this.#counts.has(resourceClass) || this.#counts.size < MAX_CLASS_LABELS
        ? resourceClass
        : OVERFLOW_CLASS;
    const byReason = this.#counts.get(label) ?? new Map<ContentDenialReason, number>();
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    this.#counts.set(label, byReason);
  };

  /** Stable order: class, then reason. */
  snapshot(): readonly DenialCount[] {
    return [...this.#counts.entries()]
      .flatMap(([resourceClass, byReason]) =>
        [...byReason.entries()].map(([reason, count]) => ({ resourceClass, reason, count })),
      )
      .sort(
        (left, right) =>
          left.resourceClass.localeCompare(right.resourceClass) ||
          left.reason.localeCompare(right.reason),
      );
  }

  total(): number {
    return this.snapshot().reduce((sum, item) => sum + item.count, 0);
  }

  reset(): void {
    this.#counts.clear();
  }

  /** Emits and clears the totals every interval (only when non-empty); `stop` flushes once. */
  startReporting(
    report: (denials: readonly DenialCount[]) => void,
    intervalMs = 60_000,
  ): () => void {
    const flush = () => {
      const denials = this.snapshot();
      if (denials.length === 0) return;
      this.reset();
      report(denials);
    };
    const timer = setInterval(flush, intervalMs);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      flush();
    };
  }
}
