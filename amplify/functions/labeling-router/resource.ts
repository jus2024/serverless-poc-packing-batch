/**
 * labeling-router 関数の構成メタデータ（design §6 表 / §6.2）。
 *
 * `LabelingFunctions` Construct（FEAT-003）が raw CDK `NodejsFunction` として生成する際に
 * 参照する確定値をエクスポートする（design §4 / §6）。方式 A-Lambda の中継（要件 2.5）。
 * トリガーは unit Streams ESM（Construct 側で `DynamoEventSource` を付与）。
 * タイムアウト 5 分 / メモリ 256MB（design §6 表）。
 */
import { fileURLToPath } from "node:url";

export const ROUTER_ENTRY = fileURLToPath(
  new URL("./handler.ts", import.meta.url),
);

export const ROUTER_HANDLER = "handler";

/** タイムアウト秒（design §6 表: 5 分）。 */
export const ROUTER_TIMEOUT_SECONDS = 5 * 60;

/** メモリ MB（design §6 表: 256MB）。 */
export const ROUTER_MEMORY_MB = 256;
