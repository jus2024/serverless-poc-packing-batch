import { ArnFormat, Duration, Names, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import {
  NodejsFunction,
  OutputFormat,
  type BundlingOptions,
} from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import type { LabelingApi } from "./labeling-api.js";
import {
  LabelingTables,
  LABELING_TABLE_ENV_KEYS,
} from "./labeling-tables.js";
import {
  getVerificationConfig,
  type VerificationConfig,
} from "./verification-config.js";
import {
  SEEDER_ENTRY,
  SEEDER_HANDLER,
  SEEDER_TIMEOUT_SECONDS,
  SEEDER_MEMORY_MB,
} from "../functions/seeder/resource.js";
import {
  PLAN_SEEDER_ENTRY,
  PLAN_SEEDER_HANDLER,
  PLAN_SEEDER_TIMEOUT_SECONDS,
  PLAN_SEEDER_MEMORY_MB,
} from "../functions/plan-seeder/resource.js";
import {
  ROUTER_ENTRY,
  ROUTER_HANDLER,
  ROUTER_TIMEOUT_SECONDS,
  ROUTER_MEMORY_MB,
} from "../functions/labeling-router/resource.js";
import {
  WORKER_ENTRY,
  WORKER_HANDLER,
  WORKER_TIMEOUT_SECONDS,
  WORKER_MEMORY_MB,
} from "../functions/labeling-worker/resource.js";
import {
  LABELING_API_ENTRY,
  LABELING_API_HANDLER,
  LABELING_API_TIMEOUT_SECONDS,
  LABELING_API_MEMORY_MB,
} from "../functions/labeling-api/resource.js";

/**
 * Lambda 関数 4 本の定義と IAM 権限（design §6 / §6.5）。
 *
 * ## この Construct が作るもの（参考 EC PoC `order-functions.ts` を踏襲）
 *
 * seeder / labeling-router / labeling-worker / labeling-api の 4 関数を raw CDK
 * `NodejsFunction` で作る。各関数の確定値（エントリパス・タイムアウト・メモリ）は
 * `amplify/functions/{name}/resource.ts` が export しており、本 Construct はそれを読んで
 * ハードコードを避ける（design §4 / §6。FEAT-002 の findings）。
 *
 * **イベントソース（Streams ESM / SQS ESM / Pipes）はここでは作らない**。入口の
 * 差し替えと SQS→worker の多重制御は観測の道具であり（design §4.3 / R5）、
 * `labeling-stream.ts` が持つ。API Gateway の配線も `labeling-api.ts` が持つ。
 * この Construct は「関数とその IAM 権限」だけに責務を絞る。
 *
 * ## `reservedConcurrentExecutions` を設定しない（design §6 / R5）
 *
 * worker を `MaximumConcurrency`（既定 1,000）まで張り付かせるのが本 PoC の問いなので、
 * どの関数にも予約枠を設定しない（枠を人為的に区切ると観測したい現象を設計で消す）。
 *
 * ## バンドルとランタイム（design §6 / FEAT-002 findings）
 *
 * `bundling.format` は既定（CJS）ではなく **ESM**（`OutputFormat.ESM`）にする。本 PoC の
 * ハンドラ・純ロジックは `.js` 拡張子付き ESM import で書かれており（`amplify/package.json`
 * が `type: module`）、CJS でバンドルすると import 解決が合わない。`externalModules` は
 * `@aws-sdk/*`（ランタイム同梱を使う）、`NODE_OPTIONS='--enable-source-maps'`、
 * `runtime=NODEJS_22_X`（§1.1 / §6 で確定）。
 *
 * ## IAM は `grant*` を使わず `PolicyStatement` で手で絞る（design §6.5 / 非機能 3）
 *
 * `grantWriteData` などのまとめ付与ヘルパーは design §6.5 の表より広くなるため使わない。
 * Streams 読み取りは router の `DynamoEventSource` が、SQS 受信は worker の `SqsEventSource`
 * が付与するため、ここには現れない（`labeling-stream.ts`）。
 */

const BUNDLING: BundlingOptions = {
  minify: true,
  sourceMap: true,
  target: "node22",
  // ESM でバンドルする（amplify/package.json が type:module。handler は .js import の ESM）
  format: OutputFormat.ESM,
  // AWS SDK はランタイム同梱を使う（design §6 / FEAT-002 findings）
  externalModules: ["@aws-sdk/*"],
};

/** 物理関数名の論理名（design §6 表）。`stack.test.ts` と突き合わせる。 */
export const LABELING_FUNCTION_LOGICAL_NAMES = {
  seeder: "labeling-seeder",
  router: "labeling-router",
  worker: "labeling-worker",
  api: "labeling-api",
  planSeeder: "labeling-plan-seeder",
} as const;

export interface LabelingFunctionsProps {
  /** テーブル 2 本。環境変数と IAM の対象になる */
  readonly tables: LabelingTables;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;

  /**
   * 物理関数名の接頭辞。
   *
   * @default 'kiro-roasters'
   */
  readonly functionNamePrefix?: string;

  /**
   * 物理関数名の末尾に付ける一意サフィックス。
   * 既定で付けるのは `labeling-tables.ts` と同じ理由（関数名はリージョン内で一意、
   * 固定名では sandbox / ブランチごとのスタックが 2 つ目で衝突する）。
   * 空文字を渡すと固定名になる。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly functionNameSuffix?: string;
}

/** Lambda 関数と IAM 権限をまとめて定義する Construct（design §6） */
export class LabelingFunctions extends Construct {
  /** 約 1,000 件を PENDING で一括 INSERT（要件 1）。labeling-api の非同期 invoke 対象 */
  readonly seeder: NodejsFunction;

  /** 方式 A-Lambda の中継（要件 2.5）。`labeling-stream.ts` が Streams ESM を繋ぐ */
  readonly router: NodejsFunction;

  /** 付番ワーカー（要件 3〜5）。`labeling-stream.ts` が SQS ESM を繋ぐ */
  readonly worker: NodejsFunction;

  /** 画面 A〜D の API（§4.4 の 7 ルート）。`labeling-api.ts` が API Gateway を繋ぐ */
  readonly api: NodejsFunction;

  /**
   * 焙煎計画 SEED（roast-batch に 10 件を PLANNED で投入。要件 B2）。手動 invoke 専用で
   * イベントソースを持たない（Streams/SQS/Pipes に接続しない。既存 seeder とは完全に独立。§4.2）。
   */
  readonly planSeeder: NodejsFunction;

  private readonly tables: LabelingTables;
  private readonly functionName: (logicalName: string) => string;

  constructor(scope: Construct, id: string, props: LabelingFunctionsProps) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const prefix = props.functionNamePrefix ?? "kiro-roasters";
    const suffix = props.functionNameSuffix ?? defaultNameSuffix(this);

    this.tables = props.tables;
    this.functionName = (logicalName) =>
      [prefix, logicalName, suffix].filter((part) => part !== "").join("-");

    const tableEnv = props.tables.tableEnvironment;
    const baseEnv = { NODE_OPTIONS: "--enable-source-maps" };

    // seeder: UNIT/ROAST_BATCH テーブル名 + SEED_UNIT_COUNT_MAX（design §6 / FEAT-002）
    this.seeder = new NodejsFunction(this, "Seeder", {
      functionName: this.functionName(LABELING_FUNCTION_LOGICAL_NAMES.seeder),
      entry: SEEDER_ENTRY,
      handler: SEEDER_HANDLER,
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(SEEDER_TIMEOUT_SECONDS),
      memorySize: SEEDER_MEMORY_MB,
      bundling: BUNDLING,
      environment: {
        ...baseEnv,
        [envKeys.unitTableName]: tableEnv[envKeys.unitTableName],
        [envKeys.roastBatchTableName]: tableEnv[envKeys.roastBatchTableName],
        SEED_UNIT_COUNT_MAX: String(config.seedUnitCountMax),
        // BatchWriteItem の並列度（最速投入・T2 観測用。既定 1＝直列）
        SEED_WRITE_CONCURRENCY: process.env.SEED_WRITE_CONCURRENCY ?? "1",
      },
    });

    // labeling-router: LABELING_QUEUE_URL のみ（テーブル env 不要。FEAT-002）。
    // QUEUE_URL は SQS 作成後に `labeling-stream.ts` が addEnvironment で注入する
    this.router = new NodejsFunction(this, "Router", {
      functionName: this.functionName(LABELING_FUNCTION_LOGICAL_NAMES.router),
      entry: ROUTER_ENTRY,
      handler: ROUTER_HANDLER,
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(ROUTER_TIMEOUT_SECONDS),
      memorySize: ROUTER_MEMORY_MB,
      bundling: BUNDLING,
      environment: { ...baseEnv },
    });

    // labeling-worker: UNIT/ROAST_BATCH テーブル名 + BEST_BEFORE_DAYS（FEAT-002）
    this.worker = new NodejsFunction(this, "Worker", {
      functionName: this.functionName(LABELING_FUNCTION_LOGICAL_NAMES.worker),
      entry: WORKER_ENTRY,
      handler: WORKER_HANDLER,
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(WORKER_TIMEOUT_SECONDS),
      memorySize: WORKER_MEMORY_MB,
      bundling: BUNDLING,
      environment: {
        ...baseEnv,
        [envKeys.unitTableName]: tableEnv[envKeys.unitTableName],
        [envKeys.roastBatchTableName]: tableEnv[envKeys.roastBatchTableName],
        BEST_BEFORE_DAYS: String(config.bestBeforeDays),
        // 擬似処理時間（R5 / T1 観測用。既定 0 では本来の挙動）
        PROCESSING_TIME_MS: String(config.processingTimeMs),
      },
      // reservedConcurrentExecutions は設定しない（design §6 / R5）
    });

    // labeling-api: UNIT/ROAST_BATCH テーブル名 + 両 GSI 名 + RELAY_MODE +
    // LABELING_MAX_CONCURRENCY + BEST_BEFORE_DAYS/SEED_UNIT_COUNT_MAX（GET /config 用。FEAT-002）。
    // LABELING_SEEDER_FUNCTION_NAME は wireSeederInvoke で後から注入する
    this.api = new NodejsFunction(this, "Api", {
      functionName: this.functionName(LABELING_FUNCTION_LOGICAL_NAMES.api),
      entry: LABELING_API_ENTRY,
      handler: LABELING_API_HANDLER,
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(LABELING_API_TIMEOUT_SECONDS),
      memorySize: LABELING_API_MEMORY_MB,
      bundling: BUNDLING,
      environment: {
        ...baseEnv,
        [envKeys.unitTableName]: tableEnv[envKeys.unitTableName],
        [envKeys.roastBatchTableName]: tableEnv[envKeys.roastBatchTableName],
        [envKeys.batchUnitsIndexName]: tableEnv[envKeys.batchUnitsIndexName],
        [envKeys.lotTraceIndexName]: tableEnv[envKeys.lotTraceIndexName],
        RELAY_MODE: config.relayMode,
        LABELING_MAX_CONCURRENCY: String(config.labelingMaxConcurrency),
        BEST_BEFORE_DAYS: String(config.bestBeforeDays),
        SEED_UNIT_COUNT_MAX: String(config.seedUnitCountMax),
        // GET /config が worker の実値を正しく報告するため（計測条件の取り違え防止）
        PROCESSING_TIME_MS: String(config.processingTimeMs),
      },
    });

    // plan-seeder: roast-batch テーブル名のみ（焙煎計画 SEED 10 件の条件付き PutItem。§4.2）。
    // イベントソース・API 統合は付けない（手動 invoke。backend.ts 変更不要）
    this.planSeeder = new NodejsFunction(this, "PlanSeeder", {
      functionName: this.functionName(
        LABELING_FUNCTION_LOGICAL_NAMES.planSeeder,
      ),
      entry: PLAN_SEEDER_ENTRY,
      handler: PLAN_SEEDER_HANDLER,
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(PLAN_SEEDER_TIMEOUT_SECONDS),
      memorySize: PLAN_SEEDER_MEMORY_MB,
      bundling: BUNDLING,
      environment: {
        ...baseEnv,
        [envKeys.roastBatchTableName]: tableEnv[envKeys.roastBatchTableName],
      },
    });

    this.grantSeederPermissions();
    this.grantWorkerPermissions();
    this.grantApiPermissions();
    this.grantPlanSeederPermissions();
    // router は SQS SendMessage を持つが、SQS は `labeling-stream.ts` 作成後に
    // そちらが queue.grantSendMessages 相当を PolicyStatement で付与する（循環回避）
  }

  /**
   * labeling-api に seeder 起動権限と関数名の環境変数を付与する（design §6.5 / §10）。
   *
   * ## コンストラクタで設定できない理由
   *
   * seeder の `lambda:InvokeFunction` 対象 ARN は本 Construct が決める物理関数名から
   * 組み立てる（下記）。環境変数 `LABELING_SEEDER_FUNCTION_NAME`（labeling-api が
   * 非同期 invoke する対象の関数名）も同様。これらは API Gateway の有無に依存しないため
   * 本来コンストラクタでも足せるが、参考 EC PoC の `wireApiBaseUrl` と同じく「API を作った
   * 直後に backend.ts が明示的に呼ぶ」配線点として独立させ、依存の向きを読みやすくする
   * （design §10 の `functions.wireSeederInvoke(api)`）。
   *
   * ## `seeder.grantInvoke(api)` を使わない理由（参考 EC PoC `grantSelfInvoke` と同じ）
   *
   * `grantInvoke` は関数 ARN を `Fn::GetAtt` で参照し、循環参照の余地を作る。物理関数名は
   * 本 Construct が決めているので ARN を文字列として組み立てれば関数リソースを参照せずに済む。
   * `:*` のバージョン修飾子まで広げないのは、labeling-api が修飾子なしの関数名を宛先にするため。
   *
   * @param _api labeling-api（配線順序を backend.ts に明示させるために受け取るが、
   *   seeder 起動の権限・環境変数は api 関数リソース自身に付ける）。
   */
  wireSeederInvoke(_api: LabelingApi): void {
    const seederName = this.functionName(
      LABELING_FUNCTION_LOGICAL_NAMES.seeder,
    );
    const seederArn = Stack.of(this).formatArn({
      service: "lambda",
      resource: "function",
      resourceName: seederName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    this.api.addEnvironment("LABELING_SEEDER_FUNCTION_NAME", seederName);
    this.api.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [seederArn],
      }),
    );
  }

  /**
   * seeder の IAM 権限（design §6.5）。
   * - unit: `BatchWriteItem` / `PutItem`（約 1,000 件を 25 件ずつ投入。要件 1.3）
   * - roast-batch: `GetItem`（unit_count / lot_id / item_id / roast_date を読む。§6.1）
   */
  private grantSeederPermissions(): void {
    const { unitTable, roastBatchTable } = this.tables;

    this.seeder.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:BatchWriteItem", "dynamodb:PutItem"],
        resources: [unitTable.tableArn],
      }),
    );
    this.seeder.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [roastBatchTable.tableArn],
      }),
    );
  }

  /**
   * labeling-worker の IAM 権限（design §6.5）。
   * - unit: `UpdateItem`（条件付き付番。要件 3.4/3.5）
   * - roast-batch: `UpdateItem`（labeled_count の ADD と完了遷移。要件 3.6/4）
   *
   * roast-batch への `GetItem` は**付けない**。完了判定の `:n` は SQS ペイロードの
   * `unit_count` から束縛するため追加読み取りが不要であり、最小権限を維持する
   * （design §3.1 / §6.3-4 / HIGH-1・案 B）。SQS 受信権限は `SqsEventSource` が付与する。
   */
  private grantWorkerPermissions(): void {
    const { unitTable, roastBatchTable } = this.tables;

    this.worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [unitTable.tableArn, roastBatchTable.tableArn],
      }),
    );
  }

  /**
   * labeling-api の IAM 権限（design §6.5）。
   * - roast-batch: `GetItem` / `PutItem` / `UpdateItem` / `Scan`（画面 A/B/C の操作）
   * - unit: `Query`（基表 + GSI 2 本。画面 D のトレース照会。要件 11）
   *
   * seeder への `lambda:InvokeFunction` は `wireSeederInvoke` で付与する（循環回避）。
   */
  private grantApiPermissions(): void {
    const { unitTable, roastBatchTable } = this.tables;

    this.api.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Scan",
        ],
        resources: [roastBatchTable.tableArn],
      }),
    );
    this.api.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [
          unitTable.tableArn,
          // GSI は名前で限定する（`index/*` にしない。GSI は 2 本に固定）
          `${unitTable.tableArn}/index/${this.tables.batchUnitsIndexName}`,
          `${unitTable.tableArn}/index/${this.tables.lotTraceIndexName}`,
        ],
      }),
    );
  }

  /**
   * plan-seeder の IAM 権限（design §4.2 / §4.4）。
   * - roast-batch: `PutItem` のみ（焙煎計画 10 件の条件付き投入。`ConditionExpression` に
   *   追加権限は不要）。`BatchWriteItem`/`GetItem` は付けない（§4.4 で冪等性を条件付き
   *   `PutItem` に寄せたため不要。最小権限）。
   *
   * unit テーブル・GSI には権限を付けない（plan-seeder は roast-batch にしか書かず、
   * Streams 流入をゼロに保つ。要件 B2-6）。`grant*` ヘルパーは使わない（既存方針）。
   */
  private grantPlanSeederPermissions(): void {
    const { roastBatchTable } = this.tables;

    this.planSeeder.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [roastBatchTable.tableArn],
      }),
    );
  }
}

/** テーブル環境変数キーの別名（コンストラクタ内の可読性のため） */
const envKeys = LABELING_TABLE_ENV_KEYS;

/**
 * 物理関数名の既定サフィックス（design §3.3 / §6）。
 * `labeling-tables.ts` の `defaultNameSuffix` と同じ考え方（スタック名を含むハッシュの
 * 下 8 桁。再デプロイでは変わらない）。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
