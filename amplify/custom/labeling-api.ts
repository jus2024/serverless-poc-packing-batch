import { Stack } from "aws-cdk-lib";
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  Cors,
  EndpointType,
  LambdaIntegration,
  RestApi,
  type IResource,
} from "aws-cdk-lib/aws-apigateway";
import type { IUserPool } from "aws-cdk-lib/aws-cognito";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

/**
 * API Gateway REST API とルート定義（design §4.4 / §7、要件 8〜11 / 決定 1）。
 *
 * ## Cognito User Pool 認証を掛ける（参考 EC PoC `order-api.ts` を踏襲）
 *
 * `userPool` を渡すと全ルート（OPTIONS プリフライトを除く）に Cognito User Pool
 * オーソライザーを掛ける。`CognitoUserPoolsAuthorizer`（`identitySource` 未指定＝既定
 * `method.request.header.Authorization`）は `Authorization` ヘッダーの Cognito 発行 JWT
 * （ID / アクセストークンのいずれも）を受理し署名・有効期限・失効を検証する。本 PoC の
 * フロントは EC PoC に合わせ **ID トークン**を `Authorization: Bearer <idToken>` で送る
 * （`src/lib/labeling/api.ts`。design §4.4）。これにより Amplify Hosting にデプロイしても
 * 4 画面は Cognito 認証配下でのみ操作できる（要件 8.3 / 9.3 / 10.5 / 11.4）。
 *
 * CORS プリフライト（OPTIONS）には認証を掛けない。ブラウザはプリフライトに
 * `Authorization` を付けないため、ここを認証必須にすると全 CORS リクエストが失敗する。
 * `defaultCorsPreflightOptions` が生成する OPTIONS は MOCK 統合で認証なし（NONE）のまま
 * 残す（`stack.test.ts` が検査する。design §16）。
 *
 * `userPool` を省略した場合（テスト・ローカル合成）は `AuthorizationType.NONE` に
 * フォールバックする。ただし `backend.ts` からは必ず `userPool` を渡すこと（design §10）。
 *
 * ## design §4.4 の 6 ルートすべてを定義する
 *
 * 画面 A〜D のデータアクセス経路（決定 1）。ルートは `LABELING_API_ROUTES` の表から
 * 機械的に生成し、`stack.test.ts` が表と design §4.4 の対応を検査する。
 */

/** ルートの割り当て先。本 PoC の API は 1 ハンドラ（labeling-api）が全ルートを受ける */
export interface LabelingApiHandlers {
  /** 画面 A〜D の 6 ルートを `httpMethod` + `resource` で分岐する唯一のハンドラ（§6.4） */
  readonly api: IFunction;
}

export interface LabelingApiRoute {
  readonly method: "GET" | "POST";
  /** 先頭スラッシュ付きのパス。`{batchId}` テンプレートを含む */
  readonly path: string;
  readonly handler: keyof LabelingApiHandlers;
}

/**
 * design §4.4 / §3.2 のルート表そのもの（全 7 ルート。これが唯一の出典）。
 *
 * `POST /batches/{batchId}/labeling-start` は条件付き遷移成功時に seeder を**非同期 invoke**
 * して即 202 を返す（要件 1.1 / 9.2。決定 2）。API Gateway の統合タイムアウトは上限 29 秒で、
 * 約 1,000 件の INSERT を同期で待つ経路は存在し得ない。進捗の照会先が
 * `GET /batches/{batchId}`（画面 C のポーリング）である。
 */
export const LABELING_API_ROUTES: readonly LabelingApiRoute[] = [
  // 画面 A: RoastBatch を PutItem（要件 8.1）
  { method: "POST", path: "/batches", handler: "api" },
  // 画面 B: バッチ一覧（Scan + ?status= フィルタ。既定 ROASTING_DONE。要件 9.1）
  { method: "GET", path: "/batches", handler: "api" },
  // 画面 C: 進捗ポーリング（roast-batch 読み取り。要件 10.1）
  { method: "GET", path: "/batches/{batchId}", handler: "api" },
  // 画面 B: [付番開始]→条件付き遷移後に seeder 非同期 invoke（要件 1.1 / 9.2）
  { method: "POST", path: "/batches/{batchId}/labeling-start", handler: "api" },
  // 業務: 焙煎完了の一括記録（PLANNED → ROASTING_DONE。要件 B3。§3.2）
  { method: "POST", path: "/batches/roasting-complete", handler: "api" },
  // 画面 D: GSI Query（?batchId= / ?lotId=。要件 11.1 / 11.2）
  { method: "GET", path: "/units", handler: "api" },
  // デプロイ済み検証パラメータの確認（非機能 5）
  { method: "GET", path: "/config", handler: "api" },
];

/**
 * CORS の許可内容（design §4.4）。
 * `shared/http.ts` の CORS ヘッダー（実応答に付ける）と揃える。プリフライトで許可した
 * メソッドと実応答が食い違うとブラウザ側で原因不明の CORS エラーになる
 * （`stack.test.ts` が突き合わせる）。`Authorization` は Cognito 認証で全リクエストに付く。
 */
export const LABELING_API_CORS = {
  allowOrigins: Cors.ALL_ORIGINS,
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
} as const;

