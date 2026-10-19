# 1000 多重検証の観測ツールキット

`labeling-worker` の `ConcurrentExecutions` の立ち上がりカーブ（R5 / T1）、SQS 滞留、
Throttle、unit テーブルのオンデマンド・スロットル（T2）を CloudWatch から時系列で取得する。

参考 EC PoC（`serverless-poc-ec-site-ordering`）の観測ツールキットの流儀に倣い、
**AWS CLI ベースで追加依存なし**・**リソースは接頭辞 `kiro-roasters-` で自動検出**（サフィックスを
ハードコードしないので再デプロイ・ブランチ違いでも動く）・**読み取り専用**（課金リソースを作らない）。

## 前提

- AWS CLI v2 が設定済み（sandbox と同じ資格情報・リージョン）
- `python3`（標準ライブラリのみ使用）
- sandbox がデプロイ済みで、1000 多重検証用に `PROCESSING_TIME_MS` を設定済み
  （例 `PROCESSING_TIME_MS=3000 npx ampx sandbox`。`GET /config` で実値を確認できる）

## 使い方

```bash
# 直近 15 分を 60 秒粒度で取得（既定）
bash docs/poc/observe/observe.sh

# 立ち上がりを細かく見る（30 分・10 秒粒度）
DURATION_MIN=30 PERIOD=10 bash docs/poc/observe/observe.sh

# 東京リージョンの場合
REGION=ap-northeast-1 bash docs/poc/observe/observe.sh
```

| 環境変数 | 既定 | 意味 |
|----------|------|------|
| `REGION` | `us-west-2`（`AWS_REGION` があればそちら） | 対象リージョン |
| `PREFIX` | `kiro-roasters` | リソース検出の命名接頭辞 |
| `DURATION_MIN` | `15` | 遡る時間（分）。`START_TIME` 指定時は無視 |
| `PERIOD` | `60` | 粒度（秒）。立ち上がりを細かく見るなら `10` |
| `START_TIME` | （空） | 窓の起点。前回の投入を除外してこの投入だけを見るときに使う。`now` / `now-10min` / `now-2h` / ISO8601 絶対時刻（`2026-10-18T10:28:00Z`） |
| `END_TIME` | （空＝現在） | 窓の終点。省略時は現在時刻。`START_TIME` と同じ書式 |
| `OUT_DIR` | `docs/poc/observe/out` | CSV 出力先 |

`START_TIME` を指定すると `DURATION_MIN` は無視され、サマリの「到達秒」はその窓の起点を 0 秒として
計算される（前回の投入が窓に混ざらないので立ち上がりカーブが読みやすい）。`START_TIME=now` のみ
指定した場合は窓が 0 になるため、END から 1 粒度分だけさかのぼった最小窓で走る（エラーにしない）。

**きれいにカーブを取るコツ:** 投入を始める直前に `date -u +%Y-%m-%dT%H:%M:%SZ` で時刻を控え、
投入後に `START_TIME=<その時刻>` で観測すると、その投入だけの立ち上がりが得られる。

```bash
# 例: 投入開始時刻を控えてから投入 → あとでその時刻を起点に観測
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BATCHES=20 UNIT_COUNT=1200 STAGGER_SEC=10 bash docs/poc/observe/load.sh
# （数分待つ）
START_TIME=$T0 PERIOD=10 bash docs/poc/observe/observe.sh
```

## 出力

- **CSV**: `out/observe-<timestamp>.csv`。表計算・グラフ化にそのまま使える。列:
  - `worker_concurrent_max` 同時実行（最大）／ `worker_invocations_sum` 呼び出し数
  - `worker_errors_sum` エラー／ `worker_duration_avg_ms` ・ `worker_duration_p99_ms` 処理時間
  - `queue_visible_max` 滞留／ `queue_inflight_max` 処理中／ `queue_oldest_age_sec_max` 最古メッセージ滞留秒
  - `queue_sent_sum` 送信／ `queue_deleted_sum` 削除（**送信=削除なら取りこぼしなし**）
  - `unit_write_throttle_sum` unit 書込スロットル（T2）／ `roast_batch_wcu_sum` 完了カウンタ更新の WCU
  - `router_iterator_age_ms_max` 中継 Lambda の入口遅れ（`RELAY_MODE=lambda/both` のときのみ値が入る）
