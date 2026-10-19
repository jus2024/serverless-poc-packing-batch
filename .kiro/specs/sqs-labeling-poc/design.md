# Design Document
SQS 付番バッチ処理 PoC（Streams → SQS ファンアウト・最大 1,000 多重）

## 1. 概要

Kiro Roasters の「焙煎後の梱包バッチ処理」を題材に、**DynamoDB Streams に滞留した
個体（個包装）レコードを SQS で受け、付番ワーカー Lambda を最大 1,000 多重まで
張り付かせて捌けるか**を実測する検証環境の技術設計である。要件は
`.kiro/specs/sqs-labeling-poc/requirements.md`（要件 1〜12、R1〜R5）に対応する。

本 PoC は先行する DynamoDB Streams 直結 PoC
（`github.com/jus2024/serverless-poc-ec-site-ordering` の `order-pipeline-poc`）の
続編として位置づけられる。前作が示した「Streams 直結では同時実行が `S × P` に
抑えられ、Lambda 枠 1,000 には届かない」という結論を踏まえ、**SQS を挟んで入口の
制約を外したときに同時実行枠まで到達できるか**を見に行く。したがってシリーズとしての
地続き感・リアルさを保つため、**本設計は参考 EC PoC リポジトリの構成・コーディング
スタイル・コメント方針を忠実に踏襲する**。具体的には `amplify/custom/*.ts` に
L2 CDK Construct を機能ごとに分割し、各 Construct へ「なぜその設定か」を要件番号・
設計節つきの日本語 JSDoc で記す。参照したのは EC PoC の `order-tables.ts` /
`order-stream.ts` / `order-functions.ts` / `order-api.ts` / `order-monitoring.ts` /
`order-alarms.ts` / `verification-config.ts` / `backend.ts` と、
`src/lib/orders/` / `src/components/orders/` のフロント実装である。

本リポジトリは Amplify Gen 2 の業務 Web アプリテンプレートである。参考リポジトリの
独立 CDK 前提を、テンプレートの構成規約（`.kiro/steering/structure.md` /
`amplify-backend.md`）に合わせて読み替える。IaC は `amplify/custom/`（L2 Construct 分割）、
Lambda ハンドラは `amplify/functions/`、フロントは `src/` に置き、既存の auth（Cognito）/
data（Todo モデル / AppSync）とは別のネストスタックに分離して共存させる。

### 1.1 技術スタック（この設計で確定・承認後は固定）

| 層 | 技術 | 備考 |
|----|------|------|
| IaC | AWS CDK（Amplify Gen 2 内蔵）/ `aws-cdk-lib` v2 / TypeScript | `amplify/custom/*.ts` に L2 Construct 分割 |
| DynamoDB | `TableV2` + `Billing.onDemand()` + `StreamViewType.NEW_IMAGE` | GSI 射影 `ALL`、`RemovalPolicy.DESTROY` |
| 中継（入口） | EventBridge Pipes（方式 A-Pipes）/ 中継 Lambda（方式 A-Lambda） | `RELAY_MODE` で切替 |
| キュー | SQS 標準キュー（`QueueEncryption.SQS_MANAGED` + `enforceSSL`） | 両方式が共用する 1 本 |
| Lambda | Node.js 22.x / `NodejsFunction`（esbuild バンドル） | Python は追加しない（要件 12.6） |
| API | API Gateway REST API + Cognito User Pool オーソライザー | 画面 A〜D のデータアクセス経路（論点 1） |
| 可観測性 | CloudWatch Dashboard + Alarms + SNS Topic | IaC で定義（要件 7.6） |
| フロント | Next.js App Router + TypeScript + `@aws-amplify/ui-react`（`Authenticator`）| CSS Modules（既存テンプレート踏襲） |
| 認証 | 既存 Amplify auth（Cognito User Pool）を流用 | 4 画面を `<Authenticator>` 配下に置く |

フロントの装飾は既存テンプレートの CSS Modules（`page.module.css` /
`sample.module.css`）と `@aws-amplify/ui-react` に合わせる。アクセシビリティ
（ラベルと入力の関連付け、フォーカス可視、キーボード操作、`role="alert"`、
レスポンシブ）は既存 `sample/page.tsx` と EC PoC の `OrderDashboard` の水準を満たすが、
新規に Tailwind やコンポーネントライブラリは導入しない（テンプレートの様式を保つため）。

### 1.2 中心的な問いと観測の骨子

焙煎が終わった 1 ロット分（約 1,000 個）の個包装を同時に付番したいとき、非同期
ファンアウト構成はどこまでスケールするか。入口だけを差し替えて同一の SQS・同一の
ワーカーにつなぎ、付番ワーカーの `ConcurrentExecutions` の立ち上がりカーブを観測する。
一次指標は **付番ワーカーの `ConcurrentExecutions`**（R5。前作の一次指標は中継側の
`IteratorAge` だったが、本作は SQS ファンアウト後の多重数が主役である）。

---

## 2. アーキテクチャ

### 2.1 全体像

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

### 2.2 ネストスタック分離（要件 12.2）

参考 `backend.ts` の `backend.createStack('OrderPipelinePoc')` に倣い、本 PoC の全
リソースを `backend.createStack('SqsLabelingPoc')` のネストスタックに置く。既存の
auth / data とは別スタックになり、検証終了後にこのスタックだけを sandbox 削除で
一括破棄できる（要件 12.1 / 非機能 2）。クロススタック参照は `LabelingApi`
（Cognito オーソライザー）→ `backend.auth.resources.userPool` の一方向のみで循環しない。

### 2.3 消費能力モデルと本作の差分（前作との地続き）

前作の消費能力は Streams 直結の `S × P ÷ D`（S=オープンシャード数、P=並列化係数、
D=処理時間）で、同時実行は `S × P` に上限が張られた。本作は SQS を挟むことでこの
上限を外す。SQS イベントソースマッピングの同時実行は `MaximumConcurrency`（既定 1,000・
最大 1,250）が上限で、キューに十分な滞留があれば Lambda は速やかに多重を立ち上げる。
したがって本作の問いは「入口（Streams→SQS の中継）がボトルネックにならないか」と
「`MaximumConcurrency` まで本当に張り付くか」であり、入口方式（pipes / lambda）の
立ち上がりカーブの差を比較対象にする（R5 / 要件 5.5）。

---

## 3. データモデル（要件データモデル節に準拠）

Lot `1─<N` RoastBatch `1─<N` Unit の 3 階層。Lot はテーブルを作らず Unit に `lot_id`
属性として持たせる。全テーブルは接頭辞 `kiro-roasters-`、`ap-northeast-1`、
`Billing.onDemand()`（PAY_PER_REQUEST）、`RemovalPolicy.DESTROY`。
`amplify/custom/labeling-tables.ts`（`LabelingTables` Construct）で `TableV2` として定義する。

### 3.1 `kiro-roasters-unit`（主役・Streams で滞留する側）

- PK: `unit_id`（単独・SK なし）。`UNIT#...` 形式。冪等キー。
- 属性: `batch_id` / `lot_id` / `item_id` / `seq` / `unit_count` / `roast_date` /
  `status`（`PENDING`→`LABELED`）/ `best_before` / `qr_payload` / `created_at` / `labeled_at`。
- Streams: 有効、`StreamViewType.NEW_IMAGE`（後続は新規イメージだけを読む。要件 2 / 1.6）。

**`unit_count`（N）を unit に非正規化する理由（レビュー指摘 HIGH-1 への対応・案 B を採用）:**
worker の完了遷移（§6.3-4）は条件式 `labeled_count = :n` の `:n` に当該 batch の `unit_count`
（固定値）を束縛する必要がある。worker が参照する入口は SQS ペイロード（§3.4）だけであり、
Pipes 経路はその SQS 本文を Streams の `NewImage`（= unit レコード）からしか射影できない。
したがって **unit レコード自体に `unit_count` 属性を持たせる案 B** が、Pipes 経路・中継 Lambda
経路の両方式で成立する唯一の素直な解である（案 A は Pipes 射影のために結局 unit への非正規化を
要し、案 C は worker IAM に roast-batch `GetItem` を足すため最小権限を崩す）。seeder は各 Unit を
INSERT するとき、その batch の `unit_count` を属性として全 Unit に持たせる（seeder は §6.1 で
roast-batch を `GetItem` 済みなので値を持っている）。これにより worker は追加の読み取り
（roast-batch `GetItem`）なしに `:n = payload.unit_count` を束縛でき、§6.5 の worker IAM は
roast-batch への `UpdateItem` のみ（`GetItem` を足さない＝最小権限を維持）のままでよい。
この属性追加は requirements.md のデータモデル（unit テーブル）とも整合する（requirements 側の
unit テーブル定義にも `unit_count` を追記済み）。
- GSI1 `batch-units-index`: PK `batch_id` / SK `unit_id`、`projectionType=ALL`。
- GSI2 `lot-trace-index`: PK `lot_id` / SK `unit_id`、`projectionType=ALL`。

GSI の射影を `ALL` にするのは、画面 D のトレース照会が `status` / `best_before` /
`qr_payload` / `labeled_at` を返す（要件 11.3）ため基表への追加読み取りを避ける狙いである。
射影 `ALL` の GSI は基表と同量の書き込みを受けるため、GSI 側の `WriteThrottleEvents` も
観測対象にする（要件 7.5）。前作の知見どおり、GSI には warm throughput を設定しない。

### 3.2 `kiro-roasters-roast-batch`（投入指示＋完了集計・Streams なし）

- PK: `batch_id`（単独・SK なし）。`BATCH#...` 形式。
- 属性: `item_id` / `lot_id` / `roast_date` / `unit_count` / `labeled_count` /
  `status`（`ROASTING_DONE`→`LABELING`→`LABELED`）/ `labeling_started_at` /
  `labeling_finished_at` / `created_at`。
- Streams なし。GSI なし。

画面 B のバッチ一覧（`status=ROASTING_DONE` の抽出。要件 9.1）は、本 PoC の規模
（検証者が手で数件登録する程度）では GSI を作らず `Scan` + フィルタで足りる。専用の
status-index を足すと、GSI の射影分だけ書き込み容量が増え、観測したい unit テーブル側の
容量と混ざる。バッチ件数は数十件を超えない前提なので `Scan` の方が構成が素直である
（この判断は論点ではなく、規模に基づく確定事項）。

### 3.3 命名と一意サフィックス

参考 `defaultTableNameSuffix` に倣い、物理名は
`Names.uniqueResourceName(this, { maxLength: 12 }).slice(-8).toLowerCase()` の 8 文字を
`[prefix, logicalName, suffix]` の末尾に付ける（例: `kiro-roasters-unit-ab12cd34`）。
sandbox / ブランチごとに別スタックができても DynamoDB テーブル名・SQS キュー名が
衝突しないようにするため。空文字サフィックスを渡すと固定名になる（単一専用アカウント向け）。
テーブル名を必要とするのは Lambda（環境変数）と CloudWatch（`table.tableName` 参照）だけで、
文字列そのものに依存する箇所はない。

### 3.4 SQS メッセージペイロード（約 250 バイト + unit_count 微増・要件に準拠）

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

冪等キー `unit_id` をメッセージに含め、ワーカーは条件付き書き込みにそのまま使う
（要件 2.10 / 3.8）。1 レコード＝1 メッセージ（要件 2.3）。

**`unit_count` をペイロードに含める（レビュー指摘 HIGH-1 への対応・案 B）:** worker の完了遷移
（§6.3-4）が条件式 `labeled_count = :n` の `:n` に束縛する当該 batch の `unit_count`（固定値）を、
worker が追加の読み取りなしに得られるよう、SQS ペイロードに `unit_count`（Number）を含める。
これにより従来の約 250 バイトから整数 1 フィールド分（約 15〜20 バイト）**微増**する（1,000 件
規模では観測に影響しない）。入口双方がこの値を写す: **Pipes の `inputTemplate` は Streams の
`NewImage.unit_count`（§3.1 で unit に非正規化済み）を** ペイロードへ射影し、**中継 Lambda
（router）も `NewImage` の `unit_count` を** §6.2 の射影でペイロードへ写す。unit レコードに
`unit_count` が載っている（§3.1）ため、Pipes 経路（`NewImage` 射影のみ可能）でも成立する。

