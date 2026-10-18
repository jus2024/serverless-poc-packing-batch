# 検証結果: SQS × Lambda 1000 多重（個体付番 PoC）

Kiro Roasters の梱包バッチ処理（DynamoDB Streams → SQS → 付番ワーカー最大 1,000 多重）の
実機検証ログ。sandbox 実機でしか出ない挙動と、受け入れ基準 R1〜R5・過渡特性 T1〜T2 の実測を記録する。

> このドキュメントは**随時追記**する。新しいシナリオ（方式比較 L_cmp、L3/L4、D 変更など）を
> 回したら、末尾の「追記テンプレート」に沿って節を足すこと。

- 仕様: `.kiro/specs/sqs-labeling-poc/`（requirements / design）、出典 `spec/aws-sqs-lambda-1000/`
- 観測ツール: `docs/poc/observe/`（`observe.sh` / `load.sh` / `to_csv.py`）

---

## 1. 検証環境

| 項目 | 値 |
|------|-----|
| リージョン | `us-west-2`（AWS プロファイル既定。仕様の `ap-northeast-1` とは別。PoC では機能に影響なし） |
| デプロイ | `npx ampx sandbox`（ネストスタック `SqsLabelingPoc`） |
| worker 関数 | `kiro-roasters-labeling-worker-*`（Node.js 22、メモリ 256MB、タイムアウト 60s） |
| unit テーブル | `kiro-roasters-unit-*`（Streams NEW_IMAGE、GSI 2 本、オンデマンド） |
| SQS | `kiro-roasters-labeling-*`（標準キュー、可視性 360s） |
| 入口 | `RELAY_MODE=pipes`（EventBridge Pipes。方式 A-Pipes） |
| worker 多重上限 | `MaximumConcurrency=1000` |
| 擬似処理時間 | `PROCESSING_TIME_MS=3000`（R5/T1 観測のため。既定 0 では 1 バッチでキューが枯れて多重が立たない） |

---

## 2. 実機デプロイで判明した不具合（合成テストをすり抜けたもの）

ローカルの vitest（型・CDK 合成アサーション）は通っていたが、`ampx sandbox` で実デプロイ・実行して
初めて顕在化した不具合。いずれも「実機でしか出ない」種類で、修正と回帰テストを入れた。

| # | 症状 | 根本原因 | 修正コミット |
|---|------|---------|------------|
| 1 | デプロイが `UPDATE_ROLLBACK_FAILED` で失敗 | EventBridge Pipes の source `batchSize=100` が、target=SQS の上限 10 を超過（SQS SendMessageBatch は 1 回 10 件まで） | `2bc284c` |
| 2 | 画面のタブが切り替わらない（全パネル表示） | `.panel{display:block}`（詳細度 0,1,0）が UA の `[hidden]{display:none}`（0,0,0）を上書き | `2217e85` |
| 3 | 画面 C/D で `batch not found`（`BATCH#BATCH%23...`） | API Gateway がパスパラメータを**デコードせず**渡し、`ensureBatchId` が `BATCH#` を二重付与 | `e57bb42` |
| 4 | seeder が 1 件も投入せずクラッシュ | seeder/worker が GSI 名まで要求する `resolveTableConfig()` を呼ぶが、construct は GSI 名の env を注入していない（最小権限） | `a63e3d5` |
| 5 | 投入後も全 unit が PENDING のまま（worker が全件失敗・無限リトライ） | Pipes の `inputTemplate` が Streams の `.N` を**文字列**で送り、worker の `typeof unit_count !== "number"` 判定で弾かれる。しかも catch が沈黙してログゼロ | `ce90ed5` |

教訓: CDK 合成テストは「env キー定数の一致」までは見ていたが、「各関数の env セットがハンドラの
実行時要求を満たすか」「API Gateway のデコード挙動」「Pipes の型射影」は検証範囲外だった。
いずれも実デプロイで初めて出る。

---

## 3. 受け入れ基準の実機確認（R1〜R5）

機能パイプライン（R1〜R4）は少量（unit_count=20）で一周を確認し、R5 は 1000 多重検証で確認した。

| ID | 要件 | 結果 | 根拠 |
|----|------|------|------|
| R1 | 滞留生成（PENDING 一括 INSERT・Streams NEW_IMAGE） | ✅ | seeder が 20/1200 件を PENDING で投入、Streams へ |
| R2 | 中継（INSERT のみ 1 レコード=1 メッセージ） | ✅ | Pipes 経由で SQS に全件到達、二重付番なし |
| R3 | 冪等付番（`attribute_not_exists(best_before)`、成功時のみ `labeled_count ADD`） | ✅ | 二重配信は条件で弾かれ、Duration ~390ms の短時間終了として観測 |
| R4 | 完了検知（`labeled_count==unit_count` で LABELED、キュー深度非依存） | ✅ | roast-batch が LABELED・`labeling_finished_at` 設定、SQS 深度に依存せず |
| R5 | 最大 1000 多重到達・張り付き | ✅ | **ConcurrentExecutions=1000 到達、約 3 分張り付き、Throttle 0**（§4.2） |

