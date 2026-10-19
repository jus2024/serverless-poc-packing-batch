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
#   START_TIME=now bash docs/poc/observe/observe.sh                    # 今この瞬間を起点に
#   START_TIME=now-10min bash docs/poc/observe/observe.sh             # 10 分前から今まで
#   START_TIME=2026-10-18T10:28:00Z bash docs/poc/observe/observe.sh  # 絶対時刻を起点に
#   START_TIME=... END_TIME=... bash docs/poc/observe/observe.sh      # 窓を両端固定
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
DURATION_MIN="${DURATION_MIN:-15}"   # 遡る時間（分）。START_TIME 指定時は無視される
PERIOD="${PERIOD:-60}"               # 粒度（秒）。10 / 30 / 60 など
# 絶対時刻で窓を固定したいとき（前回の投入を除外してこの投入だけを見る）。
# UTC ISO8601（例 2026-10-18T10:28:00Z）。START_TIME を指定すると DURATION_MIN は無視され、
# END_TIME 省略時は現在時刻までになる。
START_TIME="${START_TIME:-}"
END_TIME="${END_TIME:-}"
OUT_DIR="${OUT_DIR:-$(cd "$(dirname "$0")" && pwd)/out}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
CSV="$OUT_DIR/observe-$STAMP.csv"

if [[ -n "$START_TIME" ]]; then
  echo "リージョン: $REGION / 接頭辞: $PREFIX / 期間: START_TIME=${START_TIME} 指定 / 粒度: ${PERIOD}s"
else
  echo "リージョン: $REGION / 接頭辞: $PREFIX / 期間: 直近 ${DURATION_MIN} 分 / 粒度: ${PERIOD}s"
fi

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
ROAST_TABLE="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@,'${PREFIX}-roast-batch')]" --output text | pick_first)"
ROUTER="$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName,'${PREFIX}-labeling-router')].FunctionName" \
  --output text | pick_first)"
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
# 時刻トークンを UTC ISO8601 に解決する。受け付ける形:
#   - "now"                 … 現在時刻
#   - "now-10min" / "now-2h"… 現在からの相対（分 min / 時 h）
#   - ISO8601 絶対時刻       … 2026-10-18T10:28:00Z 等はそのまま使う
# macOS(date -v) と GNU(date -d) の両対応。
resolve_time() {
  local tok="$1"
  if [[ "$tok" == "now" ]]; then
    date -u +%Y-%m-%dT%H:%M:%SZ
    return
  fi
  if [[ "$tok" =~ ^now-([0-9]+)(min|m|h)$ ]]; then
    local n="${BASH_REMATCH[1]}" unit="${BASH_REMATCH[2]}"
    if date -v-1M >/dev/null 2>&1; then
      case "$unit" in
        h) date -u -v-"${n}"H +%Y-%m-%dT%H:%M:%SZ ;;
        *) date -u -v-"${n}"M +%Y-%m-%dT%H:%M:%SZ ;;
      esac
    else
      case "$unit" in
        h) date -u -d "${n} hours ago" +%Y-%m-%dT%H:%M:%SZ ;;
        *) date -u -d "${n} minutes ago" +%Y-%m-%dT%H:%M:%SZ ;;
      esac
    fi
    return
  fi
  # それ以外は絶対時刻としてそのまま使う
  printf '%s' "$tok"
}

if [[ -n "$START_TIME" ]]; then
  # 絶対/相対で窓を固定（前回の投入を除外してこの投入だけを見る）
  START="$(resolve_time "$START_TIME")"
else
  # 従来どおり DURATION_MIN 分だけ遡る
  if date -v-1M >/dev/null 2>&1; then
    START="$(date -u -v-"${DURATION_MIN}"M +%Y-%m-%dT%H:%M:%SZ)"
  else
    START="$(date -u -d "${DURATION_MIN} minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
  fi
fi

if [[ -n "$END_TIME" ]]; then
  END="$(resolve_time "$END_TIME")"
else
  END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# CloudWatch は start < end を要求する。START_TIME=now のように窓が 0 以下になる場合は、
