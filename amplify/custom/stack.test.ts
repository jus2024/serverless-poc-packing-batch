import { describe, it, expect } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { LabelingTables, LABELING_TABLE_ENV_KEYS } from "./labeling-tables.js";
import { LabelingFunctions } from "./labeling-functions.js";
import { LabelingApi, LABELING_API_ROUTES } from "./labeling-api.js";
import {
  LabelingStream,
  PIPES_INSERT_FILTER_PATTERN,
  PIPES_SQS_TARGET_MAX_BATCH_SIZE,
  QUEUE_VISIBILITY_TIMEOUT,
} from "./labeling-stream.js";
import { LabelingMonitoring } from "./labeling-monitoring.js";
import { LabelingAlarms } from "./labeling-alarms.js";
import {
  resolveVerificationConfig,
  type VerificationConfig,
  type RelayMode,
} from "./verification-config.js";
import { ENV_KEYS } from "../functions/shared/runtime-config.js";

/**
 * CDK 合成テスト（design §16 / FEAT-003 の verification）。
 *
 * `Template.fromStack` で配線を検査する。参考 EC PoC の `*.test.ts`（CDK 合成検査）に倣い、
 * `backend.ts`（Amplify の `defineBackend`）ではなく各 Construct を素の `Stack` 上に組んで
 * 検査する。`backend.ts` の配線順序・既存 auth/data 非改変は目視と型で担保し、ここでは
 * design §16 の各項目を合成結果で確認する。
 */

interface BuildOptions {
  relayMode?: RelayMode;
  withUserPool?: boolean;
  config?: VerificationConfig;
}

function buildStack(options: BuildOptions = {}): {
  stack: Stack;
  template: Template;
} {
  const app = new App();
  const stack = new Stack(app, "TestLabelingStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });

  const config =
    options.config ??
    resolveVerificationConfig({
      env: { RELAY_MODE: options.relayMode ?? "both" },
    });

  const tables = new LabelingTables(stack, "LabelingTables", { config });
  const functions = new LabelingFunctions(stack, "LabelingFunctions", {
    tables,
    config,
  });
  const api = new LabelingApi(stack, "LabelingApi", {
    handlers: { api: functions.api },
    userPool:
      options.withUserPool === false
        ? undefined
        : new UserPool(stack, "TestUserPool"),
  });
  functions.wireSeederInvoke(api);
  const stream = new LabelingStream(stack, "LabelingStream", {
    tables,
    functions,
    config,
  });
  new LabelingMonitoring(stack, "LabelingMonitoring", {
    functions,
    tables,
    stream,
    config,
  });
  new LabelingAlarms(stack, "LabelingAlarms", { functions, tables, stream });

  return { stack, template: Template.fromStack(stack) };
}

describe("LabelingStream — 入口と worker ESM", () => {
  it("router ESM のフィルタが eventName=INSERT で固定されている（方式 A-Lambda）", () => {
    const { template } = buildStack({ relayMode: "lambda" });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: Match.anyValue(),
      FilterCriteria: {
        Filters: [
          { Pattern: Match.stringLikeRegexp('"eventName":\\["INSERT"\\]') },
        ],
      },
    });
  });

  it("Pipes のフィルタが eventName=INSERT で固定されている（方式 A-Pipes）", () => {
    const { template } = buildStack({ relayMode: "pipes" });
    template.hasResourceProperties("AWS::Pipes::Pipe", {
      SourceParameters: {
        FilterCriteria: {
          Filters: [{ Pattern: PIPES_INSERT_FILTER_PATTERN }],
        },
      },
    });
  });

  it("Pipes の inputTemplate が NewImage.unit_count を射影する（HIGH-1・案 B）", () => {
    const { template } = buildStack({ relayMode: "pipes" });
    template.hasResourceProperties("AWS::Pipes::Pipe", {
      TargetParameters: {
        InputTemplate: Match.stringLikeRegexp("NewImage\\.unit_count"),
      },
    });
  });

  it("Pipes の source batchSize が SQS ターゲット上限 10 以下（デプロイ失敗の回帰防止）", () => {
    // target が SQS の Pipes は batchSize > 10 で作成に失敗する
    // （"batch size N is greater than the max supported batch size 10 for target sqs"）。
    // 合成では検出されずデプロイ時に初めて落ちるため、ここで固定して回帰を防ぐ。
    expect(PIPES_SQS_TARGET_MAX_BATCH_SIZE).toBeLessThanOrEqual(10);
    const { template } = buildStack({ relayMode: "pipes" });
    template.hasResourceProperties("AWS::Pipes::Pipe", {
      SourceParameters: {
        DynamoDBStreamParameters: {
          BatchSize: PIPES_SQS_TARGET_MAX_BATCH_SIZE,
        },
      },
    });
  });

  it("RELAY_MODE=pipes は Pipe を作り Streams ESM を作らない", () => {
    const { template } = buildStack({ relayMode: "pipes" });
    template.resourceCountIs("AWS::Pipes::Pipe", 1);
    // Streams（DynamoDB）をソースにする ESM が無いこと = SQS ソースの worker ESM のみ
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
  });

  it("RELAY_MODE=lambda は Streams ESM を作り Pipe を作らない", () => {
    const { template } = buildStack({ relayMode: "lambda" });
    template.resourceCountIs("AWS::Pipes::Pipe", 0);
    // router(Streams) + worker(SQS) の 2 本
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
  });

  it("RELAY_MODE=both は Pipe と Streams ESM の両方を作る", () => {
    const { template } = buildStack({ relayMode: "both" });
    template.resourceCountIs("AWS::Pipes::Pipe", 1);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
  });

  it("worker ESM の MaximumConcurrency が config を反映する", () => {
    const { template } = buildStack({
      config: resolveVerificationConfig({
        env: { RELAY_MODE: "lambda", LABELING_MAX_CONCURRENCY: "750" },
      }),
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      ScalingConfig: { MaximumConcurrency: 750 },
    });
  });

  it("SQS が SQS_MANAGED + enforceSSL + DESTROY + 可視性 360 秒", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::SQS::Queue", {
      SqsManagedSseEnabled: true,
      VisibilityTimeout: QUEUE_VISIBILITY_TIMEOUT.toSeconds(),
    });
    // enforceSSL は QueuePolicy の Deny(aws:SecureTransport=false) として現れる
    template.hasResourceProperties("AWS::SQS::QueuePolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          }),
        ]),
      },
    });
  });

  it("全キューが RemovalPolicy.DESTROY（DeletionPolicy=Delete）", () => {
    const { template } = buildStack({ relayMode: "both" });
    const queues = template.findResources("AWS::SQS::Queue");
    for (const q of Object.values(queues)) {
      expect(q.DeletionPolicy).toBe("Delete");
    }
  });
});