**`unit_id` の採番規則（これが唯一の出典。レビュー指摘 1 への対応）:** `unit_id` は冪等キーであり、
worker の `attribute_not_exists(best_before)` による二重付番防止と `RELAY_MODE=both` の二重配信吸収
（§15）はすべてこのキーの一意性・決定性に依存する。したがって採番ルールを 1 箇所で確定し、
seeder の生成・Pipes `inputTemplate` の射影・router の射影・worker の条件付き書き込みの四者が
**同一文字列**を作ることを保証する。規則は次のとおり:

```
unit_id = 'UNIT#' + <batch_id の "BATCH#" 接頭辞を除いた本体> + '-' + String(seq).padStart(6, '0')
```

- `seq` は batch 内 **1 始まり**の連番（`1` 〜 `unit_count`）。
- ゼロ埋め桁数は **6 桁**固定（`unit_count` 上限 `SEED_UNIT_COUNT_MAX`=1200 を十分に収容し、
  辞書順ソートが連番順と一致する）。
- `BATCH#` 接頭辞は `unit_id` には**含めない**（本体のみを連結する）。例: `batch_id =
  'BATCH#2026-10-09-AM-01'`、`seq = 742` のとき `unit_id = 'UNIT#2026-10-09-AM-01-000742'`。

この規則を `shared/unit-keys.ts` の `buildUnitId(batchId, seq)` として唯一の実装にし、
seeder・router が同一関数を呼ぶ。Pipes 側は TypeScript を実行できないため `inputTemplate` で
同じ文字列を組み立てる（`BATCH#` を剥がした本体 + `-` + 6 桁ゼロ埋め `seq`）必要があり、
`unit-keys.ts` の出力と Pipes `inputTemplate` の射影が一致することを §16 の結合テスト（実機）で
突き合わせる（合成テストだけでは Pipes の文字列射影を担保しづらいため。§4.3.2 / 未検証前提 3）。

---

## 4. バックエンド構成（`amplify/custom/` の L2 Construct 分割）

参考 EC PoC の分割方針を踏襲し、機能ごとに Construct を分ける。各ファイルは要件番号・
設計節を引用した日本語 JSDoc（「なぜその設定か」）を持つ。ファイル構成と責務は次のとおり。

| ファイル | Construct | 責務（design 節） | 参考 EC PoC |
|----------|-----------|------------------|-------------|
| `labeling-tables.ts` | `LabelingTables` | unit / roast-batch テーブル、GSI、Streams（§3） | `order-tables.ts` |
| `labeling-stream.ts` | `LabelingStream` | Pipes + 中継 Lambda + SQS + worker ESM の配線（§5） | `order-stream.ts` |
| `labeling-functions.ts` | `LabelingFunctions` | seeder / router / worker / api ハンドラと IAM（§6） | `order-functions.ts` |
| `labeling-api.ts` | `LabelingApi` | REST API + Cognito オーソライザー + ルート（§7） | `order-api.ts` |
| `labeling-monitoring.ts` | `LabelingMonitoring` | CloudWatch ダッシュボード（§8.1） | `order-monitoring.ts` |
| `labeling-alarms.ts` | `LabelingAlarms` | アラーム + SNS トピック（§8.2） | `order-alarms.ts` |
| `verification-config.ts` | `getVerificationConfig()` | 検証パラメータの解決・検証（§9） | `verification-config.ts` |

### 4.1 `verification-config.ts`（検証パラメータの解決と検証）

参考 `verification-config.ts` と同じ構造にする。環境変数を合成時に 1 度だけ解決し、
範囲外・解釈不能な値は既定値へ黙って読み替えず `VerificationConfigError` でデプロイを
止める（要件 2.9 / 非機能 5）。`getVerificationConfig()` はキャッシュして合成中に何度
参照しても同じ値を返す（警告も 1 回）。本 PoC で解決するパラメータは次の表（これが唯一の出典）。

| キー（env） | 既定 | 範囲 | 用途（design 節） |
|-------------|------|------|-------------------|
| `RELAY_MODE` | `pipes` | `pipes` / `lambda` / `both` | 入口方式の切替（§5.2、論点 3） |
| `LABELING_MAX_CONCURRENCY`（`WORKER_MAX_CONCURRENCY`）| 1000 | 2〜1250 | worker ESM の `MaximumConcurrency`（§5.4、R5） |
| `LABELING_WORKER_BATCH_SIZE` | 1 | 1〜10 | worker ESM の `batchSize`（§5.4） |
| `ROUTER_BATCH_SIZE` | 100 | 1〜1000 | 方式 A-Lambda の Streams ESM `batchSize`（§5.3） |
| `ROUTER_PARALLELIZATION_FACTOR` | 1 | 1〜10 | 方式 A-Lambda の Streams ESM `parallelizationFactor`（§5.3） |
| `SEED_UNIT_COUNT_MAX` | 1200 | 1〜5000 | seeder が 1 バッチで INSERT する上限（§6.1） |
| `BEST_BEFORE_DAYS` | 365 | 1〜3650 | 付番時の賞味期限日数（§6.3。※要件 3.2 からの軽微な逸脱。下記注記参照） |

**`BEST_BEFORE_DAYS` の既定 365 と要件 3.2 の関係（レビュー指摘 7 への対応）:**
要件 3.2 は `best_before = roast_date + 365 日` を固定で要求する。本設計は検証利便
（賞味期限ロジックの境界確認を日数を変えて行える）のため既定 365 で上書き可能にしており、
**既定値のままでは要件 3.2 に準拠する**。要件に無い設定可能性を 1 つ足している軽微な
スコープ拡張であることをここに明記する。検証者が明示的に上書きしない限り常に 365 日である。

> **TTL について（レビュー指摘 2 への対応）:** 当初案にあった `DATA_TTL_DAYS` パラメータは
> **削除した**。§3 のデータモデル（unit / roast-batch）に TTL 用の数値属性（`expires_at` 等）は
> 存在せず、`TableV2` に `timeToLiveAttribute` も設定しないため、「どの属性に TTL を効かせるか」を
> 設計から決定できない矛盾があった。検証データの破棄は非機能 2（`RemovalPolicy.DESTROY` +
> sandbox 削除で `SqsLabelingPoc` スタックごと一括破棄）で十分に満たせるため、TTL は本 PoC では
> 採用しない。将来 TTL が必要になった場合は §3 の unit テーブルに `expires_at: Number`（epoch 秒）を
> 追記し `timeToLiveAttribute: 'expires_at'` と seeder のセットを足す拡張点として残す。

`RELAY_MODE` は文字列列挙なので数値表とは別に検証する。許容 3 値以外は
`VerificationConfigError` を投げて合成を失敗させる（要件 2.9）。

**`MaximumConcurrency` の下限 2 を自前検証する理由（レビュー指摘 5 への対応）:**
確認した `aws-cdk-lib`（v2 系）の `SqsEventSource` の合成バリデーションは `maxConcurrency` に
**下限・上限チェックを持たない**（下限/上限を検証するのは `provisionedPollerConfig` の poller 数のみ）。
下限 2 はイベントソースマッピングの **CloudFormation / SQS サービス側のプロパティ制約**
（`ScalingConfig.MaximumConcurrency` の有効範囲 2〜1,000。予約枠を使わない場合）であり、
1 を指定しても **CDK 合成時には弾かれず、デプロイ時に失敗する**。これを合成段階で早期に止める
ため（testing 方針「明らかな問題で早期に失敗させる」）、`verification-config.ts` 側で下限 2 を
自前検証して合成を失敗させる。既定 1,000・最大 1,250 は要件 5.1 の既定・上限に合わせる
（1,250 はアカウント枠引き上げ時の上限で、既定枠 1,000 の範囲内で検証する）。
解決した値は `backend.ts` が `getVerificationConfig()` で 1 度だけ取得し、全 Construct と
`GET /config`（§7）に共有する。

### 4.2 `LabelingTables`（`labeling-tables.ts`）

参考 `order-tables.ts` に倣い `TableV2` で unit / roast-batch を作る。要点:

- unit テーブル: `partitionKey=unit_id`、`dynamoStream=StreamViewType.NEW_IMAGE`、
  GSI1 `batch-units-index` / GSI2 `lot-trace-index`（いずれも `projectionType=ALL`）。
  warm throughput は設定しない（本作は SQS 側の多重が主役で、unit テーブルへの書き込みは
  seeder の `BatchWriteItem` と worker の `UpdateItem` に限られ、オンデマンドのバーストで足りる）。
- roast-batch テーブル: `partitionKey=batch_id`、Streams なし、GSI なし。
- `get unitStreamArn()`: Streams ARN。無効なら明示的に例外（props 変更で静かに壊れるのを防ぐ）。
- `get tableEnvironment()`: Lambda へ渡す環境変数（テーブル名・GSI 名・Streams ARN）。
  キーは `LABELING_UNIT_TABLE_NAME` / `LABELING_ROAST_BATCH_TABLE_NAME` /
  `LABELING_BATCH_UNITS_INDEX_NAME` / `LABELING_LOT_TRACE_INDEX_NAME` /
  `LABELING_UNIT_STREAM_ARN`。実行時側 `shared/runtime-config.ts` が同じキーを読む。

### 4.3 `LabelingStream`（`labeling-stream.ts`）— 本 PoC の観測装置

参考 `order-stream.ts` を踏襲しつつ、本作の主眼である「入口の差し替え」と「SQS→worker の
多重制御」をこの 1 ファイルに集約する。EC PoC では Streams を直接 processor につないで
いたが、本作ではここに SQS・Pipes・中継 Lambda・worker ESM の 4 要素の配線が入る。
`RELAY_MODE` に応じて pipes / lambda / both のいずれを有効化するかを決めるのもここ。

#### 4.3.1 SQS 標準キュー（要件 6）

```
new Queue(this, 'LabelingQueue', {
  queueName: name('labeling'),               // kiro-roasters-labeling-<suffix>
  encryption: QueueEncryption.SQS_MANAGED,   // 要件 6.2
  enforceSSL: true,                          // 要件 6.3
  visibilityTimeout: Duration.seconds(360),  // worker タイムアウト 60 秒（§6 表）× 6 = 360 秒
  removalPolicy: RemovalPolicy.DESTROY,       // 要件 6.4
})
```

標準キュー（FIFO 不要。付番は順序不問。要件 6.1 / スコープ）。DLQ はキューにも付ける
（`maxReceiveCount=5` で `kiro-roasters-labeling-dlq-<suffix>`）。worker が条件以外の理由で
繰り返し失敗したメッセージを隔離し、観測を汚さないため。

**可視性タイムアウトの算出根拠（レビュー指摘 8 への対応）:** worker 関数のタイムアウトは
§6 の表で **60 秒**と定義している。SQS をイベントソースにする Lambda は、キューの可視性
タイムアウトを**関数タイムアウトの 6 倍以上**にすることが AWS の推奨であり（部分バッチ応答・
リトライ中にメッセージが他コンシューマへ再可視化されるのを防ぐため）、`60 秒 × 6 = 360 秒` を
`Duration.seconds(360)` として明示的に設定する（式ではなく確定値で書き、worker タイムアウトを
変えたらここも手で見直す運用にする）。`LABELING_WORKER_BATCH_SIZE` は既定 1（1 メッセージ＝
1 個体）で、1 件あたり 60 秒前提で足りる。`batchSize` を増やす検証を行う場合は 1 バッチの
処理時間が延びるため、その時点で worker タイムアウトと可視性タイムアウトを併せて見直す。
なお `SqsEventSource` は可視性タイムアウトが関数タイムアウト未満のとき合成時に警告を出すため、
設定ミスは合成段階で気づける。両方式がこの 1 本に送信し、worker が唯一の受信者（要件 6.5）。

#### 4.3.2 方式 A-Pipes（EventBridge Pipes。要件 2.4）

`CfnPipe`（`aws-cdk-lib/aws-pipes` の L1。CDK に Pipes の安定 L2 は無いため L1 を使う）で
source=unit Streams、target=SQS を結ぶ。source パラメータ: `startingPosition=LATEST`、
`batchSize`（router と揃えて既定 100）、フィルタ `eventName=INSERT`（要件 2.4）。
target パラメータ: SQS。`inputTemplate` で Streams の `NewImage` から §3.4 のペイロード
（`unit_count` を含む）へ射影する（Pipes の入力変換を使い、ワーカーが受け取る本文を方式間で
揃える）。`unit_count` は §3.1 で unit に非正規化済みのため `NewImage.unit_count` から射影できる
（レビュー指摘 HIGH-1・案 B）。Pipes 実行ロールには Streams 読み取りと SQS 送信を最小権限で付与する。

