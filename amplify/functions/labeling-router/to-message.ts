/**
 * labeling-router の純ロジック（design §6.2 / 要件 2.5）。
 *
 * DynamoDB Streams レコード（NEW_IMAGE）を §3.4 の SQS ペイロードへ射影する。
 * ESM フィルタの二次防御として `eventName=INSERT` 以外を捨て（要件 2.5）、残りを
 * 10 件単位にチャンク化する（SendMessageBatch の 1 回最大 10 件）。
 *
 * ペイロードには `NewImage.unit_count` を含める（HIGH-1・案 B。worker が追加読み取り
 * なしに完了判定の `:n` を束縛できるようにするため。design §3.4）。副作用（SQS 送信）は
 * handler に閉じ、ここは純関数のみ。
 */
import type { DynamoDBRecord } from "aws-lambda";
import type { LabelingMessagePayload } from "../shared/types.js";

/** SendMessageBatch の 1 回あたり上限（design §6.2。10 件）。 */
export const SEND_MESSAGE_CHUNK_SIZE = 10;

/** DynamoDB Streams の AttributeValue（NEW_IMAGE）から素の値を取り出す最小ヘルパ。 */
function str(image: Record<string, unknown> | undefined, key: string): string {
  const av = image?.[key] as { S?: string } | undefined;
  if (av?.S === undefined) {
    throw new Error(`to-message: missing string attribute "${key}" in NewImage`);
  }
  return av.S;
}

function num(image: Record<string, unknown> | undefined, key: string): number {
  const av = image?.[key] as { N?: string } | undefined;
  if (av?.N === undefined) {
    throw new Error(`to-message: missing number attribute "${key}" in NewImage`);
  }
  return Number(av.N);
}

/**
 * 1 件の Streams レコードを §3.4 のペイロードへ射影する。
 * INSERT 以外は null を返す（呼び出し側がフィルタする）。
 */
export function toMessagePayload(
  record: DynamoDBRecord,
): LabelingMessagePayload | null {
  // 二次ガード: INSERT 以外は転送しない（要件 2.5。ESM フィルタに加えた防御）
  if (record.eventName !== "INSERT") {
    return null;
  }
  const image = record.dynamodb?.NewImage as
    | Record<string, unknown>
    | undefined;
  return {
    unit_id: str(image, "unit_id"),
    batch_id: str(image, "batch_id"),
    lot_id: str(image, "lot_id"),
    item_id: str(image, "item_id"),
    seq: num(image, "seq"),
    unit_count: num(image, "unit_count"),
    roast_date: str(image, "roast_date"),
  };
}

/**
 * Streams レコード群を §3.4 ペイロードへ射影する（INSERT 以外は除外）。
 */
export function toMessagePayloads(
  records: readonly DynamoDBRecord[],
): LabelingMessagePayload[] {
  const out: LabelingMessagePayload[] = [];
  for (const r of records) {
    const p = toMessagePayload(r);
    if (p) {
      out.push(p);
    }
  }
  return out;
}

/** 配列を指定サイズのチャンクに分割する（SendMessageBatch 用の 10 件チャンク）。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new Error(`chunk: size must be >= 1 (got ${size})`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
