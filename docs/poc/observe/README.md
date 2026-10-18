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
| `DURATION_MIN` | `15` | 遡る時間（分） |
| `PERIOD` | `60` | 粒度（秒）。立ち上がりを細かく見るなら `10` |
| `OUT_DIR` | `docs/poc/observe/out` | CSV 出力先 |

## 出力

- **CSV**: `out/observe-<timestamp>.csv`。列は timestamp・worker 同時実行(最大)・
  Invocations(合計)・Throttles(合計)・SQS 滞留(最大)・SQS 処理中(最大)・unit 書込スロットル(合計)。
  表計算やグラフ化にそのまま使える（記事のグラフ素材）。
- **サマリ**（標準出力）: ピーク同時実行数と、各しきい値（100/250/500/750/900/1000 多重）に
  **初めて到達した経過秒**（＝立ち上がりカーブ T1）、worker/unit テーブルの Throttle 合計（T2）。

## 典型的な観測手順（R5）

```bash
# 1. worker の処理時間を延ばして再デプロイ（キューを枯らさず多重を積み上げるため）
PROCESSING_TIME_MS=3000 npx ampx sandbox

# 2. 画面 A で unit_count=1200 のバッチを複数登録 → 画面 B で相次いで [付番開始]
#    （滞留を切らさないだけの供給を入れる。1 バッチだと途中でキューが枯れる）

# 3. 投入開始から数分後に観測（細かい粒度で立ち上がりを見る）
DURATION_MIN=20 PERIOD=10 bash docs/poc/observe/observe.sh
```

ConcurrentExecutions は「1 分あたり最大 60 インスタンス増」で律速されるため、1000 到達までは
時間がかかる。滞留（`queue_visible_max`）が 0 に落ちる前に次のバッチを足し続けると、カーブが
途切れず 1000 に向かう。`unit_write_throttle_sum` が立てば T2（オンデマンドの初動スロットル）を
捉えられている。

## 注意

- GetMetricData は読み取り専用だが、呼び出し回数に応じたごく小さな CloudWatch 料金がかかる。
- CloudWatch メトリクスには数十秒〜数分の反映遅れがある。投入直後は数分おいてから実行する。
- 出力 CSV（`out/`）は `.gitignore` 済み。コミットしたい結果は別途コピーする。
