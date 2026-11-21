/**
 * The dice engine's shapes (`_techspec.md` "Module API"). A roll is a pure function of an expression,
 * caller-resolved inputs, and an injected randomness source. It reads no character, system, formula,
 * clock, or storage (`PRD.md` s.20).
 */

export const DIE_TYPES = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100', 'dF'] as const;
export type DieType = (typeof DIE_TYPES)[number];

export type SuccessOperator = '>=' | '>' | '<=' | '<' | '=';

/** D-07. Rejected at parse, so a pasted expression cannot hang a client (FR-011). */
export const ROLL_LIMITS = {
  expressionLength: 200,
  totalDice: 100,
  terms: 16,
  magnitude: 1_000_000,
  nameLength: 64,
} as const;

export type ParsedTerm =
  | {
      readonly kind: 'dice';
      readonly sign: 1 | -1;
      readonly count: number;
      readonly die: DieType;
      readonly keep?: { readonly mode: 'highest' | 'lowest'; readonly count: number };
    }
  | { readonly kind: 'modifier'; readonly sign: 1 | -1; readonly value: number }
  | { readonly kind: 'input'; readonly sign: 1 | -1; readonly name: string };

export interface RollExpression {
  readonly source: string;
  readonly terms: readonly ParsedTerm[];
  readonly success?: { readonly operator: SuccessOperator; readonly threshold: number };
  /** Every name the caller must resolve, sorted and unique. */
  readonly inputs: readonly string[];
}

/** Caller-resolved values (FR-004). */
export type RollInputs = Readonly<Record<string, unknown>>;

export interface RollRequest {
  readonly expression: string;
  readonly inputs?: Readonly<Record<string, number>>;
}

export interface RolledDie {
  readonly value: number;
  readonly kept: boolean;
  /** Present with a success clause: whether this kept die met the threshold. */
  readonly success?: boolean;
}

export type RollTerm =
  | {
      readonly kind: 'dice';
      readonly sign: 1 | -1;
      readonly die: DieType;
      readonly faces: readonly RolledDie[];
      /** Signed sum of the kept dice. */
      readonly subtotal: number;
    }
  | { readonly kind: 'modifier'; readonly sign: 1 | -1; readonly value: number }
  | {
      readonly kind: 'input';
      readonly sign: 1 | -1;
      readonly name: string;
      readonly value: number;
    };

export interface RollResult {
  readonly terms: readonly RollTerm[];
  /** D-04: the signed sum of kept dice, or the success count. */
  readonly natural: number;
  /** D-04: natural plus every modifier. */
  readonly modified: number;
  readonly successes?: number;
}

export type RollParseCode =
  | 'syntax'
  | 'unknown_die'
  | 'out_of_bounds'
  | 'no_dice'
  | 'invalid_success'
  | 'reserved_name';

export interface RollParseFailure {
  readonly code: RollParseCode;
  readonly message: string;
  readonly position?: number;
}

export type RollEvaluationCode = 'missing_input' | 'invalid_input';

/** A message names the input, never its value. */
export interface RollEvaluationFailure {
  readonly code: RollEvaluationCode;
  readonly name: string;
  readonly message: string;
}

/** Returns a whole number with `0 <= n < bound`; `bound` is at most 2^32. */
export interface RandomSource {
  nextInt(bound: number): number;
}