**`inputTemplate` と `buildUnitId` の文字列一致を実機で突き合わせる具体ケース（レビュー指摘
NIT-1 への対応）:** Pipes 側は TypeScript を実行できないため `inputTemplate` で `unit_id` を
`buildUnitId`（§3.4）と同一文字列に組み立てる必要があり、この一致は合成テストでは担保しづらく
実機結合テストに依存する（`RELAY_MODE=pipes` / `both` の正しさはローカル/CI では検出できない
制約）。突き合わせの境界ケースを §17 の検証シナリオに固定する: (1) `seq=1`（6 桁ゼロ埋めで
`-000001`）、(2) `seq=unit_count`（例 `unit_count=1000` → `-001000`、桁上がりの境界）、
(3) `BATCH#` 接頭辞の剥がし（`batch_id='BATCH#2026-10-09-AM-01'` → 本体 `2026-10-09-AM-01`）。
この 3 ケースで Pipes 射影 `unit_id` と `buildUnitId` の出力が完全一致することを実機で確認する。

#### 4.3.3 方式 A-Lambda（中継 Lambda `labeling-router`。要件 2.5）

`labeling-router` に `DynamoEventSource(unitTable, {...})` を付ける。設定は参考
`order-stream.ts` と同じ思想:

- `startingPosition=LATEST`（過去を再処理しない。再デプロイで件数がずれるのを防ぐ）。
- `filters=[FilterCriteria.filter({ eventName: FilterRule.isEqual('INSERT') })]`（要件 2.1 / 2.2）。
  **フィルタが構造として固定**されていること自体がテストの検査対象。ハンドラ側にも
  `eventName=INSERT` の二次ガードを置く（要件 2.5）。
- `batchSize=ROUTER_BATCH_SIZE`、`parallelizationFactor=ROUTER_PARALLELIZATION_FACTOR`。
- `reportBatchItemFailures=true`、`retryAttempts=3`、`bisectBatchOnError=true`、
  `onFailure=new SqsDlq(routerDlq)`（Streams ESM 専用の DLQ。メタデータのみが入る）。

ルーターは受け取った INSERT レコードを `SendMessageBatch`（1 回最大 10 件）で SQS へ転送する。

#### 4.3.4 worker ESM（SQS → labeling-worker。要件 3 / 5）

`labeling-worker` に `SqsEventSource(labelingQueue, {...})` を付ける:

- `maxConcurrency=LABELING_MAX_CONCURRENCY`（既定 1,000。R5 / 要件 5.1 / 5.3）。
- `batchSize=LABELING_WORKER_BATCH_SIZE`（既定 1。1 メッセージ＝1 個体。要件 3.1）。
- `reportBatchItemFailures=true`（要件 3.9。付番条件以外の失敗を部分再試行にする）。

`maxConcurrency` は本 PoC の唯一の直接操作変数なので、ESM を `labeling-functions.ts` に
埋め込まずこの Construct に独立させる（参考 `order-stream.ts` と同じ理由）。

#### 4.3.5 `RELAY_MODE` の分岐（論点 3）

合成時に `config.relayMode` を読み、`pipes` なら Pipes のみ、`lambda` なら router の
`DynamoEventSource` のみ、`both` なら両方を有効化する。`both` は比較用途（同一シナリオで
両入口を同時に流し、立ち上がりカーブを突き合わせる）に限る。both では同一 INSERT が
Pipes 経由と router 経由で二重に SQS へ届き得る＝二重配信になるが、**worker の条件付き
書き込み（`attribute_not_exists(best_before)`）で冪等に吸収される**（要件 3.5 / 3.7。
2 回目は弾かれ `labeled_count` も二重加算されない）。この前提を Construct の JSDoc に明記する。

### 4.4 `LabelingApi`（`labeling-api.ts`）— 画面 A〜D のデータアクセス経路（論点 1）

参考 `order-api.ts` に倣い、REST API に Cognito User Pool オーソライザーを掛ける。
全ルート（OPTIONS を除く）が `AuthorizationType.COGNITO`。

**オーソライザーの検証内容（レビュー指摘 6 への対応）:** `CognitoUserPoolsAuthorizer`
（`identitySource` 未指定＝既定 `method.request.header.Authorization`）は、`Authorization`
ヘッダーに載った **Cognito 発行の JWT（ID トークン / アクセストークンのいずれも）** を受理し、
署名・有効期限・失効を検証する。「ID トークンのみを検証する」わけではない。本 PoC のフロントは
参考 EC PoC に合わせ **ID トークン**を `Authorization: Bearer <idToken>` で送る運用とする
（`src/lib/labeling/api.ts` が Cognito セッションから ID トークンを取得して付与。§11.1）。

エンドポイント種別は `REGIONAL`、ステージ名 `poc`、CORS は `GET/POST/OPTIONS` +
`Content-Type`/`Authorization`。ルート表（これが唯一の出典。テストが design と突き合わせる）:

| メソッド | パス | ハンドラ | 用途（要件） |
|----------|------|---------|--------------|
| POST | `/batches` | labeling-api | 画面 A: RoastBatch を PutItem（要件 8.1） |
| GET | `/batches` | labeling-api | 画面 B: バッチ一覧（Scan + `?status=` フィルタ。既定 `ROASTING_DONE`。要件 9.1） |
| GET | `/batches/{batchId}` | labeling-api | 画面 C: 進捗ポーリング（roast-batch 読み取り。要件 10.1） |
| POST | `/batches/{batchId}/labeling-start` | labeling-api | 画面 B: [付番開始]→条件付き遷移後に seeder 非同期 invoke（要件 1.1 / 9.2） |
| GET | `/units` | labeling-api | 画面 D: GSI Query（`?batchId=` / `?lotId=`。要件 11.1 / 11.2） |
| GET | `/config` | labeling-api | デプロイ済み検証パラメータの確認（非機能 5） |

**`GET /batches` のアクセスパターン確定（レビュー指摘 4 への対応）:**
`GET /batches` は roast-batch を `Scan` し、クエリパラメータ `?status=` で状態を絞る。
**`status` を省略した場合の既定は `ROASTING_DONE`**（画面 B が付番待ち一覧を取る既定動作。
要件 9.1）。`status` の許容値は `ROASTING_DONE` / `LABELING` / `LABELED` の **3 値**で、
それ以外は **400**（既定へ黙って読み替えない。非機能 5）。画面 C の進捗は
`GET /batches/{batchId}`（単体 `GetItem`）を使うため、画面 C が全件取得のために
`GET /batches` を使うことはない。したがって「全ステータスを返す」挙動は提供せず、
`?status=` は上記 3 値のいずれか（省略時 `ROASTING_DONE`）に一本化する。入力検証は §14 の表に
`?status=` 行として追記する。

**`{batchId}`（`BATCH#...` で `#` を含む）の encode/decode 責務の確定（レビュー指摘 MEDIUM-1）:**
`batch_id` は `BATCH#2026-10-09-AM-01` の形式で `#` を含み、`#` は URL ではフラグメント区切りに
なるためパスセグメントに素で入れると API Gateway まで届かない。責務を次のとおり確定する:
フロント `src/lib/labeling/api.ts` が `encodeURIComponent(batchId)` でパスセグメントをエンコード
して送る（`BATCH#...` → `BATCH%23...`）。**Lambda は `event.pathParameters.batchId`
（API Gateway がデコード済みの `BATCH#...`）をそのまま使う**（ハンドラ側で追加の decode を
行わない）。クエリ版の照会（`GET /units?batchId=`）も同様に `encodeURIComponent` でクエリ値を
エンコードする（`?batchId=BATCH%23...`、Lambda は `event.queryStringParameters.batchId` を
デコード済みで受ける）。これは `{batchId}` を使う 2 ルート（`GET /batches/{batchId}`、
`POST /batches/{batchId}/labeling-start`）と `GET /units?batchId=` の全てに適用する。
§16 のユニットテスト（`src/lib/labeling/api.ts`）に「`#` を含む batchId のエンコード」ケースを追加する。

`backend.ts` は `api.url` を `addOutput({ custom: { labelingApiUrl, alarmTopicArn } })` で
出力する（§10）。参考と同じく `url`（循環参照になる）と区別し、Lambda の環境変数へ渡す
必要がある値は `urlForLambdaEnvironment`（文字列組み立て）を使う。ただし本作では Lambda
から自分の API を叩く経路（EC の measure に相当）が無いため、`urlForLambdaEnvironment` は
`GET /config` の自己記述用途に留まり、循環は発生しない。

---

## 5. 入口・中継・ワーカーの実装詳細

（Construct の配線は §4.3 に、ハンドラのロジックは §6 に書く。本節は節番号参照のための
索引であり、§4.3 を参照のこと。）

---

## 6. Lambda 関数（`amplify/functions/`）

参考 EC PoC の `amplify/functions/` 構成（各関数が `handler.ts` を持ち、純ロジックは
隣接モジュールに分けてユニットテスト可能にする）を踏襲する。`shared/` に共通モジュールを置く。
全関数 Node.js 22.x / `NodejsFunction`、`bundling.externalModules=['@aws-sdk/*']`、
`NODE_OPTIONS='--enable-source-maps'`、`reservedConcurrentExecutions` は設定しない
（worker を 1,000 まで張り付かせるため枠を人為的に区切らない。R5）。

| ディレクトリ | 役割 | トリガー | タイムアウト/メモリ |
|--------------|------|---------|---------------------|
| `seeder/` | 約 1,000 件を PENDING で一括 INSERT（要件 1） | labeling-api からの非同期 invoke | 15 分 / 512MB |
| `labeling-router/` | 方式 A-Lambda の中継（要件 2.5） | unit Streams ESM | 5 分 / 256MB |
| `labeling-worker/` | 1 メッセージ＝1 個体を付番（要件 3〜5） | SQS ESM | 60 秒 / 256MB |
| `labeling-api/` | 画面 A〜D の API（§4.4 の 6 ルート） | API Gateway | 30 秒 / 256MB |
| `shared/` | `runtime-config.ts` / `ddb.ts` / `http.ts` / `types.ts` / `unit-keys.ts` / `qr.ts` | — | — |

### 6.1 `seeder/`（要件 1）

labeling-api の `POST /batches/{batchId}/labeling-start` から**非同期 invoke**される
（論点 2 で確定）。

**二重起動の抑止は API 層が所有する（レビュー指摘 1 / HIGH への対応）:** 本 PoC は seeder を
非同期 invoke（即 202）するため、検証者が短時間に [付番開始] を 2 回押すと複数の起動要求が
走り得る。この二重起動を弾く**唯一の判定点を API 層（`POST /labeling-start`）の条件付き
`UpdateItem` に一本化する**。seeder 自身は INSERT 前に状態遷移を行わない（API 層が既に
`LABELING` へ遷移済みの前提で起動される）。これにより「どの層が、INSERT の前と後のどちらで、
どの条件式で二重起動を弾くか」が 1 つに定まり、2 本目の seeder がそもそも起動されないため、
全件 INSERT が二重に走って R5 の立ち上がりカーブを汚すことがない。遷移の詳細は §6.4 の
`POST /batches/{batchId}/labeling-start` を参照。

seeder 本体の処理（API 層が `ROASTING_DONE → LABELING` の遷移を確定させた後に呼ばれる）:

1. `batch_id` を受け取り roast-batch を `GetItem`（`unit_count` / `lot_id` / `item_id` /
   `roast_date` を取得。状態は API 層が既に `LABELING` にしている）。`unit_count`（≒1,000、
   `SEED_UNIT_COUNT_MAX` で上限）件の Unit を `status=PENDING` で生成する。各 Unit の `unit_id` は
   `shared/unit-keys.ts` の採番規則で一意化（`seq` 由来で決定的）し、`batch_id` / `lot_id` /
   `item_id` / `seq`（batch 内連番）/ `unit_count` / `roast_date` / `created_at` を設定（要件 1.5）。
   **`unit_count` は §6.1-1 の `GetItem` で得た batch の値を全 Unit に同一値で非正規化して持たせる
   （レビュー指摘 HIGH-1・案 B。worker の完了遷移が NewImage 経由で `unit_count` を得られるように
   するため。§3.1 / §3.4）。**
