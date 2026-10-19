# Requirements Document
SQS 付番バッチ処理 PoC（Streams → SQS ファンアウト・最大 1,000 多重）

## Introduction

Kiro Roasters（架空のスペシャルティコーヒー焙煎所）の「焙煎後の梱包バッチ処理」を題材に、
**DynamoDB Streams に滞留した個体（個包装）レコードを SQS で受け、付番ワーカー Lambda を
最大 1,000 多重まで張り付かせて捌けるか**を実測する。できるだけ本番運用に近いリアルさで構築する。

### 中心的な問い

焙煎が終わった 1 ロット分（約 1,000 個）の個包装を、同時に「付番（ラベリング）」したいとき、
非同期ファンアウト構成はどこまでスケールするのか。

1. DynamoDB Streams からの中継（入口）がボトルネックになるのか
2. SQS で受けた付番ワーカー Lambda の同時実行数は本当に 1,000 まで立ち上がるのか
3. 入口の実装方式（EventBridge Pipes / 中継 Lambda）で立ち上がりカーブに差が出るのか

この問いに答えるため、**入口だけを差し替えて同一の SQS・同一のワーカーにつなぎ、
同時実行数の立ち上がりカーブを観測する**という構成をとる。

### 参考構成との関係

本 PoC は、先行する DynamoDB Streams 直結 PoC
（`github.com/jus2024/serverless-poc-ec-site-ordering` の `.kiro/specs/order-pipeline-poc/`）が
示した「Streams 直結では同時実行が `S × P` に抑えられ、Lambda 枠 1,000 には届かない」という
結論を踏まえ、**SQS を挟んで入口の制約を外したときに同時実行枠まで到達できるか**を見に行く位置づけである。
したがって本 PoC の主役は「SQS ファンアウト」と「付番ワーカーの多重制御」であり、
記事の主眼は画面 B（付番開始）と画面 C（付番進捗モニタ）にある。

### 前提と読み替え

本リポジトリは Amplify Gen 2 の業務 Web アプリテンプレートである。参考リポジトリの CDK 前提を
以下のとおり読み替える（`.kiro/steering/structure.md` / `amplify-backend.md` に従う）。

| # | 読み替え前 | 本 Spec での扱い | 理由 |
|---|-----------|----------------|------|
| 1 | 独立した CDK リポジトリ | IaC は `amplify/custom/`（L2 Construct 分割）、Lambda ハンドラは `amplify/functions/`、フロントは `src/` に置く | テンプレートの構成規約を維持する |
| 2 | CDK context / stack parameter による切り替え | 環境変数 `RELAY_MODE`（`pipes` / `lambda` / `both`）で切り替える | `ampx sandbox` に `--context` が届かないため、環境変数が唯一の経路 |
| 3 | `npx cdk deploy` で完結 | `npx ampx sandbox`（開発）/ Amplify Hosting（本番）に読み替える | Amplify Gen 2 バックエンドは内部で CDK を使う |
| 4 | エンドユーザー認証なし | 検証用フロント 4 画面を Cognito User Pool 認証配下に置く | 既存テンプレートの auth を活用し、本番運用に近づける |

### 検証リソースの前提

- AWS アカウントが利用可能で、リージョンは `ap-northeast-1` を使う。
- Lambda 同時実行枠がデフォルト 1,000 であること（引き上げ申請はしない）。付番ワーカーの `MaximumConcurrency` 既定 1,000・最大 1,250。
- Node.js 22.x / npm がローカルにインストール済み。
- 検証は開発者自身の sandbox 環境で行う。
- 本 PoC で追加する検証用リソースはすべて `RemovalPolicy.DESTROY` とし、sandbox 削除で一括破棄できる。

## Glossary

