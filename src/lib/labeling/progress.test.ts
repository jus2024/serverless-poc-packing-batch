/**
 * progress.ts のユニットテスト（design §16。進捗率・完了判定・ETA・増分）。
 */
import { describe, it, expect } from "vitest";
import {
  progressPercent,
  isBatchComplete,
  recentRatePerSecond,
  estimateEtaSeconds,
  elapsedSeconds,
} from "./progress";

describe("progressPercent", () => {
  it("付番済み/総数の百分率を返す", () => {
    expect(progressPercent(742, 1000)).toBeCloseTo(74.2);
    expect(progressPercent(0, 1000)).toBe(0);
    expect(progressPercent(1000, 1000)).toBe(100);
  });

  it("unit_count が 0 以下ならゼロ除算を避けて 0 を返す", () => {
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(5, -10)).toBe(0);
  });

  it("異常値（超過・負）は 0〜100 に丸める", () => {
    expect(progressPercent(1500, 1000)).toBe(100);
    expect(progressPercent(-5, 1000)).toBe(0);
  });
});

describe("isBatchComplete", () => {
  it("status=LABELED のときだけ完了", () => {
    expect(isBatchComplete({ status: "LABELED" })).toBe(true);
    expect(isBatchComplete({ status: "LABELING" })).toBe(false);
    expect(isBatchComplete({ status: "ROASTING_DONE" })).toBe(false);
  });
});

describe("recentRatePerSecond", () => {
  it("直近 2 観測から件/秒を算出する", () => {
    const rate = recentRatePerSecond(
      { labeledCount: 100, timestampMs: 1_000 },
      { labeledCount: 150, timestampMs: 2_000 },
    );
    expect(rate).toBe(50); // +50 件 / 1 秒
  });

  it("経過 0 以下や件数が減った場合は 0", () => {
    expect(
      recentRatePerSecond(
        { labeledCount: 100, timestampMs: 2_000 },
        { labeledCount: 150, timestampMs: 2_000 },
      ),
    ).toBe(0);
    expect(
      recentRatePerSecond(
        { labeledCount: 150, timestampMs: 1_000 },
        { labeledCount: 100, timestampMs: 2_000 },
      ),
    ).toBe(0);
  });
});

describe("estimateEtaSeconds", () => {
  it("残り件数 / レートで ETA を概算する", () => {
    expect(estimateEtaSeconds(500, 1000, 50)).toBe(10); // 残り500 / 50件秒
  });

  it("完了済み（残り 0 以下）やレート 0 以下は null", () => {
    expect(estimateEtaSeconds(1000, 1000, 50)).toBeNull();
    expect(estimateEtaSeconds(500, 1000, 0)).toBeNull();
    expect(estimateEtaSeconds(500, 1000, -1)).toBeNull();
  });
});

describe("elapsedSeconds", () => {
  it("開始時刻からの経過秒を返す", () => {
    const started = "2026-10-09T00:00:00.000Z";
    const now = Date.parse(started) + 30_000;
    expect(elapsedSeconds(started, now)).toBe(30);
  });

  it("未確定・解釈不能・未来は 0", () => {
    expect(elapsedSeconds(undefined, Date.now())).toBe(0);
    expect(elapsedSeconds("", Date.now())).toBe(0);
    expect(elapsedSeconds("not-a-date", Date.now())).toBe(0);
    const started = "2026-10-09T00:00:00.000Z";
    expect(elapsedSeconds(started, Date.parse(started) - 1000)).toBe(0);
  });
});
