/**
 * 共通型定義（design §3 / §3.4）。
 *
 * Unit / RoastBatch のレコード型、SQS ペイロード型、labeling-api の入出力型、
 * status のリテラル union をここに集約する。handler・純ロジック・テストの各所が
 * この 1 ファイルの型を共有し、属性名・status 値のブレを防ぐ（EC PoC スタイル）。
 */

/**
 * RoastBatch の status（design §2.1 / §3.2）。
 * PLANNED（焙煎前・焙煎計画）→ ROASTING_DONE（焙煎完了・付番待ち）→ LABELING（付番中）→ LABELED（付番完了）。
 */
export type RoastBatchStatus =
  | "PLANNED"
  | "ROASTING_DONE"
  | "LABELING"
  | "LABELED";

/**
 * Unit の status（design §3.1）。PENDING（投入直後）→ LABELED（付番済み）。
 */
export type UnitStatus = "PENDING" | "LABELED";

/**
 * `kiro-roasters-roast-batch` レコード（design §3.2）。
 * Streams なし・GSI なし。投入指示と完了集計を持つ。
 */
export interface RoastBatchRecord {
  batch_id: string; // PK。`BATCH#...` 形式
  item_id: string;
  lot_id: string;
  roast_date: string; // ISO 8601 日付
  unit_count: number;
  labeled_count: number;
  status: RoastBatchStatus;
  created_at: string;
  labeling_started_at?: string;
  labeling_finished_at?: string;
}

/**
 * `kiro-roasters-unit` レコード（design §3.1）。
 * `unit_count` は worker の完了判定のため非正規化して全 Unit に持たせる
 * （HIGH-1・案 B。design §3.1 / §3.4）。
 */
export interface UnitRecord {
  unit_id: string; // PK。`UNIT#...` 形式。冪等キー
  batch_id: string;
  lot_id: string;
  item_id: string;
  seq: number; // batch 内 1 始まりの連番
  unit_count: number; // 当該 batch の総数（非正規化）
  roast_date: string;
  status: UnitStatus;
  created_at: string;
  best_before?: string;
  qr_payload?: string;
  labeled_at?: string;
}

/**
 * SQS メッセージペイロード（design §3.4）。
 * worker が 1 件処理する単位。`unit_count` を含み（HIGH-1・案 B）、
 * worker は追加読み取りなしに完了判定の `:n` を束縛できる。
 */
export interface LabelingMessagePayload {
  unit_id: string;
  batch_id: string;
  lot_id: string;
  item_id: string;
  seq: number;
  unit_count: number;
  roast_date: string;
}

/**
 * `POST /batches` の入力（design §14 / 要件 8）。
 * `unit_count` 省略時の既定 1000 補完は API 層が所有する（design §6.4 / レビュー第 2R-7）。
 */
export interface CreateBatchInput {
  item_id: string;
  lot_id: string;
  roast_date: string;
  unit_count?: number;
}

/**
 * seeder の非同期 invoke ペイロード（design §6.1 / §6.4）。
 * API 層が `ROASTING_DONE → LABELING` の条件付き遷移を確定した後に渡す batch_id。
 */
export interface SeederInvokePayload {
  batch_id: string;
}

/**
 * `POST /batches/roasting-complete` の入力（design §3.3 / 要件 B3）。
 * 焙煎担当が複数バッチをまとめて焙煎完了（PLANNED → ROASTING_DONE）にする。
 */
export interface RoastingCompleteInput {
  batch_ids: string[];
}

/**
 * `POST /batches/roasting-complete` の 200 レスポンス（design §3.3）。
 * 部分成功を 4 配列で区別する。要素はいずれも正規化済み（`BATCH#` 接頭辞付き）の batch_id。
 * 4 配列の和は入力 dedupe 後の件数に一致する。
 */
export interface RoastingCompleteResponse {
  completed: string[]; // PLANNED → ROASTING_DONE に遷移できたもの
  skipped: string[]; // 既に ROASTING_DONE（冪等スキップ）
  not_found: string[]; // 存在しない batch_id
  invalid: string[]; // LABELING/LABELED など PLANNED 以外からの不正遷移
}