2. `BatchWriteItem` を 25 件ずつ（約 40 回）に分割して投入（要件 1.3）。`UnprocessedItems` が
   返れば指数バックオフで再送し全件書き込むまで試行（要件 1.7。参考 `inventory-seed` の
   `writeBatchWithRetry` と同じ構造）。

seeder は検証トリガーであり、エンドユーザー機能ではない（要件 1.8）。各 INSERT は
`NEW_IMAGE` の Streams に `eventName=INSERT` として乗る（要件 1.6）。`status=LABELING` への
遷移と `labeling_started_at` の打刻は **API 層が INSERT 開始前に確定済み**であり（§6.4）、
要件 1.4 の「一括 INSERT に伴い `roast-batch.status` が `LABELING` になる」は、API 層の
条件付き遷移 → seeder 非同期起動 → INSERT という順序で満たす（遷移が INSERT の論理的開始の
一部として先行する）。

### 6.2 `labeling-router/`（方式 A-Lambda。要件 2.5）

Streams レコードを受け取り、ハンドラ先頭で `record.eventName !== 'INSERT'` を捨てる
（ESM フィルタの二次防御）。残りを §3.4 のペイロード（`NewImage.unit_count` を含む。
レビュー指摘 HIGH-1・案 B）へ射影し `SendMessageBatch`（10 件単位）で SQS へ送る。送信失敗は `batchItemFailures` で部分再試行に回す（`reportBatchItemFailures=true`）。
純ロジック（レコード→ペイロード射影、10 件チャンク化）は `labeling-router/to-message.ts` に
分けてユニットテストする。

### 6.3 `labeling-worker/`（付番。要件 3〜5）

SQS メッセージ（§3.4）を 1 件処理する:

1. `best_before = roast_date + BEST_BEFORE_DAYS 日`（既定 **365**。既定のまま要件 3.2 準拠。
   上書き可能なのは検証利便のための軽微な拡張で §4.1 に明記）を計算（要件 3.2）。
   暦日加算は UTC 基準で日数を足し ISO 8601 日付へ戻す（うるう年は `Date` の加算に委ね、
   「暦日 +365 日」の素直な解釈にする＝閏日を跨ぐと暦日で 366 日後になる場合がある。
   これを確定仕様とし `shared/` の純関数でユニットテストする）。
2. `qr_payload` を生成（`shared/qr.ts`。`unit_id` / `item_id` / `best_before` を含む
   文字列。実画像生成は対象外＝ペイロード文字列まで。要件 3.3 / スコープ）。
   **出力フォーマットを確定する（これが唯一の出典。レビュー指摘 5）:**
   `qr_payload = JSON.stringify({ unit_id, item_id, best_before })`。キーの順序は
   `unit_id` → `item_id` → `best_before` に固定し（決定性のため。`qr.ts` が常に同じキー順で
   オブジェクトを組み立てる）、同一入力に対して常に同一文字列を返すことを §16 のユニットテストで
   保証する。JSON を採るのは、将来実画像化（QR エンコード）する際にパースが素直で、画面 D の
   トレース表示でも構造化して見せられるため（独自区切りより拡張しやすい）。
3. unit を `UpdateItem`: `SET status=LABELED, best_before, qr_payload, labeled_at`、
   `ConditionExpression attribute_not_exists(best_before)`（要件 3.4 / 3.5。二重付番を弾く）。
4. 条件成功時のみ roast-batch を `UpdateItem ADD labeled_count :one`（要件 3.6）。この応答で
   更新後の `labeled_count` を取得し（`ReturnValues=UPDATED_NEW`）、`unit_count`（= ペイロードの
   `payload.unit_count`。§3.4 / HIGH-1・案 B）に達していれば roast-batch を `UpdateItem` で
   `status=LABELED`・`labeling_finished_at` をセット、
   `ConditionExpression labeled_count = :n AND status = :labeling`（要件 4.1 / 4.2。
   ちょうど 1 回だけ完了遷移。キュー深度に依存しない。要件 4.3 / 4.4）。
   **完了遷移の `:n` は当該 batch の `unit_count`（固定値。自分が ADD で読んだ `labeled_count`
   ではない。`unit_count` は追加読み取りなしに `payload.unit_count` から束縛する）を束縛する**
   （レビュー指摘 MEDIUM-2）。すなわち完了遷移は「`labeled_count` が `unit_count` にちょうど一致し、
   かつ `status` が `LABELING`」のときだけ成立する。
   **なぜちょうど 1 回成立するか（3 点の根拠を本文に明示。レビュー指摘 MEDIUM-2）:** `:n` は
   `unit_count` 固定値であり、`labeled_count` は付番成功ごとに単調増加するため `unit_count` に
   ちょうど一致する瞬間は 1 回だけである。さらに `status = :labeling` ガードが既遷移（既に
   `LABELED`）を弾くため、1,000 多重のうち完了遷移が成立するのは厳密に 1 回に限られる
   （`:n` 固定 + 単調増加 + status ガード の 3 点）。ADD 応答で得た `labeled_count` は完了遷移を
   **試みるトリガー**であり、完了の**判定基準**はあくまで条件式側の `labeled_count = unit_count`
   である（別々の `UpdateItem` の間に他 worker の ADD が割り込んでも、`:n` が自分の読んだ値では
   なく `unit_count` 固定値であるため誤判定しない）。
5. 条件が弾かれた（既に付番済み）場合は `labeled_count` を加算せず、メッセージを正常終了に
   する（要件 3.7）。付番条件以外（スロットル・一時障害）の失敗は `batchItemFailures` で
   再試行対象に報告（要件 3.9）。

純ロジック（`best_before` 計算、`qr_payload` 生成、更新式の組み立て、完了判定）は
`labeling-worker/labeling.ts` / `shared/qr.ts` に分けてユニットテストする。副作用（DDB 呼び出し）は
`handler.ts` に閉じる。

### 6.4 `labeling-api/`（画面 A〜D。§4.4）

API Gateway プロキシ統合の 1 ハンドラが 6 ルートを `event.httpMethod` + `event.resource` で
分岐する（参考 `order-query` が複数 GET を 1 関数で受けるのと同じ）。各ルート:

- `POST /batches`: 入力（`item_id` / `lot_id` / `roast_date` / `unit_count`）を検証し
  `status=ROASTING_DONE`・`created_at` を付けて `PutItem`（要件 8.1 / 8.2 / 8.4）。
  **`batch_id` は衝突回避のため API が生成する**: `BATCH#<lot_id から LOT# を剥がした本体>-<作成時刻の
  ISO 8601 タイムスタンプ>`（例 `BATCH#2026-10-01-003-2026-10-16T06:55:00.000Z`）。glossary / §3.1
  の `BATCH#2026-10-09-AM-01` は ID 形式の例示であり、実際の値は同一ロットの複数回登録でも一意に
  なるようタイムスタンプを連結する（キーとして一意・決定的）。
  **`unit_count` 省略時は既定 1000 を確定値として PutItem する（レビュー指摘 7）**。既定の補完は
  この API 層が所有し、roast-batch に確定した数値を書き込む。seeder は roast-batch を信頼して
  `GetItem` で `unit_count` を読む設計（§6.1）であり、**seeder 側で既定補完は行わない**（補完の
  所有層を API 層に一本化し、seeder が未定義値を読む可能性を排除する）。
- `GET /batches`: roast-batch を `Scan`、`?status=` でフィルタして一覧を返す（既定
  `ROASTING_DONE`。許容値 `ROASTING_DONE`/`LABELING`/`LABELED`、それ以外は 400。§4.4 / 要件 9.1）。
- `GET /batches/{batchId}`: `GetItem` で roast-batch を返す（画面 C のポーリング。要件 10.1）。
- `POST /batches/{batchId}/labeling-start`: **二重起動抑止の判定点（§6.1）**。まず roast-batch を
  `UpdateItem` で `ROASTING_DONE → LABELING` へ**同期的に条件付き遷移**する
  （`ConditionExpression status = :roasting_done`、`SET status=:labeling, labeling_started_at=:now`。
  要件 1.4）。(a) 条件成功 → seeder を**非同期 invoke**（`InvocationType=Event`）して即 **202** を返す
  （論点 2。要件 1.1 / 9.2）。(b) `ConditionalCheckFailed`（既に `LABELING`/`LABELED`＝二重押下や
  処理中）→ seeder を invoke せず **409 Conflict**（既に付番開始済み）を返す。これにより 2 本目の
  seeder が起動されず、全件 INSERT の二重実行を根本から防ぐ。
- `GET /units?batchId=`: GSI1 `batch-units-index` を `Query`（要件 11.1）。
- `GET /units?lotId=`: GSI2 `lot-trace-index` を `Query`（要件 11.2）。応答は各 Unit の
  `status` / `best_before` / `qr_payload` / `labeled_at` を含む（要件 11.3）。
- `GET /config`: `getVerificationConfig()` 相当の実行時値（`shared/runtime-config.ts`）を返す。

### 6.5 IAM（最小権限。非機能 3）

参考 `order-functions.ts` と同じく `grant*` ヘルパーを使わず `PolicyStatement` を手で絞る。

| 関数 | 権限 |
|------|------|
| seeder | unit への `BatchWriteItem` / `PutItem`、roast-batch への `GetItem`（状態遷移は持たない。§6.1 / §6.4） |
| labeling-router | （Streams 読み取りは `DynamoEventSource` が付与）、SQS `SendMessage*` |
| labeling-worker | （SQS 受信は `SqsEventSource` が付与）、unit への `UpdateItem`、roast-batch への `UpdateItem` |
| labeling-api | roast-batch への `GetItem` / `PutItem` / `UpdateItem` / `Scan`、unit への `Query`（基表 + GSI 2 本）、seeder への `lambda:InvokeFunction`（非同期起動用） |

seeder 起動の `InvokeFunction` 対象は seeder の ARN を文字列組み立てで限定し（参考
`grantSelfInvoke` と同じく循環参照を避ける）、`:*` 修飾子まで広げない。

### 6.6 `shared/`

- `runtime-config.ts`: テーブル名・GSI 名・Streams ARN・検証パラメータを環境変数から解決。
  範囲外は `RuntimeConfigError`（既定へ読み替えない。非機能 5）。合成側 `verification-config.ts`
  とキー名が重複するため、テストで突き合わせる（参考と同じ思想）。
- `ddb.ts`: `DynamoDBDocumentClient` のシングルトン。
- `http.ts`: API レスポンス（`ok` / `toErrorResponse` / `parseJsonBody`）と CORS ヘッダー。
- `types.ts`: Unit / RoastBatch / SQS ペイロード / API 入出力の型。
- `unit-keys.ts`: `unit_id` / `batch_id` / `lot_id` の採番・パース。`unit_id` の採番規則は
  §3.4 で確定した `buildUnitId(batchId, seq)`（`'UNIT#' + <BATCH# を除いた本体> + '-' +
  String(seq).padStart(6, '0')`、`seq` は 1 始まり）が唯一の実装。seeder・router がこれを呼び、
  Pipes `inputTemplate` が同じ文字列を組み立てる（§3.4 / §4.3.2）。採番の決定性をユニットテストで保証（§16）。
- `qr.ts`: `qr_payload` 文字列生成。出力フォーマットは §6.3-2 で確定（`JSON.stringify({ unit_id,
  item_id, best_before })`）。

---

## 7. API Gateway（§4.4 参照）

ルート表・認証・CORS・出力は §4.4 に記載。本節は索引。

---

## 8. 可観測性（CloudWatch）

### 8.1 `LabelingMonitoring`（ダッシュボード。要件 7）

参考 `order-monitoring.ts` に倣い、単一ダッシュボード `kiro-roasters-labeling-<suffix>` を
IaC で定義（要件 7.6。手作業禁止）。粒度 1 分固定。本作の一次指標は **worker の
`ConcurrentExecutions`** なので最上段に 24 幅で単独配置し、`MaximumConcurrency` と
アカウント枠 1,000 の注釈線を引く。ウィジェット（タイトルは定数化しテストが design と突き合わせる）:

| ウィジェット | メトリクス | 要件 |
|--------------|-----------|------|
| 同時実行（worker・一次指標） | `labeling-worker` の `ConcurrentExecutions`（最大）。注釈: MaxConcurrency / 枠 1,000 | 7.1 / R5 / 5.2〜5.4 |
| 入口別の立ち上がり比較 | router の `AWS/Lambda` `Invocations` と Pipes の `AWS/Pipes` `Invocations`（`RELAY_MODE` で見分ける。both 時の制約は下記注記） | 5.5 |
| SQS キュー深度 | `ApproximateNumberOfMessagesVisible` + `...NotVisible`（処理中） | 7.2 |
| worker スロットル | `labeling-worker` の `Throttles` | 7.3 |
| 中継側 IteratorAge | router の `IteratorAge`（方式 A-Lambda のとき）。Pipes 側の遅延も併記 | 7.4 |
| unit テーブル書き込み容量 | `ConsumedWriteCapacityUnits`（基表 + GSI 2 本） | 7.5 |
| unit テーブル書き込みスロットル | `WriteThrottleEvents`（基表 + GSI 2 本） | 7.5 |
| DLQ メッセージ数 | SQS DLQ / Streams DLQ の `ApproximateNumberOfMessagesVisible` | — |

**入口別比較ウィジェットの Pipes 側メトリクスの確定（レビュー指摘 NIT-2）:** EventBridge Pipes に
「SQS への送信件数」を一意に表す単一の標準メトリクスは無いため、Pipes 側の立ち上がりは
**`AWS/Pipes` 名前空間の `Invocations`（PipeName ディメンション）**で描く（router 側は
`AWS/Lambda` の `Invocations`）。SQS の `NumberOfMessagesSent` は入口別に按分できず、
**`RELAY_MODE=both` のときは Pipes 経由と router 経由の送信が合算されて入口別に分離できない**
制約があるため、`both` では「どちらの入口でも 1,000 まで張り付くか」の定性比較に留める旨を
ウィジェットの注記に明示する（§4.3.5 / 決定 3 と整合）。

ヘッダーに読み方（「`ConcurrentExecutions` が `MaximumConcurrency` 付近に張り付けば
ファンアウト成功」「入口方式ごとに立ち上がりカーブを比較」「ゼロも観測結果」）をテキストで置く。

### 8.2 `LabelingAlarms`（アラーム + SNS。参考 `order-alarms.ts`）

要件は CloudWatch 可視化（要件 7）までだが、参考構成の地続き感を保つためダッシュボードと
別 Construct でアラームと SNS トピック（`kiro-roasters-labeling-alarms-<suffix>`、
`enforceSSL`、サブスクリプションは作らず `topicArn` を出力）を定義する。閾値はダッシュボードと
共有し、ずれないようにする。アラーム: worker スロットル > 0（critical）、アカウント同時実行 80%
（warning）、SQS/Streams DLQ にメッセージ（warning）、SQS キュー深度の長時間高止まり（warning）。
これらは「本番運用に近いリアルさ」のための拡張であり、要件 7 の必須範囲を超える部分は
`topicArn` を出力するだけで購読は検証者に委ねる。

---

## 9. 検証パラメータ（§4.1 参照）

解決・検証ロジックは §4.1。本節は索引。

---

## 10. `backend.ts`（合成）

参考 `backend.ts` に倣う。既存 `defineBackend({ auth, data })` に本 PoC を足す:

```
const backend = defineBackend({ auth, data });
const stack = backend.createStack('SqsLabelingPoc');       // 要件 12.2
const config = getVerificationConfig();                    // 1 度だけ解決・共有（§4.1）
const tables = new LabelingTables(stack, 'LabelingTables', { config });
const functions = new LabelingFunctions(stack, 'LabelingFunctions', { tables, config });
const api = new LabelingApi(stack, 'LabelingApi', {
  handlers: functions,
  userPool: backend.auth.resources.userPool,               // クロススタック参照（一方向）
});
functions.wireSeederInvoke(api);                            // labeling-api に seeder 起動権限/環境変数
const stream = new LabelingStream(stack, 'LabelingStream', { tables, functions, config });  // §4.3
new LabelingMonitoring(stack, 'LabelingMonitoring', { functions, tables, stream });
const alarms = new LabelingAlarms(stack, 'LabelingAlarms', { functions, tables, stream });
backend.addOutput({
  custom: {
    labelingApiUrl: api.url,                                // 要件 8〜11 のフロント接続
    alarmTopicArn: alarms.topicArn,
    relayMode: config.relayMode,                            // 現在有効な入口を検証者が確認（非機能 5）
    labelingMaxConcurrency: String(config.labelingMaxConcurrency),
  },
});
```

既存 auth / data（Todo）は変更しない（要件 12.1 / 12.4）。`labelingApiUrl` は
`amplify_outputs.json` の `custom.labelingApiUrl` に載り、`next dev` では
`.env.local` の `NEXT_PUBLIC_LABELING_API_URL` に写す（§11）。

---

## 11. フロントエンド（`src/`）

### 11.1 構成（参考 `src/lib/orders/` / `src/components/orders/` を踏襲）

- `src/app/page.tsx`: **トップページを画面 A〜D のタブ構成ダッシュボードに置換**
  （要件 12.5 / structure 方針）。サンプルページ `src/app/sample/` は残すがナビから外す
  （置換後のトップにはサンプルへのリンクを置かない）。
- `src/lib/labeling/api.ts`: API クライアント。参考 `src/lib/orders/api.ts` と同じ構造
  （ベース URL 解決 = `NEXT_PUBLIC_LABELING_API_URL` のみ、Cognito ID トークン付与、
  型付き例外 `LabelingApiFailure`）。6 ルートの関数（`createBatch` / `listBatches` /
  `getBatch` / `startLabeling` / `listUnitsByBatch` / `listUnitsByLot` / `getConfig`）。
- `src/lib/labeling/progress.ts`: 進捗算術（`labeled_count / unit_count` の百分率、
  完了判定、ETA 概算）。純関数でユニットテスト。
- `src/components/labeling/`: `LabelingDashboard`（タブ外枠）、`BatchRegisterPanel`（画面 A）、
  `BatchListPanel`（画面 B）、`ProgressMonitorPanel`（画面 C）、`UnitTracePanel`（画面 D）、
  `use-batch-polling.ts`（進捗ポーリングフック。参考 `use-execution-polling.ts` を踏襲）、
  `labeling.module.css`。

タブは 4 画面を常時マウント（`hidden` で切替）し、画面 C のポーリングがタブ離脱で
止まらないようにする（参考 `OrderDashboard` と同じ）。認証は既存 `AmplifyProvider` の
`<Authenticator>` 配下（layout.tsx）に全画面が入るため、4 画面とも Cognito 認証配下で
のみ操作できる（要件 8.3 / 9.3 / 10.5 / 11.4）。

**styling 方針の precedence 判断（レビュー指摘 3 への対応）:** styling 手段はグローバル
ステアリング `ui-ux-standards`（Tailwind CSS v4 ユーティリティを必須とし、コンポーネント
ライブラリ・アドホック CSS を禁じる）と、ワークスペースステアリング tech / structure
（既存テンプレートの CSS Modules + `@aws-amplify/ui-react` を踏襲）が真っ向から衝突する。
**ワークスペースレベルのステアリングはグローバルレベルより優先される**ため、本設計は
既存テンプレート・参考 EC PoC（`OrderDashboard`）と地続きの **CSS Modules + `@aws-amplify/ui-react`**
を採り、新規に Tailwind やコンポーネントライブラリは導入しない。ただしアクセシビリティ要件は
styling 手段と独立して両ステアリングが共通に求めるものであり、グローバル規約と**同水準**で満たす:
ラベルと入力の関連付け（`<label htmlFor>`）、`aria-invalid` / `aria-describedby`、
エラーの `role="alert"`、`:focus-visible` の可視化、キーボード操作、レスポンシブ、
最小タップ領域（モバイルで操作可能なボタンサイズ）。この precedence 判断を実装者が迷わないよう
ここに明記する（なぜ Tailwind を採らないか = ワークスペース優先 + 地続きの再現性）。

### 11.2 画面 A（バッチ登録。要件 8）

`item_id` / `lot_id` / `roast_date` / `unit_count` を入力し `POST /batches`。各入力は
`<label htmlFor>` で関連付け、検証エラーは `aria-describedby` + `aria-invalid` + `role="alert"`
（既存 `sample/page.tsx` の様式）。`status=ROASTING_DONE` で登録される。

### 11.3 画面 B（バッチ一覧・付番開始。要件 9）

`GET /batches`（`status=ROASTING_DONE`）で一覧表示。各行に [付番開始] ボタンを置き、
押すと `POST /batches/{id}/labeling-start`。ボタンには「検証トリガー（約 1,000 件を一括投入
します）」の注記を付け、検証者に性質が分かる表示にする（要件 9.4）。

### 11.4 画面 C（付番進捗モニタ。要件 10）

`use-batch-polling.ts` が `GET /batches/{id}` を 1〜2 秒間隔でポーリング（要件 10.1。
参考フックの 3 秒より短く設定）。進捗は `labeled_count / unit_count`（例: 742/1000）の
バーで表示し、根拠は SQS キュー深度ではなく `labeled_count`（要件 10.2）。`status=LABELED`
で完了表示（要件 10.4）。稼働指標（同時実行の立ち上がり）は、**進捗バーをフロントに出し、
CloudWatch の詳細メトリクスはダッシュボードへのリンク誘導**とする（論点 4）。
`backend.addOutput` の情報だけでは個別メトリクスの時系列をフロントで再描画できないため、
リンク誘導（CloudWatch ダッシュボード URL）で十分とし、フロントには進捗バーと
「付番済み/総数・経過時間・直近 1 秒の増分（ポーリング差分から算出）」を出す（要件 10.3）。

### 11.5 画面 D（個体トレース照会。要件 11）

batch 指定 → `GET /units?batchId=`（GSI1）、lot 指定 → `GET /units?lotId=`（GSI2）。
結果テーブルに `status` / `best_before` / `qr_payload` / `labeled_at` を表示（要件 11.3）。

---

## 12. 決定（曖昧点の確定・根拠付き）

本 PoC で確定が必要だった 5 つの論点を、根拠とともに記録する。承認後はこの決定を固定する。

### 決定 1: 画面 A〜D のデータアクセス経路 = API Gateway + Lambda（Cognito 認証）

**選択肢:** (a) API Gateway + Lambda（Cognito オーソライザー）、(b) Amplify data（AppSync/GraphQL）の拡張。

**決定: (a) API Gateway + Lambda を採用する。**

**根拠:** 参考 EC PoC が方式 A（API Gateway + Cognito）を採っており、シリーズとしての
地続き感・リアルさを保つ本 PoC の目的に最も合う。加えて本 PoC は検証用のテーブル
（unit / roast-batch）を `amplify/custom/` の `TableV2` として生の DynamoDB で定義する
方針であり（要件 12.2）、これらは AppSync の管理外にある。(b) を採ると、GSI Query や
条件付き書き込み・`BatchWriteItem`・非同期 invoke といった本 PoC 固有の操作を AppSync の
カスタムリゾルバ（VTL / JS リゾルバ）で表現する必要が生じ、既存 Todo モデルのスキーマにも
手を入れることになって要件 12.1（auth/data を変更しない）に反する。API Gateway + Lambda なら
検証ロジックを素の TypeScript ハンドラに書け、EC PoC のハンドラ様式をそのまま流用できる。

**各操作のエンドポイント割り当て（§4.4 の表を確定）:**
- roast-batch の `PutItem`（画面 A）= `POST /batches`。
- バッチ一覧（画面 B）= `GET /batches`（`status=ROASTING_DONE` フィルタ）。
- seeder 起動トリガー（画面 B の [付番開始]）= `POST /batches/{batchId}/labeling-start`。
- 進捗ポーリング（画面 C）= `GET /batches/{batchId}`。
- GSI Query（画面 D）= `GET /units?batchId=`（GSI1）/ `GET /units?lotId=`（GSI2）。

### 決定 2: seeder の起動方式 = 非同期 invoke + 即 202、進捗は画面 C でポーリング

