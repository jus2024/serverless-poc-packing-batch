/**
 * plan-seeder ハンドラ（design §4.1 / §4.4 / §4.5 / 要件 B2）。
 *
 * 焙煎計画 SEED（10 件）を roast-batch テーブルに `status: "PLANNED"` で投入する。
 * **手動 invoke**（AWS CLI `lambda invoke` / コンソール）で実行し、イベントソースは持たない。
 *
 * 冪等性（design §4.4 / MEDIUM-2）:
 * 各レコードを `PutCommand` + `ConditionExpression: attribute_not_exists(batch_id)` で
 * **1 件ずつ逐次**投入する。既存行があれば条件が偽になり `ConditionalCheckFailedException`
 * が返り、その行はスキップされる（＝再投入しても既存の進行中状態を一切上書きしない）。
 * `BatchWriteItem` は条件付き書き込み不可のため使わない。
 *
 * 検証コアへの非干渉（design §4.1 / 要件 B2-6）:
 * unit テーブルには一切触れないため Streams 流入はゼロ。既存 `seeder/` を import しない。
 * 付与権限は roast-batch 限定の `dynamodb:PutItem` のみ（§4.2）。
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { getDocClient } from "../shared/ddb.js";
import { resolveRoastBatchTableName } from "../shared/runtime-config.js";
import { buildPlanSeedRecords } from "./plan-data.js";

/** 投入結果（手動 invoke のログで確認する。design §4.4）。 */
export interface PlanSeedResult {
  inserted: string[];
  skipped: string[];
}

export const handler = async (): Promise<PlanSeedResult> => {
  // roast-batch 専用の解決（plan-seeder は roast-batch にしか書かず、unit テーブル名は
  // 注入されないため、unit 名も要求する resolveTableNames() を呼ぶと起動時に失敗する。§4.1 / §4.2）
  const tables = resolveRoastBatchTableName();
  const client = getDocClient();

  const records = buildPlanSeedRecords(new Date().toISOString());
  const result: PlanSeedResult = { inserted: [], skipped: [] };

  for (const record of records) {
    try {
      await client.send(
        new PutCommand({
          TableName: tables.roastBatchTableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(batch_id)",
        }),
      );
      result.inserted.push(record.batch_id);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // 既存行があるためスキップ（既存 status に関わらず上書きしない＝巻き戻さない）
        result.skipped.push(record.batch_id);
      } else {
        // スロットル等は throw して Lambda を失敗させる（再実行で冪等に回復する）
        throw err;
      }
    }
  }

  return result;
};
