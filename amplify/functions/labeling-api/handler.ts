/**
 * labeling-api ハンドラ（画面 A〜D。design §6.4 / §4.4 / 要件 8〜11）。
 *
 * API Gateway プロキシ統合の 1 ハンドラが 6 ルートを `event.httpMethod` + `event.resource` で
 * 分岐する。ルーティング・入力検証は routes.ts（純）に委ね、ここは副作用（DDB / Lambda invoke）
 * のみを行う。POST /labeling-start は条件付き遷移（ROASTING_DONE→LABELING）を同期実行し、
 * ConditionalCheckFailed を 409 に写して seeder を invoke しない（二重起動抑止の唯一の判定点。
 * design §6.1 / §6.4）。
 */
import {
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from "@aws-sdk/client-lambda";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { getDocClient } from "../shared/ddb.js";
import { ok, jsonResponse, HttpError, CORS_HEADERS } from "../shared/http.js";
import {
  resolveTableConfig,
  resolveVerificationConfig,
  ENV_KEYS,
  RuntimeConfigError,
} from "../shared/runtime-config.js";
import type {
  RoastBatchRecord,
  SeederInvokePayload,
} from "../shared/types.js";
import { routeRequest, type RouteAction } from "./routes.js";

let lambdaClient: LambdaClient | undefined;
function getLambdaClient(): LambdaClient {
  if (!lambdaClient) {
    lambdaClient = new LambdaClient({});
  }
  return lambdaClient;
}

function seederFunctionName(): string {
  const name = process.env[ENV_KEYS.SEEDER_FUNCTION_NAME];
  if (!name) {
    throw new RuntimeConfigError(
      `required env ${ENV_KEYS.SEEDER_FUNCTION_NAME} is missing`,
    );
  }
  return name;
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    // unit_count の上限検証（design §14）に使う SEED_UNIT_COUNT_MAX を実行時に解決して渡す
    const { seedUnitCountMax } = resolveVerificationConfig();
    const action = routeRequest(
      {
        httpMethod: event.httpMethod,
        resource: event.resource,
        body: event.body,
        pathParameters: event.pathParameters,
        queryStringParameters: event.queryStringParameters,
      },
      { seedUnitCountMax },
    );
    return await execute(action);
  } catch (err) {
    if (err instanceof HttpError) {
      return err.toResponse();
    }
    // 想定外は 500（詳細は返さずログに委ねる）
    return jsonResponse(500, {
      error: "InternalServerError",
      message: "unexpected error",
    });
  }
};

async function execute(action: RouteAction): Promise<APIGatewayProxyResult> {
  const tables = resolveTableConfig();
  const client = getDocClient();

  switch (action.kind) {
    case "options":
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };

    case "createBatch": {
      // 既定補完済みの unit_count を確定値として PutItem（design §6.4）
      const now = new Date().toISOString();
      const batchId = `BATCH#${action.lot_id.replace(/^LOT#/, "")}-${now}`;
      const record: RoastBatchRecord = {
        batch_id: batchId,
        item_id: action.item_id,
        lot_id: action.lot_id,
        roast_date: action.roast_date,
        unit_count: action.unit_count,
        labeled_count: 0,
        status: "ROASTING_DONE",
        created_at: now,
      };
      await client.send(
        new PutCommand({ TableName: tables.roastBatchTableName, Item: record }),
      );
      return jsonResponse(201, record);
    }

    case "listBatches": {
      const res = await client.send(
        new ScanCommand({
          TableName: tables.roastBatchTableName,
          FilterExpression: "#status = :s",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": action.status },
        }),
      );
      return ok(res.Items ?? []);
    }

    case "getBatch": {
      const res = await client.send(
        new GetCommand({
          TableName: tables.roastBatchTableName,
          Key: { batch_id: action.batch_id },
        }),
      );
      if (!res.Item) {
        throw new HttpError(404, "NotFound", `batch ${action.batch_id} not found`);
      }
      return ok(res.Item);
    }

    case "startLabeling": {
      // 条件付き遷移 ROASTING_DONE → LABELING（二重起動抑止の唯一の判定点。design §6.4）
      const now = new Date().toISOString();
      try {
        await client.send(
          new UpdateCommand({
            TableName: tables.roastBatchTableName,
            Key: { batch_id: action.batch_id },
            UpdateExpression:
              "SET #status = :labeling, labeling_started_at = :now",
            ConditionExpression: "#status = :roasting_done",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":labeling": "LABELING",
              ":roasting_done": "ROASTING_DONE",
              ":now": now,
            },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // 既に LABELING/LABELED（二重押下・処理中）→ seeder を invoke せず 409（design §6.4）
          throw new HttpError(
            409,
            "Conflict",
            `batch ${action.batch_id} already started labeling`,
          );
        }
        throw err;
      }

      // 条件成功時のみ seeder を非同期 invoke（InvocationType=Event）して即 202（design §6.4）
      const payload: SeederInvokePayload = { batch_id: action.batch_id };
      await getLambdaClient().send(
        new InvokeCommand({
          FunctionName: seederFunctionName(),
          InvocationType: InvocationType.Event,
          Payload: Buffer.from(JSON.stringify(payload)),
        }),
      );
      return jsonResponse(202, {
        batch_id: action.batch_id,
        status: "LABELING",
        labeling_started_at: now,
      });
    }

    case "listUnits": {
      const indexName =
        action.by === "batch"
          ? tables.batchUnitsIndexName
          : tables.lotTraceIndexName;
      const keyName = action.by === "batch" ? "batch_id" : "lot_id";
      const res = await client.send(
        new QueryCommand({
          TableName: tables.unitTableName,
          IndexName: indexName,
          KeyConditionExpression: "#k = :v",
          ExpressionAttributeNames: { "#k": keyName },
          ExpressionAttributeValues: { ":v": action.value },
        }),
      );
      // 一覧なので 0 件は 200 + 空配列（design §13）
      return ok(res.Items ?? []);
    }

    case "getConfig": {
      const verification = resolveVerificationConfig();
      return ok({
        bestBeforeDays: verification.bestBeforeDays,
        seedUnitCountMax: verification.seedUnitCountMax,
        processingTimeMs: verification.processingTimeMs,
        relayMode: process.env[ENV_KEYS.RELAY_MODE] ?? "pipes",
        labelingMaxConcurrency:
          process.env[ENV_KEYS.LABELING_MAX_CONCURRENCY] ?? "1000",
      });
    }

    default: {
      // 到達不能（routeRequest が網羅）。型安全のための保険。
      throw new HttpError(404, "NotFound", "unhandled action");
    }
  }
}
