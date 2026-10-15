/**
 * 実行時（Lambda ハンドラ）設定の解決（design §4.2 / §6.6 / 非機能 5）。
 *
 * テーブル名・GSI 名・Streams ARN・実行時に必要な検証パラメータを環境変数から解決する。
 * 範囲外・解釈不能な値は既定へ黙って読み替えず `RuntimeConfigError` を投げる（非機能 5）。
 * 環境変数キーは合成側（`amplify/custom` の `verification-config.ts` / `LabelingTables`）と
 * 一致させる必要があり（design §4.2 の `LABELING_*`）、キー名のブレを防ぐため定数化する。
 * 合成側と実行時側のキー名はテストで突き合わせる（design §6.6 / §16）。
 */

/** 実行時設定の解決に失敗したときに投げる型付き例外（非機能 5）。 */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

/**
 * 環境変数キー（design §4.2 / §4.1）。合成側（Construct）が同じキーで注入する。
 * この定数が実行時側・合成側の突き合わせの基準になる。
 */
export const ENV_KEYS = {
  // テーブル / GSI / Streams（design §4.2）
  UNIT_TABLE_NAME: "LABELING_UNIT_TABLE_NAME",
  ROAST_BATCH_TABLE_NAME: "LABELING_ROAST_BATCH_TABLE_NAME",
  BATCH_UNITS_INDEX_NAME: "LABELING_BATCH_UNITS_INDEX_NAME",
  LOT_TRACE_INDEX_NAME: "LABELING_LOT_TRACE_INDEX_NAME",
  UNIT_STREAM_ARN: "LABELING_UNIT_STREAM_ARN",
  // SQS（router が送信先として参照）
  LABELING_QUEUE_URL: "LABELING_QUEUE_URL",
  // seeder 起動（labeling-api が参照）
  SEEDER_FUNCTION_NAME: "LABELING_SEEDER_FUNCTION_NAME",
  // 実行時に必要な検証パラメータ（design §4.1）
  BEST_BEFORE_DAYS: "BEST_BEFORE_DAYS",
  SEED_UNIT_COUNT_MAX: "SEED_UNIT_COUNT_MAX",
  RELAY_MODE: "RELAY_MODE",
  LABELING_MAX_CONCURRENCY: "LABELING_MAX_CONCURRENCY",
} as const;

/** 検証パラメータの既定・範囲（design §4.1 の表。実行時側で使う分のみ）。 */
export const BEST_BEFORE_DAYS_DEFAULT = 365;
export const BEST_BEFORE_DAYS_MIN = 1;
export const BEST_BEFORE_DAYS_MAX = 3650;

export const SEED_UNIT_COUNT_MAX_DEFAULT = 1200;
export const SEED_UNIT_COUNT_MAX_MIN = 1;
export const SEED_UNIT_COUNT_MAX_MAX = 5000;

/** 環境変数ソース（テスト容易性のため注入可能にする）。 */
export type EnvSource = Record<string, string | undefined>;

function requireString(env: EnvSource, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    throw new RuntimeConfigError(`required env ${key} is missing or empty`);
  }
  return raw;
}

/**
 * 整数の環境変数を範囲込みで解決する。未設定なら既定、範囲外・非整数は RuntimeConfigError。
 * 既定へ黙って読み替えない（非機能 5）: 値が「存在するが不正」なら例外、「未設定」なら既定。
 */
function resolveIntInRange(
  env: EnvSource,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") {
    return def;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new RuntimeConfigError(`env ${key} must be an integer (got "${raw}")`);
  }
  if (n < min || n > max) {
    throw new RuntimeConfigError(
      `env ${key} out of range [${min}, ${max}] (got ${n})`,
    );
  }
  return n;
}

/** テーブル / GSI / Streams の名前解決（design §4.2）。 */
export interface TableConfig {
  unitTableName: string;
  roastBatchTableName: string;
  batchUnitsIndexName: string;
  lotTraceIndexName: string;
}

export function resolveTableConfig(env: EnvSource = process.env): TableConfig {
  return {
    unitTableName: requireString(env, ENV_KEYS.UNIT_TABLE_NAME),
    roastBatchTableName: requireString(env, ENV_KEYS.ROAST_BATCH_TABLE_NAME),
    batchUnitsIndexName: requireString(env, ENV_KEYS.BATCH_UNITS_INDEX_NAME),
    lotTraceIndexName: requireString(env, ENV_KEYS.LOT_TRACE_INDEX_NAME),
  };
}

/**
 * 実行時に必要な検証パラメータを解決する（design §4.1。実行時側が使う分）。
 */
export interface RuntimeVerificationConfig {
  bestBeforeDays: number;
  seedUnitCountMax: number;
}

export function resolveVerificationConfig(
  env: EnvSource = process.env,
): RuntimeVerificationConfig {
  return {
    bestBeforeDays: resolveIntInRange(
      env,
      ENV_KEYS.BEST_BEFORE_DAYS,
      BEST_BEFORE_DAYS_DEFAULT,
      BEST_BEFORE_DAYS_MIN,
      BEST_BEFORE_DAYS_MAX,
    ),
    seedUnitCountMax: resolveIntInRange(
      env,
      ENV_KEYS.SEED_UNIT_COUNT_MAX,
      SEED_UNIT_COUNT_MAX_DEFAULT,
      SEED_UNIT_COUNT_MAX_MIN,
      SEED_UNIT_COUNT_MAX_MAX,
    ),
  };
}
