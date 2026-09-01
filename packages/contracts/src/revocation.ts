import { type Static, Type } from '@sinclair/typebox';
import { Id, Timestamp, Version } from './primitives.ts';

export const CampaignAccessRevoked = Type.Object(
  {
    campaignId: Id,
    userId: Id,
    membershipVersion: Version,
    reason: Type.Union([
      Type.Literal('removed'),
      Type.Literal('role_changed'),
      Type.Literal('ownership_transferred'),
      Type.Literal('signed_out'),
    ]),
    committedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'CampaignAccessRevoked' },
);
export type CampaignAccessRevoked = Static<typeof CampaignAccessRevoked>;

export interface CampaignAccessRevocationPublisher {
  publish(event: CampaignAccessRevoked): Promise<void>;
}

export const ReplicaPurgeWatermark = Type.Object(
  {
    campaignId: Id,
    userId: Id,
    replicaId: Id,
    membershipVersion: Version,
    acknowledgedAt: Timestamp,
  },
  { additionalProperties: false, $id: 'ReplicaPurgeWatermark' },
);
export type ReplicaPurgeWatermark = Static<typeof ReplicaPurgeWatermark>;

export interface ReplicaPurgeEvidence {
  acknowledge(watermark: ReplicaPurgeWatermark): Promise<void>;
  safeToPurge(input: {
    readonly campaignId: string;
    readonly userId: string;
    readonly membershipVersion: number;
  }): Promise<boolean>;
}
