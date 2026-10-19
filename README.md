# 個体付番バッチ PoC（DynamoDB Streams → SQS ファンアウト・最大 1,000 多重）

架空のスペシャルティコーヒー焙煎メーカー **Kiro Roasters** の「焙煎後の梱包バッチ処理」を題材に、
**DynamoDB Streams に滞留した約 1,000 個の個体（個包装）を SQS でファンアウトし、付番ワーカー
Lambda を最大 1,000 多重まで張り付かせて一斉に捌けるか**を実測する検証プロジェクトです。

この検証装置は AWS Amplify Gen 2 業務 Web アプリのスターターテンプレートの上に載っており、
本 PoC のリソースは既存の auth（Cognito）/ data（Todo）とは別のネストスタック `SqsLabelingPoc`
に分離して共存します（既存の Todo / サンプルページは変更・削除しません）。テンプレート自体の
使い方は末尾の[テンプレートについて](#テンプレートについて)を参照してください。

## 2 層モード（業務モード / 検証モード）

トップページ（`src/app/page.tsx`）は **業務モード（既定）** と **検証モード** の 2 層ナビで
構成されます。両モードは常時マウントし表示だけを切り替えます（非表示側のモニタはポーリングを
止めて過剰ポーリングを抑止します）。

- **業務モード（既定）**: 現場オペレーター向けの業務 4 画面。Kiro Roasters のブランドヘッダー
  （`BrandIcon` + 店名）を先頭に出します。
  - **焙煎担当**: 焙煎計画（`PLANNED`）の一覧から、完了したバッチを複数選択で「焙煎完了を記録」する。
  - **梱包担当**: 付番待ち（`ROASTING_DONE`）/ 付番中（`LABELING`）の一覧。[付番開始]（= 約 1,000
    個体を一括投入する**検証トリガー**）とモニタ導線。
  - **ライン監督**: 付番モニタ。進捗（`labeled_count` ベース）・付番レート（件/分）・同時実行
    （pinned 1000 + `GET /config` の実値）・プリンタ能力 500 枚/分との大小でボトルネック判定。
  - **QC・出荷**: 出荷可能（`LABELED`）一覧と個体トレース（バッチ / ロット起点のリコール照会）。
- **検証モード**: 既存の付番検証ダッシュボード（画面 A〜D）。見た目・情報設計は従来どおり不変です。

### 業務フロー（起点 = 焙煎計画）

```
焙煎計画 SEED（PLANNED・初期データ）
  → 焙煎担当が複数選択で「焙煎完了を記録」 → ROASTING_DONE
    → 梱包担当が [付番開始]（検証トリガー）→ LABELING（約 1,000 個体を一括投入）
      → 付番ワーカーが多重処理 → LABELED
        → QC が出荷準備・個体トレース
```

焙煎計画は「既に存在するもの」という前提で、画面では入力せず **初期データ**として持ちます。
投入は専用 Lambda `plan-seeder` の手動 invoke で行います（[焙煎計画 SEED の投入](#焙煎計画-seed-の投入plan-seeder)）。

## 中心的な問い

1. Streams に滞留した個体を **SQS で受ければ、後続処理の同時実行を Streams のシャード数から
   切り離して 1,000 多重まで到達できるか**（Streams 直読みは `S × P` の壁で頭打ちになる、という
   姉妹 PoC の結果を受けた続編）。
2. Streams → SQS の**中継（入口）がボトルネックにならないか**。マネージドの EventBridge Pipes と
   自前の中継 Lambda の 2 方式を、同じ SQS・同じワーカーにつないで入口だけ差し替えて比較する。
3. 付番ワーカーが `MaximumConcurrency` まで本当に張り付くか、その**立ち上がりカーブ**はどう描くか。

```
最大同時実行数 ≈ min(MaximumConcurrency, 滞留した個体数)
```

**1 個体 = 1 レコード = 1 付番ジョブ**で粒度を人工的に砕いていないため、1 バッチの完成が
そのまま約 1,000 件の独立・順序不問なジョブを生みます（外部レート制限が無く 1,000 多重を素直に出せる）。

## ドメインモデル

```
Lot（生豆入荷ロット） 1 ──< N  RoastBatch（焙煎バッチ） 1 ──< N  Unit（個体＝個包装）
LOT#2026-10-01-003          BATCH#2026-10-09-AM-01            UNIT#2026-10-09-AM-01-000742
```

- **Unit**（`kiro-roasters-unit`）: Streams に滞留し 1,000 多重で付番される主役。PK は `unit_id` 単独
  （冪等キー）。GSI1 `batch-units-index`（バッチ内全個体）/ GSI2 `lot-trace-index`（ロット起点のトレース）。
  Streams は `NEW_IMAGE`、課金はオンデマンド。
- **RoastBatch**（`kiro-roasters-roast-batch`）: 投入指示と完了集計。PK は `batch_id` 単独。
  `unit_count`（投入数）と `labeled_count`（付番完了数）で完了を判定する。Streams なし。
  status は業務フローに沿って `PLANNED`（焙煎前・焙煎計画）→ `ROASTING_DONE`（焙煎完了・付番待ち）
  → `LABELING`（付番中）→ `LABELED`（付番完了）の 4 値。`PLANNED → ROASTING_DONE` は焙煎担当画面
  からの一括記録 API（`POST /batches/roasting-complete`）が roast-batch への条件付き `UpdateItem`
  のみで行い、Unit テーブル（Streams）には一切波及しません。
- **Lot**: 参照のみ（テーブルは作らず Unit の属性として持つ）。

## 構成図

```
[画面 A] バッチ登録 ──PutItem──▶ kiro-roasters-roast-batch (Streams なし)
                                        ▲ labeled_count 加算 / 完了遷移
[画面 B] 付番開始 ──POST /batches/{id}/labeling-start──▶ labeling-api
                       └─条件付き遷移 ROASTING_DONE→LABELING（同期・二重起動抑止）
                       └─(条件成功時のみ非同期 invoke 202)─▶ seeder ──BatchWriteItem×40──▶ kiro-roasters-unit
                                                                                   │ Streams(NEW_IMAGE, INSERT)
                                     ┌─────────────────────────────────────────────┤
                                     │ RELAY_MODE=pipes            RELAY_MODE=lambda │
                                     ▼                                              ▼
                          EventBridge Pipes (filter INSERT)        labeling-router (ESM, INSERT ガード)
                                     │  SendMessage                        │ SendMessageBatch
                                     └──────────────▶ kiro-roasters-labeling (SQS 標準) ◀────┘
                                                            │ SqsEventSource(MaximumConcurrency=1000)
                                                            ▼
                                                   labeling-worker ──UpdateItem(条件付き)──▶ kiro-roasters-unit
                                                            └──ADD labeled_count / 完了遷移──▶ roast-batch
[画面 C] 進捗モニタ ──GET /batches/{id}──(1〜2秒ポーリング)──▶ labeling-api (roast-batch 読み取り)
[画面 D] トレース照会 ──GET /units?batchId= / ?lotId=──▶ labeling-api (GSI Query)
可観測性: CloudWatch Dashboard / Alarms / SNS（labeling-worker の ConcurrentExecutions 等）
```

- 入口は `RELAY_MODE` で `pipes`（EventBridge Pipes）/ `lambda`（labeling-router）/ `both`（両方）を選びます。
- `both` の二重配信は worker の冪等条件（条件付き `UpdateItem`）で吸収され、`labeled_count` も二重加算されません。
- 完了は **キュー深度ではなく `labeled_count == unit_count`** で判定します（深度 0 でも処理中が残りうるため）。
- 画面 A〜D はトップページ（`src/app/page.tsx`）のタブ構成ダッシュボードです。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js（App Router）+ TypeScript |
| 検証バックエンド | Amplify Gen 2 カスタムスタック（CDK L2 Construct） |
| データ | DynamoDB（Unit: Streams `NEW_IMAGE` + GSI 2 本 / RoastBatch）、オンデマンド課金 |
| メッセージング | EventBridge Pipes / SQS 標準キュー / Lambda SQS イベントソース |
| 認証 | Amazon Cognito User Pool（既存 auth と共用。全画面が `<Authenticator>` 配下） |
| 可観測性 | CloudWatch Dashboard / Alarms / SNS |
| ホスティング | Amplify Hosting |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## ディレクトリ構成（本 PoC の範囲）

```
amplify/
  custom/                 # 検証リソースの L2 CDK Construct（ネストスタック SqsLabelingPoc）
    verification-config.ts  #  検証パラメータの解決・範囲検証（RELAY_MODE / MaximumConcurrency 等）
    labeling-tables.ts      #  Unit（Streams + GSI 2 本）/ RoastBatch テーブル
    labeling-functions.ts   #  seeder / router / worker / api の Lambda 定義と IAM
    labeling-stream.ts      #  Streams→(Pipes または router)→SQS→worker の配線
    labeling-api.ts         #  API Gateway（Cognito オーソライザー付き）
    labeling-monitoring.ts  #  CloudWatch ダッシュボード
    labeling-alarms.ts      #  アラーム + SNS トピック
  functions/
    seeder/               # 焙煎完成を模し Unit を約 1,000 件一括 INSERT
    plan-seeder/          # 焙煎計画 SEED（roast-batch に 10 件を PLANNED で投入・手動 invoke）
    labeling-router/      # 中継 Lambda（Streams ESM → SQS、INSERT ガード）
    labeling-worker/      # 付番ワーカー（冪等 UpdateItem・完了検知）
    labeling-api/         # 画面 A〜D + 焙煎完了一括記録（POST /batches/roasting-complete）
    shared/               # 共有モジュール（unit-keys / runtime-config / ddb / http 等）
  backend.ts              # createStack('SqsLabelingPoc') で検証スタックを分離・配線
src/
  app/page.tsx            # トップページ = 業務モード（既定）/ 検証モードの 2 層ダッシュボード
  app/icon.png            # ファビコン（public/brand の 256 版をコピー）
  components/common/      # BrandIcon（ブランドアイコン。業務モードヘッダーで使用）
  components/labeling/    # 検証 A〜D + ModeSwitcher
    business/             #   業務 4 画面（焙煎担当 / 梱包担当 / ライン監督 / QC）
  lib/labeling/           # API クライアント・進捗算術・製品マスタ・稼働メトリクス
public/brand/             # ブランドアセット（kiro-roasters-icon-256.png / kiro-roasters-icon.png）
.kiro/specs/sqs-labeling-poc/   # requirements / design / tasks（仕様駆動の成果物）
```

> 本 PoC は既存テンプレート（`src/app/sample/`、`agents/`、`src/components/agent/` など）を温存した
> まま共存します。テンプレート部分の構成は[テンプレートについて](#テンプレートについて)を参照。

## セットアップ

```bash
# 1. 依存をインストール（vitest などの検証用依存を含む）
npm install

# 2. Amplify sandbox を起動（SqsLabelingPoc スタックを合成・デプロイ）
npx ampx sandbox
```

`npx ampx sandbox` が生成する `amplify_outputs.json` の `custom.labelingApiUrl`（API Gateway の
エンドポイント）を、フロントの環境変数 `NEXT_PUBLIC_LABELING_API_URL` に写します。

```bash
# .env.local に API エンドポイントを設定（値は amplify_outputs.json の custom.labelingApiUrl）
# NEXT_PUBLIC_LABELING_API_URL=https://xxxxxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod
```

```bash
# 3. 開発サーバーを起動
npm run dev
```

`http://localhost:3000` にログイン（Cognito）すると業務モード（既定）のダッシュボードが開きます。
検証モードはモード切替タブで表示できます。

> `amplify_outputs.json` は sandbox が生成するローカルファイルでコミット対象外です。
> `.env.local` も同様にコミットしません（シークレットや環境固有値をリポジトリに含めない）。

### 焙煎計画 SEED の投入（plan-seeder）

業務フローの起点である焙煎計画は初期データとして持ちます。デプロイ後、専用 Lambda
`plan-seeder` を**手動 invoke** して roast-batch に 10 件（`status=PLANNED`）を投入します。
固定 `batch_id` と各レコードの条件付き `PutItem`（`attribute_not_exists(batch_id)`）により
**冪等**で、再投入しても既存の進行中状態を巻き戻しません（Unit テーブルには触れないため
Streams 流入はゼロ）。

```bash
# 物理関数名のサフィックスはデプロイ出力（スタックの関数一覧）で確認する
aws lambda invoke \
  --function-name kiro-roasters-labeling-plan-seeder-<suffix> \
  --payload '{}' /dev/stdout
# 戻り値 { "inserted": [...], "skipped": [...] } で投入結果を確認できる
```

投入後、業務モードの焙煎担当画面に `PLANNED` のバッチが並び、焙煎完了の記録ができます。
シークレットはコード/ペイロードに含めません（テーブル名は環境変数、認証は Lambda 実行ロール）。

### ブランドアセット

業務モードは Kiro Roasters のブランド（ヘッダーの `BrandIcon`・差し替え済みファビコン）を使います。
画像の実体は 3 箇所に配置しており、差し替え時は三者を揃えて更新してください。

| パス | 用途 |
|------|------|
| `public/brand/kiro-roasters-icon-256.png` | Web 表示用の軽量版（`BrandIcon` が参照） |
| `public/brand/kiro-roasters-icon.png` | 高解像度版（元データ・再書き出し用） |
| `src/app/icon.png` | ファビコン（256 版をコピー） |

## 検証シナリオ

1. `RELAY_MODE` を選んで `npx ampx sandbox`（まず合成が通ることを確認する）。
2. 画面 A で RoastBatch を 1 件登録する（`unit_count≈1000`、`status=ROASTING_DONE`）。
3. 画面 B で [付番開始] → seeder が非同期起動（即 202）→ 約 1,000 件が PENDING で INSERT →
   `status=LABELING` に遷移する。
4. Streams（INSERT）→ 入口（pipes/lambda）→ SQS → worker が多重起動する。
   CloudWatch ダッシュボードで worker の `ConcurrentExecutions` が `MaximumConcurrency`
   付近に張り付くこと、その立ち上がりカーブを観測する（R5）。

   **Pipes の文字列射影を実機で突き合わせる 3 境界ケース:**
   `RELAY_MODE=pipes` / `both` のとき、Pipes `inputTemplate` が組み立てた `unit_id` が
   `buildUnitId`（`shared/unit-keys.ts`）と完全一致することを、SQS 受信メッセージ（または worker ログ）で
   以下 3 ケース突き合わせる。
   - `seq=1` → サフィックスが `-000001`（ゼロ埋め先頭）
   - `seq=unit_count` → サフィックスが桁境界（例 `-001000`）
   - `BATCH#` を剥がした本体部分が一致（`unit_id` の衝突・不一致が無い＝ worker の冪等条件が効く）

   あわせて SQS 受信ペイロードの `unit_count` が JSON の数値（Number）のまま保たれていること
   （文字列化されると worker の `labeled_count = :n` 比較で型不一致になり得る）を確認する。
5. 画面 C で `labeled_count/unit_count` が増え、達成で `status=LABELED`・`labeling_finished_at` が確定する。
6. 画面 D で batch / lot から Unit をトレースする（`best_before` / `qr_payload` / `labeled_at`）。
7. `RELAY_MODE` を変えて再デプロイし、入口方式の立ち上がりカーブを比較する（R5）。
8. 複数バッチ同時は 2〜4 を複数バッチで相次いで実行する。
9. 検証後は sandbox 削除で `SqsLabelingPoc` スタックごと一括破棄する（既存 Todo は温存）。

> 1,000 多重の張り付き（R5）と Pipes `inputTemplate` の文字列射影は、sandbox 実機でしか確認できません
> （ローカル / CI の自動テスト対象外）。

## 受け入れ基準（EARS）

| ID | 要件 | 実装の要点 |
|----|------|-----------|
| R1 | 滞留の生成 | 画面 B の付番開始で `unit_count` 件を `PENDING` で一括 INSERT、`status=LABELING` に遷移、INSERT を Streams（`NEW_IMAGE`）に乗せる |
| R2 | 中継（Streams → SQS） | `eventName=INSERT` のみを 1 レコード = 1 メッセージで転送。INSERT 以外は転送しない（再発火防止）。両方式を同一 SQS・同一ワーカーに接続 |
| R3 | 付番（消費） | `best_before = roast_date + 365日` 計算、`qr_payload` 生成、`UpdateItem` で付番。`attribute_not_exists(best_before)` で二重付番を弾き、成功時のみ `labeled_count` を `ADD 1` |
| R4 | 完了検知 | `labeled_count == unit_count` で `status=LABELED`・`labeling_finished_at`。キュー深度に依存しない。`:n = unit_count` 固定・単調増加・status ガードでちょうど 1 回だけ成立 |
| R5 | スケール | `ConcurrentExecutions` を最大 1,000 まで到達、`MaximumConcurrency=1000` で張り付かせる。立ち上がりカーブを観測 |

詳細な要件・設計・タスクは [`.kiro/specs/sqs-labeling-poc/`](.kiro/specs/sqs-labeling-poc/) にあります。
実機の検証結果（R1〜R5・立ち上がりカーブ T1・オンデマンドのスロットル T2・実機で見つけた不具合）は
[`docs/poc/verification-results.md`](docs/poc/verification-results.md) に記録しています（随時追記）。

## 開発・検証コマンド

```bash
npm run lint          # eslint
npx tsc --noEmit      # 型チェック（フロント）
npx vitest --run      # ユニットテスト + CDK 合成アサーション（Template.fromStack）
```

- CDK の検証は `aws-cdk-lib/assertions` の `Template.fromStack` による合成アサーションで行います
  （`npx ampx sandbox` の実デプロイに頼らず、ローカル / CI で構成を検査する）。
- Lambda の純粋ロジック（`best_before` 計算 / `qr_payload` / 冪等条件 / 完了検知カウンタ / `unit_id` 採番）
  と、フロントの API クライアント（`#` を含む `batchId` のエンコード等）をユニットテストで固定しています。

## クリーンアップ

```bash
npx ampx sandbox delete
```

sandbox 削除で本 PoC のネストスタック `SqsLabelingPoc`（Unit / RoastBatch テーブル、SQS、
Lambda、Pipes、ダッシュボード、アラーム）が一括破棄されます（全リソース `RemovalPolicy.DESTROY`）。
既存の auth（Cognito）/ data（Todo）は別スタックのため温存されます。

> **検証していない期間はスタックを削除してください。** オンデマンド課金のため、投入時・付番時に
> 瞬間的に書き込みがスパイクします。放置課金を避けるため、使わないときは削除します。

## デプロイ影響

- **業務モード追加の影響レイヤーはフロント / Amplify バックエンド / ドキュメントに閉じ、
  検証コアは未変更です。** 追加は PLANNED ステータス・焙煎完了一括記録 API
  （`POST /batches/roasting-complete`）・独立した `plan-seeder`・業務 4 画面と 2 層ナビです。
  Streams → SQS → worker の 1,000 多重、入口 2 方式（Pipes / router）、`MaximumConcurrency` の
  定義には一切手を入れていません。`PLANNED → ROASTING_DONE` は roast-batch への条件付き
  `UpdateItem` のみで、Unit テーブル（Streams）・SQS・worker には波及しません。
- **CI のみに影響し、Amplify Hosting / AgentCore には波及しません。** 本 PoC では CI の
  `setup-node` を Node.js 22 に引き上げ（Lambda ランタイム 22.x と揃える）、vitest による
  テスト実行を CI に追加します。Web アプリのホスティングやエージェント実行基盤の構成は変わりません。
- **`RELAY_MODE` の切替は再デプロイが必要です。** 入口方式の切替は環境変数 `RELAY_MODE`
  （`pipes` / `lambda` / `both`）が唯一の経路で、合成時に入口を決めます。値を変えたら
  `npx ampx sandbox` を再実行して反映します。
  - `pipes`: EventBridge Pipes が Streams → SQS を中継する
  - `lambda`: labeling-router（Lambda）が Streams → SQS を中継する
  - `both`: 両方を有効化する（二重配信は worker の冪等条件で吸収）
- **`PROCESSING_TIME_MS`（worker の擬似処理時間、ミリ秒。既定 0）で 1000 多重の立ち上げを制御します。**
  worker は本来 1 件 ~80ms で終わるため、1 バッチ程度では SQS→Lambda のスケール（1 分あたり
  最大 60 インスタンス増）が立ち上がる前にキューが枯れ、`ConcurrentExecutions` が 1,000 に届きません。
  付番後に擬似 sleep を入れて 1 件の処理時間を延ばすと、リトルの法則（同時実行 ≒ 到着レート × 処理時間）で
  同じ件数でも多重度を押し上げられます。R5 / T1（1000 到達までのカーブ）の観測では
  `PROCESSING_TIME_MS=3000` 程度に設定し、`unit_count` を上限近く（または複数バッチ）で投入します。
  値は環境変数なので変更には再デプロイが必要です（`GET /config` で実デプロイ値を確認できます）。
- **seeder 失敗時の縮退挙動:** seeder が上限リトライを超過し一部 Unit を INSERT できなかった場合、
  `labeled_count` は `unit_count` に到達せず完了遷移は成立しません。画面 C は未完了のまま
  （キュー深度ではなく `labeled_count` 基準の正しい挙動）になります。再試行は batch を作り直してください。
  張り付きカーブの観測自体は取得できます。

## ブランチ戦略 / CI

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

| 対象 | 担当 | 方法 |
|------|------|------|
| 品質ゲート | GitHub Actions | lint、型チェック、vitest |
| Web デプロイ | Amplify Hosting | Git push で自動 |

---

## テンプレートについて

本リポジトリは **AWS Amplify Gen 2 業務 Web アプリのスターターテンプレート**の上に構築されています。
テンプレートは Next.js + TypeScript のフロント、Amplify Gen 2 のバックエンド（auth / data）、
サンプルの Todo CRUD、そしてオプションの Strands Agents による AI エージェント機能（CopilotKit +
AgentCore Runtime）を備えます。本 PoC はこれらを温存したまま共存します。

### サンプル（Todo CRUD）

`http://localhost:3000/sample` でテンプレート同梱の Todo リストが動きます（既存 data の `Todo`
モデルを使用、本 PoC の API とは独立）。ダッシュボードのナビからは外していますが、参照用に残しています。

### エージェント機能（任意）

AI エージェント機能を使う場合は AgentCore CLI でエージェントプロジェクトを作成します。

```bash
npm install -g @aws/agentcore   # 未インストールの場合
agentcore create                # Project name: agents / Language: Python / Protocol: AG-UI / Framework: Strands
```

ローカル確認（Docker が必要）:

```bash
cd agents
agentcore dev                   # http://localhost:8080/invocations
```

Web アプリとの結合はデプロイが前提です（SigV4 署名に Amplify Hosting のコンピューティングロールが
必要なため、ローカルでは結合テストできません）。接続の仕組みと手順は
[docs/deployment.md](docs/deployment.md) を参照してください。

```
ブラウザ (CopilotKit + Cognito トークン)
  → /api/copilotkit (Next.js API Route, Amplify Hosting SSR Lambda)
    → CopilotRuntime + ExperimentalEmptyAdapter
      → HttpAgent (SigV4 署名、コンピューティングロールの権限で署名)
        → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

エージェントのデプロイは `cd agents && agentcore deploy`、削除は `agentcore remove all --yes` です。

### Kiro + Agent Toolkit for AWS

[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws) の MCP サーバーを設定済みです。
Kiro から AWS ドキュメント検索、スキル検索、CLI 実行が利用できます。

### 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ詳細・前提条件 |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（Amplify + AgentCore + コンピューティングロール） |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro の steering/skills の使い方 |
| [docs/sample/](docs/sample/) | サンプルページの仕組み |
| [agents/README.md](agents/README.md) | エージェント開発の詳細 |
