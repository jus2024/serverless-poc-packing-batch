import { Duration, Names } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { LabelingFunctions } from "./labeling-functions.js";
import { LabelingStream } from "./labeling-stream.js";
import { LabelingTables } from "./labeling-tables.js";
import { ACCOUNT_CONCURRENCY_LIMIT } from "./labeling-monitoring.js";

/**
 * アラームと SNS トピック（design §8.2 / 要件 7）。
 *
 * ## ダッシュボードと別 Construct で持つ（参考 EC PoC `order-alarms.ts` を踏襲）
 *
 * 要件は CloudWatch 可視化（要件 7）までだが、参考構成の地続き感・本番運用に近いリアルさを
 * 保つため、ダッシュボードと別にアラームと SNS トピックを定義する。トピックは `enforceSSL`、
 * サブスクリプションは作らず `topicArn` を出力するだけ（購読は検証者に委ねる。要件 7 の
 * 必須範囲を超える拡張）。閾値はダッシュボード（`labeling-monitoring.ts`）と共有してずれない
 * ようにする（`ACCOUNT_CONCURRENCY_LIMIT` を import）。
 *
 * アラーム（design §8.2）:
 * - worker スロットル > 0（critical）
 * - アカウント同時実行 80%（warning）
 * - SQS / Streams DLQ にメッセージ（warning）
 * - SQS キュー深度の長時間高止まり（warning）
 */

/** 同時実行アラームの閾値（アカウント枠の 80%。design §8.2）。 */
export const CONCURRENCY_WARNING_RATIO = 0.8;

/** SQS 深度の高止まり閾値（メッセージ数。design §8.2）。 */
export const QUEUE_DEPTH_WARNING_THRESHOLD = 5000;

export interface LabelingAlarmsProps {
  readonly functions: LabelingFunctions;
  readonly tables: LabelingTables;
  readonly stream: LabelingStream;

  /**
   * SNS トピック名の接頭辞。
   *
   * @default 'kiro-roasters-labeling-alarms'
   */
  readonly topicNamePrefix?: string;

  /**
   * トピック名の末尾に付ける一意サフィックス（`labeling-tables.ts` と同じ理由）。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly topicNameSuffix?: string;
}

/** アラームと SNS トピックを定義する Construct（design §8.2） */
export class LabelingAlarms extends Construct {
  /** 購読なしの SNS トピック（`topicArn` を出力。design §8.2） */
  readonly topic: Topic;

  /** 全アラーム。ダッシュボード・検証記録の突き合わせ用 */
  readonly alarms: Alarm[];

  constructor(scope: Construct, id: string, props: LabelingAlarmsProps) {
    super(scope, id);

    const prefix = props.topicNamePrefix ?? "kiro-roasters-labeling-alarms";
    const suffix = props.topicNameSuffix ?? defaultNameSuffix(this);

    this.topic = new Topic(this, "AlarmTopic", {
      topicName: [prefix, suffix].filter((part) => part !== "").join("-"),
      enforceSSL: true,
    });

    const { functions, stream } = props;
    const period = Duration.minutes(1);
    this.alarms = [];

    // worker スロットル > 0（critical）
    this.alarms.push(
      new Alarm(this, "WorkerThrottleAlarm", {
        alarmDescription:
          "付番ワーカーがスロットルされた（critical。同時実行枠の奪い合い等）",
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "Throttles",
          dimensionsMap: { FunctionName: functions.worker.functionName },
          statistic: "Sum",
          period,
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // アカウント同時実行 80%（warning）
    this.alarms.push(
      new Alarm(this, "AccountConcurrencyAlarm", {
        alarmDescription:
          "付番ワーカーの同時実行がアカウント枠の 80% に達した（warning）",
        metric: new Metric({
          namespace: "AWS/Lambda",
          metricName: "ConcurrentExecutions",
          dimensionsMap: { FunctionName: functions.worker.functionName },
          statistic: "Maximum",
          period,
        }),
        threshold: Math.floor(ACCOUNT_CONCURRENCY_LIMIT * CONCURRENCY_WARNING_RATIO),
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // SQS DLQ にメッセージ（warning）
    this.alarms.push(
      new Alarm(this, "SqsDlqAlarm", {
        alarmDescription: "SQS DLQ にメッセージが届いた（warning。恒久失敗の隔離）",
        metric: new Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: stream.deadLetterQueue.queueName },
          statistic: "Maximum",
          period,
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );

    // Streams DLQ にメッセージ（warning）。lambda / both で routerDLQ が存在する
    if (stream.routerDeadLetterQueue) {
      this.alarms.push(
        new Alarm(this, "StreamsDlqAlarm", {
          alarmDescription:
            "Streams DLQ にメタデータが届いた（warning。中継の恒久失敗）",
          metric: new Metric({
            namespace: "AWS/SQS",
            metricName: "ApproximateNumberOfMessagesVisible",
            dimensionsMap: {
              QueueName: stream.routerDeadLetterQueue.queueName,
            },
            statistic: "Maximum",
            period,
          }),
          threshold: 0,
          comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
          evaluationPeriods: 1,
          treatMissingData: TreatMissingData.NOT_BREACHING,
        }),
      );
    }

    // SQS キュー深度の長時間高止まり（warning。5 分連続で閾値超過）
    this.alarms.push(
      new Alarm(this, "QueueDepthAlarm", {
        alarmDescription:
          "SQS キュー深度が高止まりしている（warning。worker が捌けていない）",
        metric: new Metric({
          namespace: "AWS/SQS",
          metricName: "ApproximateNumberOfMessagesVisible",
          dimensionsMap: { QueueName: stream.queue.queueName },
          statistic: "Maximum",
          period,
        }),
        threshold: QUEUE_DEPTH_WARNING_THRESHOLD,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    );
  }

  /** SNS トピックの ARN（`backend.addOutput` の `custom.alarmTopicArn` の出典。design §10） */
  get topicArn(): string {
    return this.topic.topicArn;
  }
}

/**
 * トピック名の既定サフィックス（design §3.3）。
 * `labeling-tables.ts` の `defaultNameSuffix` と同じ考え方。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
