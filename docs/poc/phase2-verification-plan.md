# 検証計画メモ: #2 記事（並行数制御・下流保護・運用編）

Kiro Roasters 梱包バッチ PoC（DynamoDB Streams → SQS → 付番ワーカー最大 1,000 多重）の
**第 2 本の記事**に向けた実行計画。sandbox を 1 回立てて一気に回し切るための段取りをまとめる。

## このメモの位置づけ

- #1（`docs/poc/verification-results.md`）で全 10 試行を回し、「SQS を挟めば 1,000 多重に到達」
  「律速は供給（S×P・投入総量）」「worker Throttle は worker 自身の `MaxConc=1000`＝アカウント枠の
  天井が原因」「オンデマンドの書き込みは本規模をスロットルなしで吸った（学習済みテーブル）」
  までを実測した。
- このメモは #1 の **§6「未実施・次に回すもの」** を実行手順まで具体化したもの。出典は
  `verification-results.md` §6 と、記事計画（`article/aws-dynamodb-streams-sqs` の
  `streams-sqs-article-plan.md`）の 5 項目。
- **このメモ自体では実装・デプロイ・検証は行わない**。#2 執筆に着手するときに、この順番・この
  コマンドで sandbox を 1 回立てて撮り切るための計画である。
- 参照したコードの実体（パラメータ名・範囲・既定値・IAM・observe.sh の取得系列）は本メモ作成時点で
  各ファイルを読んで確認済み。コード変更が要る項目は末尾の表にまとめた。

### #2 の主題

**「1,000 多重が下流 DynamoDB を殺す → 並行数制御（MaxConc）で下流を守る」のトレードオフ実演。**
「守れるが付番は遅くなる」ことを、CloudWatch メトリクスと業務時間（roast-batch の
`labeling_started_at` → `labeling_finished_at`）の両面で見せる。

---

## 前提と可変パラメータ（コードの実体）

#2 で触るパラメータと、その定義場所・範囲・注入経路（実機で読んで確認済み）。

| パラメータ | env 名 | 範囲 / 既定 | 定義 | 注入経路 |
|------------|--------|-------------|------|----------|
| worker 多重上限 | `LABELING_MAX_CONCURRENCY` | 2〜1250 / 1000 | `amplify/custom/verification-config.ts` | `labeling-stream.ts` が `SqsEventSource.maxConcurrency` に設定 |
| worker 擬似処理時間 | `PROCESSING_TIME_MS` | 0〜60000 / 0 | 同上 | worker 関数の env（`labeling-functions.ts`） |
| router 並列化係数 | `ROUTER_PARALLELIZATION_FACTOR` | 1〜10 / 1 | 同上 | `labeling-stream.ts` が Streams ESM の `parallelizationFactor` に設定 |
| router バッチサイズ | `ROUTER_BATCH_SIZE` | 1〜1000 / 100 | 同上 | 同上（`batchSize`） |
| seeder 書込並列度 | `SEED_WRITE_CONCURRENCY` | 1〜48 / 1 | `amplify/functions/shared/runtime-config.ts` | **seeder 関数の env**。`labeling-functions.ts` が `process.env.SEED_WRITE_CONCURRENCY ?? "1"` で読み、**合成時に** seeder に注入する |
| 入口方式 | `RELAY_MODE` | pipes / lambda / both / pipes | `amplify/custom/verification-config.ts` | 全関数・`labeling-stream.ts` の分岐 |

**重要な注入経路の注意（#1 で混乱しやすかった点）:**
- `SEED_WRITE_CONCURRENCY` は **load.sh の環境変数ではない**。`labeling-functions.ts` が
  `process.env.SEED_WRITE_CONCURRENCY` を**合成時（`ampx sandbox` を起動したシェル）**に読んで
  seeder 関数の env に焼き込む。したがって最速投入をするには **`ampx sandbox` を起動するシェルで
  `SEED_WRITE_CONCURRENCY=48` を export してデプロイ**しておく必要がある（load.sh では変えられない）。
- 同様に `LABELING_MAX_CONCURRENCY` / `PROCESSING_TIME_MS` / `ROUTER_*` / `RELAY_MODE` も**合成時の
  環境変数**。値を変えるたびに `ampx sandbox` の再デプロイが要る（load.sh の再実行では変わらない）。
