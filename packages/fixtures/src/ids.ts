/**
 * Stable identifiers for the sandbox campaign.
 *
 * Fixed rather than generated so a test can assert against a specific record and a
 * developer can recognize one in a log. All are valid `Id` values.
 */

const prefix = (suffix: string): string => `00000000-0000-4000-8000-${suffix}`;

export const CAMPAIGN_ID = prefix('000000000001');

export const USERS = {
  gm: prefix('00000000a001'),
  playerA: prefix('00000000a002'),
  playerB: prefix('00000000a003'),
  assistantGm: prefix('00000000a004'),
  observer: prefix('00000000a005'),
} as const;

export const CHARACTERS = {
  wren: prefix('00000000b001'),
  tolly: prefix('00000000b002'),
} as const;

export const LOCATIONS = {
  village: prefix('00000000c001'),
  oldRoad: prefix('00000000c002'),
  abandonedWarehouse: prefix('00000000c003'),
  forestCamp: prefix('00000000c004'),
  tradingPost: prefix('00000000c005'),
} as const;

export const NPCS = {
  merchant: prefix('00000000d001'),
  villageElder: prefix('00000000d002'),
  guard: prefix('00000000d003'),
  traveler: prefix('00000000d004'),
  smuggler: prefix('00000000d005'),
  banditLeader: prefix('00000000d006'),
} as const;

export const ITEMS = {
  weatheredLetter: prefix('00000000e001'),
  merchantLedger: prefix('00000000e002'),
  brokenSeal: prefix('00000000e003'),
  supplyCrate: prefix('00000000e004'),
  oldMap: prefix('00000000e005'),
} as const;
