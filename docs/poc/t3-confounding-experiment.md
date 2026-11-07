# T3 方式比較の交絡解消 追試 — 実行手順書

## 目的

[verification-results.md §4.11](./verification-results.md) の未確認・交絡を解消する。#1 の方式比較で
「Pipes ≈ 中継 Lambda P=10」と並んだが、原因（Pipes の P / batchSize / Pipes 内部機構）を切り分けていない。

- ① Pipes の `ParallelizationFactor` 実値を `describe-pipe` で確定する
- ② Pipes の実効並列度（`AWS/Pipes` の `Concurrency`）を観測する
- ③ 中継 Lambda の batchSize を Pipes と同じ 10 に揃えて再測する

**原則: 条件ごとに変えるのは 1 変数のみ。** 投入・下流・リージョンは全条件で同一にする。

> この手順書は準備のみ。実環境での動作（特に実 `AWS/Pipes` メトリクスが取得できるか）は
> **初回の E1 で確認すること**（後述「初回 E1 で確認する点」）。

## 共通条件

| 項目 | 値 |
|------|----|
| リージョン | `us-west-2` |
| worker 処理時間 | `PROCESSING_TIME_MS=3000` |
| 投入 | `BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=10`（#1 の試行 2/4/7 と同一。24,000 個体） |
| seeder | 既定の直列。**`SEED_WRITE_CONCURRENCY` を設定しない**（デプロイ時のシェル環境変数が Lambda に焼き込まれるため `unset` する） |

比較相手（verification-results.md の既存試行）:

| 試行 | 方式 | P | batchSize | worker ピーク |
|------|------|---|-----------|---------------|
| 2 | Pipes | 未確認（E1 で確定） | 10 | 1000 |
| 4 | Lambda | 1 | 100 | 502 |
| 7 | Lambda | 10 | 100 | 1000 |

## 実験マトリクス（デプロイ回数最小の順序）

| 条件 | デプロイ | 試行 4/7 との差 | 見たいこと |
|------|----------|-----------------|-----------|
| E1 | `RELAY_MODE=pipes`（既定） | — | Pipes の実 P、Pipes `Concurrency`、試行 2 の再現 |
| E2 | `RELAY_MODE=lambda ROUTER_PARALLELIZATION_FACTOR=1 ROUTER_BATCH_SIZE=10` | 試行 4 と **batchSize のみ**違う（100→10） | P=1 で batchSize を下げると 502 から動くか |
| E3 | `RELAY_MODE=lambda ROUTER_PARALLELIZATION_FACTOR=10 ROUTER_BATCH_SIZE=10` | 試行 7 と **batchSize のみ**違う（100→10） | P=10 で batchSize を下げても 1000 か |

### 各条件の共通手順

作業ディレクトリはリポジトリルート。条件ごとに次を行う。

```bash
# 0. デプロイ前: 前回の環境変数が残っていないか確認して消す
unset SEED_WRITE_CONCURRENCY RELAY_MODE ROUTER_PARALLELIZATION_FACTOR ROUTER_BATCH_SIZE PROCESSING_TIME_MS

# 1. デプロイ（条件ごとのコマンドは下記 E1〜E3。別ターミナルで起動したままにする）
# 2. デプロイ完了後、設定を確認（S と P を記録）
bash docs/poc/observe/pipe-info.sh

# 3. 投入。T0 を控えて、同じシェルで観測する
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=10 bash docs/poc/observe/load.sh

# 4. 数分待つ（全バッチが LABELED になるまで。目安 10 分）。観測
START_TIME=$T0 PERIOD=10 bash docs/poc/observe/observe.sh

# 5. 業務時間
SINCE=$T0 bash docs/poc/observe/batch-times.sh
```

### E1: Pipes（既定）

```bash
PROCESSING_TIME_MS=3000 npx ampx sandbox
```

- `pipe-info.sh` で `ParallelizationFactor`（未設定＝既定 1 のはず）と `S` を記録する。
- observe の `Pipes 同時実行 (最大)` を読む。

### E2: 中継 Lambda P=1・batchSize=10

```bash
PROCESSING_TIME_MS=3000 RELAY_MODE=lambda ROUTER_PARALLELIZATION_FACTOR=1 ROUTER_BATCH_SIZE=10 npx ampx sandbox
```

### E3: 中継 Lambda P=10・batchSize=10

```bash
PROCESSING_TIME_MS=3000 RELAY_MODE=lambda ROUTER_PARALLELIZATION_FACTOR=10 ROUTER_BATCH_SIZE=10 npx ampx sandbox
```

