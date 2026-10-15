import { describe, it, expect } from "vitest";
import {
  computeBestBefore,
  buildLabelingValues,
  buildUnitLabelUpdate,
  buildLabeledCountAddUpdate,
  buildCompletionUpdate,
} from "./labeling.js";
import type { LabelingMessagePayload } from "../shared/types.js";

/**
 * labeling-worker 純ロジックのテスト（design §6.3 / 要件 3〜5）。
 * best_before（うるう年跨ぎ含む）、付番/加算/完了判定の式組み立てを検証する。
 */

const payload: LabelingMessagePayload = {
  unit_id: "UNIT#2026-10-09-AM-01-000742",
  batch_id: "BATCH#2026-10-09-AM-01",
  lot_id: "LOT#2026-10-01-003",
  item_id: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
  seq: 742,
  unit_count: 1000,
  roast_date: "2026-10-09",
};

describe("computeBestBefore", () => {
  it("roast_date + 365 日（UTC 暦日加算）", () => {
    // 2026-10-09 + 365 日 = 2027-10-09（2027 は平年）
    expect(computeBestBefore("2026-10-09", 365)).toBe("2027-10-09");
  });

  it("うるう年（2028 の 2/29）を跨ぐと暦日 +365 で 1 日手前になる", () => {
    // 2027-10-09 + 365 日: 途中に 2028-02-29 を含むため 2028-10-08
    expect(computeBestBefore("2027-10-09", 365)).toBe("2028-10-08");
  });

  it("月末跨ぎ（+1 日）", () => {
    expect(computeBestBefore("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("うるう日の加算（2028-02-28 + 1 = 2028-02-29）", () => {
    expect(computeBestBefore("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("不正な roast_date は例外", () => {
    expect(() => computeBestBefore("2026/10/09", 365)).toThrow();
    expect(() => computeBestBefore("not-a-date", 365)).toThrow();
  });

  it("days が 1 未満または非整数は例外", () => {
    expect(() => computeBestBefore("2026-10-09", 0)).toThrow();
    expect(() => computeBestBefore("2026-10-09", 1.5)).toThrow();
  });
});

describe("buildLabelingValues", () => {
  it("best_before と qr_payload（キー順固定）と labeled_at を組み立てる", () => {
    const v = buildLabelingValues(payload, 365, "2026-10-09T01:00:00.000Z");
    expect(v.best_before).toBe("2027-10-09");
    expect(v.qr_payload).toBe(
      '{"unit_id":"UNIT#2026-10-09-AM-01-000742","item_id":"ITEM#ETH-YIRG-G1-MEDIUM-DRIP","best_before":"2027-10-09"}',
    );
    expect(v.labeled_at).toBe("2026-10-09T01:00:00.000Z");
  });
});

describe("buildUnitLabelUpdate", () => {
  const v = {
    best_before: "2027-10-09",
    qr_payload: "{}",
    labeled_at: "2026-10-09T01:00:00.000Z",
  };

  it("attribute_not_exists(best_before) で二重付番を弾く", () => {
    const u = buildUnitLabelUpdate(v);
    expect(u.ConditionExpression).toBe("attribute_not_exists(best_before)");
  });

  it("status=LABELED と best_before/qr_payload/labeled_at をセットする", () => {
    const u = buildUnitLabelUpdate(v);
    expect(u.UpdateExpression).toContain("#status = :labeled");
    expect(u.ExpressionAttributeNames["#status"]).toBe("status");
    expect(u.ExpressionAttributeValues[":labeled"]).toBe("LABELED");
    expect(u.ExpressionAttributeValues[":bb"]).toBe("2027-10-09");
  });
});

describe("buildLabeledCountAddUpdate", () => {
  it("ADD labeled_count :one（アトミック加算）", () => {
    const u = buildLabeledCountAddUpdate();
    expect(u.UpdateExpression).toBe("ADD labeled_count :one");
    expect(u.ExpressionAttributeValues[":one"]).toBe(1);
  });
});

describe("buildCompletionUpdate", () => {
  it(":n に unit_count 固定値を束縛し labeled_count=:n AND status=:labeling を組む", () => {
    const u = buildCompletionUpdate(1000, "2026-10-09T02:00:00.000Z");
    expect(u.ConditionExpression).toBe(
      "labeled_count = :n AND #status = :labeling",
    );
    expect(u.ExpressionAttributeValues[":n"]).toBe(1000);
    expect(u.ExpressionAttributeValues[":labeling"]).toBe("LABELING");
    expect(u.ExpressionAttributeValues[":labeled"]).toBe("LABELED");
    expect(u.ExpressionAttributeNames["#status"]).toBe("status");
  });

  it("status=LABELED と labeling_finished_at をセットする", () => {
    const u = buildCompletionUpdate(1000, "2026-10-09T02:00:00.000Z");
    expect(u.UpdateExpression).toBe(
      "SET #status = :labeled, labeling_finished_at = :fa",
    );
    expect(u.ExpressionAttributeValues[":fa"]).toBe("2026-10-09T02:00:00.000Z");
  });
});
