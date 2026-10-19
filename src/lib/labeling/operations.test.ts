import { describe, it, expect } from "vitest";
import {
  PINNED_WORKER_CONCURRENCY,
  PRINTER_CAPACITY_PER_MIN,
  labelingRatePerMinute,
  printerBottleneckVerdict,
} from "./operations";
import type { ProgressSample } from "./progress";

/**
 * 稼働メトリクス純ロジックのユニットテスト（design §6 / §11.1 / 要件 F6）。
 */

const sample = (labeledCount: number, timestampMs: number): ProgressSample => ({
  labeledCount,
  timestampMs,
});

describe("labelingRatePerMinute", () => {
  it("件/秒 × 60 で件/分を返す", () => {
    // 10 秒で 100 件 → 10 件/秒 → 600 件/分
    const rate = labelingRatePerMinute(sample(0, 0), sample(100, 10_000));
    expect(rate).toBe(600);
  });

  it("時刻逆行・経過 0 は 0", () => {
    expect(labelingRatePerMinute(sample(0, 10_000), sample(100, 5_000))).toBe(0);
    expect(labelingRatePerMinute(sample(0, 1_000), sample(100, 1_000))).toBe(0);
  });

  it("件数が減った異常値は 0", () => {
    expect(labelingRatePerMinute(sample(100, 0), sample(50, 10_000))).toBe(0);
  });
});

describe("printerBottleneckVerdict", () => {
  it("<= 0 は IDLE", () => {
    expect(printerBottleneckVerdict(0)).toBe("IDLE");
    expect(printerBottleneckVerdict(-5)).toBe("IDLE");
  });

  it("> 500 は PRINTER_BOUND", () => {
    expect(printerBottleneckVerdict(501)).toBe("PRINTER_BOUND");
    expect(printerBottleneckVerdict(620)).toBe("PRINTER_BOUND");
  });

  it("0 < rate <= 500 は WITHIN_CAPACITY", () => {
    expect(printerBottleneckVerdict(1)).toBe("WITHIN_CAPACITY");
    expect(printerBottleneckVerdict(499)).toBe("WITHIN_CAPACITY");
  });

  it("境界 500 ちょうどは WITHIN_CAPACITY", () => {
    expect(printerBottleneckVerdict(500)).toBe("WITHIN_CAPACITY");
  });
});

describe("定数（フロント固定値）", () => {
  it("PINNED_WORKER_CONCURRENCY=1000 / PRINTER_CAPACITY_PER_MIN=500", () => {
    expect(PINNED_WORKER_CONCURRENCY).toBe(1000);
    expect(PRINTER_CAPACITY_PER_MIN).toBe(500);
  });
});
