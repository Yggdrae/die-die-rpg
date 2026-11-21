import { HOLD_RENEW_INTERVAL_MS, type LongTextHold } from '@rpg/sync';

export class HoldRenewalController {
  #timer: ReturnType<typeof setInterval> | undefined;

  start(renew: () => Promise<LongTextHold | undefined>, lost: () => void): void {
    this.stop();
    this.#timer = setInterval(() => {
      renew()
        .then((hold) => {
          if (hold === undefined) lost();
        })
        .catch(lost);
    }, HOLD_RENEW_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
