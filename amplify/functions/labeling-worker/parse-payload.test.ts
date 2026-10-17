import { describe, it, expect } from "vitest";
import type { SQSRecord } from "aws-lambda";
import { parsePayload } from "./handler.js";

/**
 * SQS ペイロード解釈のテスト（design §3.4 / NIT-1）。
 *
 * 入口が 2 系統あり seq / unit_count の型が揃わない:
 * - router（方式 A-Lambda）: SendMessageBatch で JSON をそのまま送る → number
 * - Pipes（方式 A-Pipes）: inputTemplate が DynamoDB Streams の .N（文字列）を射影 → 文字列
 * どちらでも worker が付番できることを固定する（実機で Pipes が文字列を送り全件 PENDING の
 * まま進まなかった回帰）。
 */

function rec(body: unknown): SQSRecord {
  return { messageId: "m1", body: JSON.stringify(body) } as SQSRecord;
}

const base = {
  unit_id: "UNIT#2026-10-09-AM-01-000742",
  batch_id: "BATCH#2026-10-09-AM-01",
  lot_id: "LOT#2026-10-01-003",
  item_id: "ITEM#ETH-YIRG",
  roast_date: "2026-10-09",
};

describe("parsePayload", () => {
  it("router 経路（seq/unit_count が number）を解釈する", () => {
    const p = parsePayload(rec({ ...base, seq: 742, unit_count: 1000 }));
    expect(p.seq).toBe(742);
    expect(p.unit_count).toBe(1000);
    expect(typeof p.unit_count).toBe("number");
  });

  it("Pipes 経路（seq/unit_count が文字列）も number に正規化する（実機回帰）", () => {
    const p = parsePayload(rec({ ...base, seq: "742", unit_count: "1000" }));
    expect(p.seq).toBe(742);
    expect(p.unit_count).toBe(1000);
    expect(typeof p.unit_count).toBe("number");
  });

  it("unit_id 欠落は例外", () => {
    expect(() => parsePayload(rec({ ...base, unit_id: "", seq: 1, unit_count: 10 }))).toThrow();
  });

  it("unit_count が数値化できない文字列は例外", () => {
    expect(() =>
      parsePayload(rec({ ...base, seq: 1, unit_count: "abc" })),
    ).toThrow();
  });
});
