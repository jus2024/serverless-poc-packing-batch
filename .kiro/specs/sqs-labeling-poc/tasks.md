# Implementation Plan
SQS 付番バッチ処理 PoC（Streams → SQS ファンアウト・最大 1,000 多重）

本計画は承認済み design.md（verdict: APPROVED / 第 4 ラウンド）と requirements.md（要件 1〜12 / R1〜R5）に
基づく、ファイル単位の実装計画である。各タスクは依存順に並べ、完了ごとにビルド可能な状態を保つ。
参照節は design.md の節番号。参考実装スタイルは EC PoC（`serverless-poc-ec-site-ordering` の
`order-*.ts` / `src/lib/orders/` / `src/components/orders/`）に揃える。

絶対パスの基点: `/Users/okamasa/dev/kiro-web-app-v2/serverless-poc-packing-batch/.worktrees/sqs-labeling-1000`
（以下パスはこの worktree 配下の相対表記）。

## 検証の前提（design §16 / §16.0）

- 最も狭い検証を最初に: 変更モジュールの vitest ユニットテスト → CDK 合成テスト（`Template.fromStack`）
  → `npx tsc --noEmit`（型） → `npm run lint`。
- 1,000 多重の実測（R5）・Pipes `inputTemplate` 文字列射影（NIT-1）は実機 sandbox でしか検証できず、
  本計画の自動検証対象外（§16 末尾 / §17）。
- フロントは lint + 型チェックを優先（testing 方針）。

---

## フェーズ 0: テスト基盤・依存・CI（他タスクの検証前提。最初に行う）

- [ ] 1. テスト基盤の devDependency 追加とスクリプト整備（design §16.0）。
      `vitest`・`@types/aws-lambda`・`aws-sdk-client-mock`・`aws-sdk-client-mock-jest` を
      **正確なバージョンピン止め**（キャレット無し）で `package.json` の `devDependencies` に追加。
      `scripts` に `"test": "vitest --run"` と `"test:watch": "vitest"` を追加（EC PoC の表記に合わせる）。
      リポジトリルートに `vitest.config.ts` を新設（node 環境、`amplify/**` と `src/**` の `*.test.ts` を対象、
      Next の `@/*` パスエイリアスを `tsconfig` から解決）。CDK 合成テストは同梱の `aws-cdk-lib/assertions` を使うため追加依存は不要。
      Files: `package.json`, `vitest.config.ts`
      Verify: `npm install` が成功し、`npx vitest --run` が「テスト 0 件」でエラーなく終了する。

- [ ] 2. CI の Node バージョンを 22 に引き上げ、テストステップを追加（design §16.0 / レビュー第 2R-2）。
      `.github/workflows/ci.yml` の `actions/setup-node` を `node-version: 22` に変更し、
      型チェックの後に `npm run test`（lint・型チェックと同一ワークフロー）ステップを追加する。
      実機デプロイを伴う結合テストは CI に含めない。
      Files: `.github/workflows/ci.yml`
      Verify: `npx yaml`相当は不要。`npm run lint` が通る状態で YAML の構造が壊れていないこと（目視 + CI 実行で確認）。ローカルでは `node -e "require('js-yaml')"` が無いため、構文は手動確認で足りる。

---

## フェーズ 1: shared/ 共通モジュール（全ハンドラの土台。純ロジック先行）

- [ ] 3. `shared/unit-keys.ts` を作成（design §3.4 / §6.6）。
      `unit_id` 採番の唯一の実装 `buildUnitId(batchId, seq)` を実装
      （`'UNIT#' + <BATCH# 接頭辞を除いた本体> + '-' + String(seq).padStart(6, '0')`、`seq` は 1 始まり・6 桁ゼロ埋め）。
      `batch_id` / `lot_id` のパースヘルパ（接頭辞剥がし）も併置。要件番号・設計節引用の日本語 JSDoc を付す。
      併せて `shared/unit-keys.test.ts` を作成（`seq=1`→`-000001`、`seq=1000`→`-001000`、`BATCH#` 剥がし、決定性）。
      Files: `amplify/functions/shared/unit-keys.ts`, `amplify/functions/shared/unit-keys.test.ts`
      Verify: `npx vitest --run amplify/functions/shared/unit-keys.test.ts` が全パス。

