# Amplify Gen 2 業務 Web アプリテンプレート

AWS Amplify Gen 2 を中核にした業務 Web アプリケーション用のスターターテンプレートです。
オプションで Strands Agents による AI エージェント機能を追加できます。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js + TypeScript |
| バックエンド | AWS Amplify Gen 2 |
| エージェント UI（任意） | CopilotKit（`@copilotkit/react-core/v2`）+ AG-UI プロトコル |
| エージェント（任意） | Python 3.12〜3.13 / Strands Agents SDK + ag-ui-strands |
| エージェント実行基盤（任意） | Amazon Bedrock AgentCore Runtime |
| エージェント管理（任意） | AgentCore CLI (`@aws/agentcore`) |
| ホスティング | Amplify Hosting |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## ディレクトリ構成

```
src/                    # フロントエンド（Next.js App Router）
  app/api/copilotkit/   # CopilotKit Runtime API Route（SigV4 → AgentCore プロキシ）
  lib/agent/            # CopilotProvider（認証 + CopilotKit 接続）
  components/agent/     # AgentChatSection（CopilotChat UI）
amplify/                # Amplify Gen 2 バックエンド定義
agents/                 # エージェント（任意、AgentCore CLI 管理）
  agentcore/            # AgentCore CLI 設定
  app/                  # エージェントコード
docs/                   # 詳細ドキュメント
.kiro/                  # Kiro ワークスペース設定
.github/                # CI/CD
```

---

## SQS 付番バッチ処理 PoC（Streams → SQS ファンアウト・最大 1,000 多重）

Kiro Roasters の「焙煎後の梱包バッチ処理」を題材に、DynamoDB Streams に滞留した
約 1,000 個の個体を SQS でファンアウトし、`labeling-worker` を最大 1,000 多重で立ち上げて
一斉に付番する検証環境です。入口（Streams → SQS の中継）がボトルネックにならないか、
`MaximumConcurrency` まで本当に張り付くかを観測します。

本 PoC のリソースは既存の auth（Cognito）/ data（Todo）とは別のネストスタック
`SqsLabelingPoc` に分離して共存します。既存の Todo / サンプルページは変更・削除しません。

### 構成図（design §2.1 全体像）

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
- `both` の二重配信は worker の冪等条件（§6.3 の条件付き UpdateItem）で吸収され、`labeled_count` も二重加算されません。
- 画面 A〜D はトップページ（`src/app/page.tsx`）のタブ構成ダッシュボードです。

### セットアップ

```bash
# 1. 依存をインストール
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

> `amplify_outputs.json` は sandbox が生成するローカルファイルでコミット対象外です。
> `.env.local` も同様にコミットしません（シークレットや環境固有値をリポジトリに含めない）。

### 検証シナリオ（design §17）

1. `RELAY_MODE` を選んで `npx ampx sandbox`（まず合成が通ることを確認する）。
2. 画面 A で RoastBatch を 1 件登録する（`unit_count≈1000`、`status=ROASTING_DONE`）。
3. 画面 B で [付番開始] → seeder が非同期起動（即 202）→ 約 1,000 件が PENDING で INSERT →
   `status=LABELING` に遷移する。
4. Streams（INSERT）→ 入口（pipes/lambda）→ SQS → worker が多重起動する。
   CloudWatch ダッシュボードで worker の `ConcurrentExecutions` が `MaximumConcurrency`
   付近に張り付くことを観測する（R5）。

   **Pipes の文字列射影を実機で突き合わせる 3 境界ケース（design-review NIT-1）:**
   `RELAY_MODE=pipes` / `both` のとき、Pipes `inputTemplate` が組み立てた `unit_id` が
   `buildUnitId`（§3.4）と完全一致することを、SQS 受信メッセージ（または worker ログ）で
   以下 3 ケース突き合わせる。
   - `seq=1` → サフィックスが `-000001`（ゼロ埋め先頭）
   - `seq=unit_count` → サフィックスが桁境界（例 `-001000`）
   - `BATCH#` を剥がした本体部分が一致（`unit_id` の衝突・不一致が無い＝ worker の冪等条件が効く）

   あわせて SQS 受信ペイロードの `unit_count` が JSON の数値（Number）のまま保たれていること
   （文字列化されると worker の `labeled_count = :n` 比較で型不一致になり得る）を確認する。
