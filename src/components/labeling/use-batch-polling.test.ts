/**
 * use-batch-polling の停止条件テスト（design §16）。
 *
 * vitest 環境は node（DOM 無し。vitest.config.ts）のため、フック本体ではなく
 * 停止判定の純関数 `shouldStopPolling` を検証する。
 */
import { describe, it, expect } from "vitest";
import { shouldStopPolling, DEFAULT_POLL_INTERVAL_MS } from "./use-batch-polling";

describe("shouldStopPolling", () => {
  it("active=false なら停止する", () => {
    expect(shouldStopPolling({ active: false, batch: null })).toBe(true);
    expect(
      shouldStopPolling({ active: false, batch: { status: "LABELING" } }),
    ).toBe(true);
  });

  it("batch が LABELED（完了）なら停止する", () => {
    expect(
      shouldStopPolling({ active: true, batch: { status: "LABELED" } }),
    ).toBe(true);
  });

  it("未取得（null）や付番中は継続する", () => {
    expect(shouldStopPolling({ active: true, batch: null })).toBe(false);
    expect(
      shouldStopPolling({ active: true, batch: { status: "ROASTING_DONE" } }),
    ).toBe(false);
    expect(
      shouldStopPolling({ active: true, batch: { status: "LABELING" } }),
    ).toBe(false);
  });
});

describe("ポーリング間隔", () => {
  it("既定は 1〜2 秒の範囲（design §11.4）", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_POLL_INTERVAL_MS).toBeLessThanOrEqual(2000);
  });
});