---

## 4. 1000 多重の実測（R5 / T1 / T2）

### 4.1 試行 1 — 供給律速で 857 止まり（供給不足の実証）

- 投入: `BATCHES=10 UNIT_COUNT=1200 STAGGER_SEC=20`（12,000 個体）
- `PROCESSING_TIME_MS=3000`

| 経過 | ConcurrentExecutions | queue_visible（滞留） | queue_inflight |
|------|----------------------|----------------------|----------------|
| +0s | 302 | 1,159 | 15 |
| +60s | 543 | 560 | 291 |
| +120s | 798 | 827 | 337 |
| +180s | **857（ピーク）** | **16（枯渇）** | 145 |

ピーク **857 多重**。+180s で滞留が 827 → 16 に急落＝**キューが枯れた瞬間に頭打ち**。
到達の律速は Lambda スケール上限ではなく「滞留量（供給）」だと確定。

補助指標（observe.sh 拡張版）:
- worker Duration avg ~3,080ms / p99 ~3,600ms、Errors 0、Throttles 0。
- **SQS 最古メッセージ滞留（最大）26 秒** ← 多重が足りずキューが一時的に詰まった（下の 1000 の回と対照）。
- **SQS 送信 12,000 / 削除 12,000（取りこぼしなし）** ← 投入した全個体が付番・削除された。

### 4.2 試行 2 — 供給を厚くして 1000 到達・張り付き

- 投入: `BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=10`（24,000 個体。試行 1 の 2 倍・間隔半分）
- `PROCESSING_TIME_MS=3000`

**立ち上がりカーブ（T1、observe.sh サマリ。窓起点 = 投入時刻）**

| しきい値 | 到達 |
|---------|------|
| 100〜750 多重 | +0 秒（最初のデータ点で既に 750 まで駆け上がり） |
| 900 多重 | +60 秒 |
| **1000 多重** | **+60 秒** |

**張り付きと下流（CSV、1 分粒度）**

| 時刻(JST) | ConcurrentExecutions | queue_visible | queue_inflight | worker Invocations/分 |
|-----------|----------------------|---------------|----------------|----------------------|
| 10:19 | 896 | 0 | 0 | 6,579 |
| 10:20 | **1,000** | 0 | 0 | 6,000 |
| 10:21 | **1,000** | 2 | 48 | 6,040 |
| 10:22 | 1,000 | 0 | 393 | 2,360 |

- **1,000 多重に約 3 分張り付き**（`MaximumConcurrency=1000` の天井が効いている＝それ以上増えない）。
- worker Throttles **0**、worker Errors **0**。unit テーブル WriteThrottleEvents **0**。
- 10:21 以降 `queue_inflight` が増加＝1000 で頭打ちになり処理が追いつかず「処理中」が溜まり始めた兆候。

補助指標（observe.sh 拡張版）:
- worker Duration avg ~3,140ms / p99 ~3,614ms（857 の回とほぼ同じ＝1000 でも処理時間劣化なし）。
- **SQS 最古メッセージ滞留（最大）3 秒** ← 多重が十分でキューが詰まらず常に新鮮（857 の回の 26 秒と対照的）。
- **SQS 送信 24,000 / 削除 24,000（取りこぼしなし）** ← 20 バッチ全個体を欠落なく付番。

**857 の回との対比（滞留の古さ）が示すこと**: 同じ worker・同じ D でも、多重が足りないと最古メッセージが
26 秒まで古くなる（処理が到着に追いつかない）が、1000 まで出ると 3 秒に収まる。SQS を挟むことで
「多重を増やして滞留の古さを抑える」制御が効いていることの実測。

### 4.3 Duration（1 件の処理時間。両試行で比較）

worker Duration（ms、`get-metric-statistics`、1 分粒度）:

| | avg | p99 | max |
|---|-----|-----|-----|
| 試行 1（857、4 点平均） | ~3,068 | ~3,587 | ~3,836 |
| 試行 2（1000、5 点平均） | ~3,055 | ~3,417 | ~3,737 |

- avg は両試行とも `PROCESSING_TIME_MS=3000` + 実処理 ~20〜140ms でほぼ一定。
- **同時実行が 857 → 1000 に増えても 1 件の処理時間は劣化しない**（SQS→Lambda は処理を遅くせず
  インスタンスを増やして捌く）。max の上振れ（~3,700〜3,800ms）はコールドスタート（Init）分。

### 4.4 T2（オンデマンドのスロットル追従）

