import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ENV_KEYS } from "../shared/runtime-config.js";
import { handler } from "./handler.js";
import { buildPlanSeedRecords } from "./plan-data.js";

/**
 * plan-seeder handler の副作用側テスト（BLOCK-1 / design §4.1 / §4.2 / §4.4）。
 *
 * 焦点は「roast-batch 専用の環境変数解決」契約。plan-seeder は roast-batch への
 * 条件付き PutItem しか行わず unit テーブルには触れない（Streams 流入ゼロ）。
 * 合成側も roast-batch 名の環境変数だけを注入するため、handler は
 * `LABELING_ROAST_BATCH_TABLE_NAME` だけで最初の PutItem まで進めなければならない。
 * 共通 `resolveTableNames()` のように unit 名まで要求すると、手動 invoke が書き込み前に
 * `RuntimeConfigError` で失敗し、業務画面の起点となる PLANNED 焙煎計画を 1 件も作れない。
 * ここでは aws-sdk-client-mock で DynamoDBDocumentClient を差し替え、
 * roast 環境変数だけで条件付き PutItem に到達すること、冪等スキップ、想定外例外の
 * throw を handler レベルで固定する。
 */

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("plan-seeder handler: roast-batch 専用の環境変数で起動する（BLOCK-1）", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    ddbMock.reset();
    // unit 名は意図的に未設定のまま。roast-batch 名だけを注入する（合成側の注入と一致）。
    delete process.env[ENV_KEYS.UNIT_TABLE_NAME];
    delete process.env[ENV_KEYS.BATCH_UNITS_INDEX_NAME];
    delete process.env[ENV_KEYS.LOT_TRACE_INDEX_NAME];
    process.env[ENV_KEYS.ROAST_BATCH_TABLE_NAME] = "test-roast-batch";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("unit 名が未設定でも全件 PutItem に到達し inserted を返す（起動時に設定エラーで止まらない）", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await handler();

    const expected = buildPlanSeedRecords(new Date().toISOString());
    expect(result.inserted).toHaveLength(expected.length);
    expect(result.skipped).toHaveLength(0);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(expected.length);
    // roast-batch テーブルにだけ条件付きで書く（unit テーブルには触れない）
    for (const call of putCalls) {
      expect(call.args[0].input.TableName).toBe("test-roast-batch");
      expect(call.args[0].input.ConditionExpression).toBe(
        "attribute_not_exists(batch_id)",
      );
    }
  });

  it("条件失敗（既存行）は skipped に分類し、既存状態を巻き戻さない（冪等）", async () => {
    const records = buildPlanSeedRecords(new Date().toISOString());
    const existingId = records[0].batch_id;

    ddbMock.on(PutCommand).callsFake((input) => {
      if (input.Item?.batch_id === existingId) {
        throw new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        });
      }
      return {};
    });

    const result = await handler();

    expect(result.skipped).toContain(existingId);
    expect(result.inserted).not.toContain(existingId);
    expect(result.inserted).toHaveLength(records.length - 1);
  });

  it("スロットル等の想定外 AWS エラーは throw する（再実行で冪等に回復）", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    await expect(handler()).rejects.toThrow();
  });
});