**選択肢:** (a) 同期 invoke（`RequestResponse`）、(b) 非同期 invoke（`Event`）+ 即 202。

**決定: (b) 非同期 invoke + 即 202 レスポンスを採用する。**

**根拠:** 約 1,000 件の `BatchWriteItem`（約 40 回）は数秒かかる。API Gateway の統合
タイムアウトは上限 29 秒で、同期で待つとバッチサイズを増やした検証や `UnprocessedItems` の
再送が重なった場合にタイムアウトし得る。`POST /batches/{batchId}/labeling-start` は
`InvocationType=Event` で seeder を起動して即 202 を返し、画面 C が `GET /batches/{batchId}` を
ポーリングして `labeled_count` の増加で進捗を見る（参考 EC PoC の負荷生成が 202 + 実行
レコードのポーリングで進捗を追うのと同じ思想）。

**二重起動の抑止（レビュー指摘 1 / HIGH を受けた確定）:** 非同期 invoke は即 202 を返すため、
短時間の二重 [付番開始] で複数の起動要求が走り得る。これを弾く**唯一の判定点を API 層に置く**。
`POST /batches/{batchId}/labeling-start` は seeder を invoke する**前に**、roast-batch を
`UpdateItem`（`ConditionExpression status = :roasting_done`）で `ROASTING_DONE → LABELING` へ
**同期的に確定**させ、`labeling_started_at` を打つ。条件成功時のみ seeder を非同期 invoke して
202 を返し、条件失敗（既に遷移済み）なら seeder を起動せず 409 を返す（§6.4）。これにより
2 本目の seeder はそもそも起動されず、全件 INSERT の二重実行が起きない。遷移が API 層で
先行確定するため、画面 B の `GET /batches`（既定 `ROASTING_DONE`）一覧からも当該バッチは
速やかに消える。seeder 本体は INSERT 前の状態遷移を持たない（§6.1）。当初案（seeder が全件
INSERT 後に遷移）は、非同期 202 の下では 2 本の seeder が両方 INSERT を実行し得て R5 の
観測を汚すため採らない。

### 決定 3: `RELAY_MODE` の切替粒度 = pipes / lambda / both、both の二重配信は冪等で吸収

**切替粒度:** 環境変数 `RELAY_MODE`（`pipes` / `lambda` / `both`）で合成時に入口を選ぶ
（要件 2.7）。`ampx sandbox` に CDK context が届かないため、環境変数が唯一の切替経路
（要件の読み替え表 #2）。許容 3 値以外は `verification-config.ts` が合成を失敗させる
（要件 2.9。既定へ黙って落ちない）。

**both 時の扱い:** both では同一 Unit の INSERT が Pipes 経由と router 経由の両方から
SQS に届き、**二重配信**になる（要件 2.8）。これは比較用途（両入口を同一シナリオで同時に
流し、立ち上がりカーブを並べて観測する）に限って許容する。二重配信は worker の条件付き
書き込み `attribute_not_exists(best_before)`（要件 3.5）で冪等に吸収され、2 回目の付番は
弾かれて `labeled_count` も二重加算されない（要件 3.7）。したがって completeness（要件 4）は
崩れない。**ただし** both では SQS の投入件数が約 2 倍になり、worker の `Invocations` と
`ConcurrentExecutions` の立ち上がりは単一入口のときと直接比較できない点をダッシュボードの
注記に明示する（比較は「どちらの入口でも 1,000 まで張り付くか」の定性比較に留める）。

### 決定 4: 画面 C の稼働指標 = 進捗バーは必須・フロント、CloudWatch はリンク誘導

**決定:** 進捗バー（`labeled_count / unit_count`）はフロントに必須で出す（要件 10.1 / 10.2）。
同時実行の立ち上がり等の CloudWatch メトリクスは、**フロントで時系列グラフを再描画せず、
CloudWatch ダッシュボードへのリンク誘導**で足りるとする（要件 10.3 の「導線」を満たす）。

**根拠:** `ConcurrentExecutions` や `IteratorAge` の時系列をフロントに出すには Lambda 側に
CloudWatch `GetMetricData` 権限と専用 API を足す必要があり、本 PoC の主眼（SQS ファンアウトの
IaC と観測）から外れる付随実装が増える。立ち上がりカーブの精緻な観測はダッシュボードの
役割（§8.1、要件 7）であり、フロントはそこへ誘導すれば二重に作らずに済む。フロントが
ポーリング差分から算出できる軽量な稼働感（直近 1 秒の付番増分、経過時間、ETA）は
`progress.ts` の純関数で出し、業務の言葉（742/1000）での張り付き実感を担保する。

### 決定 5: 負荷生成（複数バッチ同時）= 最小構成（画面 A で複数登録→画面 B で順次 [付番開始]）

**決定:** 専用の負荷生成ツールは作らない。画面 A で複数バッチを登録し、画面 B で各バッチの
[付番開始] を順次（または短時間に連続して）押すことで複数バッチ同時の滞留を作る最小構成を採る。

**根拠:** 本 PoC の中心的な問いは「1 ロット分（約 1,000 個）を同時付番したときに
`MaximumConcurrency` まで張り付くか」であり、1 バッチ約 1,000 件の INSERT で既に worker の
同時実行を 1,000 近くまで押し上げるだけの滞留が作れる。複数バッチ同時は「さらに積んでも
`MaximumConcurrency` が上限として効くか」の確認用で、画面 B から複数バッチの seeder を
相次いで起動すれば SQS に重畳的に滞留が積まれ、専用ツールなしで観測できる。EC PoC の
`load-generator` のような自己再帰ワーカーは、投入レートを精密に制御して消費能力の壁を
測る前作の目的に特化した装置であり、本作の「同時実行枠までの張り付き」確認には過剰である。
将来さらに大きな負荷を精密制御したくなった場合は、seeder を複数回・パラメトリックに叩く
軽量スクリプト（`docs/` のシナリオ手順）で足し、IaC には load-generator 関数を増やさない。

---

## 13. エラーハンドリング（操作ごと）

| 操作 | 失敗条件 | 回復可否 | 呼び出し元が受け取るもの | ログ |
|------|---------|---------|--------------------------|------|
| 合成時の `RELAY_MODE` / 数値パラメータ解決 | 許容値外・解釈不能 | 致命（デプロイ中止） | `VerificationConfigError`（全誤りをまとめて報告） | CDK 合成ログ（§4.1） |
| seeder の `BatchWriteItem` | `UnprocessedItems` 残 | 回復（指数バックオフ再送、上限 N 回） | 上限超過時は 500 相当（検証者の入力は正しく、原因はテーブル状態） | 再送は warn、上限超過は error |
| API `POST /labeling-start` の条件付き遷移 | `status != ROASTING_DONE`（二重押下・処理中） | 回復（2 回目を無害化） | `ConditionalCheckFailed` → seeder を invoke せず 409 Conflict を返す（§6.4。二重起動の唯一の判定点） | info |
| router の `SendMessageBatch` | 一部失敗 | 回復（部分再試行） | `batchItemFailures` で該当分のみ再試行 | warn |
| router/worker の Streams/SQS 恒久失敗 | retry 上限到達 | 隔離 | DLQ（Streams DLQ はメタデータのみ、SQS DLQ はメッセージ本体） | — |
| worker の付番 `UpdateItem` | `attribute_not_exists(best_before)` 不成立 | 正常（冪等） | 成功扱い。`labeled_count` 加算せず（要件 3.7） | info |
| worker の付番 `UpdateItem` | スロットル・一時障害 | 回復（再試行） | 当該メッセージを `batchItemFailures` に報告（要件 3.9） | warn |
| worker の完了遷移 `UpdateItem` | `labeled_count=:n AND status=:labeling` 不成立 | 正常 | 既遷移。`labeling_finished_at` を上書きしない（要件 4.4） | info |
| API: 入力不正 | 必須欠落・型不一致・範囲外 | 回復（呼び出し側が直す） | 400 + `{ error, message, details? }`（参考 §E-1 様式） | warn |
| API: 認証なし/失効 | ID トークン欠落・無効 | 回復（再ログイン） | API Gateway が 401（Cognito オーソライザー） | — |
| API: `GET /batches/{id}` の対象なし | 存在しない batch（単体 `GetItem`） | 回復 | 404（`{ error, message }`） | warn |
| API: `GET /units` の該当なし | 該当 Unit 0 件（GSI Query 一覧） | 正常 | 200 + 空配列（`[]`。一覧なので 404 は返さない） | info |
| API: `POST /labeling-start` の重複 | 既に `LABELING`/`LABELED`（二重押下） | 回復（無害化） | 409 Conflict（seeder は起動しない。§6.4） | info |
| フロント API クライアント | fetch 失敗 / CONFIG 未設定 / HTTP エラー | 画面で分岐 | `LabelingApiFailure`（`kind`: CONFIG/REQUEST/NETWORK/HTTP） | コンソール（値は出さない） |

「適切にエラー処理する」ではなく、各操作の失敗条件・回復性・呼び出し元への返り値・
ログ水準を上表で確定する。入力ミス（warn）とシステム異常（error）を分け、ERROR ログの
件数をシステム側異常の指標にする（参考 EC PoC と同じ運用）。

---

## 14. 入力バリデーション（外部入力ごと）

| 入力 | 必須/任意 | 型・制約 | 失敗時の挙動 |
|------|----------|---------|--------------|
| `POST /batches` の `item_id` | 必須 | 文字列、`ITEM#` 接頭辞 | 400 |
| `POST /batches` の `lot_id` | 必須 | 文字列、`LOT#` 接頭辞 | 400 |
| `POST /batches` の `roast_date` | 必須 | ISO 8601 日付 | 400 |
| `POST /batches` の `unit_count` | 任意（既定 1000） | 整数 1〜`SEED_UNIT_COUNT_MAX` | 範囲外は 400 |
| `{batchId}` パスパラメータ | 必須 | 非空文字列（`#` を含む。フロントが `encodeURIComponent`、Lambda は API GW デコード済みの `event.pathParameters.batchId` をそのまま使う。§4.4） | 空は 400、未存在は 404 |
| `GET /batches` の `?status=` | 任意（既定 `ROASTING_DONE`） | 列挙 `ROASTING_DONE`/`LABELING`/`LABELED` のいずれか | 許容外は 400（既定へ読み替えない） |
| `GET /units` の `batchId`/`lotId` | いずれか必須 | 排他。両方/両方なしは 400 | 400 |
| 環境変数（§4.1 の表） | 既定ありは任意 | 表の範囲 | 合成時 `VerificationConfigError`、実行時 `RuntimeConfigError` |
| SQS メッセージ本文 | 必須 | §3.4 のスキーマ。`unit_id` 必須 | 解釈不能は当該メッセージを失敗報告（DLQ 行き） |

検証は API ハンドラ入口（合成時値は `verification-config.ts`）で行い、無効値を既定へ
読み替えない（非機能 5）。

---

## 15. 不変条件とその所有層

| 不変条件 | 所有層 | 理由 |
|----------|--------|------|
| 1 Unit は高々 1 回だけ付番される | worker の `attribute_not_exists(best_before)` 条件（DDB） | 二重配信（RELAY_MODE=both）や SQS の at-least-once 配信があっても、条件付き書き込みが唯一の真実の判定点。アプリ側の重複検知より確実 |
| `labeled_count` は付番成功ごとに正確に +1 | worker の `ADD 1`（成功時のみ）（DDB アトミック更新） | 複数 worker が並行加算しても `ADD` はアトミック。条件成功時だけ呼ぶため二重加算しない |
| 完了遷移はちょうど 1 回 | worker の `labeled_count=:n AND status=:labeling` 条件（DDB。`:n`=`unit_count` 固定値） | `:n` に当該 batch の `unit_count`（`payload.unit_count` から束縛。§3.4 / HIGH-1・案 B）を固定で入れるため、単調増加する `labeled_count` がちょうど一致するのは 1 回だけ。status ガードが既遷移を弾く。1,000 多重のどれが最後の 1 件を付けても条件成立は 1 回。キュー深度に依存しない（要件 4.3） |
| INSERT だけが SQS に乗る | ESM フィルタ（Pipes/Streams）+ ハンドラ二次ガード（構造） | フィルタが無いと MODIFY も転送され観測が汚れる。構造として固定しテストで検査（§4.3.3） |
| 入口は RELAY_MODE が選んだものだけ有効 | `verification-config.ts` + `LabelingStream` の合成分岐 | 許容値外は合成失敗。both の二重配信は冪等で吸収（決定 3） |

