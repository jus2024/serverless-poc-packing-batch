/**
 * DynamoDBDocumentClient シングルトン（design §6.6）。
 *
 * Lambda 実行コンテキストの再利用を活かすため、クライアントはモジュールスコープで
 * 1 度だけ生成して使い回す。marshall オプションは undefined を除去し、空文字は許容する
 * （検証データの属性に空文字が入り得るため）。副作用（DDB 呼び出し）は各 handler に閉じ、
 * 純ロジックはこのクライアントに依存しない。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

let docClient: DynamoDBDocumentClient | undefined;

/** 共有の DynamoDBDocumentClient を返す（初回のみ生成）。 */
export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
    });
  }
  return docClient;
}
