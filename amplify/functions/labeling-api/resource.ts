/**
 * labeling-api 関数の構成メタデータ（design §6 表 / §6.4 / §4.4）。
 *
 * `LabelingFunctions` Construct（FEAT-003）が raw CDK `NodejsFunction` として生成する際に
 * 参照する確定値をエクスポートする（design §4 / §6）。画面 A〜D の API（§4.4 の 6 ルート）。
 * トリガーは API Gateway REST API（Construct 側の `LabelingApi` が配線）。
 * タイムアウト 30 秒 / メモリ 256MB（design §6 表）。
 */
import { fileURLToPath } from "node:url";

export const LABELING_API_ENTRY = fileURLToPath(
  new URL("./handler.ts", import.meta.url),
);

export const LABELING_API_HANDLER = "handler";

/** タイムアウト秒（design §6 表: 30 秒）。 */
export const LABELING_API_TIMEOUT_SECONDS = 30;

/** メモリ MB（design §6 表: 256MB）。 */
export const LABELING_API_MEMORY_MB = 256;