---

## 16. テスタビリティ

### 16.0 テスト基盤の導入（本 PoC のスコープに含む。レビュー指摘 3 への対応）

本テンプレートの `package.json`（確認済み）には **vitest も `aws-cdk-lib/assertions` 用の型も
`@types/aws-lambda` も含まれていない**（`scripts` は `dev`/`build`/`start`/`lint` のみ、
`devDependencies` に `aws-cdk-lib`・`esbuild`・`tsx` 等はあるがテストランナーは無い）。
下記のユニットテスト・合成テストを「最も狭い検証を最初に」（testing 方針）回せるようにするには、
テスト基盤の導入自体を本 PoC のスコープに含める必要がある。実装フェーズで次を追加する:

- **devDependency 追加（バージョンはピン止め）:**
  - `vitest`（ユニットテスト + 合成テストのランナー。本リポジトリの Next/ESM 構成と相性がよい）。
  - `@types/aws-lambda`（Lambda ハンドラのイベント型。参考 EC PoC と同じ）。
  - `aws-sdk-client-mock` + `aws-sdk-client-mock-jest`（DDB/SQS/Lambda クライアントのモック。
    worker/seeder/router の副作用境界をテストする純ロジック周りで使用）。
  - CDK 合成テストは既存 `aws-cdk-lib` 同梱の `aws-cdk-lib/assertions`（`Template`）を使うため
    追加依存は不要。
  - バージョン方針: 新規追加はすべて**正確なピン止め**（キャレット無し）で `package.json` に記す
    （security 方針「明示的な設定を優先」/ 依存の再現性）。
- **`package.json` のスクリプト追加:** `"test": "vitest --run"`、`"test:watch": "vitest"`
  （参考 EC PoC の `"test": "vitest --run"` に表記を揃える。`vitest run` と挙動は同一だが、
  地続き感のため参考に合わせる。レビュー指摘 6）。
- **CI:** `.github/workflows/ci.yml`（Web App lint + 型チェック）に `npm run test` を 1 ステップ
  追加し、ユニット + 合成テストを lint/型チェックと同じワークフローで回す（testing 方針
  「CI は明らかな問題で早期に失敗させる」/ 合成テストで配線ミスを早期検知）。実機デプロイを
  伴う結合テスト（§16 末尾）は CI に含めない（Cognito + API Gateway + sandbox が必要なため）。
- **CI の Node バージョンを 22 へ引き上げる（決定。レビュー指摘 2 への対応）:** 現行 `ci.yml` の
  `actions/setup-node` は `node-version: 20`（確認済み）だが、本 PoC の Lambda ランタイムは
  **Node.js 22.x**（§1.1 / §6）で確定している。ユニット/合成テスト自体は node 20 でも通る見込みだが、
  ランタイム 22.x を前提にしたハンドラコード（22 系 API・`@types/aws-lambda` との整合）を 20 の CI で
  検査すると、ローカル sandbox・本番ランタイムと CI の間に乖離が生じる。地続きの再現性を優先し、
  **CI の `setup-node` を `node-version: 22` に引き上げて Lambda ランタイムと揃える**（この 1 行変更も
  本 PoC のスコープに含む）。これにより lint・型チェック・テストすべてがランタイムと同一メジャーで
  走り、「CI は明らかな問題で早期に失敗させる」（testing 方針）が実ランタイム基準で効く。
  `ci.yml` は IAM/デプロイには触れない lint/test ワークフローのため、本変更の影響は CI のみ
  （Amplify Hosting ビルドや AgentCore には波及しない）。

**ユニットテスト（vitest）** — 参考 EC PoC が各モジュールに `*.test.ts` を併置するのに倣う。
副作用を持たない純ロジックを対象にする:
- `verification-config.ts`: 範囲内/外、RELAY_MODE の 3 値と不正値、既定フォールバック。
- `shared/qr.ts`: `qr_payload` 生成の決定性。
- `labeling-worker/labeling.ts`: `best_before` 計算（うるう年跨ぎ含む）、更新式・完了判定の組み立て。
- `labeling-router/to-message.ts`: Streams レコード→ペイロード射影（`NewImage.unit_count` を
  ペイロードへ写すことを含む。HIGH-1・案 B）、INSERT ガード、10 件チャンク化。
- `seeder/seed-plan.ts`: Unit 生成（各 Unit に batch の `unit_count` を非正規化して付与することを
  含む。HIGH-1・案 B）、25 件チャンク化、`UnprocessedItems` 再送計画。
- `src/lib/labeling/api.ts`: ベース URL 解決、エラー分類、ID トークン付与（provider 差し替え）、
  `#` を含む batchId のエンコード（`encodeURIComponent` でパス/クエリ値を安全化。レビュー指摘 MEDIUM-1）。
- `src/lib/labeling/progress.ts`: 進捗率・完了判定・ETA。
- `src/components/labeling/`: タブのキーボード操作・ポーリング停止条件。

**合成テスト（CDK `Template.fromStack`）** — 参考の `*.test.ts`（CDK 合成検査）に倣う:
- ESM/Pipes のフィルタが `eventName=INSERT` で固定されていること。
- worker ESM の `MaximumConcurrency` が config を反映すること。
- SQS が `SQS_MANAGED` + `enforceSSL` + `DESTROY` であること。
- API 全ルートに Cognito オーソライザーが付き、OPTIONS は NONE であること。
- SQS 可視性タイムアウトが 360 秒（worker タイムアウト 60 秒 × 6）であること。
- `MaximumConcurrency` に 1 を与えると `verification-config.ts` が合成を失敗させること（下限 2 の自前検証）。
- 全テーブル/キューが `DESTROY` であること、backend が循環参照しないこと。
- 合成側キー名と実行時側キー名（`runtime-config.ts`）の突き合わせ。

ユニットテストには **`labeling-api` の `POST /labeling-start` の条件付き遷移ロジック**も含める
（`ROASTING_DONE` のとき遷移 + seeder invoke、既遷移のとき `ConditionalCheckFailed` → 409・
invoke しない。レビュー指摘 1 の二重起動抑止が API 層で効くことの検査）。`GET /batches` の
`?status=` 既定 `ROASTING_DONE`・許容 3 値・許容外 400 の分岐も対象にする（レビュー指摘 4）。

**結合テスト（手動 / sandbox）** — ローカルではフロント・バックエンドの結合はできない
（Cognito + API Gateway が要るため。testing 方針）。sandbox デプロイ後に §17 のシナリオで
手動検証する。CDK 合成が通ること（`npx ampx sandbox` の合成フェーズ）を最初の最も狭い検証とし、
その後に 1 バッチ投入→SQS 流入→worker 張り付き→完了遷移→画面 D トレースを確認する。

テストしづらい箇所（Pipes の L1、SQS の at-least-once 挙動）は、ロジックを純関数に寄せ
（ペイロード射影・冪等判定を worker/router のハンドラ外に出す）、配線の正しさは合成テストで
担保する設計にしている。1,000 多重の実測（R5）は性質上 sandbox での実機観測でしか確認できない。

---

## 17. 検証シナリオ（手順の骨子・`docs/` に詳細）

1. `RELAY_MODE` を選んで `npx ampx sandbox`（合成が通ることを最初に確認）。
2. 画面 A で RoastBatch を 1 件登録（`unit_count≈1000`、`status=ROASTING_DONE`）。
3. 画面 B で [付番開始] → seeder が非同期起動（202）→ 約 1,000 件が PENDING で INSERT →
   `status=LABELING`。
4. Streams（INSERT）→ 入口（pipes/lambda）→ SQS → worker が多重起動。
   ダッシュボードで worker の `ConcurrentExecutions` が `MaximumConcurrency` 付近に張り付くことを観測（R5）。
   **`RELAY_MODE=pipes` / `both` のとき、Pipes `inputTemplate` が組み立てた `unit_id` が
   `buildUnitId`（§3.4）と完全一致することを境界ケースで突き合わせる（レビュー指摘 NIT-1）:**
   SQS 受信メッセージ（または worker ログ）で `seq=1`（`-000001`）、`seq=unit_count`
   （例 `-001000`）、`BATCH#` 剥がし後の本体の 3 ケースを確認し、`unit_id` の衝突・不一致が
   無いこと（＝ worker の冪等条件が効くこと）を確かめる。あわせて SQS ペイロードに
   `unit_count` が載っていること（HIGH-1・案 B）、かつ **JSON 数値（文字列ではない）として
   運ばれていること**を確認する（Pipes `inputTemplate` の `<$.dynamodb.NewImage.unit_count.N>`
   が数値のまま射影されるかは合成では担保できない。design-review NIT-1）。worker の
   `parsePayload` は `typeof unit_count !== "number"` を弾くため、文字列化された場合は当該
   メッセージが失敗報告 → 再試行/DLQ となる。SQS 受信メッセージ（または worker ログ）で
   `unit_count` が `"1000"` ではなく `1000` であることを目視確認する。
5. 画面 C で `labeled_count/unit_count` が増え、達成で `status=LABELED`・`labeling_finished_at` 確定。
6. 画面 D で batch/lot から Unit をトレース（`best_before`/`qr_payload`/`labeled_at`）。
7. `RELAY_MODE` を変えて再デプロイし、入口方式の立ち上がりカーブを比較（R5 / 要件 5.5）。
8. 複数バッチ同時は 2〜4 を複数バッチで相次いで実行（決定 5）。
9. 検証後は sandbox 削除で `SqsLabelingPoc` スタックごと一括破棄（既存 Todo は温存）。

---

## 18. 要件トレーサビリティ（R1〜R5 と曖昧点の反映確認）

| 要件 | 反映箇所 |
|------|----------|
| R1 / 要件 1（滞留生成・seeder） | §6.1、決定 2、§13（seeder 行）、§17-3 |
| R2 / 要件 2（中継・両方式） | §4.3.2〜4.3.5、§6.2、決定 3 |
| R3 / 要件 3（付番ワーカー） | §4.3.4、§6.3、§15（冪等/加算）、§13（worker 行） |
| R4 / 要件 4（完了検知） | §6.3-4（`:n`=`unit_count` 固定・ちょうど 1 回の根拠）、§3.1/§3.4（`unit_count` 取得経路＝案 B）、§15（完了遷移） |
| R5 / 要件 5（最大 1,000 多重） | §2.3、§4.3.4、§8.1（一次指標）、決定 3/4、§17-4/7 |
| 要件 6（SQS 標準キュー） | §4.3.1、§16（合成テスト） |
| 要件 7（CloudWatch 可視化） | §8.1、§8.2 |
| 要件 8〜11（画面 A〜D） | §4.4、§6.4、§11.2〜11.5、決定 1/4 |
| 要件 12（既存共存） | §2.2、§10、§11.1 |
| 曖昧点 1（データアクセス経路） | 決定 1 / §4.4 |
| 曖昧点 2（seeder 起動方式） | 決定 2 / §6.1 |
| 曖昧点 3（RELAY_MODE 粒度・both） | 決定 3 / §4.3.5 / §15 |
| 曖昧点 4（画面 C 稼働指標） | 決定 4 / §11.4 |
| 曖昧点 5（複数バッチ同時負荷） | 決定 5 / §17-8 |

---

## 19. 設計レビューへの対応（`.agents/tasks/design-review.md` の指摘）

本節は複数回のレビューラウンドへの対応を記録する。§19.1 が第 1 ラウンド、§19.2 が第 2 ラウンド、
§19.3 が第 3 ラウンド（現行の `.agents/tasks/design-review.md` / `.json`）である。いずれも
要件 R1〜R5・曖昧点 1〜5 の決定（§12）と整合しており、バックログ・無視した指摘は無い。

### 19.1 第 1 ラウンド（verdict: CHANGES_REQUESTED、HIGH 1 / MEDIUM 3 / NIT 4）

本節は設計レビュー第 1 ラウンドの各指摘への対応を記録する。指摘内容は要件 R1〜R5 と照らして、
すべて**対応（修正を反映）**した。

