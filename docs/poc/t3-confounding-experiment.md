# T3 方式比較の交絡解消 追試 — 実行手順書

## 目的

[verification-results.md §4.11](./verification-results.md) の未確認・交絡を解消する。#1 の方式比較で
「Pipes ≈ 中継 Lambda P=10」と並んだが、原因（Pipes の P / batchSize / Pipes 内部機構）を切り分けていない。

- ① Pipes の `ParallelizationFactor` 実値を `describe-pipe` で確定する
- ② Pipes の実効並列度（`AWS/EventBridge/Pipes` の `Concurrency`）を観測する
- ③ 中継 Lambda の batchSize を Pipes と同じ 10 に揃えて再測する

**原則: 条件ごとに変えるのは 1 変数のみ。** 投入・下流・リージョン・**空き時間**は全条件で同一にする。

> **更新（実施後の追記）**: E1〜E3 と追試を実施した結果、方式・P・router batchSize ではなく
> **直前の worker 稼働からの空き時間**が立ち上がりを支配していたと再整理した（[verification-results.md §4.12](./verification-results.md)）。
> 本手順書の判定表（下記）は空き時間を揃えていない前提で書かれており、そのまま使うと同じ交絡を再発させる。
> 以降の追試では「空き時間の記録と制御」を必須条件にすること。

## 必須条件: 空き時間（アイドル間隔）の記録と制御

**すべての run で、直前の worker 呼び出しからの空き時間を記録し、比較する run 同士では揃える。**

- 記録方法: 投入直前に前回の最後の worker 呼び出し時刻（`observe.sh` の前回窓の最終点、または CloudWatch Logs の最終 END）を控え、
  今回の `T0` との差を run の記録項目に書く。
- 制御方法: 比較したい 2 条件は「どちらも約 15 分以内（温かい）」または「どちらも数時間以上（冷えた）」に揃える。
  再デプロイや ESM の作り直しを挟んだ場合も、その時刻を記録する（E2 の 851 は直前に ESM を作り直しており、再現しなかった）。
- 冷えた条件を作るには数時間〜十数時間待つ必要がある。温かい条件は、前の投入が捌け切った直後（約 10〜15 分以内）に投入する。
- 「冷え／温まり」は AWS の公式用語ではない。公式ドキュメント（Lambda の SQS スケーリング）には、アイドル時間のしきい値の記載はない。
  機構（SQS ESM の状態か、Lambda 実行環境の再利用か）は未検証。

## 実施結果（追記）

E1（Pipes、空き約 13 日）は worker ピーク 1000（+180 秒）、Pipes 実効並列度は最大 5（平均約 1.8）、
`describe-pipe` に `ParallelizationFactor` は出ず（既定 1 とみなす）。E2（Lambda P1 b10、空き約 15 時間）は 851 だったが、
冷えた b10 の再実行は 554 で再現せず、E2 は外れ値の可能性がある（E3 は未実施。空き時間が支配的で P・batchSize の
識別力が低いと分かったため）。詳細は [§4.12](./verification-results.md) を参照。

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
- 試行ごとに記録する項目: **直前の worker 稼働からの空き時間**、S、P（実値）、batchSize、worker ピーク、1000 到達までの秒、Pipes/router の最大同時実行、SQS 最古滞留、1 バッチ所要（min/中央値/max）、全体所要。

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

判定表を読む前に、各 run の空き時間が揃っているか確認する（揃っていなければ解釈しない）。
断定できない場合: 同条件を再試行 → それでも不明なら E4（Pipes の P を直接変える）へ。
**境界的な結果（例: 800〜950）が出たら、同条件をもう 1 回再試行する**（1 条件 1 回では偶然の可能性がある）。

## 初回 E1 で確認する点（実機でしか確認できない）

- `AWS/EventBridge/Pipes` の `Concurrency`（実機では dimension なし）が取得できるか。observe の出力に
  `Pipes 同時実行 (最大)` が出なければ、標準エラーのヒントに従い `aws cloudwatch list-metrics --namespace AWS/EventBridge/Pipes --region us-west-2` で実際の MetricName/Dimensions を確認する
  （namespace を `AWS/Pipes` と取り違えると何も返らない。これが #1 で「観測不可」とした原因）。
- `Concurrency` はアカウント内の全 Pipe の合算。他の Pipe が存在しないか事前に `aws pipes list-pipes` で確認する。
- `Invocations` / `ExecutionThrottled`（dimension なし、または PipeName 付き）が取れるか。
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