5. 画面 C で `labeled_count/unit_count` が増え、達成で `status=LABELED`・`labeling_finished_at` が確定する。
6. 画面 D で batch / lot から Unit をトレースする（`best_before` / `qr_payload` / `labeled_at`）。
7. `RELAY_MODE` を変えて再デプロイし、入口方式の立ち上がりカーブを比較する（R5 / 要件 5.5）。
8. 複数バッチ同時は 2〜4 を複数バッチで相次いで実行する（決定 5）。
9. 検証後は sandbox 削除で `SqsLabelingPoc` スタックごと一括破棄する（既存 Todo は温存）。

> 1,000 多重の張り付き（R5）と Pipes `inputTemplate` の文字列射影（NIT-1）は、
> sandbox 実機でしか確認できません（ローカル / CI の自動テスト対象外）。

### クリーンアップ

```bash
npx ampx sandbox delete
```

sandbox 削除で本 PoC のネストスタック `SqsLabelingPoc`（Unit / RoastBatch テーブル、SQS、
Lambda、Pipes、ダッシュボード、アラーム）が一括破棄されます（全リソース `RemovalPolicy.DESTROY`）。
既存の auth（Cognito）/ data（Todo）は別スタックのため温存されます。

### デプロイ影響

- **CI のみに影響し、Amplify Hosting / AgentCore には波及しません。** 本 PoC では CI の
  `setup-node` を Node.js 22 に引き上げ（Lambda ランタイム 22.x と揃える）、vitest による
  テスト実行を CI に追加します。Web アプリのホスティングやエージェント実行基盤の構成は変わりません。
- **`RELAY_MODE` の切替は再デプロイが必要です。** `ampx sandbox` には CDK context が届かないため、
  入口方式の切替は環境変数 `RELAY_MODE`（`pipes` / `lambda` / `both`）が唯一の経路で、
  合成時に入口を決めます。値を変えたら `npx ampx sandbox` を再実行して反映します。
  - `pipes`: EventBridge Pipes が Streams → SQS を中継する
  - `lambda`: labeling-router（Lambda）が Streams → SQS を中継する
  - `both`: 両方を有効化する（二重配信は worker の冪等条件で吸収）
- **seeder 失敗時の縮退挙動（design-review NIT-2）:** seeder が上限リトライを超過し一部 Unit を
  INSERT できなかった場合、`labeled_count` は `unit_count` に到達せず完了遷移は成立しません。
  画面 C は未完了のまま（キュー深度ではなく `labeled_count` 基準の正しい挙動）になります。
  再試行は batch を作り直してください。張り付きカーブの観測自体は取得できます。

---

## クイックスタート

### Web アプリを動かす（全員共通、5 分）

```bash
git clone <リポジトリURL>
cd <プロジェクト名>
npm ci
```

ターミナルを2つ開いて:

```bash
# ターミナル 1: Amplify sandbox 起動（初回は数分）
npx ampx sandbox

# ターミナル 2: 開発サーバー起動
npm run dev
```

`http://localhost:3000/sample` で Todo リストが動けば成功です。

---

### エージェントを動かす（任意）

エージェント機能は段階的に試せます。Web アプリとの結合にはデプロイが必要ですが、エージェント単体はローカルで確認できます。

#### Step 1: エージェントプロジェクトを作成する

リポジトリルートで AgentCore CLI を使ってエージェントプロジェクトを生成します。

```bash
# AgentCore CLI インストール（未インストールの場合）
npm install -g @aws/agentcore

# リポジトリルートで実行
agentcore create
```

対話 UI で以下を選択:
- Project name: **`agents`**
- Add agent: **Yes**
- Agent name: 任意（例: `my_agent`）
- Type: **Create new agent**
- Language: **Python**
- Build: **Container**
- Protocol: **AG-UI**
- Framework: **Strands Agents SDK**
- Model: **Amazon Bedrock**
- Memory: **None**（サンプルでは不要）
- Advanced: スキップ（JWT 認証は不要 — SigV4 を使用）

