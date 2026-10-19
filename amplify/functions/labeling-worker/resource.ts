/**
 * labeling-worker 関数の構成メタデータ（design §6 表 / §6.3 / §4.3.4）。
 *
 * `LabelingFunctions` Construct（FEAT-003）が raw CDK `NodejsFunction` として生成する際に
 * 参照する確定値をエクスポートする（design §4 / §6）。付番ワーカー（要件 3〜5）。
 * トリガーは SQS ESM（Construct 側で `SqsEventSource` を付与。MaximumConcurrency で多重制御）。
 * タイムアウト 60 秒 / メモリ 256MB（design §6 表）。
 *
 * **`reservedConcurrentExecutions` は設定しない**（worker を 1,000 まで張り付かせるため枠を
 * 人為的に区切らない。design §6 / R5）。この方針は Construct 側に委ねるが、意図をここに残す。
 */
import { fileURLToPath } from "node:url";

export const WORKER_ENTRY = fileURLToPath(
  new URL("./handler.ts", import.meta.url),
);

export const WORKER_HANDLER = "handler";

/** タイムアウト秒（design §6 表: 60 秒）。 */
export const WORKER_TIMEOUT_SECONDS = 60;

/** メモリ MB（design §6 表: 256MB）。 */
export const WORKER_MEMORY_MB = 256;
