/**
 * 検証パラメータの解決と検証（design §4.1 / §9、要件 2.9 / 非機能 5）。
 *
 * ## この層で検証する理由（参考 EC PoC `verification-config.ts` と同じ思想）
 *
 * 検証パラメータは「どの条件・どの入口で計測したか」を決める値であり、
 * 不正値を既定値へ黙って読み替えると**計測結果の解釈を誤る**（非機能 5）。
 * そのため範囲外・解釈不能な値は合成時に例外として扱い、デプロイ自体を止める。
 * Lambda 実行時ではなく合成時に落とすのは、壊れた設定でリソースが
 * 作られてから気づく事態を避けるため（testing 方針「明らかな問題で早期に失敗させる」）。
 *
 * ## `MaximumConcurrency` の下限 2 を自前検証する（design §4.1 / レビュー第 1R-5）
 *
 * `aws-cdk-lib`（v2 系）の `SqsEventSource` は `maxConcurrency` に下限・上限の
 * 合成バリデーションを**持たない**（下限/上限を検証するのは `provisionedPollerConfig` の
 * poller 数のみ）。下限 2 はイベントソースマッピングの CloudFormation / SQS サービス側の
 * プロパティ制約（`ScalingConfig.MaximumConcurrency` の有効範囲 2〜1,000。予約枠を
 * 使わない場合）であり、1 を指定しても **CDK 合成時には弾かれず、デプロイ時に失敗する**。
 * これを合成段階で早期に止めるため、本モジュールが下限 2 を自前検証して合成を失敗させる。
 * 範囲 2〜1250 の上限 1,250 はアカウント枠引き上げ時の上限（既定枠 1,000 の範囲内で検証）。
 *
 * ## 解決結果の共有
 *
 * `getVerificationConfig()` は合成中に 1 度だけ解決してキャッシュし、何度参照しても
 * 同じ値を返す（警告の出力も 1 回）。`backend.ts` がこれを 1 度取得し、全 Construct と
 * `GET /config`（§7）に共有する（design §4.1 末尾）。
 */

/** 入口方式の切替値（design §4.1 / §4.3.5 / 論点 3）。 */
export type RelayMode = "pipes" | "lambda" | "both";

/** `RELAY_MODE` の許容値（これが唯一の出典）。 */
export const RELAY_MODES: readonly RelayMode[] = ["pipes", "lambda", "both"];

/**
 * 未設定時に用いる既定値の一覧（design §4.1 の「既定」列）。
 * `RELAY_MODE` は文字列列挙なので数値表（NUMERIC_SPECS）とは別に持つ。
 */
export const VERIFICATION_DEFAULTS = {
  relayMode: "pipes" as RelayMode,
  labelingMaxConcurrency: 1000,
  labelingWorkerBatchSize: 1,
  routerBatchSize: 100,
  routerParallelizationFactor: 1,
  seedUnitCountMax: 1200,
  bestBeforeDays: 365,
} as const;

/** 解決済みの検証パラメータ（design §4.1 の表）。 */
export interface VerificationConfig {
  /** 入口方式（§4.3.5 / 論点 3）。 */
  relayMode: RelayMode;
  /** worker ESM の `MaximumConcurrency`（§4.3.4 / R5）。下限 2 / 上限 1250。 */
  labelingMaxConcurrency: number;
  /** worker ESM の `batchSize`（§4.3.4）。 */
  labelingWorkerBatchSize: number;
  /** 方式 A-Lambda の Streams ESM `batchSize`（§4.3.3）。 */
  routerBatchSize: number;
  /** 方式 A-Lambda の Streams ESM `parallelizationFactor`（§4.3.3）。 */
  routerParallelizationFactor: number;
  /** seeder が 1 バッチで INSERT する上限（§6.1）。 */
  seedUnitCountMax: number;
  /** 付番時の賞味期限日数（§6.3。既定 365 のまま要件 3.2 準拠）。 */
  bestBeforeDays: number;
}

/** 範囲外・解釈不能な検証パラメータを検出したときの例外（非機能 5）。 */
export class VerificationConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "検証パラメータが不正です（design §4.1 / 非機能 5）。",
        "既定値へ読み替えず合成を中止します。以下を修正してください。",
        ...issues.map((issue) => `  - ${issue}`),
      ].join("\n"),
    );
    this.name = "VerificationConfigError";
    this.issues = issues;
  }
}

interface NumericParamSpec {
  /** 環境変数名。 */
  readonly env: string;
  /** 未設定時の既定値。 */
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
  /** エラーメッセージに出す範囲の表記（design §4.1 の「範囲」列）。 */
  readonly range: string;
}

/**
 * design §4.1 の数値パラメータ表をそのまま写したもの。
 * ここが唯一の出典になるよう、範囲の判定もこの表から行う。
 *
 * `labelingMaxConcurrency` の下限が 2 なのは上記クラスコメントのとおり（SQS サービス制約を
 * 合成段階で自前検証するため）。`verification-config.test.ts` が 1 を与えると合成が失敗する
 * ことを検査する（§16）。
 */