# 直近 1 粒度分（最低 60 秒）さかのぼって最小の窓にして走らせる（エラーにしない）。
to_epoch() {
  if date -v-1M >/dev/null 2>&1; then
    date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || echo 0
  else
    date -u -d "$1" +%s 2>/dev/null || echo 0
  fi
}
START_EPOCH="$(to_epoch "$START")"
END_EPOCH="$(to_epoch "$END")"
if [[ "$START_EPOCH" -ge "$END_EPOCH" ]]; then
  BACK=$(( PERIOD > 60 ? PERIOD : 60 ))
  if date -v-1M >/dev/null 2>&1; then
    START="$(date -u -r $(( END_EPOCH - BACK )) +%Y-%m-%dT%H:%M:%SZ)"
  else
    START="$(date -u -d "@$(( END_EPOCH - BACK ))" +%Y-%m-%dT%H:%M:%SZ)"
  fi
  echo "注意: 窓が 0 以下だったため、END から ${BACK} 秒さかのぼって最小の窓にしました（START_TIME=now 等）。" >&2
fi

# ─── GetMetricData クエリ ────────────────────────────────────────
# m1 ConcurrentExecutions(worker 最大)  m2 Invocations  m3 Throttles(worker)
# m4 SQS 可視メッセージ(滞留)            m5 SQS 処理中   m6 unit WriteThrottleEvents(T2)
# 1 行 JSON（改行を入れると CLI の JSON パーサが "Invalid control character" で弾く）。
# file:// 経由で渡し、長い引数のクォート事故も避ける。
QFILE="$(mktemp)"
trap 'rm -f "$QFILE"' EXIT

# 中継 Lambda（router）の IteratorAge は RELAY_MODE=lambda/both のときだけ値を持つ
# （Streams ESM が付いている場合）。router が存在すれば m14 として追加する。
# Pipes 専用のメトリクス（AWS/Pipes）は本アカウント/構成では未発行のため取得しない
# （= Pipes 経路は入口の遅れを CloudWatch では観測できない。方式比較の論点として記録する）。
ROUTER_Q=""
if [[ -n "$ROUTER" && "$ROUTER" != "None" ]]; then
  # m14 IteratorAge（入口遅れ）、m15 ConcurrentExecutions（S×P の壁の可視化。
  # 中継 Lambda は Streams を ESM で読むため同時実行が S×P に張り付く）。
  ROUTER_Q=",{\"Id\":\"m14\",\"Label\":\"RouterIteratorAgeMs\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"IteratorAge\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$ROUTER\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},{\"Id\":\"m15\",\"Label\":\"RouterConcurrent\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"ConcurrentExecutions\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$ROUTER\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}}"
fi

printf '%s' "[\
{\"Id\":\"m1\",\"Label\":\"WorkerConcurrent\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"ConcurrentExecutions\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m2\",\"Label\":\"WorkerInvocations\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Invocations\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m3\",\"Label\":\"WorkerThrottles\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Throttles\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m4\",\"Label\":\"QueueVisible\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"ApproximateNumberOfMessagesVisible\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m5\",\"Label\":\"QueueInFlight\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"ApproximateNumberOfMessagesNotVisible\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m6\",\"Label\":\"UnitWriteThrottle\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/DynamoDB\",\"MetricName\":\"WriteThrottleEvents\",\"Dimensions\":[{\"Name\":\"TableName\",\"Value\":\"$UNIT_TABLE\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m7\",\"Label\":\"WorkerDurationAvg\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Duration\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Average\"}},\
{\"Id\":\"m8\",\"Label\":\"WorkerDurationP99\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Duration\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"p99\"}},\
{\"Id\":\"m9\",\"Label\":\"WorkerErrors\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/Lambda\",\"MetricName\":\"Errors\",\"Dimensions\":[{\"Name\":\"FunctionName\",\"Value\":\"$WORKER\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m10\",\"Label\":\"QueueOldestAgeSec\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"ApproximateAgeOfOldestMessage\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Maximum\"}},\
{\"Id\":\"m11\",\"Label\":\"QueueMessagesSent\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"NumberOfMessagesSent\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m12\",\"Label\":\"QueueMessagesDeleted\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/SQS\",\"MetricName\":\"NumberOfMessagesDeleted\",\"Dimensions\":[{\"Name\":\"QueueName\",\"Value\":\"$QUEUE_NAME\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}},\
{\"Id\":\"m13\",\"Label\":\"RoastBatchWCU\",\"MetricStat\":{\"Metric\":{\"Namespace\":\"AWS/DynamoDB\",\"MetricName\":\"ConsumedWriteCapacityUnits\",\"Dimensions\":[{\"Name\":\"TableName\",\"Value\":\"$ROAST_TABLE\"}]},\"Period\":$PERIOD,\"Stat\":\"Sum\"}}$ROUTER_Q\
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
