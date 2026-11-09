#!/usr/bin/env bash
#
# batch-times.sh — roast-batch の業務時間（labeling_started_at → labeling_finished_at）を集計する
#
# load.sh が作ったバッチを T0 で絞り、対象数・LABELED 数・全体所要・1 バッチ所要（min/中央値/max）を出す。
# タイムスタンプが壊れているバッチ（macOS の date で `.%3N` が展開されず `.3N` になった旧 load.sh 由来）は
# `.3N` を除去して秒精度で読む。それでも parse できない値は除外して件数を報告する。
#
# 使い方:
#   SINCE=2026-10-19T03:00:00Z bash docs/poc/observe/batch-times.sh
#   bash docs/poc/observe/batch-times.sh 2026-10-19T03:00:00Z     # 引数でも可
#   （SINCE 省略時は全バッチ対象。START_TIME も同義の別名として使える）
#
# 前提: AWS CLI v2 / python3（標準ライブラリのみ）/ 読み取り専用（scan）。
#
set -euo pipefail

REGION="${REGION:-${AWS_REGION:-us-west-2}}"
PREFIX="${PREFIX:-kiro-roasters}"
SINCE="${1:-${SINCE:-${START_TIME:-}}}"

pick_first() { tr '\t' '\n' | grep -v '^None$' | grep . | head -1 || true; }

ROAST_TABLE="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?starts_with(@,'${PREFIX}-roast-batch')]" --output text | pick_first)"
if [[ -z "$ROAST_TABLE" ]]; then
  echo "ERROR: roast-batch テーブルが見つかりません（リージョン ${REGION} / 接頭辞 ${PREFIX}）。sandbox デプロイを確認してください。" >&2
  exit 1
fi
echo "リージョン: $REGION / roast-batch table: $ROAST_TABLE / SINCE: ${SINCE:-（指定なし）}"

# scan はページングされる（CLI が自動で辿る）。必要な属性だけ射影する。
aws dynamodb scan --region "$REGION" --table-name "$ROAST_TABLE" \
  --projection-expression "batch_id, #s, labeling_started_at, labeling_finished_at" \
  --expression-attribute-names '{"#s":"status"}' \
  --output json | SINCE="$SINCE" python3 -c '
import os, re, sys, json, statistics
from datetime import datetime, timezone

def parse(s):
    # 旧 load.sh の壊れた値（例 ...:00.3NZ）は `.3N` を除去して秒精度で読む。
    # 通常の小数秒（.123Z 等）はそのまま fromisoformat に渡す。それ以外の不正値は ValueError で除外する
    s = re.sub(r"\.\d*N", "", s)
    s = re.sub(r"\.(\d+)", lambda m: "." + m.group(1)[:6].ljust(6, "0"), s)
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)

since_raw = os.environ.get("SINCE", "")
since = parse(since_raw) if since_raw else None
items = json.load(sys.stdin).get("Items", [])

target = labeled = broken = 0
starts, finishes, durs = [], [], []
for it in items:
    s = it.get("labeling_started_at", {}).get("S")
    if not s:
        continue
    try:
        st = parse(s)
    except ValueError:
        broken += 1
        continue
    if since and st < since:
        continue
    target += 1
    if it.get("status", {}).get("S") != "LABELED":
        continue
    f = it.get("labeling_finished_at", {}).get("S")
    if not f:
        continue
    try:
        fi = parse(f)
    except ValueError:
        broken += 1
        continue
    labeled += 1
    starts.append(st); finishes.append(fi)
    durs.append((fi - st).total_seconds())

print(f"対象バッチ数: {target} / LABELED 数: {labeled} / parse 失敗で除外: {broken}")
if durs:
    total = (max(finishes) - min(starts)).total_seconds()
    print(f"全体所要（最初の start → 最後の finish）: {total:.0f} 秒")
    print(f"1 バッチ所要: min {min(durs):.0f} / 中央値 {statistics.median(durs):.0f} / max {max(durs):.0f} 秒")
else:
    print("LABELED 済みの対象バッチがありません。")
'