- [ ] 4. `shared/types.ts` を作成（design §3 / §3.4 / §6.6）。
      Unit / RoastBatch レコード型、SQS ペイロード型（`unit_id`/`batch_id`/`lot_id`/`item_id`/`seq`/
      `unit_count`/`roast_date`）、API 入出力型、`status` のリテラル union を定義。純型のみ（副作用なし）。
      Files: `amplify/functions/shared/types.ts`
      Verify: `npx tsc --noEmit`（amplify tsconfig 経由）で型エラーが出ないこと。

- [ ] 5. `shared/qr.ts` を作成（design §6.3-2 / §6.6）。
      `buildQrPayload({ unit_id, item_id, best_before })` = `JSON.stringify({ unit_id, item_id, best_before })`
      をキー順固定で実装（決定性）。`shared/qr.test.ts` で同一入力→同一文字列、キー順を検証。
      Files: `amplify/functions/shared/qr.ts`, `amplify/functions/shared/qr.test.ts`
      Verify: `npx vitest --run amplify/functions/shared/qr.test.ts` が全パス。

- [ ] 6. `shared/runtime-config.ts` を作成（design §4.1 の表 / §6.6 / 非機能 5）。
      環境変数（テーブル名・GSI 名・Streams ARN・検証パラメータ）を解決。範囲外・解釈不能は
      `RuntimeConfigError` を投げ既定に黙って読み替えない。キー名は `LABELING_UNIT_TABLE_NAME` /
      `LABELING_ROAST_BATCH_TABLE_NAME` / `LABELING_BATCH_UNITS_INDEX_NAME` / `LABELING_LOT_TRACE_INDEX_NAME` /
      `LABELING_UNIT_STREAM_ARN` ほか §4.1 表のキー。`shared/runtime-config.test.ts` で範囲内外・不正値を検証。
      Files: `amplify/functions/shared/runtime-config.ts`, `amplify/functions/shared/runtime-config.test.ts`
      Verify: `npx vitest --run amplify/functions/shared/runtime-config.test.ts` が全パス。

- [ ] 7. `shared/ddb.ts` と `shared/http.ts` を作成（design §6.6 / §13）。
      `ddb.ts`: `DynamoDBDocumentClient` シングルトン。`http.ts`: `ok` / `toErrorResponse`
      （`{ error, message, details? }`、400/401/404/409/500 の整形）/ `parseJsonBody` / CORS ヘッダー
      （`GET/POST/OPTIONS` + `Content-Type`/`Authorization`）。副作用境界は薄く保つ。
      Files: `amplify/functions/shared/ddb.ts`, `amplify/functions/shared/http.ts`
      Verify: `npx tsc --noEmit` が通る（これらは副作用モジュールのため型チェックで検証）。

---

## フェーズ 2: Lambda ハンドラ（純ロジックを隣接モジュールに分離しユニットテスト）

- [ ] 8. `seeder/` を作成（design §6.1 / 要件 1 / R1）。
      `seeder/seed-plan.ts`（純ロジック: `unit_count` 件の Unit 生成、各 Unit に batch の `unit_count` を
      非正規化、`buildUnitId` 採番、25 件チャンク化、`UnprocessedItems` 再送計画）と
      `seeder/handler.ts`（roast-batch `GetItem` → `BatchWriteItem` ×約40・指数バックオフ再送。状態遷移は持たない）、
      `seeder/resource.ts`（`defineFunction` 相当。15 分 / 512MB、Node 22）を実装。
      `seeder/seed-plan.test.ts` を併置。
      Files: `amplify/functions/seeder/seed-plan.ts`, `amplify/functions/seeder/handler.ts`, `amplify/functions/seeder/resource.ts`, `amplify/functions/seeder/seed-plan.test.ts`
      Verify: `npx vitest --run amplify/functions/seeder/seed-plan.test.ts` が全パス（Unit 生成に `unit_count` 非正規化・25 件分割・再送計画を含む）。

- [ ] 9. `labeling-router/` を作成（design §6.2 / 要件 2.5 / R2）。
      `labeling-router/to-message.ts`（純ロジック: Streams レコード→§3.4 ペイロード射影[`NewImage.unit_count` 含む]、
      `eventName=INSERT` 二次ガード、10 件チャンク化）と `handler.ts`（`SendMessageBatch`、
      `reportBatchItemFailures` で部分再試行）、`resource.ts`（5 分 / 256MB、Node 22）を実装。
      `labeling-router/to-message.test.ts` を併置（INSERT ガード・射影・チャンク化・`unit_count` 射影）。
      Files: `amplify/functions/labeling-router/to-message.ts`, `amplify/functions/labeling-router/handler.ts`, `amplify/functions/labeling-router/resource.ts`, `amplify/functions/labeling-router/to-message.test.ts`
      Verify: `npx vitest --run amplify/functions/labeling-router/to-message.test.ts` が全パス。