- unit テーブル `WriteThrottleEvents` = **0**（両試行）。
- `ConsumedWriteCapacityUnits`（試行 2、Sum/分）: 6,621 → 12,579 → 12,000 → 13,240 → 3,560。
- 1000 並列の書き込みスパイク（ピーク ~13,000 WCU/分 ≈ ~220 WCU/秒）を**オンデマンドがスロットルなしで吸い切った**。
  「オンデマンド＝初動でスロットルが出る」という想定は、本検証の規模（unit 1 件 ~1KB、ピーク ~220 WCU/秒）では
  再現しなかった。これ自体が観測結果（より大きな項目サイズ・レートなら出る可能性は残る）。

---

## 5. 現時点の結論

- **SQS を挟めば、後続処理の同時実行を Streams のシャード数から切り離して 1,000 多重に到達できる**
  （第 3 回の Streams 直読み 640 止まりに対する回答）。Pipes 版の実測で `MaximumConcurrency=1000` に張り付き、
  Throttle 0。
- **1000 到達の律速は Lambda スケール上限ではなく「滞留量（供給）」。** 試行 1（857）→ 試行 2（1000）の
  差は入口でも worker でもなく、投入を厚くしてキューを枯らさなかったこと。
- **入口（Streams→SQS の中継）の速さが worker の到達多重に直結する（T3）。** 同条件で Pipes 版 1,000 vs
  中継 Lambda 版 502。中継 Lambda は Streams 読み出しが S×P の壁に律速され供給が遅く、worker の
  立ち上がりが追いつく前に供給が尽きた。取りこぼしはどちらも 0（§4.5）。
- **同時実行が増えても 1 件の処理時間は劣化しない。** 両方式とも Duration avg ~3,080ms で一定。
- **オンデマンドは本規模のスパイクをスロットルなしで吸った**（T2 は本検証では未発生）。
- 立ち上がりは厚い供給下（Pipes）で **60 秒で 900→1000**（T1）。

---

## 4.5 試行 3 — 方式比較（L_cmp）: 中継 Lambda 版を同条件で測る

試行 2（Pipes 版・1000 到達）と**完全に同じ投入**（`BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=10` =
24,000 個体、`PROCESSING_TIME_MS=3000`）で、入口だけ `RELAY_MODE=lambda`（中継 Lambda `labeling-router`）
に差し替えた。下流（SQS・worker）は共通なので、差が出るなら「Streams → SQS の入口」の違いだけ。

**推移（60s 粒度）**

| 時刻(JST) | ConcurrentExecutions | queue_visible | queue_inflight | SQS最古滞留(s) | router IteratorAge(ms) |
|-----------|----------------------|---------------|----------------|----------------|------------------------|
| 17:22 | 122 | 1,198 | 2 | 2 | 2,541 |
| 17:23 | 243 | 5,978 | 122 | 60 | 1,363 |
| 17:24 | 364 | 8,432 | 208 | 89 | 1,539 |
| 17:25 | 471 | 9,518 | 345 | 93 | 1,590 |
| 17:26 | **502（ピーク）** | 6,288 | 460 | 74 | — |
| 17:27 | （終了） | 0 | 0 | — | — |

- **ピーク 502 多重**（Pipes 版は同条件で 1,000）。Errors 0、worker Throttle 0、unit Throttle 0。
- **送信 24,000 / 削除 24,000（取りこぼしなし）。** 入口が違っても個体は欠落しない。
- worker Duration avg ~3,084ms / p99 ~3,569ms（Pipes 版と同じ＝下流は同条件）。
- **中継 Lambda IteratorAge 最大 2,541ms**（Pipes 版は `AWS/Pipes` 未発行で観測不可）。

**解釈（T3 の答え）**

502 は「中継 Lambda の限界値」ではなく、**この投入量・この時間での到達値**である。重要なのは形:
`queue_visible` が 9,518 まで積み上がり（滞留は潤沢）、17:26 に 6,288 → 17:27 に 0 へ急落して worker も終了した。
つまり **worker が 502 まで立ち上がった時点で、中継 Lambda が 24,000 件を SQS に送り終え、残りを数十秒で
捌いて完了した**。Pipes 版（試行 2）は worker が 1000 まで立ち上がる前に供給が続いたのに対し、
中継 Lambda 版は worker の立ち上がり（1 分 60 増）が追いつく前に供給が尽きた。

差を生んだのは**入口の供給の速さ**: 中継 Lambda は unit テーブルの Streams を ESM で読む段が
**S×P の壁**（オープンシャード数 × 並列化係数。第 3 回で詰まった壁）に律速され、SQS への供給レートが
Pipes より低い。IteratorAge 2,541ms がその遅れ（Streams 読み出しが処理に遅れている）を示す。
**同じ下流でも「入口の速さ」が worker の到達多重に直結した**のが本検証の収穫。

