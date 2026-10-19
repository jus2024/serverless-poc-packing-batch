/**
 * labeling-router ハンドラ（方式 A-Lambda。design §6.2 / 要件 2.5）。
 *
 * unit テーブルの Streams ESM（INSERT フィルタ付き）から受け取ったレコードを §3.4 の
 * ペイロードへ射影し（to-message.ts・純）、`SendMessageBatch`（10 件単位）で SQS へ転送する。
 * 送信失敗は `reportBatchItemFailures` で該当分のみ再試行に回す（要件 2.5 / 3.9 と同様の思想）。
 *
 * 副作用（SQS 送信）はこの handler に閉じ、射影・チャンク化は to-message.ts（純）に分ける。
 */
import {
  SQSClient,
  SendMessageBatchCommand,
  type SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import type {
  DynamoDBStreamEvent,
  DynamoDBBatchResponse,
  DynamoDBRecord,
} from "aws-lambda";
import { toMessagePayload, chunk, SEND_MESSAGE_CHUNK_SIZE } from "./to-message.js";
import { ENV_KEYS, RuntimeConfigError } from "../shared/runtime-config.js";

let sqsClient: SQSClient | undefined;
function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

function resolveQueueUrl(): string {
  const url = process.env[ENV_KEYS.LABELING_QUEUE_URL];
  if (!url) {
    throw new RuntimeConfigError(
      `required env ${ENV_KEYS.LABELING_QUEUE_URL} is missing`,
    );
  }
  return url;
}

/** Streams レコードのシーケンス番号（部分失敗報告の itemIdentifier）。 */
function sequenceNumber(record: DynamoDBRecord): string {
  return record.dynamodb?.SequenceNumber ?? "";
}

export const handler = async (
  event: DynamoDBStreamEvent,
): Promise<DynamoDBBatchResponse> => {
  const queueUrl = resolveQueueUrl();
  const client = getSqsClient();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  // INSERT のみを射影（to-message の二次ガード）。レコードとシーケンス番号を対で保持する。
  const projected = event.Records.map((record) => ({
    record,
    payload: toMessagePayload(record),
  })).filter(
    (p): p is { record: DynamoDBRecord; payload: NonNullable<typeof p.payload> } =>
      p.payload !== null,
  );

  for (const group of chunk(projected, SEND_MESSAGE_CHUNK_SIZE)) {
    const entries: SendMessageBatchRequestEntry[] = group.map((p, i) => ({
      Id: String(i),
      MessageBody: JSON.stringify(p.payload),
    }));

    try {
      const res = await client.send(
        new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }),
      );
      // 一部失敗は該当レコードのシーケンス番号を部分失敗に積む（要件 2.5）
      for (const failed of res.Failed ?? []) {
        const idx = Number(failed.Id);
        const rec = group[idx]?.record;
        if (rec) {
          batchItemFailures.push({ itemIdentifier: sequenceNumber(rec) });
        }
      }
    } catch {
      // バッチ全体の送信失敗はグループ全件を再試行対象にする
      for (const p of group) {
        batchItemFailures.push({ itemIdentifier: sequenceNumber(p.record) });
      }
    }
  }

  return { batchItemFailures };
};