- [ ] 10. `labeling-worker/` を作成（design §6.3 / 要件 3〜5 / R3・R4・R5）。
      `labeling-worker/labeling.ts`（純ロジック: `best_before = roast_date + BEST_BEFORE_DAYS 日`[UTC 暦日加算、
      うるう年は Date 加算に委ねる]、`qr_payload` 生成[`shared/qr.ts`]、付番 `UpdateItem` 式の組み立て
      [`attribute_not_exists(best_before)`]、完了判定式[`labeled_count = :n AND status = :labeling`、
      `:n = payload.unit_count` 固定]）と `handler.ts`（unit `UpdateItem` → 成功時 roast-batch `ADD 1`
      [`ReturnValues=UPDATED_NEW`] → `labeled_count == unit_count` で完了遷移、`reportBatchItemFailures`）、
      `resource.ts`（60 秒 / 256MB、Node 22、`reservedConcurrentExecutions` 設定しない）を実装。
      `labeling-worker/labeling.test.ts` を併置（うるう年跨ぎ・条件式・完了判定の決定性）。
      Files: `amplify/functions/labeling-worker/labeling.ts`, `amplify/functions/labeling-worker/handler.ts`, `amplify/functions/labeling-worker/resource.ts`, `amplify/functions/labeling-worker/labeling.test.ts`
      Verify: `npx vitest --run amplify/functions/labeling-worker/labeling.test.ts` が全パス。

- [ ] 11. `labeling-api/` を作成（design §6.4 / §4.4 / 要件 8〜11）。
      `labeling-api/routes.ts`（純ロジック: `httpMethod`+`resource` のルーティング、入力検証[§14 の表:
      `item_id`/`lot_id`/`roast_date`/`unit_count` 既定 1000、`?status=` 既定 `ROASTING_DONE`・許容 3 値・
      許容外 400、`?batchId=`/`?lotId=` 排他]、`POST /labeling-start` の条件付き遷移ロジック
      [`ROASTING_DONE`→遷移+invoke / 既遷移→`ConditionalCheckFailed`→409・invoke しない]）と
      `handler.ts`（DDB 呼び出し: `PutItem`/`Scan`/`GetItem`/`UpdateItem`/GSI `Query`、seeder 非同期 invoke
      [`InvocationType=Event`]）、`resource.ts`（30 秒 / 256MB、Node 22）を実装。
      `labeling-api/routes.test.ts` を併置（ルーティング・入力検証・`?status=` 分岐・labeling-start の二重起動抑止）。
      Files: `amplify/functions/labeling-api/routes.ts`, `amplify/functions/labeling-api/handler.ts`, `amplify/functions/labeling-api/resource.ts`, `amplify/functions/labeling-api/routes.test.ts`
      Verify: `npx vitest --run amplify/functions/labeling-api/routes.test.ts` が全パス。

---

## フェーズ 3: amplify/custom/ L2 Construct（ハンドラとテーブルを配線。合成テストで検査）

各 Construct に要件番号・設計節を引用した詳細日本語 JSDoc（EC PoC の `order-*.ts` スタイル・「なぜその設定か」）を付す。

- [ ] 12. `verification-config.ts` を作成（design §4.1 / §9 / 要件 2.9 / 非機能 5）。
      `getVerificationConfig()`（キャッシュ付き・1 度だけ解決）と `VerificationConfigError` を実装。
      §4.1 表の全キー（`RELAY_MODE`[pipes/lambda/both]・`LABELING_MAX_CONCURRENCY`[2〜1250]・
      `LABELING_WORKER_BATCH_SIZE`[1〜10]・`ROUTER_BATCH_SIZE`[1〜1000]・`ROUTER_PARALLELIZATION_FACTOR`[1〜10]・
      `SEED_UNIT_COUNT_MAX`[1〜5000]・`BEST_BEFORE_DAYS`[1〜3650、既定 365]）を解決・範囲検証。
      `MaximumConcurrency` 下限 2 を自前検証して合成を失敗させる。許容外は全誤りをまとめて `VerificationConfigError`。
      `verification-config.test.ts` を併置（範囲内外・RELAY_MODE 3 値と不正値・既定・下限 2）。
      Files: `amplify/custom/verification-config.ts`, `amplify/custom/verification-config.test.ts`
      Verify: `npx vitest --run amplify/custom/verification-config.test.ts` が全パス。