- load.sh が制御するのは投入側のみ: `BATCHES` / `UNIT_COUNT` / `STAGGER_SEC`（+ `REGION` / `PREFIX` /
  `LOT_ID` / `ITEM_ID` / `ROAST_DATE`）。seeder を直接 invoke して roast-batch を LABELING で作る。

**unit テーブルの実体（下流保護の対象）:** `amplify/custom/labeling-tables.ts` で
`Billing.onDemand()`・`maxWriteRequestUnits` 等の**上限は未設定**（コメント「上限は設けない」）。
PK=`unit_id` で分散。GSI 2 本（`batch-units-index` / `lot-trace-index`）はいずれも
`projectionType=ALL` なので、1 件の unit 書き込みが基表 + GSI2 本 = **実質 3 倍の WCU** を消費する。
GSI 側の `WriteThrottleEvents` も観測対象（ただし observe.sh は現状 **基表の** `WriteThrottleEvents`
のみ取得 → 後述）。

**observe.sh が取る 15 系列（確認済み）:** worker ConcurrentExecutions / Invocations / Throttles /
Errors / Duration(avg,p99)、SQS visible / inflight / oldest-age / sent / deleted、
unit WriteThrottleEvents（基表のみ）、roast-batch ConsumedWriteCapacityUnits、
router IteratorAge / ConcurrentExecutions（`RELAY_MODE=lambda/both` で router が居るときのみ）。
**seeder の ConcurrentExecutions は取得していない**（#1 §4.8-4.10 では seeder 同時実行を別途
`get-metric-data` で突き合わせていたが、observe.sh の標準系列には入っていない）。

---

## 推奨実行順序（sandbox 1 回で撮り切る段取り）

**依存関係の肝: T2・学習（項目 1）は「テーブルをリセットした直後の 1 発目」という時間制約があるので
必ず最初に撮る。** 一度でも高負荷を通すとオンデマンドが学習してしまい（#1 §4.8）、以降は初動
スロットルが出なくなる。したがって「初動を測りたい項目」→「学習後でよい項目」の順に並べる。

```
0. 前準備
   - 既存 sandbox を delete（テーブルを学習前に戻す。npx ampx sandbox delete）
   - 必要ならコード変更（末尾の表）を入れてから次へ

1. 【最初・学習前】項目 1: T2 初動スロットル + 学習カーブ
   - SEED_WRITE_CONCURRENCY=48 を export して sandbox 起動（最速投入できる状態でデプロイ）
   - リセット直後の 1 発目を最速投入（STAGGER_SEC=0）→ 初動 WriteThrottle を観測
   - 同じ投入を数回繰り返し、WriteThrottle が回を追って減る（学習）かを観測
   ↓（ここで既にテーブルは学習済みになる。以降 T2 は狙わない）

2. 項目 4: 秒粒度の立ち上がりカーブ（Logs Insights）
   - 追加投入不要。項目 1〜3 のどの投入のログからでも再構成できる。
     1 の投入ログに対して Logs Insights クエリを流しておくと二度手間がない

3. 項目 2: 食い合いの意図的再現（router+seeder+worker 同時ピーク）
   - RELAY_MODE=lambda / ROUTER_PARALLELIZATION_FACTOR=10 / PROCESSING_TIME_MS=3000 で再デプロイ
   - seeder を走らせ続け、router(~40) と worker(立ち上がり) を枠 1000 で重ねる

4. 項目 3 + 項目 5: MaxConc 分離 + 下流保護（#2 の主題）
   - LABELING_MAX_CONCURRENCY=800 で再デプロイ
   - worker が 800 で頭打ち・Throttle が出ないこと（枠に余裕）を確認（項目 3）
   - 同じ投入で下流 WriteThrottle が減る/消えること・業務時間が延びることを確認（項目 5）

5. 後始末
   - npx ampx sandbox delete（従量課金を止める）
```

> 項目 3 と 5 は「MaxConc を 800 に絞る」という同じ操作を共有するので 1 デプロイで両方撮れる。
> 項目 1 の「学習前 1 発目」を逃すとテーブル再リセット（再 delete）からやり直しになるため、
> 1 を最優先・単独で丁寧に撮る。

---

