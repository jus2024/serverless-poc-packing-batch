/**
 * ライン監督画面の稼働メトリクス（純関数。design §6 / 要件 F6）。
 *
 * 進捗の根拠は `labeled_count` のポーリング差分のみで、SQS キュー深度や CloudWatch には
 * 一切依存しない。既存 `progress.ts`（`recentRatePerSecond` / `ProgressSample`）は変更せず
 * 再利用する。サンプル（prev/cur）の保持はコンポーネント責務で、ここは算術のみを持つ。
 * `operations.test.ts` でユニットテストする。
 */
import { recentRatePerSecond, type ProgressSample } from "./progress";

/**
 * 同時実行数の固定表示（MaximumConcurrency 相当。要件 F6-2）。
 *
 * **これは計測値ではなくフロント固定定数である**。worker の `MaximumConcurrency` の既定を
 * 業務画面に示すための pinned 値であり、実値は `GET /config` の `labelingMaxConcurrency`
 * （文字列）を副次表示する（design §6.4 NIT-2）。この number 定数と文字列の実値は別物として
 * 並記するだけで、数値比較には使わない。
 */
export const PINNED_WORKER_CONCURRENCY = 1000;

/**
 * プリンタ能力（枚/分）。**これは計測値ではなくデモ用のフロント固定定数である**（隠し定数）。
 * 付番レートとこの値の大小比較だけでボトルネックを決定論的に判定する（design §6.3）。
 */
export const PRINTER_CAPACITY_PER_MIN = 500;

/**
 * 付番レート（件/分）を直近 2 観測から算出する（design §6.2 / 要件 F6-2）。
 *
 * 既存 `recentRatePerSecond(prev, cur)`（件/秒）を呼び `* 60` して件/分にする。
 * 異常値（時刻逆行・件数減）は `recentRatePerSecond` が 0 を返すので件/分も 0。
 */
export function labelingRatePerMinute(
  prev: ProgressSample,
  cur: ProgressSample,
): number {
  return recentRatePerSecond(prev, cur) * 60;
}

/** ボトルネック判定（design §6.3 / 要件 F6-2, 3）。 */
export type BottleneckVerdict = "PRINTER_BOUND" | "WITHIN_CAPACITY" | "IDLE";

/**
 * 付番レート（件/分）とプリンタ能力 500/分の大小比較のみからボトルネックを判定する
 * （CloudWatch に一切依存しない。design §6.3）。
 *
 * - `<= 0` → `IDLE`（レート未計測・停滞）。
 * - `> 500` → `PRINTER_BOUND`（プリンタが律速）。
 * - `> 0 && <= 500` → `WITHIN_CAPACITY`（能力範囲内）。境界 500 ちょうどは `WITHIN_CAPACITY`。
 */
export function printerBottleneckVerdict(ratePerMin: number): BottleneckVerdict {
  if (ratePerMin <= 0) return "IDLE";
  if (ratePerMin > PRINTER_CAPACITY_PER_MIN) return "PRINTER_BOUND";
  return "WITHIN_CAPACITY";
}
