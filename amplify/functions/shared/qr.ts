/**
 * `qr_payload` 文字列生成（design §6.3-2 / §6.6）。
 *
 * 出力フォーマットは唯一の出典として確定している:
 *   qr_payload = JSON.stringify({ unit_id, item_id, best_before })
 *
 * キー順は unit_id → item_id → best_before に固定する（決定性のため。常に同じキー順で
 * オブジェクトを組み立てる）。同一入力に対して常に同一文字列を返す。実画像生成は対象外で
 * ペイロード文字列まで（design スコープ）。JSON を採る理由は将来の QR 化・画面 D のトレース
 * 表示での扱いやすさ（独自区切りより拡張しやすい）。
 */

export interface QrPayloadInput {
  unit_id: string;
  item_id: string;
  best_before: string;
}

/**
 * `qr_payload` 文字列を決定的に組み立てる。
 * キー順を固定するため、オブジェクトリテラルを unit_id → item_id → best_before の順で作る。
 */
export function buildQrPayload(input: QrPayloadInput): string {
  return JSON.stringify({
    unit_id: input.unit_id,
    item_id: input.item_id,
    best_before: input.best_before,
  });
}