const NUMERIC_SPECS = {
  labelingMaxConcurrency: {
    env: "LABELING_MAX_CONCURRENCY",
    fallback: VERIFICATION_DEFAULTS.labelingMaxConcurrency,
    min: 2,
    max: 1250,
    integer: true,
    range: "2〜1250",
  },
  labelingWorkerBatchSize: {
    env: "LABELING_WORKER_BATCH_SIZE",
    fallback: VERIFICATION_DEFAULTS.labelingWorkerBatchSize,
    min: 1,
    max: 10,
    integer: true,
    range: "1〜10",
  },
  routerBatchSize: {
    env: "ROUTER_BATCH_SIZE",
    fallback: VERIFICATION_DEFAULTS.routerBatchSize,
    min: 1,
    max: 1000,
    integer: true,
    range: "1〜1000",
  },
  routerParallelizationFactor: {
    env: "ROUTER_PARALLELIZATION_FACTOR",
    fallback: VERIFICATION_DEFAULTS.routerParallelizationFactor,
    min: 1,
    max: 10,
    integer: true,
    range: "1〜10",
  },
  seedUnitCountMax: {
    env: "SEED_UNIT_COUNT_MAX",
    fallback: VERIFICATION_DEFAULTS.seedUnitCountMax,
    min: 1,
    max: 5000,
    integer: true,
    range: "1〜5000",
  },
  bestBeforeDays: {
    env: "BEST_BEFORE_DAYS",
    fallback: VERIFICATION_DEFAULTS.bestBeforeDays,
    min: 1,
    max: 3650,
    integer: true,
    range: "1〜3650",
  },
} as const satisfies Record<string, NumericParamSpec>;

type NumericParamKey = keyof typeof NUMERIC_SPECS;

/** `RELAY_MODE` の環境変数名。 */
export const RELAY_MODE_ENV = "RELAY_MODE";

/**
 * 検証パラメータの環境変数名（ドキュメント・テストとの突き合わせ用）。
 * 合成側（本モジュール）と実行時側（`shared/runtime-config.ts` の `ENV_KEYS`）の
 * キー名が食い違わないことを `verification-config.test.ts` / `stack.test.ts` で検査する。
 */
export const VERIFICATION_ENV_VARS: readonly string[] = [
  RELAY_MODE_ENV,
  ...Object.values(NUMERIC_SPECS).map((spec) => spec.env),
];

export interface ResolveOptions {
  /** 環境変数の出典。既定は `process.env`。 */
  env?: Record<string, string | undefined>;
}

/**
 * 環境変数から検証パラメータを解決する。
 *
 * @throws {VerificationConfigError} 範囲外・解釈不能な値が 1 つでもある場合。
 *   複数ある場合はまとめて報告する（1 回のデプロイで全ての誤りに気づけるように）。
 */
export function resolveVerificationConfig(
  options: ResolveOptions = {},
): VerificationConfig {
  const env = options.env ?? process.env;

  const issues: string[] = [];

  // 数値パラメータ（design §4.1 の表）
  const values = {} as Record<NumericParamKey, number>;
  for (const key of Object.keys(NUMERIC_SPECS) as NumericParamKey[]) {
    values[key] = parseNumeric(NUMERIC_SPECS[key], env[NUMERIC_SPECS[key].env], issues);
  }

  // RELAY_MODE（文字列列挙。数値表とは別に検証。許容 3 値以外は失敗。要件 2.9）
  const relayMode = parseRelayMode(env[RELAY_MODE_ENV], issues);

  if (issues.length > 0) {
    throw new VerificationConfigError(issues);
  }

  return {
    relayMode,
    labelingMaxConcurrency: values.labelingMaxConcurrency,
    labelingWorkerBatchSize: values.labelingWorkerBatchSize,
    routerBatchSize: values.routerBatchSize,
    routerParallelizationFactor: values.routerParallelizationFactor,
    seedUnitCountMax: values.seedUnitCountMax,
    bestBeforeDays: values.bestBeforeDays,
  };
}

let cached: VerificationConfig | undefined;

/**
 * 合成中に何度参照しても同じ値を返す（1 度だけ解決してキャッシュ）。
 * CDK Construct 側・`backend.ts` はこちらを使う（design §4.1 / §10）。
 */
export function getVerificationConfig(): VerificationConfig {
  cached ??= resolveVerificationConfig();
  return cached;
}

/** テスト用。キャッシュを破棄する。 */
export function resetVerificationConfigCache(): void {
  cached = undefined;
}

/**
 * `RELAY_MODE` を解決する（design §4.1 / §4.3.5）。
 * 未設定は既定 `pipes`、許容 3 値以外は issues に積む（既定へ黙って読み替えない）。
 */
function parseRelayMode(
  raw: string | undefined,
  issues: string[],
): RelayMode {
  if (raw === undefined || raw.trim() === "") {
    return VERIFICATION_DEFAULTS.relayMode;
  }
  const text = raw.trim();
  if ((RELAY_MODES as readonly string[]).includes(text)) {
    return text as RelayMode;
  }
  issues.push(
    `${RELAY_MODE_ENV}: 許容値外です（受け取った値: "${raw}"、許容: ${RELAY_MODES.join(" / ")}）`,
  );
  // issues に積んだ時点で呼び出し側が throw するため、戻り値は使われない
  return VERIFICATION_DEFAULTS.relayMode;
}

/**
 * 数値の環境変数を範囲込みで解決する。
 * 未設定・空文字は既定。非数値・非整数・範囲外は issues に積む（既定へ読み替えない）。
 */
function parseNumeric(
  spec: NumericParamSpec,
  raw: string | undefined,
  issues: string[],
): number {
  if (raw === undefined || raw.trim() === "") {
    return spec.fallback;
  }
  const text = raw.trim();
  const value = Number(text);

  if (!Number.isFinite(value)) {
    issues.push(
      `${spec.env}: 数値として解釈できません（受け取った値: "${raw}"、範囲: ${spec.range}）`,
    );
    return spec.fallback;
  }
  if (spec.integer && !Number.isInteger(value)) {
    issues.push(
      `${spec.env}: 整数で指定してください（受け取った値: ${text}、範囲: ${spec.range}）`,
    );
    return spec.fallback;
  }
  if (value < spec.min || value > spec.max) {
    issues.push(
      `${spec.env}: 範囲外です（受け取った値: ${text}、範囲: ${spec.range}）`,
    );
    return spec.fallback;
  }
  return value;
}