#### Step 2: エージェントをローカルで試す

生成されたエージェントの動作確認:

```bash
cd agents
agentcore dev
```

ブラウザで `http://localhost:8080/invocations` を開くと、Dev 用の AI チャット画面が表示されます（Docker が起動している必要があります）。

別ターミナルから curl で直接リクエストを送ることもできます:

```bash
curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -H "X-Agentcore-Local: true" \
  -d '{
    "threadId": "test-1",
    "runId": "run-1",
    "prompt": "1+2は？",
    "messages": [{"id": "m1", "role": "user", "content": "1+2は？"}],
    "tools": [], "context": [], "state": {}, "forwardedProps": {}
  }'
```

AG-UI イベント（`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `RUN_FINISHED`）が返れば成功です。

#### Step 3: Web アプリとエージェントを接続する（要デプロイ）

ローカルでの結合テストはできません（SigV4 署名に Amplify Hosting のコンピューティングロールが必要なため）。接続には以下の手順が必要です:

1. **Amplify Hosting にリポジトリ接続** → Web アプリ + Cognito をデプロイ
2. **AgentCore Runtime にデプロイ** → `cd agents && agentcore deploy`
3. **コンピューティングロールに権限追加** → `bedrock-agentcore:InvokeAgentRuntime` ポリシーをアタッチ
4. **環境変数を設定** → Amplify コンソールで `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` を設定
5. **再デプロイ** → 環境変数反映のためビルドをトリガー

詳細な手順は [docs/deployment.md](docs/deployment.md) を参照してください。

**接続の仕組み:**

```
ブラウザ (CopilotKit + Cognito トークン)
  → /api/copilotkit (Next.js API Route, Amplify Hosting SSR Lambda)
    → CopilotRuntime + ExperimentalEmptyAdapter
      → HttpAgent (SigV4 署名、コンピューティングロールの権限で署名)
        → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

---

## 更新時のデプロイ

### Web アプリの更新

```bash
git push origin <ブランチ名>
```

Amplify Hosting が自動デプロイします。

### エージェントの更新

```bash
cd agents
agentcore deploy
```

### 両方を更新する場合

エージェント → フロントエンドの順にデプロイしてください。

---

## お片付け（リソース削除）

```bash
# 1. AgentCore Runtime の削除
cd agents
agentcore remove all --yes
agentcore deploy

# 2. Amplify Hosting の削除（コンソールから）
# AWS コンソール → Amplify → アプリを削除

# 3. sandbox の停止（残っている場合）
npx ampx sandbox delete
```

---

## ブランチ戦略

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

## CI/CD

| 対象 | 担当 | 方法 |
|------|------|------|
| Web アプリ（品質ゲート） | GitHub Actions | lint、型チェック |
| Web アプリ（デプロイ） | Amplify Hosting | Git push で自動 |
| エージェント（品質ゲート） | GitHub Actions | lint、インポート確認 |
| エージェント（デプロイ） | AgentCore CLI | `agentcore deploy` |

## Kiro + Agent Toolkit for AWS

[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws) の MCP サーバーを設定済みです。Kiro から AWS ドキュメント検索、スキル検索、CLI 実行が利用できます。Skills はオンデマンド検索されるためローカルインストール不要です。

---

## サンプルの除去

テンプレートから自分のプロジェクトを始める際:

**フロントエンド:**
1. `src/app/sample/` を削除
2. `src/components/agent/` を削除（エージェント不使用の場合）
3. `src/lib/agent/` を削除（エージェント不使用の場合）
4. `src/app/api/copilotkit/` を削除（エージェント不使用の場合）
5. `amplify/data/resource.ts` の `Todo` モデルを自分のモデルに置き換え

**エージェント（使わない場合）:** `agents/` ディレクトリごと削除

**エージェント（使う場合）:** `agents/app/sample_agent/` を参考に新規エージェントを作成

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ詳細・前提条件 |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（Amplify + AgentCore + コンピューティングロール） |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro の steering/skills の使い方 |
| [docs/sample/](docs/sample/) | サンプルページの仕組み |
| [agents/README.md](agents/README.md) | エージェント開発の詳細 |
