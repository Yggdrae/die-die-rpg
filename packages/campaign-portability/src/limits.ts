/**
 * `.rpgpack` limits (`_db.md`, Required Container Layout). Checked against the central directory
 * before any entry is decompressed, and again while an entry is decompressed (declared sizes are
 * untrusted).
 */
export interface PackageLimits {
  /** Whole package as received. */
  readonly maxPackageBytes: number;
  /** Sum of every entry's uncompressed size. */
  readonly maxTotalUncompressedBytes: number;
  readonly maxEntries: number;
  /** One JSON entry, uncompressed. */
  readonly maxEntryBytes: number;
  /** Uncompressed / compressed, per entry. */
  readonly maxCompressionRatio: number;
}

const MB = 1024 * 1024;

export const PACKAGE_LIMITS: PackageLimits = {
  maxPackageBytes: 250 * MB,
  maxTotalUncompressedBytes: 500 * MB,
  maxEntries: 10_000,
  maxEntryBytes: 50 * MB,
  maxCompressionRatio: 100,
};

/** Structural bounds for every JSON entry; a contributor schema may narrow them further. */
export interface JsonLimits {
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxNodes: number;
}

export const JSON_LIMITS: JsonLimits = {
  maxDepth: 64,
  maxStringLength: 1_000_000,
  maxArrayLength: 100_000,
  maxObjectKeys: 10_000,
  maxNodes: 2_000_000,
};
