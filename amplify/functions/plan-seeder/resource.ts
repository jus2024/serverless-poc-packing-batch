/**
 * plan-seeder 関数の構成メタデータ（design §4.2）。
 *
 * 既存 `seeder/resource.ts` と同形で、`amplify/custom` の `LabelingFunctions` Construct が
 * 参照する確定値（エントリパス・ハンドラ名・タイムアウト・メモリ）をエクスポートする。
 *
 * plan-seeder は焙煎計画 SEED（roast-batch に 10 件を PLANNED で投入。要件 B2）専用の
 * **手動 invoke** 関数であり、既存の個体 seeder（unit 1,000 件投入）とは完全に独立している。
 * 10 件の条件付き PutItem のみなので timeout 60 秒 / メモリ 256MB で十分（design §4.2）。
 */
import { fileURLToPath } from "node:url";

/** NodejsFunction の entry（この関数の handler.ts への絶対パス）。 */
export const PLAN_SEEDER_ENTRY = fileURLToPath(
  new URL("./handler.ts", import.meta.url),
);

/** handler エクスポート名（esbuild バンドル後の `handler`）。 */
export const PLAN_SEEDER_HANDLER = "handler";

/** タイムアウト秒（design §4.2: 60 秒。10 件の put のみ）。 */
export const PLAN_SEEDER_TIMEOUT_SECONDS = 60;

/** メモリ MB（design §4.2: 256MB）。 */
export const PLAN_SEEDER_MEMORY_MB = 256;
