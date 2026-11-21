import type { CurrentAccessResolver } from './authority.ts';
import type { ReplicaSubscriptionRegistry } from './watermarks.ts';

export interface SyncTokenIssuer {
  issue(input: {
    readonly userId: string;
    readonly campaignId: string;
    readonly replicaId: string;
    readonly expiresAt: Date;
  }): Promise<string>;
}

export class SyncBootstrapService {
  constructor(
    private readonly access: CurrentAccessResolver,
    private readonly endpoint: string,
    private readonly tokens: SyncTokenIssuer,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly subscriptions?: ReplicaSubscriptionRegistry,
  ) {}

  /**
   * Issues provider credentials only after a current access decision. A device passes its stable
   * per-campaign `replicaId` so watermarks and purge eligibility track one subscriber per replica.
   */
  async bootstrap(userId: string, campaignId: string, replicaId?: string) {
    const actor = await this.access.resolve(userId, campaignId);
    if (actor === undefined) return undefined;
    const subscriber = replicaId ?? this.createId();
    const now = this.clock();
    await this.subscriptions?.register({
      campaignId,
      userId,
      replicaId: subscriber,
      subscribedAt: now,
    });
    const expiresAt = new Date(now.getTime() + 5 * 60_000);
    return {
      campaignId,
      replicaId: subscriber,
      endpoint: this.endpoint,
      token: await this.tokens.issue({ userId, campaignId, replicaId: subscriber, expiresAt }),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