## 項目 1: T2（オンデマンド初動スロットル）＋ 学習カーブ

### 狙い / 問い
`verification-results.md` §4.4 / §4.8 では unit テーブルの `WriteThrottleEvents` が全試行 0 だった。
ただしこれは**本日すでに高負荷を通して学習済み**のテーブルでの結果。**リセット直後の学習前 1 発目**で
初動スロットルが出るか、そして**同じ投入を繰り返すと回を追ってスロットルが減る（学習する）か**を観測する。
GSI 2 本（射影 ALL）で 1 書き込みが実質 3 倍 WCU になる点も効く。

### 必要な準備
- **既存パラメータだけで回せる**（`SEED_WRITE_CONCURRENCY` と load.sh の `STAGGER_SEC`）。
- **テーブルのリセットが必須**（`npx ampx sandbox delete` → 再 up）。学習状態を初期化しないと初動が出ない。
- **観測ツールへの追加（任意・推奨）:** observe.sh は現状 **基表の** `WriteThrottleEvents` のみ。
  GSI 側（射影 ALL で基表と同量の書き込みを受ける）のスロットルも見たいなら observe.sh の
  GetMetricData クエリに `Dimensions=[TableName, GlobalSecondaryIndexName]` の
  `WriteThrottleEvents` 系列を追加する（to_csv.py の COLUMNS にも 1 列追加）。**無くても基表側で
  初動スロットルの有無は判定できる**ので、まずは既存のままでよい。
- 初動スロットルがどうしても出ない場合の代替は「下流に意図的な上限を設ける」→ **コード変更が要る**
  （項目 5 の準備を参照。unit テーブルに `maxWriteRequestUnits` を設定するパラメータの新設）。

### 実行手順
```bash
# 1. テーブルを学習前に戻す
npx ampx sandbox delete

# 2. 最速投入できる状態で再デプロイ（SEED_WRITE_CONCURRENCY は合成時に seeder へ焼き込まれる）
SEED_WRITE_CONCURRENCY=48 PROCESSING_TIME_MS=3000 npx ampx sandbox
# （別案: RELAY_MODE は pipes のままでよい。入口は T2 に無関係）

# 3. 学習前 1 発目を最速投入（一斉・1 バッチだけでも可。瞬間レートを最大化）
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=0 bash docs/poc/observe/load.sh

# 4. 観測（基表 WriteThrottle と WCU を見る）
START_TIME=$T0 PERIOD=60 bash docs/poc/observe/observe.sh

# 5. 学習カーブ: 同じ投入を 2〜3 回繰り返し、毎回 observe して WriteThrottle の推移を記録
#    （テーブルは delete しない。繰り返しで学習が進むかを見る）
```

### 観測ポイント / 期待結果
- `unit_write_throttle_sum`（T2）が **1 発目で > 0** になれば初動スロットルを捉えた。
- 繰り返すたびに `unit_write_throttle_sum` が減れば「オンデマンドの学習」を実証。
- `roast_batch_wcu_sum` / unit 側 WCU で瞬間レートを併記（#1 では seeder 48 並列で unit WCU が
  約 2 倍＝ピーク ~25,000 WCU/分だった）。
- 取りこぼし 0（`queue_sent_sum == queue_deleted_sum`）は維持されるはず（at-least-once + 冪等）。

### コスト・注意
- **テーブル delete は不可逆**（データ全消去）。PoC 専用 sandbox なので問題ないが、他項目を撮る前に
  必ずこの項目を最初に済ませる（後から delete すると他項目をやり直すことになる）。
- 従量課金（DynamoDB 書き込み・Lambda・SQS）。最速投入はコストに直結。
- CloudWatch メトリクスは数十秒〜数分の反映遅れがある。投入直後は数分おいて observe する。

---

## 項目 2: 食い合いの意図的再現（#2 の目玉）

### 狙い / 問い
アカウント・リージョンの Lambda 同時実行枠（本アカウント 1000）は全関数で共有。#1 §4.9/§4.10 では
worker が 1000 に達する頃には router も seeder も 0 に落ちており、**食い合いが顕在化しなかった**
（観測された worker Throttle は worker 自身の `MaxConc=1000` 天井が原因だった）。本項目では
**router（~40 並列）+ seeder（投入中）+ worker（立ち上がり中）を意図的に同時ピークにして**、
合計を枠 1000 に当て、worker を**枠律速で頭打ち（1000 未満、例 ~960）**にする。

