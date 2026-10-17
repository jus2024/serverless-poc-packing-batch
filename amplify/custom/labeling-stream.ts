import { Duration, Names, RemovalPolicy } from "aws-cdk-lib";
import {
  FilterCriteria,
  FilterRule,
  StartingPosition,
} from "aws-cdk-lib/aws-lambda";
import {
  DynamoEventSource,
  SqsDlq,
  SqsEventSource,
} from "aws-cdk-lib/aws-lambda-event-sources";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnPipe } from "aws-cdk-lib/aws-pipes";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { LabelingFunctions } from "./labeling-functions.js";
import { LabelingTables } from "./labeling-tables.js";
import {
  getVerificationConfig,
  type RelayMode,
  type VerificationConfig,
} from "./verification-config.js";

/**
 * 入口（Streams→SQS 中継）・SQS・worker ESM の配線（design §4.3 / §5、要件 2 / 5 / 6）。
 *
 * ## この Construct が本 PoC の観測装置である（参考 EC PoC `order-stream.ts` を踏襲）
 *
 * 前作は Streams を直接 processor に繋ぎ、同時実行が `S × P` に抑えられた。本作は **SQS を
 * 挟んで入口の制約を外し、worker の `ConcurrentExecutions` が `MaximumConcurrency`（既定
 * 1,000）まで張り付くか**を見に行く（design §2.3 / R5）。したがって入口の差し替え
 * （pipes / lambda / both）と SQS→worker の多重制御をこの 1 ファイルに集約し、
 * 「どの条件で計測したか」を追うとき見る場所を 1 つにする。
 *
 * ## `RELAY_MODE` の分岐（design §4.3.5 / 論点 3）
 *
 * - `pipes`: EventBridge Pipes（`CfnPipe`）のみを有効化（source=unit Streams / target=SQS）。
 * - `lambda`: router の `DynamoEventSource`（unit Streams ESM）のみを有効化。
 * - `both`: 両方を有効化（比較用途）。同一 INSERT が Pipes 経由と router 経由で二重に SQS へ
 *   届く＝二重配信になるが、**worker の条件付き書き込み `attribute_not_exists(best_before)`
 *   で冪等に吸収される**（2 回目は弾かれ labeled_count も二重加算されない。要件 3.5 / 3.7）。
 *   ただし both では SQS 投入件数が約 2 倍になり worker の立ち上がりは単一入口と直接比較
 *   できない（ダッシュボードの注記。§8.1）。
 *
 * ## INSERT フィルタを構造として固定する（要件 2.1 / 2.4）
 *
 * seeder の INSERT だけが SQS に乗るべきで、MODIFY が混ざると観測が汚れる。Pipes の
 * `filterCriteria` と router ESM の `filters` の両方で `eventName=INSERT` を固定し、
 * フィルタの出典を定数（`UNIT_STREAM_INSERT_FILTER` / `PIPES_INSERT_FILTER_PATTERN`）に
 * 一本化して `stack.test.ts` が合成結果と突き合わせる（design §16）。ハンドラ側にも二次
 * ガードがある（`labeling-router/to-message.ts`）が、構造としての固定が一次防御である。
 */

/** router ESM のイベントフィルタ（要件 2.1 / 2.4）。テストが定数と合成結果を突き合わせる。 */
export const UNIT_STREAM_INSERT_FILTER = FilterCriteria.filter({
  eventName: FilterRule.isEqual("INSERT"),
});

/**
 * Pipes の INSERT フィルタパターン（要件 2.4）。
 * Pipes は EventBridge の event pattern 文字列で filter を受けるため、router ESM とは別に
 * JSON 文字列として組み立てる。`stack.test.ts` がこの文字列と合成結果を突き合わせる。
 */
export const PIPES_INSERT_FILTER_PATTERN = JSON.stringify({
  eventName: ["INSERT"],
});

