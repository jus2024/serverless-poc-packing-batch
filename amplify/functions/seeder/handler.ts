/**
 * seeder ハンドラ（design §6.1 / 要件 1）。
 *
 * labeling-api の `POST /batches/{batchId}/labeling-start` から **非同期 invoke** される
 * （InvocationType=Event）。API 層が既に `ROASTING_DONE → LABELING` の条件付き遷移を確定
 * させた前提で起動されるため、**seeder 自身は状態遷移を持たない**（二重起動抑止の唯一の
 * 判定点は API 層。design §6.1 / §6.4 / レビュー HIGH-1）。
 *
 * 処理:
 * 1. batch_id で roast-batch を GetItem（unit_count / lot_id / item_id / roast_date を取得）。
 * 2. unit_count 件の Unit を PENDING で生成（各 Unit に unit_count を非正規化）。
 * 3. BatchWriteItem を 25 件ずつ投入。UnprocessedItems は指数バックオフで再送し全件書くまで試行。
 *
 * 副作用（DDB 呼び出し）はこの handler に閉じ、計画生成は seed-plan.ts（純）に分ける。
 */
import { GetCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "../shared/ddb.js";
import {
  resolveTableNames,
  resolveVerificationConfig,
  RuntimeConfigError,
} from "../shared/runtime-config.js";
import type { RoastBatchRecord, UnitRecord } from "../shared/types.js";
import { buildSeedPlan } from "./seed-plan.js";

/** 指数バックオフの基準ミリ秒・上限試行回数（design §6.1 / §13）。 */
const RETRY_BASE_MS = 50;
const MAX_RETRY_ATTEMPTS = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * UnprocessedItems を指数バックオフで再送しながら全件書き込む（要件 1.7）。
 * 上限試行を超えても残れば例外（検証者の入力は正しく、原因はテーブル状態＝500 相当）。
 */
async function writeBatchWithRetry(
  tableName: string,
  records: UnitRecord[],
): Promise<void> {
  const client = getDocClient();
  let pending = records.map((item) => ({ PutRequest: { Item: item } }));
  let attempt = 0;

  while (pending.length > 0) {
    const res = await client.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
    );
    const unprocessed = res.UnprocessedItems?.[tableName] ?? [];
    if (unprocessed.length === 0) {
      return;
    }
    attempt += 1;
    if (attempt > MAX_RETRY_ATTEMPTS) {
      throw new Error(
        `seeder: ${unprocessed.length} items remained unprocessed after ${MAX_RETRY_ATTEMPTS} retries`,
      );
    }
    // 指数バックオフ（50ms, 100ms, 200ms, ...）
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    pending = unprocessed as typeof pending;
  }
}

export const handler = async (event: {
  batch_id?: string;
}): Promise<void> => {
  const batchId = event?.batch_id;
  if (!batchId) {
    throw new Error("seeder: event.batch_id is required");
  }

  const tables = resolveTableNames();
  const { seedUnitCountMax } = resolveVerificationConfig();
  const client = getDocClient();

  // 1. roast-batch を GetItem（状態は API 層が LABELING 済み。seeder は遷移しない）
  const got = await client.send(
    new GetCommand({
      TableName: tables.roastBatchTableName,
      Key: { batch_id: batchId },
    }),
  );
  const batch = got.Item as RoastBatchRecord | undefined;
  if (!batch) {
    throw new Error(`seeder: roast-batch not found for ${batchId}`);
  }
  if (batch.unit_count > seedUnitCountMax) {
    throw new RuntimeConfigError(
      `seeder: unit_count ${batch.unit_count} exceeds SEED_UNIT_COUNT_MAX ${seedUnitCountMax}`,
    );
  }

  // 2. seed-plan を生成（純ロジック。各 Unit に unit_count を非正規化）
  const { chunks } = buildSeedPlan({
    batch_id: batch.batch_id,
    lot_id: batch.lot_id,
    item_id: batch.item_id,
    unit_count: batch.unit_count,
    roast_date: batch.roast_date,
    created_at: new Date().toISOString(),
  });

  // 3. 25 件ずつ BatchWriteItem（UnprocessedItems は指数バックオフ再送）
  for (const c of chunks) {
    await writeBatchWithRetry(tables.unitTableName, c);
  }
};
