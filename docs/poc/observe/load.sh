#!/usr/bin/env bash
#
# load.sh — 1000 多重検証の負荷投入（複数バッチを連続・大量に滞留させる）
#
# 画面 B の [付番開始] を人手で連打する代わりに、roast-batch レコードを直接作って
# seeder を非同期 invoke する。Cognito 認証を介さず（API をバイパスして）、
# 供給を途切れさせずに大量の個体を Streams → SQS → worker へ流し込むためのツール。
#
# 実機パイプラインとの対応:
#   - roast-batch を status=LABELING / labeled_count=0 / labeling_started_at 付きで作成
#     （= 画面 B の API が条件付き遷移でやっていること）。
#   - seeder を InvocationType=Event で invoke（= API が条件成功時にやっていること）。
#   - 以降は本物の seeder が unit を unit_count 件 INSERT → Streams → 入口 → SQS → worker。
#
# 使い方:
#   bash docs/poc/observe/load.sh                       # 既定 5 バッチ × 1200 件
#   BATCHES=10 UNIT_COUNT=1200 bash docs/poc/observe/load.sh
#   BATCHES=5 UNIT_COUNT=1200 STAGGER_SEC=20 bash docs/poc/observe/load.sh   # 20 秒間隔で投入
#   REGION=ap-northeast-1 bash docs/poc/observe/load.sh
#
# 前提:
#   - AWS CLI v2 が設定済み（sandbox と同じ資格情報・リージョン）
#   - sandbox がデプロイ済み。1000 多重検証なら worker に PROCESSING_TIME_MS を設定済み
#   - UNIT_COUNT は SEED_UNIT_COUNT_MAX（既定 1200）以下にすること（超えると seeder が弾く）
#
# 注意:
#   - ★ 従量課金が発生する（DynamoDB 書き込み・Lambda 実行・SQS）。大量投入はコストに直結。
#   - 投入後の観測は observe.sh で行う。
#
set -euo pipefail

REGION="${REGION:-${AWS_REGION:-us-west-2}}"
PREFIX="${PREFIX:-kiro-roasters}"
BATCHES="${BATCHES:-5}"              # 投入するバッチ数
UNIT_COUNT="${UNIT_COUNT:-1200}"     # 1 バッチあたりの個体数（SEED_UNIT_COUNT_MAX 以下）
STAGGER_SEC="${STAGGER_SEC:-0}"      # バッチ投入の間隔（秒）。0=一斉
LOT_ID="${LOT_ID:-LOT#2026-10-01-003}"
ITEM_ID="${ITEM_ID:-ITEM#ETH-YIRG-G1-MEDIUM-DRIP}"
ROAST_DATE="${ROAST_DATE:-2026-10-09}"

echo "リージョン: $REGION / 接頭辞: $PREFIX"
echo "投入: ${BATCHES} バッチ × ${UNIT_COUNT} 件 = $((BATCHES * UNIT_COUNT)) 個体 / 投入間隔: ${STAGGER_SEC}s"

# ─── リソース自動検出（observe.sh と同じ流儀） ─────────────────────
pick_first() { tr '\t' '\n' | grep -v '^None$' | grep . | head -1 || true; }

ROAST_TABLE="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@,'${PREFIX}-roast-batch')]" --output text | pick_first)"
SEEDER="$(aws lambda list-functions --region "$REGION" \
  --query "Functions[?starts_with(FunctionName,'${PREFIX}-labeling-seeder')].FunctionName" \
  --output text | pick_first)"

if [[ -z "$ROAST_TABLE" || -z "$SEEDER" ]]; then
  echo "ERROR: roast-batch テーブルまたは seeder が見つかりません（リージョン $REGION / 接頭辞 $PREFIX）。sandbox デプロイを確認してください。" >&2
  exit 1
fi
echo "roast-batch table: $ROAST_TABLE"
echo "seeder: $SEEDER"
echo ""

# ─── 投入ループ ──────────────────────────────────────────────────
NOW_BASE="$(date -u +%Y-%m-%dT%H:%M:%S)"
for i in $(seq 1 "$BATCHES"); do
  # バッチ ID は衝突しないよう連番 + 秒 + ループ番号で一意化
  TS="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  BATCH_ID="BATCH#${LOT_ID#LOT#}-load-${NOW_BASE}-$(printf '%02d' "$i")"

  # 1. roast-batch を LABELING で作成（画面 B の条件付き遷移に相当）
  aws dynamodb put-item --region "$REGION" --table-name "$ROAST_TABLE" --item "$(cat <<JSON
{
  "batch_id": {"S": "$BATCH_ID"},
  "item_id": {"S": "$ITEM_ID"},
  "lot_id": {"S": "$LOT_ID"},
  "roast_date": {"S": "$ROAST_DATE"},
  "unit_count": {"N": "$UNIT_COUNT"},
  "labeled_count": {"N": "0"},
  "status": {"S": "LABELING"},
  "created_at": {"S": "$TS"},
  "labeling_started_at": {"S": "$TS"}
}
JSON
)" >/dev/null

  # 2. seeder を非同期 invoke（画面 B が条件成功時にやる invoke に相当）
  PAYLOAD="$(printf '{"batch_id":"%s"}' "$BATCH_ID" | base64)"
  aws lambda invoke --region "$REGION" --function-name "$SEEDER" \
    --invocation-type Event --payload "$PAYLOAD" \
    /dev/null >/dev/null

  echo "投入 $i/$BATCHES: $BATCH_ID （seeder 起動）"
  if [[ "$STAGGER_SEC" != "0" && "$i" -lt "$BATCHES" ]]; then
    sleep "$STAGGER_SEC"
  fi
done

echo ""
echo "投入完了。数分おいてから観測:"
echo "  DURATION_MIN=30 PERIOD=10 bash $(dirname "$0")/observe.sh"
echo "（滞留が切れそうなら本スクリプトを再実行して追い投入する）"
