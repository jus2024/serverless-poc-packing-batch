import { describe, it, expect } from "vitest";
import {
  buildUnitId,
  stripBatchPrefix,
  ensureBatchId,
  ensureLotId,
} from "./unit-keys.js";

/**
 * `buildUnitId` の採番規則テスト（design §3.4 / §6.6）。
 * seq ゼロ埋め・BATCH# 剥がし・決定性を検証する。
 */
describe("buildUnitId", () => {
  it("seq=1 を 6 桁ゼロ埋めで -000001 にする", () => {
    expect(buildUnitId("BATCH#2026-10-09-AM-01", 1)).toBe(
      "UNIT#2026-10-09-AM-01-000001",
    );
  });

  it("seq=1000 を -001000 にする（桁上がり境界）", () => {
    expect(buildUnitId("BATCH#2026-10-09-AM-01", 1000)).toBe(
      "UNIT#2026-10-09-AM-01-001000",
    );
  });

  it("design §3.4 の例（seq=742 → -000742）に一致する", () => {
    expect(buildUnitId("BATCH#2026-10-09-AM-01", 742)).toBe(
      "UNIT#2026-10-09-AM-01-000742",
    );
  });

  it("BATCH# 接頭辞を剥がして本体のみ連結する", () => {
    const id = buildUnitId("BATCH#2026-10-09-AM-01", 1);
    expect(id.includes("BATCH#")).toBe(false);
    expect(id).toBe("UNIT#2026-10-09-AM-01-000001");
  });

  it("BATCH# が無い batch_id も本体として扱う", () => {
    expect(buildUnitId("2026-10-09-AM-01", 5)).toBe(
      "UNIT#2026-10-09-AM-01-000005",
    );
  });

  it("同一入力に対して決定的（同じ文字列）", () => {
    const a = buildUnitId("BATCH#X", 7);
    const b = buildUnitId("BATCH#X", 7);
    expect(a).toBe(b);
  });

  it("seq が 1 未満または非整数なら例外", () => {
    expect(() => buildUnitId("BATCH#X", 0)).toThrow();
    expect(() => buildUnitId("BATCH#X", -1)).toThrow();
    expect(() => buildUnitId("BATCH#X", 1.5)).toThrow();
  });
});

describe("stripBatchPrefix", () => {
  it("BATCH# を剥がす", () => {
    expect(stripBatchPrefix("BATCH#abc")).toBe("abc");
  });
  it("接頭辞が無ければそのまま返す", () => {
    expect(stripBatchPrefix("abc")).toBe("abc");
  });
});

describe("ensureBatchId / ensureLotId", () => {
  it("ensureBatchId は接頭辞を補う", () => {
    expect(ensureBatchId("x")).toBe("BATCH#x");
    expect(ensureBatchId("BATCH#x")).toBe("BATCH#x");
  });
  it("ensureLotId は接頭辞を補う", () => {
    expect(ensureLotId("x")).toBe("LOT#x");
    expect(ensureLotId("LOT#x")).toBe("LOT#x");
  });
});