E2/E3 では `pipe-info.sh` の router ESM 行で `BatchSize=10` / `ParallelizationFactor` を確認し、
`RELAY_MODE` 切替で Pipe が消えている（`Pipe なし`）ことも確認する。

## 試行前後の運用

- **次の試行へ進む前に SQS を空にする**: `ApproximateNumberOfMessages` と `ApproximateNumberOfMessagesNotVisible` が両方 0 になってから次の投入・デプロイを行う。
- **デプロイ後は `pipe-info.sh` で状態確認を済ませてから投入する**（Pipe の `CurrentState=RUNNING`、router ESM の `State=Enabled`）。
- **各試行で S（オープンシャード数）を記録する**。sandbox を作り直すと S は変わりうる。S×P で比較するため必須（試行 2/4/7 は S=4）。S が 4 でないときは S×P で読み替える。
- 試行ごとに記録する項目: S、P（実値）、batchSize、worker ピーク、1000 到達までの秒、Pipes/router の最大同時実行、SQS 最古滞留、1 バッチ所要（min/中央値/max）、全体所要。

## 結果の読み方（判定表）

E1 で P=1 が確定した場合（想定）の読み方。

| E1 Pipes Concurrency | E2（P=1, batch10） | E3（P=10, batch10） | 支持される解釈 |
|----------------------|--------------------|---------------------|----------------|
| 小さい（S×1 程度） | 502 付近のまま | 1000 | batchSize は主因でない。Pipes は P=1 でも同じ S×P で速い → **Pipes の内部機構**（取得・送信の効率）で説明が要る。次の一手: E4 |
| 小さい（S×1 程度） | 1000 側へ動く | 1000 | **batchSize が効いていた**。「Pipes≈P=10」は batchSize 差による見かけの一致 |
| 大きい（S×1 を明確に超える） | 502 付近のまま | 1000 | Pipes は実効的に高並列（設定は P=1 でも内部で並列）。**Pipes の内部機構／実効並列度**。次の一手: Concurrency の中身を `list-metrics` で確認 |
| 大きい | 1000 側へ動く | 1000 | batchSize と実効並列度の両方が絡む。E4 で分離 |
| いずれ | 502 付近のまま | 1000 未満に落ちる | batchSize 小は P=10 でも不利。試行 7 との差は batchSize。解釈は保留し再試行 |
| `describe-pipe` が P>1 | — | — | 前提が崩れる。#1 の「Pipes は P=1」の推測を訂正し、S×P を Pipes 側にも適用して再整理 |

断定できない場合: 同条件を再試行 → それでも不明なら E4（Pipes の P を直接変える）へ。
**境界的な結果（例: 800〜950）が出たら、同条件をもう 1 回再試行する**（1 条件 1 回では偶然の可能性がある）。

## 初回 E1 で確認する点（実機でしか確認できない）

- `AWS/Pipes` の `Concurrency`（dimension=`AwsAccountId`）が実際に取得できるか。observe の出力に
  `Pipes 同時実行 (最大)` が出なければ、標準エラーのヒントに従い `aws cloudwatch list-metrics --namespace AWS/Pipes --region us-west-2` で実際の MetricName/Dimensions を確認する。
- `Concurrency` はアカウント内の全 Pipe の合算。他の Pipe が存在しないか事前に `aws pipes list-pipes` で確認する。
- `Invocations` / `ExecutionThrottled`（AwsAccountId + PipeName）が取れるか。
- `describe-pipe` の出力に `ParallelizationFactor` が出るか（無ければ「未設定＝既定 1」と表示される）。

## コスト・後片付け

従量課金（各試行 24,000 個体の DynamoDB 書込・Lambda・SQS・Pipes）。3 条件で計約 72,000 個体。
終了後は必ず:

```bash
npx ampx sandbox delete
```

## 任意の追加条件 E4（今回は実施しない）

Pipes 側に `parallelizationFactor` を設定可能にし、Pipes P=1 vs P=10 を直接比較する案。
**amplify/ のコード変更とデプロイ影響があるため今回は実装しない。** 必要になった場合の変更箇所:

- `amplify/custom/labeling-stream.ts`: Pipes の `sourceParameters.dynamoDbStreamParameters.parallelizationFactor` を追加
- `amplify/custom/verification-config.ts`: パラメータ新設（例 `PIPES_PARALLELIZATION_FACTOR`、範囲 1〜10。`NUMERIC_SPECS` と `VERIFICATION_ENV_VARS` に追随）
- 合成テスト（`verification-config.test.ts` / スタック合成アサーション）の追随
- 影響: Pipes の再作成（デプロイ）、Pipe の挙動変更。`.kiro` の steering 上、高感度変更に準じてレビューする