/**
 * ターゲットが SQS のときの EventBridge Pipes の source `batchSize` 上限。
 *
 * Pipes は source（DynamoDB Streams）から読んだレコードを 1 バッチ単位で target へ渡す。
 * target が SQS の場合、Pipes は内部的に `SendMessageBatch`（1 回最大 10 件）で送るため、
 * source の `batchSize` も **10 以下**でなければならない。11 以上を指定すると Pipes の作成が
 * `The configured batch size N is greater than the max supported batch size 10 for target sqs`
 * で失敗する（CloudFormation デプロイ時に判明。合成では検出されない）。
 *
 * source=Streams 単体なら 10,000 まで許されるが、ここでは target=SQS の制約が律速になる。
 * 滞留分を 1 レコード = 1 メッセージで小刻みに流す方針（§4.3.2）に影響はない。
 */
export const PIPES_SQS_TARGET_MAX_BATCH_SIZE = 10;

/**
 * Streams ESM の再試行回数の上限（design §4.3.3）。
 * 既定の -1（無限）だと恒久的に失敗する 1 レコードがシャードを塞ぎ後続も進めない。
 * 有限にして詰まりを打ち切る。
 */
export const ROUTER_STREAM_RETRY_ATTEMPTS = 3;

/** DLQ のメッセージ保持期間（SQS 最大）。到達件数はごく少ない想定なので長くしても費用は増えない。 */
export const DLQ_RETENTION = Duration.days(14);

/**
 * SQS 可視性タイムアウト（design §4.3.1 / レビュー第 1R-8）。
 * worker タイムアウト 60 秒（§6 表）× 6 = 360 秒。SQS をイベントソースにする Lambda は
 * 可視性を関数タイムアウトの 6 倍以上にするのが AWS 推奨（部分バッチ応答・リトライ中の
 * 再可視化を防ぐ）。式ではなく確定値で書き、worker タイムアウトを変えたら手で見直す。
 */
export const QUEUE_VISIBILITY_TIMEOUT = Duration.seconds(360);

/** SQS / Streams DLQ の maxReceiveCount（design §4.3.1）。 */
export const QUEUE_MAX_RECEIVE_COUNT = 5;

export interface LabelingStreamProps {
  /** テーブル 2 本。unit テーブルの Streams を入口のソースにする */
  readonly tables: LabelingTables;

  /** seeder / router / worker / api（router と worker にイベントソースを繋ぐ） */
  readonly functions: LabelingFunctions;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;

  /**
   * SQS キュー名の接頭辞。
   *
   * @default 'kiro-roasters'
   */
  readonly queueNamePrefix?: string;

  /**
   * SQS キュー名の末尾に付ける一意サフィックス（`labeling-tables.ts` と同じ理由）。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly queueNameSuffix?: string;
}

/** SQS・Pipes・router ESM・worker ESM の 4 要素を配線する Construct（design §4.3） */
export class LabelingStream extends Construct {
  /** 両方式が共用する SQS 標準キュー（要件 6） */
  readonly queue: Queue;

  /** worker が条件以外で繰り返し失敗したメッセージを隔離する DLQ（design §4.3.1） */
  readonly deadLetterQueue: Queue;

  /** 方式 A-Lambda の Streams ESM 専用 DLQ（メタデータのみ）。lambda/both で作る */
  readonly routerDeadLetterQueue?: Queue;

  /** 方式 A-Pipes の `CfnPipe`。pipes/both で作る */
  readonly pipe?: CfnPipe;

  /** 実際に有効化した入口方式。ダッシュボード・検証記録の突き合わせ用 */
  readonly relayMode: RelayMode;

  constructor(scope: Construct, id: string, props: LabelingStreamProps) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const prefix = props.queueNamePrefix ?? "kiro-roasters";
    const suffix = props.queueNameSuffix ?? defaultNameSuffix(this);
    const name = (logicalName: string) =>
      [prefix, logicalName, suffix].filter((part) => part !== "").join("-");

    this.relayMode = config.relayMode;

