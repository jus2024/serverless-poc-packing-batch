import { describe, it, expect } from "vitest";
import { resolveProductLabel } from "./product-master";

/**
 * 製品マスタ解決のユニットテスト（design §5.4 / §11.1 / 要件 F3）。
 */

describe("resolveProductLabel", () => {
  it("既知 ID の産地/焙煎度ラベルを解決する", () => {
    const label = resolveProductLabel("ITEM#ETH-YIRG-G1-MEDIUM-DRIP");
    expect(label).toEqual({
      origin: "エチオピア",
      roast: "中煎り",
      raw: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
      isKnown: true,
    });
  });

  it("焙煎度を位置ではなくキー一致で拾う（USE 有無に強い）", () => {
    // USE セグメントが無くても焙煎度 DARK を拾える
    const label = resolveProductLabel("ITEM#BRA-CERR-G2-DARK");
    expect(label.origin).toBe("ブラジル");
    expect(label.roast).toBe("深煎り");
    expect(label.isKnown).toBe(true);
  });

  it("ITEM# 接頭辞を剥がして解決する（接頭辞無しも受理）", () => {
    const label = resolveProductLabel("KEN-NYER-AA-LIGHT-DRIP");
    expect(label.origin).toBe("ケニア");
    expect(label.roast).toBe("浅煎り");
    expect(label.isKnown).toBe(true);
  });

  it("未登録産地は isKnown=false で生 ID フォールバック", () => {
    const label = resolveProductLabel("ITEM#XYZ-ABC-G1-MEDIUM-DRIP");
    expect(label.isKnown).toBe(false);
    expect(label.origin).toBe("ITEM#XYZ-ABC-G1-MEDIUM-DRIP");
    expect(label.roast).toBe("ITEM#XYZ-ABC-G1-MEDIUM-DRIP");
    expect(label.raw).toBe("ITEM#XYZ-ABC-G1-MEDIUM-DRIP");
  });

  it("焙煎度が未登録なら isKnown=false フォールバック", () => {
    const label = resolveProductLabel("ITEM#ETH-YIRG-G1-CITYROAST-DRIP");
    expect(label.isKnown).toBe(false);
    expect(label.raw).toBe("ITEM#ETH-YIRG-G1-CITYROAST-DRIP");
  });

  it("不正形式（空・接頭辞のみ）は安全にフォールバックする", () => {
    expect(resolveProductLabel("").isKnown).toBe(false);
    expect(resolveProductLabel("ITEM#").isKnown).toBe(false);
    expect(resolveProductLabel("garbage").isKnown).toBe(false);
  });
});