/**
 * 既定のステージ名（design §4.4）。
 * CDK の既定は `prod` だが、この API は検証専用なので `poc` にする。
 * `urlForLambdaEnvironment` の組み立てにも使うため定数として公開する。
 */
export const LABELING_API_STAGE_NAME = "poc";

export interface LabelingApiProps {
  readonly handlers: LabelingApiHandlers;

  /**
   * Cognito User Pool。指定すると全ルート（OPTIONS を除く）に Cognito オーソライザーを
   * 掛ける。省略時は `AuthorizationType.NONE` にフォールバック（テスト・ローカル合成用）。
   * `backend.ts` からは必ず `backend.auth.resources.userPool` を渡すこと（design §10）。
   */
  readonly userPool?: IUserPool;

  /**
   * ステージ名。API のベース URL に含まれる。
   *
   * @default 'poc'
   */
  readonly stageName?: string;
}

/** REST API とルートを定義する Construct（design §7） */
export class LabelingApi extends Construct {
  readonly api: RestApi;

  /** 実際に使ったステージ名。ベース URL の組み立てで使う */
  readonly stageName: string;

  constructor(scope: Construct, id: string, props: LabelingApiProps) {
    super(scope, id);

    this.stageName = props.stageName ?? LABELING_API_STAGE_NAME;

    // Cognito オーソライザーは userPool が渡されたときだけ作る。
    // 省略時（テスト・ローカル合成）は authorizationType = NONE にフォールバックする
    const authorizer =
      props.userPool === undefined
        ? undefined
        : new CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", {
            cognitoUserPools: [props.userPool],
          });

    this.api = new RestApi(this, "RestApi", {
      description:
        authorizer === undefined
          ? "SQS 付番バッチ処理 PoC の検証用 API（認証なし。テスト/ローカル合成用のフォールバック）"
          : "SQS 付番バッチ処理 PoC の検証用 API（Cognito User Pool 認証）",
      // REGIONAL（design §4.4）。EDGE（既定）は CloudFront を挟み遅延が乗る
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      deployOptions: {
        stageName: this.stageName,
      },
      // 全応答（エラー応答も）に CORS が必要なため、プリフライトは全リソースに付ける
      defaultCorsPreflightOptions: {
        allowOrigins: [...LABELING_API_CORS.allowOrigins],
        allowMethods: [...LABELING_API_CORS.allowMethods],
        allowHeaders: [...LABELING_API_CORS.allowHeaders],
      },
      // `defaultMethodOptions` は `addMethod` で足すルートにのみ適用される。
      // `defaultCorsPreflightOptions` が生成する OPTIONS には波及しないため、
      // プリフライトは認証なし（NONE）のまま残る（`stack.test.ts` が検査）
      defaultMethodOptions:
        authorizer === undefined
          ? { authorizationType: AuthorizationType.NONE }
          : {
              authorizationType: AuthorizationType.COGNITO,
              authorizer,
            },
    });

    // 統合はハンドラごとに 1 つ作って共有する（本 PoC は 1 ハンドラが全ルートを受ける）
    const integrations = new Map<keyof LabelingApiHandlers, LambdaIntegration>();
    const integrationFor = (
      key: keyof LabelingApiHandlers,
    ): LambdaIntegration => {
      let integration = integrations.get(key);
      if (integration === undefined) {
        integration = new LambdaIntegration(props.handlers[key], {
          proxy: true,
        });
        integrations.set(key, integration);
      }
      return integration;
    };

    for (const route of LABELING_API_ROUTES) {
      // `resourceForPath` は中間リソース（`/batches`）を作り、
      // 同じパスの再取得では既存のリソースを返す
      const resource: IResource = this.api.root.resourceForPath(route.path);
      resource.addMethod(route.method, integrationFor(route.handler));
    }
  }

  /**
   * API のベース URL（末尾はステージのスラッシュまで）。
   * `backend.addOutput` の `custom.labelingApiUrl` と `NEXT_PUBLIC_LABELING_API_URL` の
   * 出典になる（design §4.4 / §10）。
   *
   * **この値を Lambda の環境変数に渡してはならない**（循環参照になる）。
   * Lambda へ渡す必要がある場合は `urlForLambdaEnvironment` を使う。
   */
  get url(): string {
    return this.api.url;
  }

  /**
   * この API のベース URL のうち、**この API に統合された Lambda の環境変数へ渡せる形**
   * （末尾のスラッシュは含まない）。参考 EC PoC `order-api.ts` と同じ循環回避の組み立て。
   *
   * `api.url` は内部で `Stage.urlForPath()` を呼び、埋まる `stageName` が
   * `AWS::ApiGateway::Stage` の `Ref` のため、Lambda → Stage → Method → 統合先 Lambda の
   * 循環参照になる。`restApiId`（RestApi 自身の参照。Method/Deployment/Stage を経由しない）
   * から組み立てることで Lambda → RestApi の一方向で閉じる。
   *
   * 本 PoC では Lambda が自分の API を叩く経路が無いため、この getter は `GET /config` の
   * 自己記述用途に留まり循環は発生しないが、参考との地続き感のため提供する（design §4.4）。
   */
  get urlForLambdaEnvironment(): string {
    const { region, urlSuffix } = Stack.of(this.api);
    return `https://${this.api.restApiId}.execute-api.${region}.${urlSuffix}/${this.stageName}`;
  }
}
