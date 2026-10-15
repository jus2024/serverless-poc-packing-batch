/**
 * フロント用の型定義（design §11.1 / §4.4 / §6.4）。
 *
 * ## Lambda 側のモジュールを参照しない
 *
 * フロントは `amplify/functions/shared/types.ts` から import せず、画面が受け取る
 * API 入出力の形だけをこのファイルで独立に定義する（構成越境しない。structure 方針）。
 * 属性名・status リテラルは backend 側（`shared/types.ts`）と一致させる（突き合わせは
 * design §16 の実機結合テストに委ねる。ローカルでは型の形のみを揃える）。
 */

/**
 * RoastBatch の status（design §3.2）。
 * ROASTING_DONE（焙煎完了・付番待ち）→ LABELING（付番中）→ LABELED（付番完了）。
 */
export type RoastBatchStatus = "ROASTING_DONE" | "LABELING" | "LABELED";

/** Unit の status（design §3.1）。PENDING（投入直後）→ LABELED（付番済み）。 */
export type UnitStatus = "PENDING" | "LABELED";

/**
 * `GET /batches` / `GET /batches/{batchId}` が返す RoastBatch レコード（design §3.2）。
 */
export interface RoastBatch {
  batch_id: string;
  item_id: string;
  lot_id: string;
  roast_date: string;
  unit_count: number;
  labeled_count: number;
  status: RoastBatchStatus;
  created_at: string;
  labeling_started_at?: string;
  labeling_finished_at?: string;
}

/**
 * `GET /units` が返す Unit レコード（design §3.1 / §11.5）。
 * 画面 D は `status` / `best_before` / `qr_payload` / `labeled_at` を表示する（要件 11.3）。
 */
export interface Unit {
  unit_id: string;
  batch_id: string;
  lot_id: string;
  item_id: string;
  seq: number;
  unit_count: number;
  roast_date: string;
  status: UnitStatus;
  created_at: string;
  best_before?: string;
  qr_payload?: string;
  labeled_at?: string;
}

/** `POST /batches` の入力（design §14 / 要件 8）。unit_count 省略時は API 層が既定 1000 を補完。 */
export interface CreateBatchInput {
  item_id: string;
  lot_id: string;
  roast_date: string;
  unit_count?: number;
}

/** `POST /batches/{batchId}/labeling-start` が返す 202 ボディ（design §6.4）。 */
export interface StartLabelingResponse {
  batch_id: string;
  status: RoastBatchStatus;
  labeling_started_at: string;
}

/** `GET /config` が返す実行時検証パラメータ（design §6.4 / 非機能 5）。 */
export interface LabelingConfig {
  bestBeforeDays: number;
  seedUnitCountMax: number;
  relayMode: string;
  labelingMaxConcurrency: string;
}

/** API のエラーボディ（design §13。`{ error, message, details? }`）。 */
export interface LabelingErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