| 用語 | 定義 |
|------|------|
| Lot（入荷ロット） | 生豆の入荷単位。ID 形式 `LOT#2026-10-01-003`。テーブルは作らず Unit から属性参照のみ |
| RoastBatch（焙煎バッチ） | 1 回の焙煎で生じる単位。ID 形式 `BATCH#2026-10-09-AM-01`。投入指示＋完了集計を保持 |
| Unit（個体＝個包装） | 付番対象の 1 袋。ID 形式 `UNIT#2026-10-09-AM-01-000742`。冪等キー |
| 付番（ラベリング） | Unit に賞味期限・QR ペイロードを計算して付与し `status=LABELED` にする処理 |
| seeder（投入役 Lambda） | 画面 B の [付番開始] で起動し、当該 batch の約 1,000 件の Unit を `PENDING` で一括 INSERT する検証トリガー |
| 方式 A-Pipes | Unit Streams → EventBridge Pipes → SQS の入口構成 |
| 方式 A-Lambda | Unit Streams → 中継 Lambda（labeling-router）→ SQS の入口構成 |
| 付番ワーカー | SQS をイベントソースとし 1 メッセージ＝1 個体を付番する Lambda（labeling-worker） |
| 滞留（backlog） | Streams / SQS に書かれたが未処理のレコード |
| `MaximumConcurrency` | SQS イベントソースマッピングの最大同時実行数設定 |
| `IteratorAge` | Streams を読む中継側の処理遅延指標 |
| 検証者 | この PoC を操作して計測する開発者 |

## スコープ

### 含む

| 区分 | 内容 |
|------|------|
| 基盤 | Unit テーブル（Streams 有効 / 2 GSI）、RoastBatch テーブル |
| 基盤 | seeder（約 1,000 件一括 INSERT）、SQS 標準キュー、付番ワーカー |
| 入口 | 方式 A-Pipes（EventBridge Pipes）、方式 A-Lambda（中継 Lambda） |
| 入口 | `RELAY_MODE` による入口の切り替え（pipes / lambda / both） |
| 可観測性 | CloudWatch ダッシュボード（同時実行 / キュー深度 / Throttle / IteratorAge / 書き込み容量） |
| フロント | 画面 A（バッチ登録）/ B（付番開始）/ C（付番進捗モニタ）/ D（個体トレース照会） |
| 認証 | 4 画面を Cognito User Pool 認証配下に置く |
| 共存 | 既存の auth / data（Todo モデル）を壊さずに共存させる |

### 含まない

| 除外対象 | 理由 |
|---------|------|
| FIFO キュー | 付番は順序不問。標準キューで足りる |
| 実際の QR 画像生成・印刷 | `qr_payload` 文字列の生成までを対象とする |
| Lambda 同時実行枠の引き上げ申請 | 既定 1,000 枠の中で張り付きを観測する |
| 既存 Todo モデルの機能拡張 | テンプレートのサンプルとして温存するのみ |
| エージェント機能（CopilotKit / AgentCore） | 本 PoC の対象外。既存構成は温存する |

## データモデル

Lot `1─<N` RoastBatch `1─<N` Unit の 3 階層。Lot はテーブルを作らず、Unit に `lot_id` 属性として持たせトレースする。
いずれも DynamoDB テーブルは命名接頭辞 `kiro-roasters-`、リージョン `ap-northeast-1`、
`BillingMode=PAY_PER_REQUEST`、`RemovalPolicy=DESTROY` とする。
Amplify Gen 2 の `data`（AppSync / Todo）とは別に、`amplify/custom/` の L2 Construct で定義する。

### テーブル 1: `kiro-roasters-unit`（主役・Streams で滞留する側）

