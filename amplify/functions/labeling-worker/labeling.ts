/**
 * labeling-worker の純ロジック（design §6.3 / 要件 3〜5）。
 *
 * 副作用（DDB 呼び出し）を持たず、付番に必要な値と更新式を組み立てる:
 * - `best_before = roast_date + BEST_BEFORE_DAYS 日`（UTC 暦日加算。閏日は Date の加算に委ねる）。
 * - `qr_payload`（shared/qr。unit_id/item_id/best_before）。
 * - 付番 UpdateItem 式（`attribute_not_exists(best_before)` で二重付番を弾く。要件 3.4/3.5）。
 * - 完了判定 UpdateItem 式（`labeled_count = :n AND status = :labeling`、`:n = payload.unit_count`
 *   固定。追加 GetItem 無し。design §6.3-4 / HIGH-1・案 B）。
 */
import { buildQrPayload } from "../shared/qr.js";
import type { LabelingMessagePayload } from "../shared/types.js";

/**
 * `best_before` を計算する（design §6.3-1 / 要件 3.2）。
 *
 * UTC 基準で roast_date に days を暦日加算し ISO 8601 日付（YYYY-MM-DD）へ戻す。
 * うるう年は Date の加算に委ね「暦日 +N 日」の素直な解釈にする（閏日を跨ぐと暦日で
 * N 日後が実日数と 1 日ずれ得るが、これを確定仕様とする。design §6.3-1）。
 */
export function computeBestBefore(roastDate: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(roastDate)) {
    throw new Error(`computeBestBefore: invalid roast_date "${roastDate}"`);
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`computeBestBefore: days must be an integer >= 1 (got ${days})`);
  }
  const base = new Date(`${roastDate}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** 付番で設定する属性値（best_before / qr_payload / labeled_at）。 */
export interface LabelingValues {
  best_before: string;
  qr_payload: string;
  labeled_at: string;
}

/**
 * 付番値を組み立てる（best_before 計算 + qr_payload 生成）。
 * @param labeledAt handler が注入する付番時刻（ISO 8601）
 */
export function buildLabelingValues(
  payload: LabelingMessagePayload,
  bestBeforeDays: number,
  labeledAt: string,
): LabelingValues {
  const best_before = computeBestBefore(payload.roast_date, bestBeforeDays);
  const qr_payload = buildQrPayload({
    unit_id: payload.unit_id,
    item_id: payload.item_id,
    best_before,
  });
  return { best_before, qr_payload, labeled_at: labeledAt };
}

/** DynamoDB UpdateCommand 入力の式部分（純ロジックが組み立てる形）。 */
export interface UpdateExpressionParts {
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

/**
 * unit の付番 UpdateItem 式を組み立てる（design §6.3-3 / 要件 3.4/3.5）。
 * `SET status=LABELED, best_before, qr_payload, labeled_at`、
 * `ConditionExpression attribute_not_exists(best_before)`（二重付番を弾く）。
 */
export function buildUnitLabelUpdate(
  values: LabelingValues,
): UpdateExpressionParts {
  return {
    UpdateExpression:
      "SET #status = :labeled, best_before = :bb, qr_payload = :qr, labeled_at = :la",
    ConditionExpression: "attribute_not_exists(best_before)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":labeled": "LABELED",
      ":bb": values.best_before,
      ":qr": values.qr_payload,
      ":la": values.labeled_at,
    },
  };
}

/**
 * roast-batch の labeled_count 加算 UpdateItem 式を組み立てる（design §6.3-4 / 要件 3.6）。
 * `ADD labeled_count :one`。応答で更新後の labeled_count を得る（ReturnValues=UPDATED_NEW）。
 */
export function buildLabeledCountAddUpdate(): UpdateExpressionParts {
  return {
    UpdateExpression: "ADD labeled_count :one",
    // 加算自体に条件は付けない（条件は呼び出し元の unit 付番成功で担保）
    ConditionExpression: "",
    ExpressionAttributeNames: {},
    ExpressionAttributeValues: { ":one": 1 },
  };
}

/**
 * roast-batch の完了遷移 UpdateItem 式を組み立てる（design §6.3-4 / 要件 4.1/4.2）。
 *
 * `SET status=LABELED, labeling_finished_at`、
 * `ConditionExpression labeled_count = :n AND status = :labeling`。
 * **`:n` は当該 batch の `unit_count`（payload.unit_count。固定値。自分が ADD で読んだ
 * labeled_count ではない）を束縛する**（design §6.3-4 / HIGH-1・案 B / レビュー MEDIUM-2）。
 * `:n` 固定 + labeled_count 単調増加 + status ガードにより成立はちょうど 1 回。
 */
export function buildCompletionUpdate(
  unitCount: number,
  finishedAt: string,
): UpdateExpressionParts {
  return {
    UpdateExpression: "SET #status = :labeled, labeling_finished_at = :fa",
    ConditionExpression: "labeled_count = :n AND #status = :labeling",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":labeled": "LABELED",
      ":labeling": "LABELING",
      ":n": unitCount,
      ":fa": finishedAt,
    },
  };
}
