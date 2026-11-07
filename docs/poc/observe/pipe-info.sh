#!/usr/bin/env bash
#
# pipe-info.sh — Pipes の実設定と Streams のオープンシャード数 S を表示する（T3 交絡解消用）
#
# `describe-pipe` で ParallelizationFactor 等の実値を確定し、unit テーブル Streams の
# オープンシャード数 S（EndingSequenceNumber を持たないシャード数）を併記する。
# S×P の比較には S が必須（sandbox を作り直すと S は変わりうる）ので、試行ごとに記録すること。
# router に Streams ESM があれば ParallelizationFactor / BatchSize / State も併記する。
#
# 使い方:
#   bash docs/poc/observe/pipe-info.sh
#   REGION=ap-northeast-1 bash docs/poc/observe/pipe-info.sh
#
# 前提: AWS CLI v2 / python3 / 読み取り専用（list・describe 系のみ）。
# 接頭辞（PREFIX）でリソースを自動検出する（observe.sh と同じ流儀）。
#
set -euo pipefail

REGION="${REGION:-${AWS_REGION:-us-west-2}}"
PREFIX="${PREFIX:-kiro-roasters}"

pick_first() { tr '\t' '\n' | grep -v '^None$' | grep . | head -1 || true; }

echo "リージョン: $REGION / 接頭辞: $PREFIX"
echo ""

# ─── Pipe ────────────────────────────────────────────────────────
PIPE_NAME="$(aws pipes list-pipes --region "$REGION" \
  --query "Pipes[?starts_with(Name,'${PREFIX}-labeling-pipe')].Name" \
  --output text 2>/dev/null | pick_first || true)"

echo "─── Pipe ─────────────────────────────────────"
if [[ -z "$PIPE_NAME" ]]; then
  echo "Pipe なし（RELAY_MODE=lambda の可能性）"
else
  aws pipes describe-pipe --region "$REGION" --name "$PIPE_NAME" --output json | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("Name:         ", d.get("Name"))
print("CurrentState: ", d.get("CurrentState"), "/ DesiredState:", d.get("DesiredState"))
sp = d.get("SourceParameters", {}) or {}
ddb = sp.get("DynamoDBStreamParameters", {}) or {}
print("SourceParameters.DynamoDBStreamParameters:")
for k in ("BatchSize", "ParallelizationFactor", "StartingPosition",
          "MaximumBatchingWindowInSeconds", "MaximumRetryAttempts",
          "MaximumRecordAgeInSeconds", "OnPartialBatchItemFailure", "DeadLetterConfig"):
    if k in ddb:
        print(f"  {k}: {ddb[k]}")
    elif k == "ParallelizationFactor":
        print("  ParallelizationFactor: 未設定＝既定1（公式既定。実効は Concurrency で確認）")
for k, v in ddb.items():
    if k not in ("BatchSize", "ParallelizationFactor", "StartingPosition",
                 "MaximumBatchingWindowInSeconds", "MaximumRetryAttempts",
                 "MaximumRecordAgeInSeconds", "OnPartialBatchItemFailure", "DeadLetterConfig"):
        print(f"  {k}: {v}")
print("FilterCriteria:", json.dumps(sp.get("FilterCriteria"), ensure_ascii=False))
print("Source:       ", d.get("Source"))
print("Target:       ", d.get("Target"))
'
fi

# ─── unit テーブル Streams のオープンシャード数 S ────────────────────
echo ""
echo "─── Streams（unit テーブル） ─────────────────"
UNIT_TABLE="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@,'${PREFIX}-unit')]" --output text | pick_first)"
if [[ -z "$UNIT_TABLE" ]]; then
  echo "unit テーブルが見つかりません（接頭辞 ${PREFIX}）。"
else
  STREAM_ARN="$(aws dynamodb describe-table --region "$REGION" --table-name "$UNIT_TABLE" \
    --query "Table.LatestStreamArn" --output text 2>/dev/null | pick_first)"
  echo "unit table: $UNIT_TABLE"
  if [[ -z "$STREAM_ARN" ]]; then
    echo "Streams が有効ではありません。"
  else
    # ページングあり（シャードが多いと LastEvaluatedShardId で続く）。単純化のため 1 回分 + 続きを辿る。
    SHARDS_OPEN=0; SHARDS_ALL=0; START_ID=""
    while :; do
      if [[ -n "$START_ID" ]]; then
        OUT="$(aws dynamodbstreams describe-stream --region "$REGION" --stream-arn "$STREAM_ARN" \
          --exclusive-start-shard-id "$START_ID" --output json)"
      else
        OUT="$(aws dynamodbstreams describe-stream --region "$REGION" --stream-arn "$STREAM_ARN" --output json)"
      fi
      RES="$(printf '%s' "$OUT" | python3 -c '
import sys, json
d = json.load(sys.stdin)["StreamDescription"]
sh = d.get("Shards", [])
op = [s for s in sh if "EndingSequenceNumber" not in s.get("SequenceNumberRange", {})]
print(len(sh), len(op), d.get("LastEvaluatedShardId", ""))
')"
      read -r A O NEXT <<<"$RES"
      SHARDS_ALL=$((SHARDS_ALL + A)); SHARDS_OPEN=$((SHARDS_OPEN + O))
      [[ -z "${NEXT:-}" ]] && break
      START_ID="$NEXT"
    done
    echo "オープンシャード数 S: $SHARDS_OPEN （全シャード $SHARDS_ALL）  ← 試行ごとに記録する"
  fi
fi

# ─── router の Streams ESM（RELAY_MODE=lambda/both のみ） ─────────────
echo ""
echo "─── router ESM ───────────────────────────────"
ROUTER="$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName,'${PREFIX}-labeling-router')].FunctionName" \
  --output text | pick_first)"
if [[ -z "$ROUTER" ]]; then
  echo "router なし（RELAY_MODE=pipes の可能性）"
else
  echo "router: $ROUTER"
  ESM="$(aws lambda list-event-source-mappings --region "$REGION" --function-name "$ROUTER" \
    --query "EventSourceMappings[?contains(EventSourceArn,':dynamodb:')].[State,BatchSize,ParallelizationFactor]" \
    --output text | head -1 || true)"
  if [[ -z "$ESM" || "$ESM" == "None" ]]; then
    echo "Streams ESM なし"
  else
    read -r ST BS PF <<<"$ESM"
    echo "State: $ST / BatchSize: $BS / ParallelizationFactor: $PF"
  fi
fi