| 属性 | 型 | キー | 説明 |
|------|-----|------|------|
| `unit_id` | String | PK（単独・SK なし） | `UNIT#...` 形式。冪等キー |
| `batch_id` | String | — | 所属する RoastBatch |
| `lot_id` | String | — | 由来の Lot（トレース用） |
| `item_id` | String | — | 商品 SKU（`ITEM#...`） |
| `seq` | Number | — | batch 内の連番 |
| `unit_count` | Number | — | 所属 batch の総個体数（完了検知のため batch から非正規化。design §3.1 / HIGH-1） |
| `roast_date` | String | — | 焙煎日（ISO 8601 日付） |
| `status` | String | — | `PENDING` → `LABELED` |
| `best_before` | String | — | 賞味期限（付番時に計算） |
| `qr_payload` | String | — | QR ペイロード（付番時に生成） |
| `created_at` | String | — | 作成時刻（ISO 8601） |
| `labeled_at` | String | — | 付番完了時刻（付番時にセット） |

- DynamoDB Streams: 有効、`StreamViewType=NEW_IMAGE`
- GSI1 `batch-units-index`: PK `batch_id` / SK `unit_id`
- GSI2 `lot-trace-index`: PK `lot_id` / SK `unit_id`

### テーブル 2: `kiro-roasters-roast-batch`（投入指示＋完了集計・Streams なし）

| 属性 | 型 | キー | 説明 |
|------|-----|------|------|
| `batch_id` | String | PK（単独・SK なし） | `BATCH#...` 形式 |
| `item_id` | String | — | 商品 SKU |
| `lot_id` | String | — | 由来の Lot |
| `roast_date` | String | — | 焙煎日 |
| `unit_count` | Number | — | 投入予定の個体数（約 1,000） |
| `labeled_count` | Number | — | 付番済み個体数 |
| `status` | String | — | `ROASTING_DONE` → `LABELING` → `LABELED` |
| `labeling_started_at` | String | — | 付番開始時刻 |
| `labeling_finished_at` | String | — | 付番完了時刻 |
| `created_at` | String | — | 作成時刻 |

## SQS メッセージペイロード（約 250 バイト）

```json
{
  "unit_id": "UNIT#2026-10-09-AM-01-000742",
  "batch_id": "BATCH#2026-10-09-AM-01",
  "lot_id": "LOT#2026-10-01-003",
  "item_id": "ITEM#ETH-YIRG-G1-MEDIUM-DRIP",
  "seq": 742,
  "unit_count": 1000,
  "roast_date": "2026-10-09"
}
```

冪等キー `unit_id` をメッセージに含め、ワーカーは条件付き書き込みにそのまま使う。1 レコード＝1 メッセージ。
`unit_count` は worker の完了検知（`labeled_count = unit_count`）が追加読み取りなしに参照するため含める（design §3.4 / HIGH-1）。

---

## Requirements

本 PoC の受け入れ基準は EARS 形式で記述する。参考依頼の R1〜R5 を骨格とし、
ドメイン・リソース・画面・制約の要件を要件 1〜11 に展開する。各要件末尾に R1〜R5 への対応を記す。

### 要件 1: 滞留生成（seeder による一括 INSERT）【R1】

**ユーザーストーリー:** 検証者として、1 バッチ分の個体を一気に `PENDING` で滞留させたい。それにより Streams 起点の付番フローに負荷を与えて観測できる。

#### 受入基準

1. WHEN 画面 B で [付番開始] が実行される THEN システムは当該 batch の seeder（投入役 Lambda）を起動する。
2. WHEN seeder が起動する THEN システムは当該 batch の `unit_count` 件（約 1,000 件）の Unit を `status=PENDING` で `kiro-roasters-unit` に一括 INSERT する。
3. THE seeder SHALL `BatchWriteItem` を 1 回あたり 25 件（約 40 回）で分割して一括 INSERT する。
4. WHEN 一括 INSERT が完了する THEN システムは当該 `roast-batch.status` を `LABELING` に更新し、`labeling_started_at` をセットする。
5. THE 各 Unit SHALL `unit_id` を一意に採番し、`batch_id` / `lot_id` / `item_id` / `seq` / `roast_date` / `created_at` を INSERT 時に設定する。
6. WHEN Unit が INSERT される THEN 当該イベントは DynamoDB Streams（`NEW_IMAGE`）に `eventName=INSERT` として発行される。
7. IF `BatchWriteItem` が `UnprocessedItems` を返す THEN システムは当該未処理分を再送し、全件が書き込まれるまで試行する。
8. THE seeder SHALL 画面 B からの起動トリガーとして動作する検証用リソースであり、エンドユーザー向け機能ではない。

