#!/usr/bin/env bash
#
# observe.sh — 1000 多重検証の時系列観測（R5 / T1 / T2）
#
# labeling-worker の ConcurrentExecutions の立ち上がりカーブ、SQS 滞留、Throttle、
# unit テーブルのオンデマンド・スロットルを CloudWatch から時系列で取得し、
# CSV と「ピーク多重」「到達まで何秒」のサマリを出力する。
#
# 設計の受け入れ基準との対応:
#   - R5 / T1: worker ConcurrentExecutions の立ち上がり（1000 到達まで N 秒）
#   - T2:      unit テーブルの WriteThrottleEvents（オンデマンドの初動スロットル）
#
# 使い方:
#   bash docs/poc/observe/observe.sh                 # 直近 15 分を 60 秒粒度で
#   DURATION_MIN=30 PERIOD=10 bash docs/poc/observe/observe.sh
#   REGION=ap-northeast-1 bash docs/poc/observe/observe.sh
#
# 前提:
#   - AWS CLI v2 が設定済み（sandbox と同じ資格情報・リージョン）
#   - リソースは命名接頭辞 kiro-roasters- で自動検出する（サフィックスはハードコードしない）
#   - 読み取り専用（CloudWatch GetMetricData / list 系のみ。課金リソースは作らない）
#
set -euo pipefail

# ─── 設定（環境変数で上書き可） ───────────────────────────────────
REGION="${REGION:-${AWS_REGION:-us-west-2}}"
PREFIX="${PREFIX:-kiro-roasters}"
DURATION_MIN="${DURATION_MIN:-15}"   # 遡る時間（分）
PERIOD="${PERIOD:-60}"               # 粒度（秒）。10 / 30 / 60 など
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "$0")" && pwd)/out}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
CSV="$OUT_DIR/observe-$STAMP.csv"

echo "リージョン: $REGION / 接頭辞: $PREFIX / 期間: 直近 ${DURATION_MIN} 分 / 粒度: ${PERIOD}s"

# ─── リソースの自動検出（サフィックスをハードコードしない） ───────────
# 検出のポイント:
#  - ページングは有効のまま（アカウントに関数が多いと複数ページに跨り、--no-paginate だと
#    先頭ページしか見ず取りこぼす）。--query はページ跨ぎで集約される。
#  - --output text は複数ページで「ページごとの行」になり得るため、tab/改行を潰して
#    接頭辞一致の先頭 1 件に正規化する。
#  - set -e 下で grep が 0 件だと落ちるので、各検出を関数化し || true で握る。
pick_first() { tr '\t' '\n' | grep -v '^None$' | grep . | head -1 || true; }

WORKER="$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName,'${PREFIX}-labeling-worker')].FunctionName" \
  --output text | pick_first)"
UNIT_TABLE="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@,'${PREFIX}-unit')]" --output text | pick_first)"
QUEUE_NAME="$(aws sqs list-queues --region "$REGION" --queue-name-prefix "${PREFIX}-labeling" \
  --query "QueueUrls" --output text 2>/dev/null | tr '\t' '\n' | grep -v 'dlq' | grep . | head -1 | sed 's#.*/##' || true)"

if [[ "$WORKER" == "None" || -z "$WORKER" ]]; then
  echo "ERROR: labeling-worker が見つかりません（リージョン $REGION、接頭辞 $PREFIX）。sandbox をデプロイ済みか確認してください。" >&2
  exit 1
fi
echo "worker: $WORKER"
echo "unit table: $UNIT_TABLE"
echo "queue: $QUEUE_NAME"

# ─── 期間（UTC ISO8601） ──────────────────────────────────────────
# macOS(date -v) と GNU(date -d) の両対応
if date -v-1M >/dev/null 2>&1; then
  START="$(date -u -v-"${DURATION_MIN}"M +%Y-%m-%dT%H:%M:%SZ)"
else
  START="$(date -u -d "${DURATION_MIN} minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
fi
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── GetMetricData クエリ ────────────────────────────────────────
# m1 ConcurrentExecutions(worker 最大)  m2 Invocations  m3 Throttles(worker)
# m4 SQS 可視メッセージ(滞留)            m5 SQS 処理中   m6 unit WriteThrottleEvents(T2)
# 1 行 JSON（改行を入れると CLI の JSON パーサが "Invalid control character" で弾く）。
# file:// 経由で渡し、長い引数のクォート事故も避ける。
QFILE="$(mktemp)"
trap 'rm -f "$QFILE"' EXIT
printf '%s' "[\
{\"Id\":\"m1\",\"Label\":\"WorkerConcurrent\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"ConcurrentExecutions\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m2\",\"Label\":\"WorkerInvocations\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Invocations\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m3\",\"Label\":\"WorkerThrottles\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Throttles\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m4\",\"Label\":\"QueueVisible\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"ApproximateNumberOfMessagesVisible\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m5\",\"Label\":\"QueueInFlight\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"ApproximateNumberOfMessagesNotVisible\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m6\",\"Label\":\"UnitWriteThrottle\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/DynamoDB\",\"MetricName\":\"WriteThrottleEvents\",\"Dimensions\":[{\"Name\":\"TableName\",\"Value\":\"$UNIT_TABLE\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}}\
]" > "$QFILE"

echo "GetMetricData 取得中 ($START 〜 $END)..."
RAW="$(aws cloudwatch get-metric-data --region "$REGION" \
  --start-time "$START" --end-time "$END" \
  --scan-by TimestampAscending \
  --metric-data-queries "file://$QFILE" \
  --output json)"

# ─── CSV 化 + サマリ（timestamp を揃えて結合） ────────────────────
echo "$RAW" | python3 "$(dirname "$0")/to_csv.py" "$CSV"

echo ""
echo "CSV: $CSV"
echo "（CloudWatch ダッシュボードは AWS コンソール → CloudWatch → ダッシュボード → ${PREFIX}-labeling-* でも確認できます）"