- [ ] 13. `LabelingTables`（`labeling-tables.ts`）を作成（design §3 / §4.2 / 要件 12.2）。
      `TableV2` で unit（`partitionKey=unit_id`、`StreamViewType.NEW_IMAGE`、GSI1 `batch-units-index`[PK `batch_id`/
      SK `unit_id`、射影 ALL]、GSI2 `lot-trace-index`[PK `lot_id`/SK `unit_id`、射影 ALL]）/ roast-batch
      （`partitionKey=batch_id`、Streams なし・GSI なし）を定義。`Billing.onDemand()`・`RemovalPolicy.DESTROY`。
      物理名サフィックス（§3.3）。`get unitStreamArn()`（無効なら例外）・`get tableEnvironment()`（§4.2 のキー）を公開。
      Files: `amplify/custom/labeling-tables.ts`
      Verify: フェーズ 4 の合成テスト（タスク 19）で検査。本タスク単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

- [ ] 14. `LabelingFunctions`（`labeling-functions.ts`）を作成（design §6 / §6.5 / 要件 12.2）。
      seeder/router/worker/api の 4 ハンドラを `NodejsFunction`（Node 22、`externalModules=['@aws-sdk/*']`、
      `NODE_OPTIONS='--enable-source-maps'`）として束ね、テーブル環境変数（§4.2）と検証パラメータを注入。
      §6.5 の IAM を `grant*` を使わず `PolicyStatement` で手で絞る（seeder/router/worker/api 各権限）。
      `wireSeederInvoke(api)` で labeling-api に seeder の `lambda:InvokeFunction`（ARN 文字列限定）と環境変数を付与。
      Files: `amplify/custom/labeling-functions.ts`
      Verify: タスク 19 の合成テストで検査。単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

- [ ] 15. `LabelingApi`（`labeling-api.ts`）を作成（design §4.4 / §7 / 要件 8〜11）。
      REST API（`REGIONAL`、ステージ `poc`、CORS `GET/POST/OPTIONS`+`Content-Type`/`Authorization`）に
      `CognitoUserPoolsAuthorizer`（既存 `userPool` 参照）を掛け、§4.4 の 6 ルート（`POST /batches`・
      `GET /batches`・`GET /batches/{batchId}`・`POST /batches/{batchId}/labeling-start`・`GET /units`・`GET /config`）を
      labeling-api ハンドラに接続。OPTIONS を除く全ルートが `AuthorizationType.COGNITO`。
      `get url()` と `urlForLambdaEnvironment`（§4.4、循環回避）を公開。
      Files: `amplify/custom/labeling-api.ts`
      Verify: タスク 19 の合成テストで検査。単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

- [ ] 16. `LabelingStream`（`labeling-stream.ts`）を作成（design §4.3 / 要件 2・5・6 / R2・R5）。本 PoC の観測装置。
      (a) SQS 標準キュー `LabelingQueue`（§4.3.1: `SQS_MANAGED`・`enforceSSL`・`visibilityTimeout=360`・`DESTROY`・
      DLQ `maxReceiveCount=5`）、(b) 方式 A-Pipes（§4.3.2: `CfnPipe` source=unit Streams/target=SQS、
      filter `eventName=INSERT`、`inputTemplate` で §3.4 ペイロード[`NewImage.unit_count` 含む]を射影、最小権限ロール）、
      (c) 方式 A-Lambda（§4.3.3: router に `DynamoEventSource`、`startingPosition=LATEST`、INSERT フィルタ、
      `batchSize`/`parallelizationFactor`、`reportBatchItemFailures`/`retryAttempts=3`/`bisectBatchOnError`/`SqsDlq`）、
      (d) worker ESM（§4.3.4: `SqsEventSource`、`maxConcurrency=LABELING_MAX_CONCURRENCY`、`batchSize`、
      `reportBatchItemFailures`）を配線。`RELAY_MODE` 分岐（§4.3.5: pipes/lambda/both、both の二重配信は冪等吸収）を JSDoc 明記。
      Files: `amplify/custom/labeling-stream.ts`
      Verify: タスク 19 の合成テストで検査。単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