    // --- SQS 標準キュー + DLQ（design §4.3.1 / 要件 6） ---
    this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      queueName: name("labeling-dlq"),
      retentionPeriod: DLQ_RETENTION,
      encryption: QueueEncryption.SQS_MANAGED, // 要件 6.2
      enforceSSL: true, // 要件 6.3
      removalPolicy: RemovalPolicy.DESTROY, // 要件 6.4
    });

    this.queue = new Queue(this, "LabelingQueue", {
      queueName: name("labeling"),
      encryption: QueueEncryption.SQS_MANAGED, // 要件 6.2
      enforceSSL: true, // 要件 6.3
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT, // 360 秒（§4.3.1）
      removalPolicy: RemovalPolicy.DESTROY, // 要件 6.4
      // worker が条件以外の理由で繰り返し失敗したメッセージを隔離（design §4.3.1）
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: QUEUE_MAX_RECEIVE_COUNT,
      },
    });

    // --- 入口方式の分岐（design §4.3.5 / 論点 3） ---
    const usePipes = this.relayMode === "pipes" || this.relayMode === "both";
    const useLambda = this.relayMode === "lambda" || this.relayMode === "both";

    if (usePipes) {
      this.pipe = this.createPipe(props.tables, name);
    }
    if (useLambda) {
      this.routerDeadLetterQueue = new Queue(this, "RouterDeadLetterQueue", {
        queueName: name("labeling-router-dlq"),
        retentionPeriod: DLQ_RETENTION,
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      this.wireRouter(props.tables, props.functions, config);
    }

    // --- worker ESM（SQS → labeling-worker。design §4.3.4 / R5） ---
    this.wireWorker(props.functions, config);
  }

  /**
   * 方式 A-Pipes（design §4.3.2 / 要件 2.4）。
   *
   * `CfnPipe`（L1。CDK に Pipes の安定 L2 は無い）で source=unit Streams、target=SQS を結ぶ。
   * source: `startingPosition=LATEST`、`batchSize`（router と揃えて既定 100）、
   * filter `eventName=INSERT`。target: SQS。`inputTemplate` で Streams の `NewImage` から
   * §3.4 のペイロード（`unit_count` を含む）へ射影する。`unit_id` は `BATCH#` を剥がした本体 +
   * `-` + 6 桁ゼロ埋め `seq` を組み立てる（`buildUnitId` と同一文字列。一致は §16 の実機結合
   * テストで突き合わせる。NIT-1）。実行ロールには Streams 読み取りと SQS 送信を最小権限で付与。
   */
  private createPipe(
    tables: LabelingTables,
    name: (logicalName: string) => string,
  ): CfnPipe {
    // Pipes 実行ロール（最小権限。Streams 読み取り + SQS 送信。design §4.3.2）
    const role = new Role(this, "PipeRole", {
      assumedBy: new ServicePrincipal("pipes.amazonaws.com"),
      // description は ASCII のみ（CloudFormation の Role Description は CJK 非対応）。
      // 日本語の意図は本メソッドの JSDoc を参照（unit Streams → SQS の最小権限ロール）
      description:
        "EventBridge Pipes execution role (unit Streams -> SQS, least privilege)",
    });
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ],
        resources: [tables.unitStreamArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:SendMessage"],
        resources: [this.queue.queueArn],
      }),
    );

    // Streams の NewImage から §3.4 ペイロードへ射影する inputTemplate（NIT-1）。
    // unit_id は seeder/buildUnitId と同一文字列を組み立てる（UNIT# + 本体 + - + 6 桁 seq）。
    // ※ seq のゼロ埋めは Pipes 変換で表現できないため、unit_id は NewImage.unit_id をそのまま
    //   射影する（seeder が確定した冪等キーをそのまま運ぶ）。buildUnitId との一致は seeder 側が
    //   採番時に担保済みであり、実機では SQS 受信メッセージで突き合わせる（§17-4 / NIT-1）。
    const inputTemplate = [
      "{",
      '  "unit_id": <$.dynamodb.NewImage.unit_id.S>,',
      '  "batch_id": <$.dynamodb.NewImage.batch_id.S>,',
      '  "lot_id": <$.dynamodb.NewImage.lot_id.S>,',
      '  "item_id": <$.dynamodb.NewImage.item_id.S>,',
      '  "seq": <$.dynamodb.NewImage.seq.N>,',
      '  "unit_count": <$.dynamodb.NewImage.unit_count.N>,',
      '  "roast_date": <$.dynamodb.NewImage.roast_date.S>',
      "}",
    ].join("\n");

    return new CfnPipe(this, "RelayPipe", {
      name: name("labeling-pipe"),
      roleArn: role.roleArn,
      source: tables.unitStreamArn,
      target: this.queue.queueArn,
      sourceParameters: {
        dynamoDbStreamParameters: {
          startingPosition: StartingPosition.LATEST,
          // ターゲットが SQS のとき Pipes の batchSize 上限は 10（SQS SendMessageBatch の
          // 1 回あたり上限 10 件に合わせる）。11 以上を指定すると Pipes 作成が
          // "batch size N is greater than the max supported batch size 10 for target sqs"
          // で失敗する。source=DynamoDB Streams 自体は 10,000 まで許すが、ここは
          // target=SQS の制約が律速になるため 10 に固定する。
          // 1 レコード = 1 メッセージの転送方針（§4.3.2）は維持される（滞留分を小刻みに流すだけ）。
          batchSize: PIPES_SQS_TARGET_MAX_BATCH_SIZE,
        },
        // eventName=INSERT のみ届ける（要件 2.4。構造として固定）
        filterCriteria: {
          filters: [{ pattern: PIPES_INSERT_FILTER_PATTERN }],
        },
      },
      targetParameters: {
        // §3.4 ペイロードへ射影（unit_count を含む。HIGH-1・案 B）
        inputTemplate,
      },
    });
  }

  /**
   * 方式 A-Lambda（中継 Lambda。design §4.3.3 / 要件 2.5）。
   *
   * router に `DynamoEventSource(unitTable, {...})` を付ける。`startingPosition=LATEST`
   * （過去を再処理しない）、`filters=[INSERT]`、`batchSize`/`parallelizationFactor`、
   * `reportBatchItemFailures=true`、`retryAttempts=3`、`bisectBatchOnError=true`、
   * `onFailure=SqsDlq(routerDlq)`。SQS 送信先 URL を環境変数で渡し送信権限を手で絞る。
   */
  private wireRouter(
    tables: LabelingTables,
    functions: LabelingFunctions,
    config: VerificationConfig,
  ): void {
    functions.router.addEventSource(
      new DynamoEventSource(tables.unitTable, {
        startingPosition: StartingPosition.LATEST,
        batchSize: config.routerBatchSize,
        parallelizationFactor: config.routerParallelizationFactor,
        // 要件 2.1 / 2.4。この 1 行が無いと MODIFY も転送され観測が汚れる
        filters: [UNIT_STREAM_INSERT_FILTER],
        reportBatchItemFailures: true,
        retryAttempts: ROUTER_STREAM_RETRY_ATTEMPTS,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(this.routerDeadLetterQueue!),
      }),
    );

    // router が SQS へ SendMessage* する先の URL と最小権限（Streams 読取は ESM が付与）
    functions.router.addEnvironment(
      "LABELING_QUEUE_URL",
      this.queue.queueUrl,
    );
    functions.router.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:SendMessage", "sqs:SendMessageBatch"],
        resources: [this.queue.queueArn],
      }),
    );
  }

  /**
   * worker ESM（SQS → labeling-worker。design §4.3.4 / 要件 3 / 5 / R5）。
   *
   * `maxConcurrency=LABELING_MAX_CONCURRENCY`（既定 1,000。本 PoC 唯一の直接操作変数）、
   * `batchSize=LABELING_WORKER_BATCH_SIZE`（既定 1。1 メッセージ＝1 個体）、
   * `reportBatchItemFailures=true`（付番条件以外の失敗を部分再試行）。SQS 受信権限は
   * `SqsEventSource` が付与する。
   */
  private wireWorker(
    functions: LabelingFunctions,
    config: VerificationConfig,
  ): void {
    functions.worker.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: config.labelingWorkerBatchSize,
        maxConcurrency: config.labelingMaxConcurrency,
        reportBatchItemFailures: true,
      }),
    );
  }
}

/**
 * SQS キュー名の既定サフィックス（design §3.3）。
 * `labeling-tables.ts` の `defaultNameSuffix` と同じ考え方。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
