/**
 * 焙煎計画 SEED データ（純ロジック。design §4.3 / 要件 B2）。
 *
 * `plan-seeder` の handler（副作用）から呼ばれ、投入すべき `RoastBatchRecord` 配列を
 * **決定的**に返す。SEED は焙煎計画の初期データであり、各レコードは `status: "PLANNED"`
 * （焙煎前）で始まる。固定 `batch_id`（日付・AM/PM・連番が決定的）により、再投入時も
 * handler 側の条件付き PutItem（`attribute_not_exists(batch_id)`）で冪等になる（design §4.4）。
 *
 * この関数は純粋（引数で投入時刻を注入）で、`plan-data.test.ts` がユニットテストする。
 * unit テーブルには一切触れない（Streams 流入ゼロ。design §4.1 / 要件 B2-6）。
 */
import type { RoastBatchRecord } from "../shared/types.js";

/**
 * SEED レコードの不変部分（design §4.3 の 10 件表）。`created_at`/`status`/`labeled_count`
 * は `buildPlanSeedRecords` が決定的に補完する。産地 ETH/BRA/COL/GTM/KEN、焙煎度
 * LIGHT/MEDIUM/DARK、ロット・AM/PM・日付をばらけさせる。`unit_count` は 600〜1200 の範囲で
 * いずれも `SEED_UNIT_COUNT_MAX_DEFAULT = 1200` 以下にする（梱包担当の付番開始後に seeder が
 * 例外にならないため）。
 */
const PLAN_SEED_ENTRIES: ReadonlyArray<
  Pick<
    RoastBatchRecord,
    "batch_id" | "item_id" | "lot_id" | "roast_date" | "unit_count"
  >
> = [
  {
    batch_id: "BATCH#2026-02-10-AM-01",
    item_id: "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
    lot_id: "LOT#2026-02-ETH-001",
    roast_date: "2026-02-10",
    unit_count: 1000,
  },
  {
    batch_id: "BATCH#2026-02-10-AM-02",
    item_id: "ITEM#BRA-CERR-G2-DARK-ESP",
    lot_id: "LOT#2026-02-BRA-001",
    roast_date: "2026-02-10",
    unit_count: 1000,
  },
  {
    batch_id: "BATCH#2026-02-10-PM-01",
    item_id: "ITEM#COL-HUIL-G1-MEDIUM-DRIP",
    lot_id: "LOT#2026-02-COL-001",
    roast_date: "2026-02-10",
    unit_count: 800,
  },
  {
    batch_id: "BATCH#2026-02-10-PM-02",
    item_id: "ITEM#GTM-ANTI-G1-LIGHT-DRIP",
    lot_id: "LOT#2026-02-GTM-001",
    roast_date: "2026-02-10",
    unit_count: 600,
  },
  {
    batch_id: "BATCH#2026-02-11-AM-01",
    item_id: "ITEM#KEN-NYER-AA-MEDIUM-DRIP",
    lot_id: "LOT#2026-02-KEN-001",
    roast_date: "2026-02-11",
    unit_count: 1000,
  },
  {
    batch_id: "BATCH#2026-02-11-AM-02",
    item_id: "ITEM#ETH-GUJI-G1-LIGHT-DRIP",
    lot_id: "LOT#2026-02-ETH-002",
    roast_date: "2026-02-11",
    unit_count: 1200,
  },
  {
    batch_id: "BATCH#2026-02-11-PM-01",
    item_id: "ITEM#BRA-MOGI-G2-MEDIUM-ESP",
    lot_id: "LOT#2026-02-BRA-002",
    roast_date: "2026-02-11",
    unit_count: 900,
  },
  {
    batch_id: "BATCH#2026-02-12-AM-01",
    item_id: "ITEM#COL-NARI-G1-DARK-ESP",
    lot_id: "LOT#2026-02-COL-002",
    roast_date: "2026-02-12",
    unit_count: 1000,
  },
  {
    batch_id: "BATCH#2026-02-12-AM-02",
    item_id: "ITEM#GTM-HUEH-G1-MEDIUM-DRIP",
    lot_id: "LOT#2026-02-GTM-002",
    roast_date: "2026-02-12",
    unit_count: 700,
  },
  {
    batch_id: "BATCH#2026-02-12-PM-01",
    item_id: "ITEM#KEN-KIRI-AB-LIGHT-DRIP",
    lot_id: "LOT#2026-02-KEN-002",
    roast_date: "2026-02-12",
    unit_count: 1000,
  },
];

/**
 * SEED レコード 10 件を決定的に返す（design §4.3）。
 *
 * @param createdAtIso 投入時刻（ISO 8601）。テストで決定論的に注入できるよう引数化する。
 *   各レコードの `created_at` に入る。`status` は全件 `PLANNED`、`labeled_count` は 0、
 *   `labeling_started_at`/`labeling_finished_at` は未設定（焙煎前のため）。
 */
export function buildPlanSeedRecords(
  createdAtIso: string = new Date().toISOString(),
): RoastBatchRecord[] {
  return PLAN_SEED_ENTRIES.map((entry) => ({
    batch_id: entry.batch_id,
    item_id: entry.item_id,
    lot_id: entry.lot_id,
    roast_date: entry.roast_date,
    unit_count: entry.unit_count,
    labeled_count: 0,
    status: "PLANNED",
    created_at: createdAtIso,
  }));
}