### 必要な準備
- **既存パラメータだけで回せる**（`RELAY_MODE=lambda` + `ROUTER_PARALLELIZATION_FACTOR=10` で
  router を ~40 並列にできる。S×P=40）。
- **同時ピークを作る設計**（ここが肝）:
  - 入口を中継 Lambda にする（`RELAY_MODE=lambda`）→ router が Lambda 枠を食う（Pipes は枠を使わない）。
  - **seeder を走らせ続ける**: load.sh を短い `STAGGER_SEC`（例 2〜5 秒）で**多バッチ**投入し、
    seeder と router が投入中ずっと動いている状態を作る。seeder が投入し終える前に worker が
    1000 近くまで立ち上がるよう、`PROCESSING_TIME_MS=3000` で worker を長く滞在させる。
  - あるいは load.sh を**複数回連打**して供給を途切れさせず、worker 立ち上がりの最中に
    router/seeder が同時に枠を食う瞬間を作る。
- **観測ツールへの追加が要る:** observe.sh は worker + router の同時実行は取るが **seeder の
  ConcurrentExecutions を取っていない**。「3 関数の合計が枠に当たった」ことを 1 枚の CSV で示すには
  **observe.sh に seeder の ConcurrentExecutions 系列を追加**する（to_csv.py の COLUMNS にも 1 列）。
  #1 §4.8-4.10 は seeder 同時実行を別コマンドで突き合わせていた。#2 では自動で並べたい。
  → **コード変更（観測ツール）が要る項目**（末尾表）。

### 実行手順
```bash
# 1. 中継 Lambda・P=10・worker を長く滞在させる設定で再デプロイ
RELAY_MODE=lambda ROUTER_PARALLELIZATION_FACTOR=10 PROCESSING_TIME_MS=3000 \
SEED_WRITE_CONCURRENCY=48 npx ampx sandbox

# 2. seeder/router を投入中ずっと動かし、worker 立ち上がりと重ねる
#    短い STAGGER で多バッチ → 供給が切れず、投入中に worker が立ち上がる
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=40 UNIT_COUNT=1200 STAGGER_SEC=3 bash docs/poc/observe/load.sh
# 必要なら途中でもう一度 load.sh を叩いて供給を足す（worker 立ち上がり中に router/seeder を重ねる）

# 3. 観測（worker/router/seeder を同時刻で突き合わせる。seeder 系列を足した observe.sh で）
START_TIME=$T0 PERIOD=60 bash docs/poc/observe/observe.sh
```

### 観測ポイント / 期待結果
- worker + router + seeder の**合計が 1000 に張り付き**、その瞬間 worker が **1000 未満で頭打ち**
  （例 ~960）＝食い合いの顕在化。
- worker Throttle が、worker 自身の MaxConc 天井（#1）ではなく**枠食い合いのタイミング**で出る。
- 対照: 同条件で `RELAY_MODE=pipes` にすると router が枠を使わないので worker は 1000 に乗れる
  （Pipes の「枠を使わない」優位の再確認。余力があれば撮る）。

### コスト・注意
- 多バッチ・最速投入で従量課金が大きい。worker を長く滞在（`PROCESSING_TIME_MS=3000`）させるため
  Lambda 実行時間も伸びる。
- 「同時ピーク」は供給の重なり次第で再現にばらつきがある。1 回で出なければ投入を厚く/連打して
  worker 立ち上がりの最中に router/seeder を重ねる（複数回トライ前提）。

---

## 項目 3: MaxConc < アカウント枠の分離

### 狙い / 問い
`LABELING_MAX_CONCURRENCY` を 800（< 1000）に下げ、**worker が 800 で頭打ちになり Throttle が
出ない**（枠 1000 に余裕があるため）ことを確認。これで「worker の天井（MaxConc）」と「アカウント枠」を
割って、#1 の「観測された Throttle は MaxConc=1000=枠 の同値が原因」説をさらに裏付ける
（天井を枠より下げれば Throttle が消える、が予測）。