- [ ] 17. `LabelingMonitoring`（`labeling-monitoring.ts`）を作成（design §8.1 / 要件 7）。
      単一ダッシュボード（粒度 1 分固定）。最上段に worker `ConcurrentExecutions`（24 幅・MaxConcurrency/枠 1,000 注釈線）、
      以下 §8.1 の表のウィジェット（入口別 Invocations[`AWS/Pipes` と `AWS/Lambda`、both の分離不可注記]・SQS 深度・
      Throttles・IteratorAge・unit テーブル書き込み容量/スロットル[基表+GSI 2 本]・DLQ 深度）。
      ウィジェットタイトルは定数化（テストが design と突き合わせ）。読み方ヘッダーをテキスト配置。
      Files: `amplify/custom/labeling-monitoring.ts`
      Verify: タスク 19 の合成テストで検査。単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

- [ ] 18. `LabelingAlarms`（`labeling-alarms.ts`）を作成（design §8.2 / 要件 7）。
      SNS トピック（`enforceSSL`、購読は作らず `get topicArn()` を公開）とアラーム（worker スロットル>0[critical]・
      アカウント同時実行 80%[warning]・SQS/Streams DLQ メッセージ[warning]・SQS 深度長時間高止まり[warning]）。
      閾値はダッシュボードと共有してずれないようにする。
      Files: `amplify/custom/labeling-alarms.ts`
      Verify: タスク 19 の合成テストで検査。単体は `npx tsc -p amplify/tsconfig.json --noEmit` が通ること。

---

## フェーズ 4: backend.ts 合成と合成テスト

- [ ] 19. `backend.ts` を更新し CDK 合成テストを追加（design §10 / 要件 12）。
      既存 `defineBackend({ auth, data })` に対し `backend.createStack('SqsLabelingPoc')` でネストスタックを作り、
      `getVerificationConfig()` を 1 度解決して全 Construct に共有、`LabelingTables`→`LabelingFunctions`→
      `LabelingApi`（`backend.auth.resources.userPool` 参照）→`wireSeederInvoke`→`LabelingStream`→
      `LabelingMonitoring`→`LabelingAlarms` を配線。`backend.addOutput({ custom: { labelingApiUrl, alarmTopicArn,
      relayMode, labelingMaxConcurrency } })`。既存 auth/data（Todo, apiKey）は変更しない。
      合成テスト `amplify/custom/stack.test.ts` を追加（§16 の合成テスト項目: ESM/Pipes の INSERT フィルタ固定・
      worker `MaximumConcurrency` が config 反映・SQS が `SQS_MANAGED`+`enforceSSL`+`DESTROY`・全 API ルートに
      Cognito オーソライザー/OPTIONS は NONE・可視性 360 秒・`MaximumConcurrency=1` で合成失敗・全テーブル/キュー
      `DESTROY`・循環参照なし・合成/実行時キー名の突き合わせ）。
      Files: `amplify/backend.ts`, `amplify/custom/stack.test.ts`
      Verify: `npx vitest --run amplify/custom/stack.test.ts` が全パス。かつ `npx tsc -p amplify/tsconfig.json --noEmit` が通る。

---

## フェーズ 5: フロントエンド（src/。lint + 型チェック優先）

styling は CSS Modules + `@aws-amplify/ui-react`（design §11.1 の precedence 判断: ワークスペース steering 優先）。
アクセシビリティ（`<label htmlFor>`・`aria-invalid`/`aria-describedby`・`role="alert"`・focus-visible・キーボード・
レスポンシブ・最小タップ領域）はグローバル規約と同水準で満たす。

- [ ] 20. `src/lib/labeling/` API クライアントと進捗算術を作成（design §11.1 / §6.4 / 要件 8〜11）。
      `api.ts`（ベース URL = `NEXT_PUBLIC_LABELING_API_URL`、Cognito ID トークン付与、型付き例外 `LabelingApiFailure`
      [kind: CONFIG/REQUEST/NETWORK/HTTP]、6 ルート関数 `createBatch`/`listBatches`/`getBatch`/`startLabeling`/
      `listUnitsByBatch`/`listUnitsByLot`/`getConfig`、`#` を含む batchId を `encodeURIComponent` でパス/クエリ
      エンコード[§4.4 / MEDIUM-1]）、`progress.ts`（純関数: 百分率・完了判定・ETA 概算・直近増分）、
      `types.ts`（フロント用型）。`api.test.ts`（ベース URL 解決・エラー分類・ID トークン付与・`#` エンコード）と
      `progress.test.ts`（進捗率・完了判定・ETA）を併置。
      Files: `src/lib/labeling/api.ts`, `src/lib/labeling/progress.ts`, `src/lib/labeling/types.ts`, `src/lib/labeling/api.test.ts`, `src/lib/labeling/progress.test.ts`
      Verify: `npx vitest --run src/lib/labeling` が全パス。