- **サマリ**（標準出力）: ピーク同時実行数、各しきい値（100/250/500/750/900/1000）への**到達経過秒**（T1）、
  Duration avg/p99、Errors、worker/unit Throttle（T2）、SQS 最古滞留、送信=削除の取りこぼし判定、
  中継 Lambda IteratorAge（lambda モード時）。

> 入口（Streams→SQS）の遅れ: `AWS/Pipes` のメトリクスは本アカウント/構成では未発行のため、Pipes 経路の
> 入口遅れは CloudWatch では取れない。中継 Lambda 経路は `router_iterator_age_ms_max` で観測できる
> （これ自体が方式比較の論点: Lambda 中継のほうが入口を可観測にできる）。
> ConcurrentExecutions は最小 1 分粒度のため立ち上がりカーブは 1 分刻み。秒粒度は Logs Insights で別途再構成する。

## 典型的な観測手順（R5）

```bash
# 1. worker の処理時間を延ばして再デプロイ（キューを枯らさず多重を積み上げるため）
PROCESSING_TIME_MS=3000 npx ampx sandbox

# 2. 負荷投入（load.sh）: 複数バッチを一括で滞留させる。画面 B の手動連打の代わり。
#    seeder を直接 invoke するので Cognito 認証は不要。
BATCHES=10 UNIT_COUNT=1200 bash docs/poc/observe/load.sh

# 3. 投入開始から数分後に観測（細かい粒度で立ち上がりを見る）
DURATION_MIN=20 PERIOD=10 bash docs/poc/observe/observe.sh

# 滞留が切れそうなら load.sh を再実行して追い投入する（供給を途切れさせない）
```

### load.sh（負荷投入ツール）

複数の roast-batch を直接作成し seeder を非同期 invoke して、大量の個体を滞留させる。
画面 B の [付番開始] を人手で連打する代わりの機械的な投入。実機パイプラインと同じ
（roast-batch を LABELING で作成 → seeder invoke → Streams → 入口 → SQS → worker）。

| 環境変数 | 既定 | 意味 |
|----------|------|------|
| `BATCHES` | `5` | 投入するバッチ数 |
| `UNIT_COUNT` | `1200` | 1 バッチあたりの個体数（`SEED_UNIT_COUNT_MAX` 以下） |
| `STAGGER_SEC` | `0` | バッチ投入の間隔（秒）。`0`=一斉、`20`=20 秒おき |
| `REGION` / `PREFIX` / `LOT_ID` / `ITEM_ID` / `ROAST_DATE` | observe.sh と同様 | — |

```bash
# 5 バッチ × 1200 = 6,000 個体を一斉投入
bash docs/poc/observe/load.sh
# 10 バッチを 20 秒間隔で投入（立ち上がりを長く保つ）
BATCHES=10 STAGGER_SEC=20 bash docs/poc/observe/load.sh
```

> ★ 従量課金が発生する（DynamoDB 書き込み・Lambda 実行・SQS）。大量投入はコストに直結するため、
> 検証後は `npx ampx sandbox delete` でスタックごと破棄すること。

ConcurrentExecutions は「1 分あたり最大 60 インスタンス増」で律速されるため、1000 到達までは
時間がかかる。滞留（`queue_visible_max`）が 0 に落ちる前に次のバッチを足し続けると、カーブが
途切れず 1000 に向かう。`unit_write_throttle_sum` が立てば T2（オンデマンドの初動スロットル）を
捉えられている。

## 注意

- GetMetricData は読み取り専用だが、呼び出し回数に応じたごく小さな CloudWatch 料金がかかる。
- CloudWatch メトリクスには数十秒〜数分の反映遅れがある。投入直後は数分おいてから実行する。
- 出力 CSV（`out/`）は `.gitignore` 済み。コミットしたい結果は別途コピーする。