### 必要な準備
- **既存パラメータだけで回せる。コード変更不要**（`LABELING_MAX_CONCURRENCY` は範囲 2〜1250 で、
  800 は有効。`labeling-stream.ts` が `SqsEventSource.maxConcurrency` にそのまま渡す）。
- 観測ツールの追加も不要（worker ConcurrentExecutions / Throttles は既存系列）。

### 実行手順
```bash
# MaxConc を 800 に下げて再デプロイ（入口は供給が安定する pipes でよい）
LABELING_MAX_CONCURRENCY=800 RELAY_MODE=pipes PROCESSING_TIME_MS=3000 npx ampx sandbox

# #1 で 1000 に到達した投入（厚い供給）と同じ量を投入
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=30 UNIT_COUNT=1200 STAGGER_SEC=0 bash docs/poc/observe/load.sh

START_TIME=$T0 PERIOD=60 bash docs/poc/observe/observe.sh
```

### 観測ポイント / 期待結果
- worker ピーク同時実行が **800 で頭打ち**（`MaximumConcurrency=800` に張り付く）。
- worker `Throttles` 合計が **0**（枠 1000 に 200 の余裕があるため天井に当たらない）。
  → #1 の「1000 到達時の Throttle は MaxConc=枠 の天井」という説の裏付け。
- 取りこぼし 0 は維持。SQS 滞留（最古メッセージ・visible）は 1000 のときより増えるはず
  （捌く多重が少ないぶんキューが長くなる）→ 項目 5 のトレードオフに直結。

### コスト・注意
- 従量課金。項目 5 と同じデプロイ（MaxConc=800）を共有できるので、続けて項目 5 を撮ると効率的。

---

## 項目 4: 秒粒度の立ち上がりカーブ（Logs Insights）

### 狙い / 問い
CloudWatch メトリクスの `ConcurrentExecutions` は**最小 1 分粒度**（`PERIOD=10` を指定しても点は
増えない。#1 の付録の注記）。そのため #1 の立ち上がりカーブは 1 分刻みで粗い。**CloudWatch Logs
Insights** で worker の実行ログ（`REPORT` 行の `@timestamp` と `Duration`）から**秒粒度の同時実行数を
再構成**する。

### 必要な準備
- **追加投入不要・コード変更不要・観測ツール追加不要**（既存ログから。低コスト）。
- 項目 1〜3 のどの投入のログからでも再構成できる。1 の投入直後に流しておくと二度手間がない。
- ロググループ名: `/aws/lambda/kiro-roasters-labeling-worker-*`（サフィックスは実環境で確認）。

### 実行手順（Logs Insights クエリ例）
**(a) 1 秒ビンあたりの REPORT 件数（＝その秒に終了したインスタンス数の近似）:**
```
filter @type = "REPORT"
| stats count(*) as reports_per_sec by bin(1s) as t
| sort t asc
```

**(b) START/END の差分から「稼働中インスタンス数」を秒粒度で近似する:**
`REPORT` 行は `@timestamp`（終了時刻）と `@duration`（ms）を持つので、開始時刻 = 終了 − duration。
各リクエストを [開始, 終了] の区間とみなし、1 秒ビンごとに「その秒に走っていた区間数」を数える。
Logs Insights 単体で区間重なりを完全には出せないため、まず素材を抽出する:
```
filter @type = "REPORT"
| fields @timestamp, @duration,
         @timestamp - (@duration * 1ms) as start_ts
| sort @timestamp asc
| limit 10000
```
抽出した `start_ts` / `@timestamp` を CSV で落とし、ローカル（to_csv.py と同じ流儀の小スクリプト、
または表計算）で「各 1 秒ビンに重なる区間数」を数えて秒粒度カーブにする。

**(c) 立ち上がりの肌感を手早く見るなら、1 秒あたりの INIT（コールドスタート）件数:**
```
filter @type = "REPORT" and ispresent(@initDuration)
| stats count(*) as cold_starts_per_sec by bin(1s) as t
| sort t asc
```
コールドスタートの発生レートは「新しいインスタンスが増えた秒」を表すので、立ち上がりの傾きの
代理指標になる。

### 観測ポイント / 期待結果
- 1 分粒度では「+60 秒で 900→1000」としか見えなかった立ち上がりが、秒粒度では
  「1 分あたり最大 +60 インスタンス」のスケール制約に沿った滑らかな傾きとして見えるはず。
