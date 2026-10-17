/**
 * labeling-worker ハンドラ（付番。design §6.3 / 要件 3〜5）。
 *
 * SQS メッセージ（§3.4）を 1 件処理する:
 * 1. best_before / qr_payload を計算（labeling.ts・純）。
 * 2. unit を UpdateItem（`attribute_not_exists(best_before)`。二重付番を弾く）。
 * 3. 条件成功時のみ roast-batch を `ADD labeled_count :one`（UPDATED_NEW で更新後値取得）。
 *    更新後 labeled_count が payload.unit_count に達していれば完了遷移を試みる
 *    （`labeled_count = :n AND status = :labeling`、`:n = payload.unit_count` 固定）。
 * 4. 条件が弾かれた（既付番）場合は加算せず正常終了（要件 3.7）。
 * 5. 付番条件以外（スロットル・一時障害）は batchItemFailures で再試行報告（要件 3.9）。
 *
 * 副作用（DDB 呼び出し）はこの handler に閉じ、値・式の組み立ては labeling.ts（純）に分ける。
 */
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import { getDocClient } from "../shared/ddb.js";
import {
  resolveTableNames,
  resolveVerificationConfig,
} from "../shared/runtime-config.js";
import type { LabelingMessagePayload } from "../shared/types.js";
import {
  buildLabelingValues,
  buildUnitLabelUpdate,
  buildLabeledCountAddUpdate,
  buildCompletionUpdate,
} from "./labeling.js";

function parsePayload(record: SQSRecord): LabelingMessagePayload {
  const p = JSON.parse(record.body) as LabelingMessagePayload;
  if (!p.unit_id || !p.batch_id || typeof p.unit_count !== "number") {
    throw new Error("labeling-worker: invalid message payload");
  }
  return p;
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const tables = resolveTableNames();
  const { bestBeforeDays } = resolveVerificationConfig();
  const client = getDocClient();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const payload = parsePayload(record);
      const values = buildLabelingValues(
        payload,
        bestBeforeDays,
        new Date().toISOString(),
      );

      // 2. unit を条件付き付番（attribute_not_exists(best_before)）
      const unitUpdate = buildUnitLabelUpdate(values);
      try {
        await client.send(
          new UpdateCommand({
            TableName: tables.unitTableName,
            Key: { unit_id: payload.unit_id },
            UpdateExpression: unitUpdate.UpdateExpression,
            ConditionExpression: unitUpdate.ConditionExpression,
            ExpressionAttributeNames: unitUpdate.ExpressionAttributeNames,
            ExpressionAttributeValues: unitUpdate.ExpressionAttributeValues,
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // 4. 既に付番済み（二重配信など）: 加算せず正常終了（要件 3.7）
          continue;
        }
        throw err;
      }

      // 3. 付番成功 → labeled_count を ADD（UPDATED_NEW で更新後値を得る）
      const addUpdate = buildLabeledCountAddUpdate();
      const addRes = await client.send(
        new UpdateCommand({
          TableName: tables.roastBatchTableName,
          Key: { batch_id: payload.batch_id },
          UpdateExpression: addUpdate.UpdateExpression,
          ExpressionAttributeValues: addUpdate.ExpressionAttributeValues,
          ReturnValues: "UPDATED_NEW",
        }),
      );
      const labeledCount = Number(addRes.Attributes?.labeled_count ?? 0);

      // unit_count 到達で完了遷移を試みる（:n = payload.unit_count 固定・ちょうど 1 回成立）
      if (labeledCount >= payload.unit_count) {
        const completion = buildCompletionUpdate(
          payload.unit_count,
          new Date().toISOString(),
        );
        try {
          await client.send(
            new UpdateCommand({
              TableName: tables.roastBatchTableName,
              Key: { batch_id: payload.batch_id },
              UpdateExpression: completion.UpdateExpression,
              ConditionExpression: completion.ConditionExpression,
              ExpressionAttributeNames: completion.ExpressionAttributeNames,
              ExpressionAttributeValues: completion.ExpressionAttributeValues,
            }),
          );
        } catch (err) {
          if (err instanceof ConditionalCheckFailedException) {
            // 既に完了遷移済み（別 worker が遷移）: 正常（要件 4.4。finished_at を上書きしない）
          } else {
            throw err;
          }
        }
      }
    } catch {
      // 5. 付番条件以外の失敗（スロットル・一時障害・解釈不能）は再試行対象に報告（要件 3.9）
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
