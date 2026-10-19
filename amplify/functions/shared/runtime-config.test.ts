import { describe, it, expect } from "vitest";
import {
  ENV_KEYS,
  RuntimeConfigError,
  resolveTableConfig,
  resolveTableNames,
  resolveRoastBatchTableName,
  resolveVerificationConfig,
  resolveSeedWriteConcurrency,
  BEST_BEFORE_DAYS_DEFAULT,
  SEED_UNIT_COUNT_MAX_DEFAULT,
} from "./runtime-config.js";

/**
 * 実行時設定の解決テスト（design §4.1 / §6.6 / 非機能 5）。
 * 範囲内・範囲外・不正値・既定フォールバック・必須欠落を検証する。
 */

const fullTableEnv = {
  [ENV_KEYS.UNIT_TABLE_NAME]: "kiro-roasters-unit-ab12cd34",
  [ENV_KEYS.ROAST_BATCH_TABLE_NAME]: "kiro-roasters-roast-batch-ab12cd34",
  [ENV_KEYS.BATCH_UNITS_INDEX_NAME]: "batch-units-index",
  [ENV_KEYS.LOT_TRACE_INDEX_NAME]: "lot-trace-index",
};

describe("resolveTableConfig", () => {
  it("全キーが揃えば解決する", () => {
    expect(resolveTableConfig(fullTableEnv)).toEqual({
      unitTableName: "kiro-roasters-unit-ab12cd34",
      roastBatchTableName: "kiro-roasters-roast-batch-ab12cd34",
      batchUnitsIndexName: "batch-units-index",
      lotTraceIndexName: "lot-trace-index",
    });
  });

  it("必須キー欠落は RuntimeConfigError", () => {
    const { [ENV_KEYS.UNIT_TABLE_NAME]: _omit, ...rest } = fullTableEnv;
    expect(() => resolveTableConfig(rest)).toThrow(RuntimeConfigError);
  });

  it("空文字は欠落として扱い RuntimeConfigError", () => {
    expect(() =>
      resolveTableConfig({ ...fullTableEnv, [ENV_KEYS.UNIT_TABLE_NAME]: "" }),
    ).toThrow(RuntimeConfigError);
  });
});

describe("resolveTableNames（seeder / worker 用。GSI 名を要求しない）", () => {
  // seeder / worker には GSI 名の環境変数が注入されない（最小権限。labeling-functions.ts）。
  // GSI 名が無くてもテーブル名だけで解決できることを固定する（実機の seeder クラッシュ回帰）。
  it("GSI 名が無くてもテーブル名だけで解決する", () => {
    expect(
      resolveTableNames({
        [ENV_KEYS.UNIT_TABLE_NAME]: "kiro-roasters-unit-ab12cd34",
        [ENV_KEYS.ROAST_BATCH_TABLE_NAME]: "kiro-roasters-roast-batch-ab12cd34",
      }),
    ).toEqual({
      unitTableName: "kiro-roasters-unit-ab12cd34",
      roastBatchTableName: "kiro-roasters-roast-batch-ab12cd34",
    });
  });

  it("テーブル名の欠落は RuntimeConfigError", () => {
    expect(() =>
      resolveTableNames({ [ENV_KEYS.UNIT_TABLE_NAME]: "only-unit" }),
    ).toThrow(RuntimeConfigError);
  });
});

describe("resolveRoastBatchTableName（plan-seeder 用。unit 名を要求しない）", () => {
  // plan-seeder には roast-batch 名の環境変数だけが注入される（unit テーブル非接触。§4.1 / §4.2）。
  // unit 名が無くても roast-batch 名だけで解決できることを固定する（起動時設定エラー回帰）。
  it("unit 名が無くても roast-batch 名だけで解決する", () => {
    expect(
      resolveRoastBatchTableName({
        [ENV_KEYS.ROAST_BATCH_TABLE_NAME]: "kiro-roasters-roast-batch-ab12cd34",
      }),
    ).toEqual({
      roastBatchTableName: "kiro-roasters-roast-batch-ab12cd34",
    });
  });

  it("roast-batch 名の欠落は RuntimeConfigError", () => {
    expect(() => resolveRoastBatchTableName({})).toThrow(RuntimeConfigError);
  });
});

describe("resolveSeedWriteConcurrency（最速投入・T2 観測用）", () => {
  it("未設定は既定 1（従来の直列書き込み）", () => {
    expect(resolveSeedWriteConcurrency({})).toBe(1);
  });
  it("範囲内の値を解決する", () => {
    expect(resolveSeedWriteConcurrency({ [ENV_KEYS.SEED_WRITE_CONCURRENCY]: "48" })).toBe(48);
  });
  it("範囲外（>48）は RuntimeConfigError", () => {
    expect(() =>
      resolveSeedWriteConcurrency({ [ENV_KEYS.SEED_WRITE_CONCURRENCY]: "49" }),
    ).toThrow(RuntimeConfigError);
  });
});

describe("resolveVerificationConfig", () => {
  it("未設定は既定にフォールバックする", () => {
    expect(resolveVerificationConfig({})).toEqual({
      bestBeforeDays: BEST_BEFORE_DAYS_DEFAULT,
      seedUnitCountMax: SEED_UNIT_COUNT_MAX_DEFAULT,
      processingTimeMs: 0,
    });
  });

  it("PROCESSING_TIME_MS を範囲内で解決する（R5/T1 観測用。既定 0）", () => {
    expect(resolveVerificationConfig({}).processingTimeMs).toBe(0);
    expect(
      resolveVerificationConfig({ [ENV_KEYS.PROCESSING_TIME_MS]: "3000" })
        .processingTimeMs,
    ).toBe(3000);
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.PROCESSING_TIME_MS]: "60001" }),
    ).toThrow(RuntimeConfigError);
  });

  it("範囲内の値を解決する", () => {
    const cfg = resolveVerificationConfig({
      [ENV_KEYS.BEST_BEFORE_DAYS]: "180",
      [ENV_KEYS.SEED_UNIT_COUNT_MAX]: "2000",
    });
    expect(cfg.bestBeforeDays).toBe(180);
    expect(cfg.seedUnitCountMax).toBe(2000);
  });

  it("範囲外（BEST_BEFORE_DAYS 下限未満）は例外（既定へ読み替えない）", () => {
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.BEST_BEFORE_DAYS]: "0" }),
    ).toThrow(RuntimeConfigError);
  });

  it("範囲外（BEST_BEFORE_DAYS 上限超過）は例外", () => {
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.BEST_BEFORE_DAYS]: "3651" }),
    ).toThrow(RuntimeConfigError);
  });

  it("非整数は例外", () => {
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.BEST_BEFORE_DAYS]: "365.5" }),
    ).toThrow(RuntimeConfigError);
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.SEED_UNIT_COUNT_MAX]: "abc" }),
    ).toThrow(RuntimeConfigError);
  });

  it("SEED_UNIT_COUNT_MAX の範囲外は例外", () => {
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.SEED_UNIT_COUNT_MAX]: "0" }),
    ).toThrow(RuntimeConfigError);
    expect(() =>
      resolveVerificationConfig({ [ENV_KEYS.SEED_UNIT_COUNT_MAX]: "5001" }),
    ).toThrow(RuntimeConfigError);
  });
});
