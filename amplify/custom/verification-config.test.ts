import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveVerificationConfig,
  getVerificationConfig,
  resetVerificationConfigCache,
  VerificationConfigError,
  VERIFICATION_DEFAULTS,
  RELAY_MODES,
} from "./verification-config.js";

/**
 * verification-config の単体テスト（design §4.1 / §16）。
 *
 * 範囲内/外、RELAY_MODE の 3 値と不正値、既定フォールバック、MaximumConcurrency 下限 2 の
 * 自前検証（1 を与えると失敗）、複数誤りのまとめ報告を検査する。
 */
describe("resolveVerificationConfig", () => {
  it("未設定なら design §4.1 の既定値を返す", () => {
    const config = resolveVerificationConfig({ env: {} });
    expect(config).toEqual({
      relayMode: VERIFICATION_DEFAULTS.relayMode,
      labelingMaxConcurrency: VERIFICATION_DEFAULTS.labelingMaxConcurrency,
      labelingWorkerBatchSize: VERIFICATION_DEFAULTS.labelingWorkerBatchSize,
      routerBatchSize: VERIFICATION_DEFAULTS.routerBatchSize,
      routerParallelizationFactor:
        VERIFICATION_DEFAULTS.routerParallelizationFactor,
      seedUnitCountMax: VERIFICATION_DEFAULTS.seedUnitCountMax,
      bestBeforeDays: VERIFICATION_DEFAULTS.bestBeforeDays,
      processingTimeMs: VERIFICATION_DEFAULTS.processingTimeMs,
    });
  });

  it("既定の PROCESSING_TIME_MS は 0（本来の挙動）", () => {
    expect(resolveVerificationConfig({ env: {} }).processingTimeMs).toBe(0);
  });

  it("PROCESSING_TIME_MS を範囲内で解決し、範囲外(>60000)は失敗する", () => {
    expect(
      resolveVerificationConfig({ env: { PROCESSING_TIME_MS: "3000" } })
        .processingTimeMs,
    ).toBe(3000);
    expect(() =>
      resolveVerificationConfig({ env: { PROCESSING_TIME_MS: "60001" } }),
    ).toThrow(VerificationConfigError);
  });

  it("既定の BEST_BEFORE_DAYS は 365（要件 3.2 準拠）", () => {
    expect(resolveVerificationConfig({ env: {} }).bestBeforeDays).toBe(365);
  });

  it("RELAY_MODE の許容 3 値を受理する", () => {
    for (const mode of RELAY_MODES) {
      expect(
        resolveVerificationConfig({ env: { RELAY_MODE: mode } }).relayMode,
      ).toBe(mode);
    }
  });

  it("RELAY_MODE の許容外は VerificationConfigError", () => {
    expect(() =>
      resolveVerificationConfig({ env: { RELAY_MODE: "sqs" } }),
    ).toThrow(VerificationConfigError);
  });

  it("範囲内の数値を解決する", () => {
    const config = resolveVerificationConfig({
      env: {
        LABELING_MAX_CONCURRENCY: "500",
        LABELING_WORKER_BATCH_SIZE: "5",
        ROUTER_BATCH_SIZE: "250",
        ROUTER_PARALLELIZATION_FACTOR: "4",
        SEED_UNIT_COUNT_MAX: "2000",
        BEST_BEFORE_DAYS: "180",
      },
    });
    expect(config.labelingMaxConcurrency).toBe(500);
    expect(config.labelingWorkerBatchSize).toBe(5);
    expect(config.routerBatchSize).toBe(250);
    expect(config.routerParallelizationFactor).toBe(4);
    expect(config.seedUnitCountMax).toBe(2000);
    expect(config.bestBeforeDays).toBe(180);
  });

  it("MaximumConcurrency=1 は下限 2 の自前検証で合成を失敗させる", () => {
    expect(() =>
      resolveVerificationConfig({ env: { LABELING_MAX_CONCURRENCY: "1" } }),
    ).toThrow(VerificationConfigError);
  });

  it("MaximumConcurrency=2 は受理する（下限ちょうど）", () => {
    expect(
      resolveVerificationConfig({ env: { LABELING_MAX_CONCURRENCY: "2" } })
        .labelingMaxConcurrency,
    ).toBe(2);
  });

  it("MaximumConcurrency=1250 は受理し 1251 は失敗する（上限境界）", () => {
    expect(
      resolveVerificationConfig({ env: { LABELING_MAX_CONCURRENCY: "1250" } })
        .labelingMaxConcurrency,
    ).toBe(1250);
    expect(() =>
      resolveVerificationConfig({ env: { LABELING_MAX_CONCURRENCY: "1251" } }),
    ).toThrow(VerificationConfigError);
  });

  it("非整数・非数値は既定へ読み替えず失敗する（非機能 5）", () => {
    expect(() =>
      resolveVerificationConfig({ env: { LABELING_WORKER_BATCH_SIZE: "2.5" } }),
    ).toThrow(VerificationConfigError);
    expect(() =>
      resolveVerificationConfig({ env: { ROUTER_BATCH_SIZE: "abc" } }),
    ).toThrow(VerificationConfigError);
  });

  it("複数の誤りをまとめて報告する", () => {
    try {
      resolveVerificationConfig({
        env: {
          RELAY_MODE: "nope",
          LABELING_MAX_CONCURRENCY: "1",
          BEST_BEFORE_DAYS: "99999",
        },
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerificationConfigError);
      const issues = (err as VerificationConfigError).issues;
      expect(issues.length).toBe(3);
    }
  });
});

describe("getVerificationConfig", () => {
  beforeEach(() => {
    resetVerificationConfigCache();
  });

  it("1 度だけ解決してキャッシュする（同一参照を返す）", () => {
    const a = getVerificationConfig();
    const b = getVerificationConfig();
    expect(a).toBe(b);
  });
});