*対応:* R1。

### 要件 2: 中継（入口・両方式）【R2】

**ユーザーストーリー:** 検証者として、Streams の INSERT だけを SQS に転送したい。それにより入口の実装方式を差し替えて立ち上がりを比較できる。

#### 受入基準

1. THE システム SHALL `kiro-roasters-unit` の Streams を入口として、`eventName=INSERT` のレコードだけを SQS に転送する。
2. THE システム SHALL INSERT 以外（`MODIFY` / `REMOVE`）のレコードを SQS に転送しない。
3. THE 転送 SHALL 1 レコード＝1 メッセージとし、メッセージ本文は「SQS メッセージペイロード」の形式とする。
4. THE 方式 A-Pipes SHALL EventBridge Pipes を用いて Unit Streams を source、SQS を target とし、フィルタ `eventName=INSERT` を適用する。
5. THE 方式 A-Lambda（中継 Lambda `labeling-router`）SHALL Unit Streams をイベントソースマッピングで読み、`eventName=INSERT` をコードでガードし、`SendMessageBatch` で SQS に転送する。
6. THE 両方式 SHALL 同一の SQS キュー（`kiro-roasters-labeling`）および同一の付番ワーカーに接続する。
7. THE 入口の有効化 SHALL 環境変数 `RELAY_MODE` で切り替えられる（`pipes` / `lambda` / `both`）。
8. WHEN `RELAY_MODE=both` が指定される THEN 両方式が同時に有効になり、入口が二重になり得ることを設計で明示する（比較用途に限る）。
9. WHEN `RELAY_MODE` が許容値以外である THEN システムは既定値に黙って落ちず、合成（デプロイ）を失敗させる。
10. THE メッセージ本文 SHALL 冪等キー `unit_id` を含み、ワーカーがそのまま条件付き書き込みに使える。

*対応:* R2。

### 要件 3: 付番（付番ワーカー）【R3】

**ユーザーストーリー:** 検証者として、SQS から受けた個体を 1 件ずつ確実に付番したい。それにより二重付番なく大量個体を捌けるか観測できる。

#### 受入基準

1. THE 付番ワーカー（`labeling-worker`）SHALL SQS をイベントソースとし、1 メッセージ＝1 個体を処理する。
2. WHEN メッセージを処理する THEN システムは `best_before = roast_date + 365 日` を計算する。
3. WHEN メッセージを処理する THEN システムは `qr_payload` を生成する。
4. THE 付番 SHALL `kiro-roasters-unit` に対する `UpdateItem` で `status=LABELED`、`best_before`、`qr_payload`、`labeled_at` をセットする。
5. THE `UpdateItem` SHALL `ConditionExpression attribute_not_exists(best_before)` を付け、二重付番（2 回目の処理）を弾く。
6. WHEN 条件付き書き込みが成功した THEN システムは `roast-batch.labeled_count` を `ADD 1` で加算する。
7. WHEN 条件が満たされず書き込みが弾かれた（既に付番済み）THEN システムは `labeled_count` を加算せず、当該メッセージを正常終了として扱う。
8. THE ワーカー SHALL メッセージ内の `unit_id` を冪等キーとしてそのまま使う。
9. IF メッセージの処理が付番条件以外の理由（スロットル・一時障害など）で失敗する THEN システムは当該メッセージを再試行対象として報告する。

*対応:* R3。

### 要件 4: 完了検知（集計の確定）【R4】

