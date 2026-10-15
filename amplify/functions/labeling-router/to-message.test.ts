import { describe, it, expect } from "vitest";
import type { DynamoDBRecord } from "aws-lambda";
import {
  toMessagePayload,
  toMessagePayloads,
  chunk,
  SEND_MESSAGE_CHUNK_SIZE,
} from "./to-message.js";

/**
 * labeling-router 純ロジックのテスト（design §6.2 / 要件 2.5）。
 * Streams レコード → §3.4 ペイロード射影（NewImage.unit_count 含む）、INSERT ガード、
 * 10 件チャンク化を検証する。
 */

function insertRecord(seq: number): DynamoDBRecord {
  return {
    eventName: "INSERT",
    dynamodb: {
      NewImage: {
        unit_id: { S: `UNIT#2026-10-09-AM-01-${String(seq).padStart(6, "0")}` },
        batch_id: { S: "BATCH#2026-10-09-AM-01" },
        lot_id: { S: "LOT#2026-10-01-003" },
        item_id: { S: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP" },
        seq: { N: String(seq) },
        unit_count: { N: "1000" },
        roast_date: { S: "2026-10-09" },
      },
    },
  } as unknown as DynamoDBRecord;
}

describe("toMessagePayload", () => {
  it("INSERT レコードを §3.4 ペイロードへ射影する（unit_count 含む）", () => {
    expect(toMessagePayload(insertRecord(742))).toEqual({
      unit_id: "UNIT#2026-10-09-AM-01-000742",
      batch_id: "BATCH#2026-10-09-AM-01",
      lot_id: "LOT#2026-10-01-003",
      item_id: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
      seq: 742,
      unit_count: 1000,
      roast_date: "2026-10-09",
    });
  });

  it("NewImage.unit_count をペイロードに写す（HIGH-1・案 B）", () => {
    const p = toMessagePayload(insertRecord(1));
    expect(p?.unit_count).toBe(1000);
  });

  it("INSERT 以外（MODIFY/REMOVE）は null を返す（二次ガード）", () => {
    const modify = { ...insertRecord(1), eventName: "MODIFY" } as DynamoDBRecord;
    const remove = { ...insertRecord(1), eventName: "REMOVE" } as DynamoDBRecord;
    expect(toMessagePayload(modify)).toBeNull();
    expect(toMessagePayload(remove)).toBeNull();
  });

  it("NewImage に必須属性が無ければ例外", () => {
    const broken = {
      eventName: "INSERT",
      dynamodb: { NewImage: { unit_id: { S: "UNIT#x" } } },
    } as unknown as DynamoDBRecord;
    expect(() => toMessagePayload(broken)).toThrow();
  });
});

describe("toMessagePayloads", () => {
  it("INSERT のみを射影し MODIFY を除外する", () => {
    const records = [
      insertRecord(1),
      { ...insertRecord(2), eventName: "MODIFY" } as DynamoDBRecord,
      insertRecord(3),
    ];
    const out = toMessagePayloads(records);
    expect(out.map((p) => p.seq)).toEqual([1, 3]);
  });
});

describe("chunk", () => {
  it("10 件単位に分割する（SendMessageBatch 上限）", () => {
    expect(SEND_MESSAGE_CHUNK_SIZE).toBe(10);
    const items = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunk(items, SEND_MESSAGE_CHUNK_SIZE);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });
});
