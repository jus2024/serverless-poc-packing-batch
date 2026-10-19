import { describe, it, expect } from "vitest";
import { buildPlanSeedRecords } from "./plan-data.js";
import { SEED_UNIT_COUNT_MAX_DEFAULT } from "../shared/runtime-config.js";

/**
 * 焙煎計画 SEED データのユニットテスト（design §4.3 / §4.4 / §11.1）。
 * handler は副作用のみで純ロジックを持たないため、SEED データの正しさはここで担保する。
 */

const FIXED_NOW = "2026-02-09T00:00:00.000Z";

describe("buildPlanSeedRecords", () => {
  const records = buildPlanSeedRecords(FIXED_NOW);

  it("件数が 10 件（§4.3 の表と一致）", () => {
    expect(records).toHaveLength(10);
  });

  it("全件 status=PLANNED・labeled_count=0・付番時刻は未設定", () => {
    for (const r of records) {
      expect(r.status).toBe("PLANNED");
      expect(r.labeled_count).toBe(0);
      expect(r.labeling_started_at).toBeUndefined();
      expect(r.labeling_finished_at).toBeUndefined();
    }
  });

  it("created_at に注入した投入時刻が入る（決定論的）", () => {
    for (const r of records) {
      expect(r.created_at).toBe(FIXED_NOW);
    }
  });

  it("batch_id が BATCH#YYYY-MM-DD-{AM|PM}-NN 形式", () => {
    const pattern = /^BATCH#\d{4}-\d{2}-\d{2}-(AM|PM)-\d{2}$/;
    for (const r of records) {
      expect(r.batch_id).toMatch(pattern);
    }
  });

  it("batch_id に重複がない", () => {
    const ids = records.map((r) => r.batch_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("産地が ETH/BRA/COL/GTM/KEN を含む", () => {
    const origins = new Set(
      records.map((r) => r.item_id.replace(/^ITEM#/, "").split("-")[0]),
    );
    for (const expected of ["ETH", "BRA", "COL", "GTM", "KEN"]) {
      expect(origins.has(expected)).toBe(true);
    }
  });

  it("item_id が製品マスタ形式 ITEM#<ORIGIN>-...-<ROAST>-<USE> と対応する", () => {
    const pattern = /^ITEM#[A-Z]{3}-.+-(LIGHT|MEDIUM|DARK)-[A-Z]+$/;
    for (const r of records) {
      expect(r.item_id).toMatch(pattern);
    }
  });

  it("全件 unit_count <= SEED_UNIT_COUNT_MAX_DEFAULT（1200）", () => {
    expect(SEED_UNIT_COUNT_MAX_DEFAULT).toBe(1200);
    for (const r of records) {
      expect(r.unit_count).toBeLessThanOrEqual(SEED_UNIT_COUNT_MAX_DEFAULT);
      expect(r.unit_count).toBeGreaterThan(0);
    }
  });
});