**ユーザーストーリー:** 検証者として、バッチ全体の付番完了を正確に 1 回だけ確定したい。それにより進捗の見かけ（キュー深度）に惑わされず完了を判定できる。

#### 受入基準

1. WHEN `roast-batch.labeled_count` が `unit_count` に達した THEN システムは当該 `roast-batch.status` を `LABELED` に更新し、`labeling_finished_at` をセットする。
2. THE 完了確定の `UpdateItem` SHALL `ConditionExpression labeled_count = :n AND status = :labeling` を付け、ちょうど 1 件の処理だけが完了遷移を行う。
3. THE 完了判定 SHALL SQS のキュー深度に依存せず、`labeled_count == unit_count` のみを根拠とする。
4. WHEN 既に `status=LABELED` に遷移済みのバッチに対し完了遷移が再度試みられる THEN 条件により弾かれ、`labeling_finished_at` は上書きされない。

*対応:* R4。

### 要件 5: スケール（最大 1,000 多重の張り付き）【R5】

**ユーザーストーリー:** 検証者として、付番ワーカーの同時実行数を 1,000 まで張り付かせたい。それにより SQS ファンアウトが同時実行枠まで到達できることを数字で示せる。

#### 受入基準

1. THE 付番ワーカー SHALL SQS イベントソースマッピングの `MaximumConcurrency` で多重数を制御する（既定 1,000・最大 1,250）。
2. WHEN 約 1,000 件が SQS に投入される THEN システムは `ConcurrentExecutions` を最大 1,000 まで到達させ得る。
3. THE 構成 SHALL `MaximumConcurrency=1000` のとき同時実行をその上限付近に張り付かせられる。
4. THE 検証 SHALL 同時実行数の立ち上がりカーブ（0 → 上限への遷移）を CloudWatch で観測可能にする。
5. THE 入口方式（pipes / lambda）の違い SHALL 立ち上がりカーブの比較対象として観測できる。

*対応:* R5。

### 要件 6: SQS 標準キュー

**ユーザーストーリー:** 検証者として、両方式が共用する 1 本のキューが欲しい。それにより入口だけ差し替えて同一条件で比較できる。

#### 受入基準

1. THE システム SHALL `kiro-roasters-labeling` という標準キュー（順序不問・FIFO 不要）を 1 本作成する。
2. THE キュー SHALL `QueueEncryption.SQS_MANAGED` を設定する。
3. THE キュー SHALL `enforceSSL`（HTTPS 以外の送受信を拒否）を有効にする。
4. THE キュー SHALL `RemovalPolicy.DESTROY` とする。
5. THE キュー SHALL 方式 A-Pipes・方式 A-Lambda の両方から送信され、付番ワーカーが唯一の受信者となる。

### 要件 7: 可観測性（CloudWatch ダッシュボード）

**ユーザーストーリー:** 検証者として、張り付きの瞬間と限界をグラフで見たい。それにより比較結果を実測データで裏付けられる。

#### 受入基準

1. THE システム SHALL CloudWatch ダッシュボードで付番ワーカーの `ConcurrentExecutions` を可視化する。
2. THE ダッシュボード SHALL SQS キューの深度（可視・処理中メッセージ数）を可視化する。
3. THE ダッシュボード SHALL 付番ワーカーの `Throttles` を可視化する。
4. THE ダッシュボード SHALL 中継側の `IteratorAge`（Streams 読み取り遅延）を可視化する。
5. THE ダッシュボード SHALL `kiro-roasters-unit` テーブルの `WriteThrottleEvents` と `ConsumedWriteCapacity` を可視化する。
6. THE ダッシュボード SHALL IaC（`amplify/custom/`）で定義され、手作業での作成を必要としない。

### 要件 8: 画面 A（バッチ登録）

**ユーザーストーリー:** 検証者として、焙煎実績を 1 件登録したい。それにより付番対象のバッチを用意できる。