- (c) のコールドスタート・レートが立ち上がり中に高く、張り付き後に 0 近くに落ちる想定。

### コスト・注意
- Logs Insights はスキャンしたログ量に応じた課金（少量）。追加の負荷投入はしないので安い。
- `@duration` は課金 Duration（ms）。`PROCESSING_TIME_MS=3000` 設定時は ~3,000ms + 実処理。
  秒粒度の区間計算はこの duration を使う。

---

## 項目 5: 下流保護（#2 の主題）

### 狙い / 問い
**「1,000 多重が下流 DynamoDB を殺す → 並行数制御で守る」の実演。** 項目 1 で下流スロットルが出せる
状態（学習前 or 意図的に上限を設けた下流）にした上で、**MaxConc を絞る（項目 3）と下流の
`WriteThrottleEvents` が減る/消える**ことを示す。あわせて **「MaxConc を絞ると下流は守られるが付番は
遅くなる」トレードオフを業務時間**（roast-batch の `labeling_started_at` → `labeling_finished_at`）で測る。

### 必要な準備
- **既存パラメータ（`LABELING_MAX_CONCURRENCY`）だけで「絞る側」は回せる。**
- **「下流スロットルを安定的に出す」ための準備が肝。** 項目 1 の学習前 1 発目は 1 回しか撮れないため、
  保護の before/after を**繰り返し**比較するには下流スロットルを**意図的・再現的に出せる**ほうがよい。
  そのための選択肢:
  - **(推奨・要コード変更)** unit テーブルに **オンデマンドの書き込み上限 `maxWriteRequestUnits`** を
    設定できる検証パラメータ（例 `UNIT_MAX_WRITE_REQUEST_UNITS`）を新設する。`labeling-tables.ts` の
    `Billing.onDemand({ maxWriteRequestUnits })` と `verification-config.ts` のパラメータ表に追加。
    これで下流の WCU 天井を意図的に低く設定し、1000 多重で確実に `WriteThrottleEvents` を出せる
    （before）。MaxConc を絞ると書き込みレートが下がり天井を下回る（after＝守られる）。
    → **コード変更が要る項目**（末尾表）。
  - (代替・コード変更なし) 項目 1 の学習前状態に頼る。ただし学習が進むと再現しなくなるため
    before/after を同条件で繰り返しにくい。
- 業務時間の測定は**既存のまま可能**: load.sh が roast-batch を `labeling_started_at` 付きで作り、
  worker が完了時に `labeling_finished_at` を書く（#1 §4.5/§4.10 で実測済みの指標）。
  roast-batch テーブルを Scan して `labeling_finished_at - labeling_started_at` を集計する
  （#1 と同じ手順。必要なら集計用の小スクリプトを用意）。

### 実行手順
```bash
# 【before】下流が殺される状態: MaxConc=1000。下流上限を設ける場合は新パラメータも付ける
LABELING_MAX_CONCURRENCY=1000 PROCESSING_TIME_MS=3000 \
# （コード変更後）UNIT_MAX_WRITE_REQUEST_UNITS=<低めの値> \
npx ampx sandbox
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=30 UNIT_COUNT=1200 STAGGER_SEC=0 bash docs/poc/observe/load.sh
START_TIME=$T0 PERIOD=60 bash docs/poc/observe/observe.sh   # unit_write_throttle_sum > 0 を期待
# → roast-batch を Scan して業務時間（started→finished）を集計

# 【after】並行数制御で守る: MaxConc=800 に絞って再デプロイ（他は同条件）
LABELING_MAX_CONCURRENCY=800 PROCESSING_TIME_MS=3000 \
# （コード変更後）UNIT_MAX_WRITE_REQUEST_UNITS=<同じ値> \
npx ampx sandbox
T1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=30 UNIT_COUNT=1200 STAGGER_SEC=0 bash docs/poc/observe/load.sh
START_TIME=$T1 PERIOD=60 bash docs/poc/observe/observe.sh   # unit_write_throttle_sum が減る/0 を期待
# → roast-batch を Scan して業務時間が before より延びることを確認
```

