import { Duration } from "aws-cdk-lib";
import {
  Dashboard,
  GraphWidget,
  GraphWidgetView,
  HorizontalAnnotation,
  Metric,
  TextWidget,
  type IMetric,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { LabelingFunctions } from "./labeling-functions.js";
import { LabelingStream } from "./labeling-stream.js";
import { LabelingTables } from "./labeling-tables.js";
import {
  getVerificationConfig,
  type VerificationConfig,
} from "./verification-config.js";

/**
 * CloudWatch 単一ダッシュボード（design §8.1 / 要件 7）。
 *
 * ## 本 PoC の観測を 1 枚に集約する（参考 EC PoC `order-monitoring.ts` を踏襲）
 *
 * 一次指標は **worker の `ConcurrentExecutions`**（R5）。最上段に 24 幅で単独配置し、
 * `MaximumConcurrency` とアカウント枠 1,000 の注釈線を引く。粒度は 1 分固定（要件 7.6。
 * IaC で定義し手作業で作らない）。タイトルは定数化し `stack.test.ts` が design と突き合わせる。
 *
 * ## 入口別比較の制約（design §8.1 / NIT-2）
 *
 * 入口の立ち上がりは Pipes 側を `AWS/Pipes` の `Invocations`（PipeName）、router 側を
 * `AWS/Lambda` の `Invocations` で描く。SQS の `NumberOfMessagesSent` は入口別に按分できず、
 * `RELAY_MODE=both` では両入口の送信が合算されて分離できないため、both では「どちらの入口でも
 * 1,000 まで張り付くか」の定性比較に留める旨をウィジェットの注記に明示する。
 */

/** ウィジェットのタイトル定数（design §8.1。`stack.test.ts` が突き合わせる）。 */
export const LABELING_DASHBOARD_TITLES = {
  concurrency: "付番ワーカー同時実行（一次指標・R5）",
  entryComparison: "入口別の立ち上がり比較（Pipes / router）",
  queueDepth: "SQS キュー深度",
  throttles: "worker スロットル",
  iteratorAge: "中継側 IteratorAge（方式 A-Lambda）",
  unitWriteCapacity: "unit テーブル書き込み容量（基表 + GSI 2 本）",
  unitWriteThrottle: "unit テーブル書き込みスロットル（基表 + GSI 2 本）",
  dlqDepth: "DLQ メッセージ数（SQS / Streams）",
} as const;

/** アカウント同時実行枠（既定）。注釈線とアラーム閾値で共有する（design §8.1 / §8.2）。 */
export const ACCOUNT_CONCURRENCY_LIMIT = 1000;

export interface LabelingMonitoringProps {
  readonly functions: LabelingFunctions;
  readonly tables: LabelingTables;
  readonly stream: LabelingStream;

  /**
   * 解決済みの検証パラメータ（`MaximumConcurrency` の注釈線に使う）。
   *
   * @default `getVerificationConfig()`
   */
  readonly config?: VerificationConfig;

  /**
   * ダッシュボード名の接頭辞。
   *
   * @default 'kiro-roasters-labeling'
   */
  readonly dashboardNamePrefix?: string;
}

/** 単一ダッシュボードを定義する Construct（design §8.1） */
export class LabelingMonitoring extends Construct {
  readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, props: LabelingMonitoringProps) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const { functions, tables, stream } = props;
    const period = Duration.minutes(1); // 粒度 1 分固定（要件 7.6）

    const workerFnName = functions.worker.functionName;

    // 一次指標: worker ConcurrentExecutions（最大）。MaxConcurrency / 枠 1,000 の注釈線
    const concurrencyAnnotations: HorizontalAnnotation[] = [
      {
        value: config.labelingMaxConcurrency,
        label: `MaximumConcurrency (${config.labelingMaxConcurrency})`,
        color: "#1f77b4",
      },
      {
        value: ACCOUNT_CONCURRENCY_LIMIT,
        label: `アカウント枠 (${ACCOUNT_CONCURRENCY_LIMIT})`,
        color: "#d62728",
      },
    ];

    this.dashboard = new Dashboard(this, "Dashboard", {
      dashboardName: `${props.dashboardNamePrefix ?? "kiro-roasters-labeling"}-${scope.node.addr.slice(-8)}`,
      defaultInterval: Duration.hours(1),
    });

    // ヘッダー: 読み方（design §8.1）
    this.dashboard.addWidgets(
      new TextWidget({
        markdown: [
          "# SQS 付番バッチ処理 PoC — 観測ダッシュボード",
          "",
          "- `ConcurrentExecutions` が `MaximumConcurrency` 付近に張り付けばファンアウト成功（R5）。",
          "- 入口方式（pipes / lambda）ごとに立ち上がりカーブを比較する（§8.1）。",
          `- 現在有効な入口: **${stream.relayMode}**（both は入口別の送信件数が分離できず定性比較に留める。NIT-2）。`,
          "- ゼロも観測結果（滞留が無ければ worker は立ち上がらない）。",
        ].join("\n"),
        width: 24,
        height: 4,
      }),
    );

    // 最上段: 一次指標（24 幅・単独）
    this.dashboard.addWidgets(
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.concurrency,
        width: 24,
        height: 8,
        view: GraphWidgetView.TIME_SERIES,
        left: [
          this.lambdaMetric("ConcurrentExecutions", workerFnName, period, "Maximum"),
        ],
        leftAnnotations: concurrencyAnnotations,
      }),
    );

    // 入口別比較 + SQS 深度
    this.dashboard.addWidgets(
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.entryComparison,
        width: 12,
        height: 6,
        left: this.entryComparisonMetrics(functions, stream, period),
      }),
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.queueDepth,
        width: 12,
        height: 6,
        left: [
          this.sqsMetric(
            "ApproximateNumberOfMessagesVisible",
            stream.queue.queueName,
            period,
          ),
          this.sqsMetric(
            "ApproximateNumberOfMessagesNotVisible",
            stream.queue.queueName,
            period,
          ),
        ],
      }),
    );

    // worker スロットル + 中継側 IteratorAge
    this.dashboard.addWidgets(
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.throttles,
        width: 12,
        height: 6,
        left: [this.lambdaMetric("Throttles", workerFnName, period, "Sum")],
      }),
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.iteratorAge,
        width: 12,
        height: 6,
        left: [
          this.lambdaMetric(
            "IteratorAge",
            functions.router.functionName,
            period,
            "Maximum",
          ),
        ],
      }),
    );

    // unit テーブル書き込み容量 / スロットル（基表 + GSI 2 本）
    this.dashboard.addWidgets(
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.unitWriteCapacity,
        width: 12,
        height: 6,
        left: this.tableWriteMetrics(
          "ConsumedWriteCapacityUnits",
          tables,
          period,
          "Sum",
        ),
      }),
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.unitWriteThrottle,
        width: 12,
        height: 6,
        left: this.tableWriteMetrics(
          "WriteThrottleEvents",
          tables,
          period,
          "Sum",
        ),
      }),
    );

    // DLQ 深度（SQS / Streams）
    const dlqMetrics: IMetric[] = [
      this.sqsMetric(
        "ApproximateNumberOfMessagesVisible",
        stream.deadLetterQueue.queueName,
        period,
      ),
    ];
    if (stream.routerDeadLetterQueue) {
      dlqMetrics.push(
        this.sqsMetric(
          "ApproximateNumberOfMessagesVisible",
          stream.routerDeadLetterQueue.queueName,
          period,
        ),
      );
    }
    this.dashboard.addWidgets(
      new GraphWidget({
        title: LABELING_DASHBOARD_TITLES.dlqDepth,
        width: 24,
        height: 6,
        left: dlqMetrics,
      }),
    );
  }

  /**
   * 入口別の立ち上がり比較メトリクス（design §8.1 / NIT-2）。
   * router 側は `AWS/Lambda` の `Invocations`、Pipes 側は `AWS/Pipes` の `Invocations`。
   * 有効な入口だけを描く（RELAY_MODE 分岐と整合）。
   */
  private entryComparisonMetrics(
    functions: LabelingFunctions,
    stream: LabelingStream,
    period: Duration,
  ): IMetric[] {
    const metrics: IMetric[] = [];
    if (stream.routerDeadLetterQueue) {
      // lambda / both: router の Invocations
      metrics.push(
        this.lambdaMetric(
          "Invocations",
          functions.router.functionName,
          period,
          "Sum",
        ),
      );
    }
    if (stream.pipe) {
      // pipes / both: Pipes の Invocations（PipeName ディメンション）
      metrics.push(
        new Metric({
          namespace: "AWS/Pipes",
          metricName: "Invocations",
          dimensionsMap: { PipeName: stream.pipe.name! },
          statistic: "Sum",
          period,
        }),
      );
    }
    return metrics;
  }

  /** Lambda メトリクスを 1 本組み立てる。 */
  private lambdaMetric(
    metricName: string,
    functionName: string,
    period: Duration,
    statistic: string,
  ): Metric {
    return new Metric({
      namespace: "AWS/Lambda",
      metricName,
      dimensionsMap: { FunctionName: functionName },
      statistic,
      period,
    });
  }

  /** SQS メトリクスを 1 本組み立てる。 */
  private sqsMetric(
    metricName: string,
    queueName: string,
    period: Duration,
  ): Metric {
    return new Metric({
      namespace: "AWS/SQS",
      metricName,
      dimensionsMap: { QueueName: queueName },
      statistic: "Maximum",
      period,
    });
  }

  /**
   * unit テーブルの書き込みメトリクス（基表 + GSI 2 本）。
   * 射影 ALL の GSI は基表と同量の書き込みを受けるため 2 本とも観測する（要件 7.5）。
   */
  private tableWriteMetrics(
    metricName: string,
    tables: LabelingTables,
    period: Duration,
    statistic: string,
  ): IMetric[] {
    const tableName = tables.unitTable.tableName;
    return [
      new Metric({
        namespace: "AWS/DynamoDB",
        metricName,
        dimensionsMap: { TableName: tableName },
        statistic,
        period,
      }),
      new Metric({
        namespace: "AWS/DynamoDB",
        metricName,
        dimensionsMap: {
          TableName: tableName,
          GlobalSecondaryIndexName: tables.batchUnitsIndexName,
        },
        statistic,
        period,
      }),
      new Metric({
        namespace: "AWS/DynamoDB",
        metricName,
        dimensionsMap: {
          TableName: tableName,
          GlobalSecondaryIndexName: tables.lotTraceIndexName,
        },
        statistic,
        period,
      }),
    ];
  }
}
