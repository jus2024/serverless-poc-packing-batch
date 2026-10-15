/**
 * seeder の純ロジック（design §6.1 / 要件 1）。
 *
 * roast-batch 1 件から unit_count 件の Unit レコードを `status=PENDING` で生成し、
 * `BatchWriteItem` 用に 25 件ずつチャンク化する。各 Unit の `unit_id` は
 * `shared/unit-keys.ts` の `buildUnitId` で採番し（決定的）、batch の `unit_count` を
 * 全 Unit に同一値で非正規化して持たせる（HIGH-1・案 B。worker が NewImage 経由で
 * `unit_count` を得られるようにするため。design §3.1 / §3.4）。
 *
 * 副作用（DDB 呼び出し）は持たない。`UnprocessedItems` 再送計画のための分割もここに置く。
 */
import { buildUnitId } from "../shared/unit-keys.js";
import type { UnitRecord } from "../shared/types.js";

/** BatchWriteItem の 1 リクエスト上限（design §6.1。25 件ずつ）。 */
export const BATCH_WRITE_CHUNK_SIZE = 25;

/** seed-plan を生成するための batch 情報（API 層が確定した値）。 */
export interface SeedPlanInput {
  batch_id: string;
  lot_id: string;
  item_id: string;
  unit_count: number;
  roast_date: string;
  /** 各 Unit に打つ created_at（handler が実行時刻を注入）。 */
  created_at: string;
}

/**
 * unit_count 件の Unit レコードを生成する（seq は 1 始まり）。
 * 各 Unit は PENDING で、unit_id は buildUnitId により決定的に採番される。
 */
export function buildUnitRecords(input: SeedPlanInput): UnitRecord[] {
  if (!Number.isInteger(input.unit_count) || input.unit_count < 1) {
    throw new Error(
      `buildUnitRecords: unit_count must be an integer >= 1 (got ${input.unit_count})`,
    );
  }
  const records: UnitRecord[] = [];
  for (let seq = 1; seq <= input.unit_count; seq++) {
    records.push({
      unit_id: buildUnitId(input.batch_id, seq),
      batch_id: input.batch_id,
      lot_id: input.lot_id,
      item_id: input.item_id,
      seq,
      unit_count: input.unit_count,
      roast_date: input.roast_date,
      status: "PENDING",
      created_at: input.created_at,
    });
  }
  return records;
}

/**
 * 配列を指定サイズのチャンクに分割する汎用ヘルパ（25 件/10 件チャンクで使う）。
 */
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

/**
 * seed-plan を組み立てる（Unit 生成 → 25 件チャンク化）。
 * handler はこの計画どおりに `BatchWriteItem` を発行し、`UnprocessedItems` は
 * 指数バックオフで再送する（再送対象の再チャンク化は `chunk` を再利用する）。
 */
export function buildSeedPlan(input: SeedPlanInput): {
  records: UnitRecord[];
  chunks: UnitRecord[][];
} {
  const records = buildUnitRecords(input);
  return { records, chunks: chunk(records, BATCH_WRITE_CHUNK_SIZE) };
}
