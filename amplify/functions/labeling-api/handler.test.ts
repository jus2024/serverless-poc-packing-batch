import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";
import { ENV_KEYS } from "../shared/runtime-config.js";
import type { RoastingCompleteResponse } from "../shared/types.js";
import { handler } from "./handler.js";

/**
 * labeling-api handler の副作用側テスト（BLOCK-2 / design §3.5 / 要件 B3）。
 *
 * routes.test.ts はルーティング・入力検証（純ロジック）を固定するが、
 * `POST /batches/roasting-complete` の「DynamoDB の条件付き UpdateItem 結果を
 * completed/skipped/not_found/invalid の 4 配列へ写す」handler 動作は副作用側にあり、
 * そこが未テストだと『例外 Item の表現を取り違えて全件 not_found になる』既知の失敗
 * （unmarshall 漏れ）を検出できない。ここでは aws-sdk-client-mock で
 * DynamoDBDocumentClient を差し替え、成功・各種条件失敗・想定外 AWS エラーから
 * 4 分類レスポンスと 500 契約までを handler レベルで固定する。
 */

const ddbMock = mockClient(DynamoDBDocumentClient);

/** roasting-complete の API Gateway プロキシイベントを組み立てる。 */
function roastingCompleteEvent(batchIds: string[]): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    resource: "/batches/roasting-complete",
    body: JSON.stringify({ batch_ids: batchIds }),
    pathParameters: null,
    queryStringParameters: null,
  } as unknown as APIGatewayProxyEvent;
}

/** PLANNED 以外の既存行で条件失敗したときに DynamoDB が返す例外を作る。 */
function conditionFailure(
  item?: Record<string, unknown>,
): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
    // 例外中の Item は marshall 済み AttributeValue マップ（自動 unmarshall されない）
    Item: item ? marshall(item) : undefined,
  });
}

describe("handler: POST /batches/roasting-complete の 4 分類（BLOCK-2）", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    ddbMock.reset();
    // handler は resolveTableConfig / resolveVerificationConfig が要求する env を読む
    process.env[ENV_KEYS.UNIT_TABLE_NAME] = "test-unit";
    process.env[ENV_KEYS.ROAST_BATCH_TABLE_NAME] = "test-roast-batch";
    process.env[ENV_KEYS.BATCH_UNITS_INDEX_NAME] = "batch-units-index";
    process.env[ENV_KEYS.LOT_TRACE_INDEX_NAME] = "lot-trace-index";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("成功は completed に入る（HTTP 200）", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const res = await handler(roastingCompleteEvent(["BATCH#a", "BATCH#b"]));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RoastingCompleteResponse;
    expect(body).toEqual({
      completed: ["BATCH#a", "BATCH#b"],
      skipped: [],
      not_found: [],
      invalid: [],
    });
  });

  it("条件失敗で Item が無ければ not_found", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailure(undefined));
    const res = await handler(roastingCompleteEvent(["BATCH#missing"]));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RoastingCompleteResponse;
    expect(body.not_found).toEqual(["BATCH#missing"]);
    expect(body.completed).toEqual([]);
  });

  it("既に ROASTING_DONE の行は skipped（冪等）", async () => {
    ddbMock.on(UpdateCommand).rejects(
      conditionFailure({ batch_id: "BATCH#done", status: "ROASTING_DONE" }),
    );
    const res = await handler(roastingCompleteEvent(["BATCH#done"]));
    const body = JSON.parse(res.body) as RoastingCompleteResponse;
    expect(body.skipped).toEqual(["BATCH#done"]);
    expect(body.not_found).toEqual([]);
  });

  it("LABELING / LABELED / 想定外 status は invalid（不正遷移）", async () => {
    for (const status of ["LABELING", "LABELED", "SOMETHING_ELSE"]) {
      ddbMock.reset();
      ddbMock.on(UpdateCommand).rejects(
        conditionFailure({ batch_id: "BATCH#x", status }),
      );
      const res = await handler(roastingCompleteEvent(["BATCH#x"]));
      const body = JSON.parse(res.body) as RoastingCompleteResponse;
      expect(body.invalid).toEqual(["BATCH#x"]);
      expect(body.completed).toEqual([]);
      expect(body.skipped).toEqual([]);
    }
  });

  it("混在入力を 4 配列へ正しく振り分ける（unmarshall 経路を含む）", async () => {
    ddbMock
      .on(UpdateCommand, {
        Key: { batch_id: "BATCH#ok" },
      })
      .resolves({})
      .on(UpdateCommand, { Key: { batch_id: "BATCH#done" } })
      .rejects(conditionFailure({ batch_id: "BATCH#done", status: "ROASTING_DONE" }))
      .on(UpdateCommand, { Key: { batch_id: "BATCH#missing" } })
      .rejects(conditionFailure(undefined))
      .on(UpdateCommand, { Key: { batch_id: "BATCH#busy" } })
      .rejects(conditionFailure({ batch_id: "BATCH#busy", status: "LABELING" }));

    const res = await handler(
      roastingCompleteEvent([
        "BATCH#ok",
        "BATCH#done",
        "BATCH#missing",
        "BATCH#busy",
      ]),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as RoastingCompleteResponse;
    expect(body).toEqual({
      completed: ["BATCH#ok"],
      skipped: ["BATCH#done"],
      not_found: ["BATCH#missing"],
      invalid: ["BATCH#busy"],
    });
  });

  it("想定外の AWS エラーは 500 に写す（ConditionalCheckFailed 以外は再 throw）", async () => {
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error("throttled"), {
        name: "ProvisionedThroughputExceededException",
      }),
    );
    const res = await handler(roastingCompleteEvent(["BATCH#a"]));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe("InternalServerError");
  });
});