### 観測ポイント / 期待結果
- **before（MaxConc=1000）:** `unit_write_throttle_sum`（必要なら GSI 側も）> 0。業務時間は短い。
- **after（MaxConc=800）:** `unit_write_throttle_sum` が減る/0。worker ピークは 800 で頭打ち。
  業務時間（1 バッチ中央値・全バッチ総所要）は before より**延びる**＝守る代償。
- 一枚の表で「MaxConc・worker ピーク・下流 WriteThrottle・業務時間（中央値/総所要）」を before/after
  で並べ、**「守れるが遅くなる」トレードオフ**を数値で示す。
- 取りこぼしは両方 0（SQS 滞留は after のほうが長い）。

### コスト・注意
- before/after で 2 回デプロイ + 2 回投入＝従量課金が項目中最大。項目 3 の MaxConc=800 デプロイと
  after を共有すると 1 回分節約できる。
- `maxWriteRequestUnits` を新設して意図的にスロットルを起こすのは**検証目的の設定**。本番テンプレートの
  既定値には入れない（product / security 方針: テンプレートは汎用・安全な既定を保つ）。検証中のみ使う
  パラメータであることをコード・ドキュメントに明記する。
- 下流を意図的に殺す設定なので、検証後は `npx ampx sandbox delete` で確実に破棄する。

---

## コード変更が必要な項目のまとめ表

#2 執筆着手時はこの表を見れば準備作業が分かる。

| 項目 | 変更要否 | 変更内容 |
|------|----------|----------|
| 1. T2 初動スロットル + 学習 | 原則 **不要** | 既存 `SEED_WRITE_CONCURRENCY`（48）+ テーブルリセットで回せる。GSI 側 WriteThrottle も見るなら observe.sh/to_csv.py に GSI の `WriteThrottleEvents` 系列を**任意追加**。初動が出ない場合のみ項目 5 の `maxWriteRequestUnits` 新設に合流 |
| 2. 食い合いの意図的再現 | **要（観測ツール）** | observe.sh の GetMetricData クエリに **seeder の `ConcurrentExecutions`** 系列を追加（worker+router+seeder の合計を 1 枚で突き合わせるため）。to_csv.py の `COLUMNS` にも seeder 列を 1 つ追加。本体コード（amplify/）の変更は不要（`RELAY_MODE=lambda`・`ROUTER_PARALLELIZATION_FACTOR=10` は既存パラメータ） |
| 3. MaxConc < 枠 の分離 | **不要** | 既存 `LABELING_MAX_CONCURRENCY=800`（範囲 2〜1250 内）を合成時に渡すだけ。`labeling-stream.ts` がそのまま `SqsEventSource.maxConcurrency` に反映。観測も既存系列 |
| 4. 秒粒度カーブ（Logs Insights） | **不要** | 既存ログに Logs Insights クエリを流すだけ。CSV 化してローカルで区間集計する小スクリプトは任意（観測ツール本体の変更ではない） |
| 5. 下流保護（主題） | **要（本体コード・推奨）** | 下流スロットルを再現的に出すため、unit テーブルに **オンデマンド書込上限** のパラメータを新設: `labeling-tables.ts` の `Billing.onDemand({ maxWriteRequestUnits })` + `verification-config.ts` のパラメータ表（例 `UNIT_MAX_WRITE_REQUEST_UNITS`、範囲・既定の定義）+ `runtime-config.ts` 側は不要（合成時のみ使う）。**検証専用**で本番既定には入れない。「絞る側」は既存 `LABELING_MAX_CONCURRENCY` で回せる |

### 補足: コード変更の影響レイヤー
- 項目 2 の変更は **観測ツール（`docs/poc/observe/`）のみ**。フロントエンド・Amplify バックエンド・
  エージェントに影響なし。lint/型チェックにも影響しない（shell / python）。
- 項目 5 の `maxWriteRequestUnits` 新設は **Amplify バックエンド（`amplify/custom/`）の変更**＝
  **デプロイ影響あり**（unit テーブルのプロパティ変更。既存テーブルへの `maxWriteRequestUnits`
  追加は再作成を伴わない更新のはずだが、デプロイ前に合成差分を確認する）。`verification-config.ts` の
  テスト（範囲検証）も追随が要る。検証専用パラメータであることを明記し、本番既定（上限なし）を変えない。