- [ ] 21. `src/components/labeling/` の 4 画面 + ダッシュボード + ポーリングフックを作成（design §11.1〜11.5 / 要件 8〜11）。
      `LabelingDashboard`（4 画面を常時マウント・`hidden` でタブ切替、キーボード操作可能）、`BatchRegisterPanel`（画面 A）、
      `BatchListPanel`（画面 B: 一覧 + [付番開始]、検証トリガー注記）、`ProgressMonitorPanel`（画面 C: 進捗バー
      `labeled_count/unit_count`・完了表示・CloudWatch リンク誘導）、`UnitTracePanel`（画面 D: batch/lot 照会テーブル
      `status`/`best_before`/`qr_payload`/`labeled_at`）、`use-batch-polling.ts`（`GET /batches/{id}` を 1〜2 秒ポーリング、
      タブ離脱で止めない）、`labeling.module.css`。アクセシビリティ属性を全入力・ボタンに付す。
      `use-batch-polling` のポーリング停止条件のユニットテストを併置。
      Files: `src/components/labeling/LabelingDashboard.tsx`, `src/components/labeling/BatchRegisterPanel.tsx`, `src/components/labeling/BatchListPanel.tsx`, `src/components/labeling/ProgressMonitorPanel.tsx`, `src/components/labeling/UnitTracePanel.tsx`, `src/components/labeling/use-batch-polling.ts`, `src/components/labeling/use-batch-polling.test.ts`, `src/components/labeling/labeling.module.css`
      Verify: `npx vitest --run src/components/labeling` が全パス。かつ `npm run lint` が通る。

- [ ] 22. トップページを検証ダッシュボードに置換（design §11.1 / 要件 12.5 / structure 方針）。
      `src/app/page.tsx` を `LabelingDashboard` をマウントするタブ構成の検証ダッシュボードに置換。
      サンプルページ（`src/app/sample/`）は残すが、トップのナビから `/sample` リンクを外す。
      既存 `AmplifyProvider`（layout.tsx の `<Authenticator>` 配下）により 4 画面とも Cognito 認証配下で動作する。
      Files: `src/app/page.tsx`（必要なら `src/app/page.module.css`）
      Verify: `npm run lint` と `npx tsc --noEmit` が通る。トップに `/sample` リンクが無いこと（目視）。

---

## フェーズ 6: ドキュメント

- [ ] 23. `README.md` を更新（design §17 / 要件 12 / repo-workflow 方針）。
      構成図テキスト（§2.1 の全体像）、セットアップ（`npm install` → `npx ampx sandbox`、`NEXT_PUBLIC_LABELING_API_URL`
      の `.env.local` への写し方）、検証シナリオ（§17 の 1〜9・Pipes `unit_id`/`unit_count` 型の実機突き合わせ=NIT-1/NIT）、
      クリーンアップ（sandbox 削除で `SqsLabelingPoc` 一括破棄・既存 Todo 温存）、デプロイ影響（CI は node 22・テスト追加、
      Amplify Hosting/AgentCore 非波及）を記載。seeder 失敗時の縮退挙動（完了遷移成立せず・batch 作り直し。design-review NIT 2）も 1 行添える。
      Files: `README.md`
      Verify: `npm run lint`（Markdown は対象外のため）に影響しないこと。リンク・コードブロックの体裁を目視確認。

---

## 全体の最終検証（統合）

- [ ] 24. 統合検証（全フェーズ完了後）。
      Files: （なし。検証のみ）
      Verify: `npx vitest --run`（全ユニット + 合成テスト）が全パス、`npx tsc --noEmit`（ルート）と
      `npx tsc -p amplify/tsconfig.json --noEmit`（amplify）が型エラーなし、`npm run lint` がパス。
      実機（1,000 多重 R5・Pipes 文字列射影 NIT-1）は sandbox 検証に委ね、自動検証対象外であることを記録する。

---

## 依存関係メモ

- タスク 1（テスト基盤）は 3 以降の全ユニットテスト検証の前提。最初に行う。
- フェーズ 1（shared、3〜7）はフェーズ 2 の全ハンドラが依存。
- タスク 12（verification-config）はタスク 14/16/19 が依存。
- フェーズ 3（Construct、12〜18）はタスク 19（backend.ts 合成）が依存。
- フェーズ 5（フロント、20〜22）はバックエンドのデプロイ出力に実行時依存するが、型/lint/ユニットは独立に検証可能。
- タスク 23（README）・24（統合）は最後。
