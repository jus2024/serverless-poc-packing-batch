import { describe, it, expect } from "vitest";
import {
  buildUnitRecords,
  buildSeedPlan,
  chunk,
  BATCH_WRITE_CHUNK_SIZE,
} from "./seed-plan.js";

/**
 * seeder 純ロジックのテスト（design §6.1 / 要件 1）。
 * Unit 生成（unit_count 非正規化・buildUnitId 採番）、25 件チャンク化を検証する。
 */

const input = {
  batch_id: "BATCH#2026-10-09-AM-01",
  lot_id: "LOT#2026-10-01-003",
  item_id: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
  unit_count: 1000,
  roast_date: "2026-10-09",
  created_at: "2026-10-09T00:00:00.000Z",
};

describe("buildUnitRecords", () => {
  it("unit_count 件を生成し seq を 1..unit_count にする", () => {
    const recs = buildUnitRecords({ ...input, unit_count: 3 });
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("全 Unit を PENDING にする", () => {
    const recs = buildUnitRecords({ ...input, unit_count: 5 });
    expect(recs.every((r) => r.status === "PENDING")).toBe(true);
  });

  it("buildUnitId で決定的に採番する（1 始まり・6 桁ゼロ埋め）", () => {
    const recs = buildUnitRecords({ ...input, unit_count: 1000 });
    expect(recs[0].unit_id).toBe("UNIT#2026-10-09-AM-01-000001");
    expect(recs[999].unit_id).toBe("UNIT#2026-10-09-AM-01-001000");
  });

  it("各 Unit に batch の unit_count を非正規化して付与する（HIGH-1・案 B）", () => {
    const recs = buildUnitRecords({ ...input, unit_count: 1000 });
    expect(recs.every((r) => r.unit_count === 1000)).toBe(true);
  });

  it("batch_id / lot_id / item_id / roast_date / created_at を各 Unit に伝播する", () => {
    const [r] = buildUnitRecords({ ...input, unit_count: 1 });
    expect(r.batch_id).toBe(input.batch_id);
    expect(r.lot_id).toBe(input.lot_id);
    expect(r.item_id).toBe(input.item_id);
    expect(r.roast_date).toBe(input.roast_date);
    expect(r.created_at).toBe(input.created_at);
  });

  it("unit_count が 1 未満または非整数なら例外", () => {
    expect(() => buildUnitRecords({ ...input, unit_count: 0 })).toThrow();
    expect(() => buildUnitRecords({ ...input, unit_count: 1.5 })).toThrow();
  });
});

describe("chunk", () => {
  it("指定サイズで分割する", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("空配列は空のチャンク配列", () => {
    expect(chunk([], 25)).toEqual([]);
  });
  it("size < 1 は例外", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe("buildSeedPlan", () => {
  it("1000 件を 25 件チャンクで 40 回に分割する（design §6.1）", () => {
    const plan = buildSeedPlan(input);
    expect(plan.records).toHaveLength(1000);
    expect(BATCH_WRITE_CHUNK_SIZE).toBe(25);
    expect(plan.chunks).toHaveLength(40);
    expect(plan.chunks.every((c) => c.length <= 25)).toBe(true);
  });

  it("端数が出るケース（26 件 → 25 + 1）", () => {
    const plan = buildSeedPlan({ ...input, unit_count: 26 });
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]).toHaveLength(25);
    expect(plan.chunks[1]).toHaveLength(1);
  });
});
