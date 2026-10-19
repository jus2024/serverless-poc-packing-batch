import { describe, it, expect } from "vitest";
import { buildQrPayload } from "./qr.js";

/**
 * `qr_payload` 生成の決定性・キー順テスト（design §6.3-2）。
 */
describe("buildQrPayload", () => {
  const input = {
    unit_id: "UNIT#2026-10-09-AM-01-000742",
    item_id: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
    best_before: "2027-10-09",
  };

  it("キー順を unit_id → item_id → best_before に固定する", () => {
    expect(buildQrPayload(input)).toBe(
      '{"unit_id":"UNIT#2026-10-09-AM-01-000742","item_id":"ITEM#ETH-YIRG-G1-MEDIUM-DRIP","best_before":"2027-10-09"}',
    );
  });

  it("入力オブジェクトのキー順に依存せず同じ文字列を返す（決定性）", () => {
    const reordered = {
      best_before: input.best_before,
      item_id: input.item_id,
      unit_id: input.unit_id,
    };
    expect(buildQrPayload(reordered)).toBe(buildQrPayload(input));
  });

  it("同一入力に対して常に同一文字列（冪等）", () => {
    expect(buildQrPayload(input)).toBe(buildQrPayload(input));
  });

  it("有効な JSON であり 3 キーのみを含む", () => {
    const parsed = JSON.parse(buildQrPayload(input));
    expect(parsed).toEqual(input);
    expect(Object.keys(parsed)).toEqual(["unit_id", "item_id", "best_before"]);
  });
});
