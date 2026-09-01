import type { CurrentAccessResolver } from './authority.ts';

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
  ) {}

  async bootstrap(userId: string, campaignId: string) {
    const actor = await this.access.resolve(userId, campaignId);
    if (actor === undefined) return undefined;
    const replicaId = this.createId();
    const expiresAt = new Date(this.clock().getTime() + 5 * 60_000);
    return {
      campaignId,
      replicaId,
      endpoint: this.endpoint,
      token: await this.tokens.issue({ userId, campaignId, replicaId, expiresAt }),
      expiresAt: expiresAt.toISOString(),
    };
  }
}
