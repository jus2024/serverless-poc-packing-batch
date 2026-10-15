/**
 * `unit_id` / `batch_id` / `lot_id` の採番・パース（design §3.4 / §6.6）。
 *
 * `unit_id` は冪等キーであり、worker の `attribute_not_exists(best_before)` による
 * 二重付番防止と `RELAY_MODE=both` の二重配信吸収（design §15）はすべてこのキーの
 * 一意性・決定性に依存する。採番ルールを 1 箇所（`buildUnitId`）で確定し、seeder の
 * 生成・router の射影・Pipes `inputTemplate` の射影・worker の条件付き書き込みの
 * 四者が **同一文字列** を作ることを保証する（design §3.4）。
 *
 *   unit_id = 'UNIT#' + <batch_id の "BATCH#" 接頭辞を除いた本体> + '-' + String(seq).padStart(6, '0')
 *
 * - `seq` は batch 内 1 始まりの連番（1 〜 unit_count）。
 * - ゼロ埋めは 6 桁固定（SEED_UNIT_COUNT_MAX=1200 を十分に収容し、辞書順ソートが連番順と一致）。
 * - `BATCH#` 接頭辞は `unit_id` には含めない（本体のみを連結する）。
 */

export const BATCH_PREFIX = "BATCH#";
export const UNIT_PREFIX = "UNIT#";
export const LOT_PREFIX = "LOT#";
export const ITEM_PREFIX = "ITEM#";

/** `unit_id` の seq ゼロ埋め桁数（design §3.4。6 桁固定）。 */
export const UNIT_SEQ_PAD = 6;

/**
 * `batch_id` から `BATCH#` 接頭辞を剥がした本体を返す。
 * 接頭辞が付いていなければそのまま本体として扱う（決定性のため例外にしない）。
 */
export function stripBatchPrefix(batchId: string): string {
  return batchId.startsWith(BATCH_PREFIX)
    ? batchId.slice(BATCH_PREFIX.length)
    : batchId;
}

/**
 * `unit_id` の唯一の採番実装（design §3.4）。seeder・router が呼ぶ。
 *
 * @param batchId `BATCH#...` 形式の batch_id（接頭辞なしでも受理）
 * @param seq     batch 内 1 始まりの連番
 */
export function buildUnitId(batchId: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`buildUnitId: seq must be an integer >= 1 (got ${seq})`);
  }
  const body = stripBatchPrefix(batchId);
  return `${UNIT_PREFIX}${body}-${String(seq).padStart(UNIT_SEQ_PAD, "0")}`;
}

/**
 * `batch_id` を正規化する（`BATCH#` が無ければ付与）。
 * API 層が受け取った値を一貫した形で扱うためのヘルパ。
 */
export function ensureBatchId(raw: string): string {
  return raw.startsWith(BATCH_PREFIX) ? raw : `${BATCH_PREFIX}${raw}`;
}

/**
 * `lot_id` を正規化する（`LOT#` が無ければ付与）。
 */
export function ensureLotId(raw: string): string {
  return raw.startsWith(LOT_PREFIX) ? raw : `${LOT_PREFIX}${raw}`;
}