#### 受入基準

1. WHEN 画面 A で焙煎実績が登録される THEN システムは `kiro-roasters-roast-batch` に `PutItem` する。
2. THE 登録される RoastBatch SHALL `status=ROASTING_DONE` と `unit_count`（約 1,000）を含む。
3. THE 画面 A SHALL Cognito User Pool 認証配下でのみ操作できる。
4. THE 画面 A SHALL `item_id` / `lot_id` / `roast_date` を入力・設定できる。

### 要件 9: 画面 B（バッチ一覧・付番開始）

**ユーザーストーリー:** 検証者として、付番待ちのバッチを選んで付番を開始したい。それにより検証トリガーを引ける。

#### 受入基準

1. THE 画面 B SHALL 付番待ち（`status=ROASTING_DONE`）のバッチ一覧を表示する。
2. WHEN バッチを選び [付番開始] を押す THEN システムは当該 batch の seeder を起動する（要件 1）。
3. THE 画面 B SHALL Cognito User Pool 認証配下でのみ操作できる。
4. THE [付番開始] SHALL 検証トリガーであることが検証者に分かる表示にする。

### 要件 10: 画面 C（付番進捗モニタ）

**ユーザーストーリー:** 検証者として、742/1000 のような進捗をリアルタイムで見たい。それにより張り付きの様子を業務の言葉で確認できる。

#### 受入基準

1. THE 画面 C SHALL `roast-batch` を 1〜2 秒間隔でポーリングし、進捗を `labeled_count / unit_count`（例: 742/1000）で表示する。
2. THE 進捗表示 SHALL SQS のキュー深度ではなく `labeled_count` を根拠とする。
3. THE 画面 C SHALL 稼働指標（同時実行の立ち上がり等）を併せて確認できる導線を持つ。
4. WHEN `status=LABELED` に遷移した THEN 画面 C は完了を表示する。
5. THE 画面 C SHALL Cognito User Pool 認証配下でのみ操作できる。

### 要件 11: 画面 D（個体トレース照会）

**ユーザーストーリー:** 検証者として、バッチやロットから個体を辿りたい。それにより付番結果をトレースできる。

#### 受入基準

1. WHEN batch を指定して照会する THEN システムは GSI1 `batch-units-index` を Query して当該 batch の Unit を返す。
2. WHEN lot を指定して照会する THEN システムは GSI2 `lot-trace-index` を Query して当該 lot の Unit を返す。
3. THE 照会結果 SHALL 各 Unit の `status` / `best_before` / `qr_payload` / `labeled_at` を含む。
4. THE 画面 D SHALL Cognito User Pool 認証配下でのみ操作できる。

### 要件 12: 既存構成との共存

**ユーザーストーリー:** 検証者として、本 PoC 追加で既存テンプレートを壊したくない。それにより sandbox が引き続き動く状態を保てる。

#### 受入基準

1. THE 本 PoC SHALL 既存の `amplify/auth/resource.ts`（Cognito）と `amplify/data/resource.ts`（Todo モデル / AppSync）を変更・削除しない。
2. THE 新規の DynamoDB テーブル・SQS・Lambda・Pipes・ダッシュボード SHALL `amplify/custom/` の L2 Construct と `amplify/functions/` のハンドラとして追加し、`amplify/backend.ts` で合成する。
3. THE 検証用リソース名 SHALL 既存の AppSync 管理リソース名と衝突しない（接頭辞 `kiro-roasters-`）。
4. WHEN 本 PoC を追加した状態で `npx ampx sandbox` を実行する THEN 既存の Todo モデルは引き続き動作する。
5. THE 検証用フロント 4 画面 SHALL トップページ（`src/app/page.tsx`）を主画面として構築し、サンプルページ（`src/app/sample/`）は参照用に温存する。
6. THE Python コード SHALL 追加しない（本 PoC のランタイムは TypeScript / Lambda(Node.js) で実装する）。