| # | 重大度 | 指摘要旨 | 対応 | 反映箇所 |
|---|--------|---------|------|----------|
| 1 | HIGH | seeder の二重起動抑止が決定 2 と §6.1 で矛盾（非同期 202 下で 2 本の seeder が両方 INSERT し得る） | **対応**。レビュー案 (b) を採用。二重起動の判定点を **API 層（`POST /labeling-start`）の同期・条件付き `UpdateItem`（`status=:roasting_done`）に一本化**し、条件成功時のみ seeder を非同期 invoke、失敗時は 409 で invoke しない。seeder 本体は INSERT 前遷移を持たない。これにより 2 本目の seeder が起動されず R5 の観測が汚れない。 | §6.1 / §6.4（labeling-start）/ 決定 2 / §2.1 図 / §13 / §15 |
| 2 | MEDIUM | `DATA_TTL_DAYS` が存在しない TTL 属性を参照 | **対応**。レビュー案 (b) を採用し `DATA_TTL_DAYS` を §4.1 の表から**削除**。破棄は `RemovalPolicy.DESTROY` + sandbox 削除（非機能 2）で足りる旨と、将来 TTL 採用時の拡張点（`expires_at` + `timeToLiveAttribute`）を注記。 | §4.1（削除 + 注記） |
| 3 | MEDIUM | vitest 等テスト基盤が未確認・導入手順が設計に無い | **対応**。§16.0 を新設。`vitest` / `@types/aws-lambda` / `aws-sdk-client-mock(-jest)` の devDependency 追加（ピン止め）、`test` スクリプト、`aws-cdk-lib/assertions` 利用、CI（`ci.yml`）での `npm run test` 実行を明記。 | §16.0 |
| 4 | MEDIUM | `GET /batches` のアクセスパターンが §4.4 と §6.4 で不一致 | **対応**。`?status=` 既定 `ROASTING_DONE`、許容 3 値（`ROASTING_DONE`/`LABELING`/`LABELED`）、許容外 400 に一本化。「全ステータスを返す」挙動は削除（画面 C は単体 `GET /batches/{id}` を使う）。§14 に `?status=` 行を追加。 | §4.4 / §6.4 / §14 / §16 |
| 5 | NIT | `MaximumConcurrency` 下限 2 を「CDK/CFN の制約」と帰属するのは不正確 | **対応**。「CDK 合成では検証されず、CloudFormation/SQS サービス制約として有効範囲 2〜1,000。1 指定はデプロイ時に失敗。よって `verification-config.ts` で下限 2 を自前検証して合成を止める」と書き換え。 | §4.1 |
| 6 | NIT | 「API Gateway は既定で ID トークンを検証」が不正確 | **対応**。「Cognito オーソライザーは `Authorization` の JWT（ID / アクセストークン双方）を検証し、フロントは EC PoC に合わせ ID トークンを送る」に修正。 | §4.4 |
| 7 | NIT | `BEST_BEFORE_DAYS` 可変化は要件 3.2（固定 365）からの軽微な逸脱 | **対応**。既定 365 で要件準拠であること、上書き可能は検証利便のための軽微な拡張であることを 1 行明記（固定化はせず可変を維持）。 | §4.1 / §6.3 |
| 8 | NIT | `visibilityTimeout = worker.timeout * 6` の具体値・出典が暗黙 | **対応**。`Duration.seconds(360)`（worker タイムアウト 60 秒 × 6＝AWS 推奨）と確定値で記述。`batchSize` 変更時の見直し、合成時警告にも言及。 | §4.3.1 / §16 |

### 19.2 第 2 ラウンド（verdict: CHANGES_REQUESTED、HIGH 0 / MEDIUM 3 / NIT 4）

本節は現行レビュー（`.agents/tasks/design-review.md` / `design-review.json`）の各指摘への対応を
記録する。第 1 ラウンドで HIGH（二重起動）は解消済みと確認されており、本ラウンドの指摘は
テンプレート実態との不整合・採番規則の未確定・styling 方針の precedence 未記載である。
7 件すべてを要件 R1〜R5 と照らして**対応（修正を反映）**した。バックログ・無視した指摘は無い。

| # | 重大度 | 指摘要旨 | 対応 | 反映箇所 |
|---|--------|---------|------|----------|
| 1 | MEDIUM | 冪等キー `unit_id` の採番規則が例示のみでルール未確定（seeder/Pipes/router/worker が食い違い得る） | **対応**。§3.4 に採番規則を唯一の出典として確定: `unit_id = 'UNIT#' + <BATCH# を除いた本体> + '-' + String(seq).padStart(6,'0')`、`seq` は batch 内 1 始まり・6 桁ゼロ埋め・`BATCH#` は含めない。`shared/unit-keys.ts` の `buildUnitId` を唯一の実装とし、seeder/router が呼ぶ。Pipes `inputTemplate` は同一文字列を組み立て、一致を §16 の結合テスト（実機）で突き合わせる。採番の決定性をユニットテストで保証。 | §3.4 / §6.6 / §16 |
| 2 | MEDIUM | CI の node 20 と Lambda ランタイム 22.x の不整合に設計が未言及 | **対応**。レビュー案 (a) を採用。**CI の `setup-node` を `node-version: 22` へ引き上げて Lambda ランタイム 22.x と揃える**ことを §16.0 に決定として明記（この 1 行変更も PoC スコープ）。lint/型チェック/テストが実ランタイムと同一メジャーで走り、早期失敗が実基準で効く。影響は CI のみ（Amplify Hosting/AgentCore に波及しない）。 | §16.0 |
| 3 | MEDIUM | グローバル UI/UX ステアリング（Tailwind 必須）との styling 方針衝突が設計で未解決 | **対応**。§11.1 に precedence 判断を明記。ワークスペースステアリング（tech/structure = CSS Modules）がグローバル `ui-ux-standards`（Tailwind）より優先されるため CSS Modules + `@aws-amplify/ui-react` を採る。ただしアクセシビリティ要件（ラベル関連付け・`aria-invalid`/`aria-describedby`・`role="alert"`・focus-visible・キーボード・レスポンシブ・最小タップ領域）はグローバル規約と同水準で満たすと明記。 | §11.1 |
| 4 | NIT | 完了遷移 `labeled_count = :n` の `:n` 束縛値が未明示 | **対応**。§6.3-4 に「`:n` には当該 batch の `unit_count` を束縛する」と明記。完了遷移は `labeled_count = unit_count` かつ `status = LABELING` のときだけ成立すると言明。 | §6.3-4 |
| 5 | NIT | `qr_payload` の文字列フォーマットが未確定 | **対応**。§6.3-2 に `qr_payload = JSON.stringify({ unit_id, item_id, best_before })` を唯一の出典として確定。キー順を固定し決定性をユニットテストで保証。JSON を採る理由（将来の QR 化・トレース表示での扱いやすさ）も明記。 | §6.3-2 / §6.6 |
| 6 | NIT | テストスクリプト名が参考 EC PoC（`vitest --run`）と不統一（設計は `vitest run`） | **対応**。`"test": "vitest --run"` に揃える（挙動同一・地続き感のため）。 | §16.0 |
| 7 | NIT | seeder が read する `unit_count` と `POST /batches` 既定（1000）の確定経路が暗黙 | **対応**。§6.4 の `POST /batches` 行に「`unit_count` 省略時は既定 1000 を確定値として PutItem する（補完の所有は API 層、seeder は補完しない）」と明記。seeder が未定義値を読む可能性を排除。 | §6.4 |

いずれの対応も要件 R1〜R5・曖昧点 1〜5 の決定（§12）と整合しており、バックログ・無視した指摘は無い。

### 19.3 第 3 ラウンド（verdict: CHANGES_REQUESTED、HIGH 1 / MEDIUM 2 / NIT 3）

本節は現行レビュー（`.agents/tasks/design-review.md` / `design-review.json`）の各指摘への対応を
記録する。HIGH-1 は worker の完了検知が参照する `unit_count` の取得経路が未定義かつ IAM と矛盾する
という R4 中核のブロッカーであり、**案 B（unit に `unit_count` を非正規化）を採用して解消**した。
6 件すべてを要件 R1〜R5・決定（§12）と照らして**対応（修正を反映）**した。バックログ・無視した
指摘は無い。

| # | 重大度 | 指摘要旨 | 対応 | 反映箇所 |
|---|--------|---------|------|----------|
| HIGH-1 | HIGH | worker の完了検知が参照する `unit_count` の取得経路が未定義（SQS ペイロードに無く、worker IAM にも roast-batch `GetItem` が無い）＝ R4 が実装不能で IAM と矛盾 | **対応・案 B を採用**。Pipes 経路は `NewImage`（unit レコード）からしか射影できないため、`unit_count` を **unit に非正規化**するのが Pipes/中継 Lambda 両方式で成立する唯一の素直な解。(1) §3.1 の unit 属性に `unit_count`（N）を追加、seeder が §6.1 の `GetItem` 値を全 Unit に同一値で付与。(2) §3.4 の SQS ペイロードに `unit_count`（Number）を追加（約 250 バイトから微増）、Pipes `inputTemplate` と router が `NewImage.unit_count` を射影。(3) worker は追加読み取りなしに `:n = payload.unit_count` を束縛、IAM は roast-batch `UpdateItem` のみ（`GetItem` を足さず最小権限維持）。(4) requirements.md の unit テーブル定義にも `unit_count` を追記し整合。 | §3.1 / §3.4 / §4.3.2 / §6.1 / §6.2 / §6.3-4 / §6.5（据え置き）/ §15 / §16 / requirements データモデル |
| MEDIUM-1 | MEDIUM | `{batchId}`（`BATCH#...`、`#` を含む）の encode/decode 責務が未確定で画面 B/C が動かないリスク | **対応**。§4.4 に確定: フロント `src/lib/labeling/api.ts` が `encodeURIComponent(batchId)` でパス/クエリ値をエンコード、Lambda は API GW デコード済みの `event.pathParameters.batchId`（`GET /units?batchId=` はクエリ値）をそのまま使う。§14 の `{batchId}` 行も更新。§16 のユニットテストに「`#` を含む batchId のエンコード」ケースを追加。 | §4.4 / §14 / §16 |
| MEDIUM-2 | MEDIUM | 完了遷移がちょうど 1 回成立する根拠（`:n` 固定 + 単調増加 + status ガード）が §6.3-4 本文に未明示で `:n` 誤読の余地 | **対応**。§6.3-4 本文に明記: `:n` は当該 batch の `unit_count`（固定値。自分が ADD で読んだ値ではなく `payload.unit_count` から束縛）。`labeled_count` は単調増加で `unit_count` に一致する瞬間は 1 回、かつ `status=:labeling` ガードで既遷移を弾くため成立は厳密に 1 回。ADD 応答の `labeled_count` は完了遷移を**試みるトリガー**であり判定基準は条件式側の `labeled_count=unit_count` である旨を添える。§15 の不変条件行も `:n`=`unit_count` 固定で更新。 | §6.3-4 / §15 |
| NIT-1 | NIT | Pipes `inputTemplate` の `unit_id` 文字列射影が未検証前提と自認 | **対応**。§4.3.2 に突き合わせの具体ケース（`seq=1` → `-000001` / `seq=unit_count` → 桁境界 / `BATCH#` 剥がし）を §17 シナリオに固定して実機で突き合わせると明記。§17-4 に実機確認手順を追記。 | §4.3.2 / §17-4 |
| NIT-2 | NIT | 入口別比較ウィジェットの Pipes 側メトリクスが曖昧 | **対応**。§8.1 で Pipes 側を `AWS/Pipes` の `Invocations`（PipeName）、router 側を `AWS/Lambda` の `Invocations` と確定。`both` 時は SQS `NumberOfMessagesSent` が両入口合算で分離不可の制約を注記（定性比較に留める）。 | §8.1 |
| NIT-3 | NIT | §13 の `GET /units` 空配列と単体取得 404 の区別が二重 | **対応**。§13 の該当行を「`GET /batches/{id}` 未存在 → 404 / `GET /units` 該当なし → 200 + 空配列」とルートごとに分割。 | §13 |

いずれの対応も要件 R1〜R5・曖昧点 1〜5 の決定（§12）と整合しており、バックログ・無視した指摘は無い。