describe("LabelingTables — テーブル", () => {
  it("unit テーブルが NEW_IMAGE Streams と GSI 2 本（射影 ALL）を持つ", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "batch-units-index",
          Projection: { ProjectionType: "ALL" },
        }),
        Match.objectLike({
          IndexName: "lot-trace-index",
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
  });

  it("全テーブルが RemovalPolicy.DESTROY（DeletionPolicy=Delete）", () => {
    const { template } = buildStack();
    const tables = template.findResources("AWS::DynamoDB::GlobalTable");
    expect(Object.keys(tables).length).toBe(2);
    for (const t of Object.values(tables)) {
      expect(t.DeletionPolicy).toBe("Delete");
    }
  });
});

describe("LabelingApi — ルートと認証", () => {
  it("design §4.4 の 6 ルートが全て定義されている", () => {
    const { template } = buildStack();
    // OPTIONS を除く 6 メソッド（POST/GET）が COGNITO で定義される
    const methods = template.findResources("AWS::ApiGateway::Method");
    const nonOptions = Object.values(methods).filter(
      (m) => m.Properties?.HttpMethod !== "OPTIONS",
    );
    expect(nonOptions.length).toBe(LABELING_API_ROUTES.length);
  });

  it("OPTIONS 以外の全メソッドが Cognito オーソライザー、OPTIONS は NONE", () => {
    const { template } = buildStack();
    const methods = template.findResources("AWS::ApiGateway::Method");
    for (const m of Object.values(methods)) {
      const props = m.Properties ?? {};
      if (props.HttpMethod === "OPTIONS") {
        expect(props.AuthorizationType).toBe("NONE");
      } else {
        expect(props.AuthorizationType).toBe("COGNITO_USER_POOLS");
        expect(props.AuthorizerId).toBeDefined();
      }
    }
  });

  it("userPool 省略時は NONE にフォールバックする", () => {
    const { template } = buildStack({ withUserPool: false });
    const methods = template.findResources("AWS::ApiGateway::Method");
    for (const m of Object.values(methods)) {
      expect(m.Properties?.AuthorizationType).toBe("NONE");
    }
  });

  it("REGIONAL エンドポイント・ステージ poc", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      EndpointConfiguration: { Types: ["REGIONAL"] },
    });
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "poc",
    });
  });
});

describe("MaximumConcurrency 下限 2 の自前検証（合成失敗）", () => {
  it("MaximumConcurrency=1 を与えると合成前に例外（stack 構築が失敗する）", () => {
    expect(() =>
      buildStack({
        config: resolveVerificationConfig({
          env: { RELAY_MODE: "lambda", LABELING_MAX_CONCURRENCY: "1" },
        }),
      }),
    ).toThrow();
  });
});

describe("合成/実行時キー名の突き合わせ（design §6.6 / §16）", () => {
  it("テーブル環境変数キーが合成側と実行時側で一致する", () => {
    expect(LABELING_TABLE_ENV_KEYS.unitTableName).toBe(ENV_KEYS.UNIT_TABLE_NAME);
    expect(LABELING_TABLE_ENV_KEYS.roastBatchTableName).toBe(
      ENV_KEYS.ROAST_BATCH_TABLE_NAME,
    );
    expect(LABELING_TABLE_ENV_KEYS.batchUnitsIndexName).toBe(
      ENV_KEYS.BATCH_UNITS_INDEX_NAME,
    );
    expect(LABELING_TABLE_ENV_KEYS.lotTraceIndexName).toBe(
      ENV_KEYS.LOT_TRACE_INDEX_NAME,
    );
    expect(LABELING_TABLE_ENV_KEYS.unitStreamArn).toBe(
      ENV_KEYS.UNIT_STREAM_ARN,
    );
  });

  it("labeling-api に seeder 起動用の環境変数と invoke 権限が付く（wireSeederInvoke）", () => {
    const { template } = buildStack();
    // 環境変数 LABELING_SEEDER_FUNCTION_NAME が api 関数に注入される
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          LABELING_SEEDER_FUNCTION_NAME: Match.anyValue(),
        }),
      },
    });
    // seeder ARN 限定の lambda:InvokeFunction
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
          }),
        ]),
      },
    });
  });
});

describe("合成全体 — 循環参照なし", () => {
  it("スタック全体が合成でき循環参照にならない", () => {
    expect(() => buildStack({ relayMode: "both" }).template.toJSON()).not.toThrow();
  });
});