> 中継 Lambda 版でも、もっと長く・厚く供給を続ければ 1000 に届く可能性はある（S×P の壁が SQS 供給
> レートにどう効くか次第）。502 は上限ではなく、Pipes と同条件での到達値である点に注意。

---

## 6. 未実施・次に回すもの

| 項目 | 内容 | 状態 |
|------|------|------|
| L_cmp 方式比較 | Pipes 版（1000）vs 中継 Lambda 版（502）を同条件で比較。入口の速さが到達多重に直結することを実測（T3） | ✅ 実施（§4.5 / 下の比較表） |
| L3 / L4 | 3〜5 バッチ同時のピーク多重・Queue 深度・IteratorAge | 試行 2 が実質 20 バッチ相当。個別 L3/L4 は未整理 |
| 中継 Lambda 版で 1000 に届くか | 供給をさらに厚く・長くして S×P の壁を越えられるか | 未実施（502 は限界ではなく到達値） |
| 1250 への接近 | `MaximumConcurrency` を上げて上限に迫る | 未実施 |
| 入口の遅れ計測 | Pipes 側は `AWS/Pipes` が本アカウント/構成で**未発行**のため CloudWatch では観測不可（＝ Pipes 経路は入口の遅れがメトリクスで見えない、という知見）。router 側は `AWS/Lambda` IteratorAge で取得可能 | router 側は L_cmp（lambda モード）で取得予定。SQS 最古滞留は取得済み |

---

## 付録: 追記テンプレート（新シナリオを回したらこの形で §4 以降に足す）

```
### 試行 N — <ひとことで狙い>

- 入口: RELAY_MODE=<pipes|lambda|both>
- 投入: BATCHES=.. UNIT_COUNT=.. STAGGER_SEC=..（= N 個体）
- PROCESSING_TIME_MS=..
- 観測窓: START_TIME=<投入時刻>（observe.sh）

立ち上がり（T1）:
| しきい値 | 到達 |
|---------|------|
| ... | +.. 秒 |

張り付き・下流:
| 時刻 | ConcurrentExecutions | queue_visible | queue_inflight |
|------|----------------------|---------------|----------------|
| ... | ... | ... | ... |

Duration(avg/p99/max): ...
Throttles(worker/unit): ...
所見: ...
```

### 方式比較表（L_cmp。両方式を同条件 24,000 個体・D=3000ms で実測）

| 観点 | 方式 A-Pipes（試行 2） | 方式 A-Lambda（試行 3） |
|------|------------------------|-------------------------|
| ピーク同時実行 | **1,000** | **502**（この条件での到達値。上限ではない） |
| 500 到達まで | +0 秒（即） | +240 秒（4 分かけて） |
| worker Duration avg / p99 | ~3,140ms / ~3,614ms | ~3,084ms / ~3,569ms（**ほぼ同じ＝下流は同条件**） |
| worker Errors / Throttle | 0 / 0 | 0 / 0 |
| unit テーブル WriteThrottle | 0 | 0 |
| SQS 最古メッセージ滞留（最大） | 3 秒 | **93 秒**（供給が遅く滞留が古くなった） |
| SQS 滞留ピーク（queue_visible） | 0〜2（即捌け） | **9,518**（供給が worker 立ち上がりより速く積んだ） |
| 取りこぼし（送信=削除） | なし（24,000=24,000） | なし（24,000=24,000） |
| 入口の遅れ（IteratorAge） | 観測不可（`AWS/Pipes` 未発行） | **最大 2,541ms**（Streams 読み出しが S×P で律速） |
| 実装・運用 | マネージド（フィルタ+Target 設定のみ。batchSize は SQS 上限 10 に注意） | 自前 Lambda（ESM で Streams 読み、SendMessageBatch）。入口を可観測にできる |

**結論（T3）**: 同じ下流・同じ投入でも、**入口が Pipes か中継 Lambda かで worker の到達多重が 1,000 vs 502 と
明確に差が出た**。差の源泉は「Streams → SQS の供給の速さ」。Pipes は速く SQS に積むため worker が 1000 まで
立ち上がれたが、中継 Lambda は Streams を ESM で読む段が S×P の壁に律速され供給が遅く、worker の
立ち上がりが追いつく前に供給が尽きて 502 で終わった（IteratorAge 2,541ms がその遅れを示す）。
取りこぼしはどちらも 0。「マネージドの Pipes が速い・中継 Lambda は可観測で自由だが S×P を引きずる」という
トレードオフが数値で見えた。

> 粒度の限界: ConcurrentExecutions は CloudWatch メトリクスの最小粒度が 1 分のため、立ち上がりカーブは
> 1 分刻みの点でしか得られない（`PERIOD=10` を指定しても点は増えない）。秒粒度のカーブが必要なら
> CloudWatch Logs Insights で worker の START/END ログから再構成する（本検証では未実施＝案 C）。