## Non-Functional Requirements

1. **リージョン / 課金:** 全リソースは `ap-northeast-1`、DynamoDB は `PAY_PER_REQUEST`。
2. **破棄容易性:** 検証用リソースは全て `RemovalPolicy.DESTROY`。sandbox 削除で一括破棄できる。
3. **最小権限:** seeder は Unit への書き込みと roast-batch 更新のみ、ワーカーは Unit 更新と roast-batch 加算のみ、画面 D 照会は読み取りのみに権限を絞る。
4. **セキュリティ:** シークレットをハードコードしない。SQS は `enforceSSL` と `SQS_MANAGED` 暗号化を必須とする。
5. **切り替えの明示:** `RELAY_MODE` など再デプロイが必要な設定と、現在有効な設定値を検証者が確認できる。
6. **構成規約の遵守:** IaC は `amplify/custom/`、Lambda は `amplify/functions/`、フロントは `src/`。構成の越境をしない。

## Acceptance Criteria（PoC 全体の合否・テスト可能）

1. [付番開始] 1 回で `unit_count` 件が `PENDING` で INSERT され、`roast-batch.status` が `LABELING` になり、各 INSERT が Streams（`NEW_IMAGE`）に乗る。（R1 / 要件 1）
2. `eventName=INSERT` のレコードだけが 1 レコード＝1 メッセージで SQS に届き、`MODIFY`/`REMOVE` は届かない。両方式が同一 SQS・同一ワーカーに接続している。（R2 / 要件 2・6）
3. 付番ワーカーが `best_before` 計算・`qr_payload` 生成・`status=LABELED` 付番を行い、同一 `unit_id` を 2 回処理しても `attribute_not_exists(best_before)` で 2 回目が弾かれ、`labeled_count` も二重加算されない。（R3 / 要件 3）
4. `labeled_count == unit_count` に達した時点でちょうど 1 回だけ `status=LABELED` と `labeling_finished_at` が確定し、キュー深度には依存しない。（R4 / 要件 4）
5. 約 1,000 件投入時に `MaximumConcurrency=1000` で `ConcurrentExecutions` が上限付近まで張り付き、立ち上がりカーブが CloudWatch で観測でき、入口方式ごとに比較できる。（R5 / 要件 5・7）
6. `RELAY_MODE` が `pipes` / `lambda` / `both` で入口を切り替えられ、許容値以外では合成が失敗する。（要件 2）
7. 本 PoC を追加した状態で `npx ampx sandbox` を実行しても、既存の auth（Cognito）と data（Todo モデル）が壊れず動作する。（要件 12）

## Out of Scope

- FIFO キュー、実際の QR 画像生成・印刷、実際のラベル印刷機連携。
- Lambda 同時実行枠の引き上げ申請（既定 1,000 枠内で検証）。
- エージェント機能（CopilotKit / AgentCore）の追加・変更。
- 既存 Todo モデルの機能拡張。
- Python ランタイムの追加。

## Assumptions（明示した前提）

- 参考依頼で「確定仕様（これが正）」とされた値（ID 形式、テーブル定義、属性、`RELAY_MODE`、`MaximumConcurrency` 既定 1,000・最大 1,250、ペイロード形式）は確定要件として扱った。
- 付番ワーカーの実装言語は、テンプレートの TypeScript ファースト方針と「Python は `agents/` 内のみ」という技術ルールに従い、Node.js Lambda とした。
- `best_before` は暦日 +365 日（うるう年の扱いは design で確定する）。
- seeder の起動経路（画面 B → API → Lambda 直接 Invoke か、キュー経由か）は design で確定する。本要件では「[付番開始] が seeder を起動する」ことのみを要求する。
- RoastBatch の読み取り（画面 B / C のポーリング、画面 D の GSI Query）を Cognito 認証配下でどの API 経由にするかは design で確定する。
