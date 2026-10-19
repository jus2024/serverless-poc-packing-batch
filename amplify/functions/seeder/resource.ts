/**
 * seeder 関数の構成メタデータ（design §6 表 / §6.1）。
 *
 * 本 PoC の Lambda は Amplify の `defineFunction` ではなく、`amplify/custom` の
 * `LabelingFunctions` Construct（FEAT-003）が raw CDK `NodejsFunction` として生成する
 * （design §4 / §6）。各関数ディレクトリの `resource.ts` は、その Construct が参照する
 * 「エントリパス・タイムアウト・メモリ・ランタイム」等の確定値をエクスポートする
 * （値を 1 箇所に集約し、Construct 側のハードコードを避ける）。
 *
 * seeder: 約 1,000 件を PENDING で一括 INSERT（要件 1）。labeling-api からの非同期 invoke。
 * タイムアウト 15 分 / メモリ 512MB（design §6 表）。
 */
import { fileURLToPath } from "node:url";

/** NodejsFunction の entry（この関数の handler.ts への絶対パス）。 */
export const SEEDER_ENTRY = fileURLToPath(
  new URL("./handler.ts", import.meta.url),
);

/** handler エクスポート名（esbuild バンドル後の `handler`）。 */
export const SEEDER_HANDLER = "handler";

/** タイムアウト秒（design §6 表: 15 分）。 */
export const SEEDER_TIMEOUT_SECONDS = 15 * 60;

/** メモリ MB（design §6 表: 512MB）。 */
export const SEEDER_MEMORY_MB = 512;
