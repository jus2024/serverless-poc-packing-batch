/**
 * 製品マスタ定数と解決関数（純データ + 純関数。design §5.3 / §5.4 / 要件 F3）。
 *
 * `item_id` は `ITEM#<ORIGIN>-<DISTRICT>-<GRADE>-<ROAST>-<USE>` 形式（design §4.3 と一致）。
 * 画面は生 SKU を前面に出さず、このマスタで産地・焙煎度の業務ラベルに解決して表示する
 * （過去 PoC `stock-management` の `ITEM_PREFIX_GROUPS` 手法を踏襲）。パース・フォールバックは
 * 純関数なので `product-master.test.ts` でユニットテストする。
 */

/** 産地コード → 日本語ラベル（要件 F3-3 の 5 産地を必須）。 */
export const ORIGIN_LABELS: Record<string, { ja: string; code: string }> = {
  ETH: { ja: "エチオピア", code: "ETH" },
  BRA: { ja: "ブラジル", code: "BRA" },
  COL: { ja: "コロンビア", code: "COL" },
  GTM: { ja: "グアテマラ", code: "GTM" },
  KEN: { ja: "ケニア", code: "KEN" },
};

/** 焙煎度コード → 日本語ラベル。 */
export const ROAST_LABELS: Record<string, string> = {
  LIGHT: "浅煎り",
  MEDIUM: "中煎り",
  DARK: "深煎り",
};

export interface ProductLabel {
  /** 産地ラベル（例「エチオピア」）。未解決時は生 ID。 */
  origin: string;
  /** 焙煎度ラベル（例「中煎り」）。未解決時は生 ID。 */
  roast: string;
  /** 生 item_id（副次表示・ツールチップ用）。 */
  raw: string;
  /** マスタで解決できたか（産地・焙煎度ともに既知か）。 */
  isKnown: boolean;
}

/**
 * `item_id` を産地・焙煎度の業務ラベルに解決する（design §5.4 / 要件 F3）。
 *
 * `ITEM#` 接頭辞を剥がし `-` で分割、先頭を産地コード、焙煎度は `ROAST_LABELS` のキー
 * （LIGHT/MEDIUM/DARK）に一致するセグメントを拾う（位置ではなくキー一致で `<USE>` の有無に
 * 強くする）。産地/焙煎度いずれかが未登録、または形式不正なら `isKnown: false` とし、
 * `origin`/`roast` に生 ID をそのまま入れてフォールバックする（要件 F3-4）。
 */
export function resolveProductLabel(itemId: string): ProductLabel {
  const body = itemId.startsWith("ITEM#") ? itemId.slice("ITEM#".length) : itemId;
  const segments = body.split("-").filter((s) => s !== "");

  const originCode = segments[0];
  const origin = originCode ? ORIGIN_LABELS[originCode] : undefined;

  const roastSegment = segments.find((s) => s in ROAST_LABELS);
  const roast = roastSegment ? ROAST_LABELS[roastSegment] : undefined;

  if (origin === undefined || roast === undefined) {
    // フォールバック: 生 ID をそのまま返し、未登録バッジで示せるようにする
    return { origin: itemId, roast: itemId, raw: itemId, isKnown: false };
  }

  return { origin: origin.ja, roast, raw: itemId, isKnown: true };
}
