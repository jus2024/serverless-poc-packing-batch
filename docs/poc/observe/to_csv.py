#!/usr/bin/env python3
"""
to_csv.py — CloudWatch GetMetricData の JSON（stdin）を時系列 CSV に変換し、サマリを出す。

observe.sh から呼ばれる。6 系列（m1〜m6）を timestamp で結合し、
worker ConcurrentExecutions のピークと「N 到達までの経過秒」を表示する。

使い方: observe.sh が `... | python3 to_csv.py <出力CSVパス>` で呼ぶ。
標準ライブラリのみ（追加依存なし）。
"""
import sys
import json
from datetime import datetime

# ラベル → CSV 列名（出力順）
COLUMNS = [
    ("WorkerConcurrent", "worker_concurrent_max"),
    ("WorkerInvocations", "worker_invocations_sum"),
    ("WorkerThrottles", "worker_throttles_sum"),
    ("WorkerErrors", "worker_errors_sum"),
    ("WorkerDurationAvg", "worker_duration_avg_ms"),
    ("WorkerDurationP99", "worker_duration_p99_ms"),
    ("QueueVisible", "queue_visible_max"),
    ("QueueInFlight", "queue_inflight_max"),
    ("QueueOldestAgeSec", "queue_oldest_age_sec_max"),
    ("QueueMessagesSent", "queue_sent_sum"),
    ("QueueMessagesDeleted", "queue_deleted_sum"),
    ("UnitWriteThrottle", "unit_write_throttle_sum"),
    ("RoastBatchWCU", "roast_batch_wcu_sum"),
    ("RouterIteratorAgeMs", "router_iterator_age_ms_max"),
    ("RouterConcurrent", "router_concurrent_max"),
]
# 1000 多重の立ち上がりを測る到達しきい値
RAMP_TARGETS = [100, 250, 500, 750, 900, 1000]


def main() -> None:
    out_path = sys.argv[1] if len(sys.argv) > 1 else "observe.csv"
    data = json.load(sys.stdin)
    results = {r["Label"]: r for r in data.get("MetricDataResults", [])}

    # 全系列の timestamp を集合に集めてソート（系列ごとに穴があり得る）
    ts_set = set()
    for label, _col in COLUMNS:
        for t in results.get(label, {}).get("Timestamps", []):
            ts_set.add(t)
    timestamps = sorted(ts_set)

    if not timestamps:
        print("観測データがありません（期間内にメトリクスが無い）。投入後に時間を置いて再実行するか、"
              "DURATION_MIN を延ばしてください。", file=sys.stderr)
        # 空 CSV（ヘッダのみ）は作っておく
        with open(out_path, "w") as f:
            f.write("timestamp," + ",".join(c for _, c in COLUMNS) + "\n")
        return

    # ラベルごとに {timestamp: value} の辞書を作る
    series = {}
    for label, _col in COLUMNS:
        r = results.get(label, {})
        series[label] = dict(zip(r.get("Timestamps", []), r.get("Values", [])))

    # CSV 出力
    with open(out_path, "w") as f:
        f.write("timestamp," + ",".join(c for _, c in COLUMNS) + "\n")
        for t in timestamps:
            row = [t]
            for label, _col in COLUMNS:
                v = series[label].get(t)
                row.append("" if v is None else f"{v:g}")
            f.write(",".join(row) + "\n")

    # ─── サマリ ───────────────────────────────────────────────
    conc = [(t, series["WorkerConcurrent"].get(t)) for t in timestamps]
    conc = [(t, v) for t, v in conc if v is not None]
    throttle_total = sum(v for v in series["WorkerThrottles"].values())
    unit_throttle_total = sum(v for v in series["UnitWriteThrottle"].values())

    print("")
    print("─── サマリ ──────────────────────────────────")
    if conc:
        peak_v = max(v for _t, v in conc)
        peak_t = next(t for t, v in conc if v == peak_v)
        t0 = _parse(conc[0][0])
        print(f"ピーク同時実行数 (worker ConcurrentExecutions): {peak_v:g}")
        print(f"ピーク時刻: {peak_t}")
        print("")
        print("立ち上がり（各しきい値に初めて到達した経過秒。観測開始＝0 秒）:")
        for target in RAMP_TARGETS:
            hit = next((t for t, v in conc if v >= target), None)
            if hit is not None:
                elapsed = (_parse(hit) - t0).total_seconds()
                print(f"  {target:>5} 多重: +{elapsed:6.0f} 秒 ({hit})")
            else:
                print(f"  {target:>5} 多重: 未到達")
    # Duration（最大の点＝最も負荷が高い瞬間の処理時間）
    dur_avg = [v for v in series["WorkerDurationAvg"].values() if v is not None]
    dur_p99 = [v for v in series["WorkerDurationP99"].values() if v is not None]
    errors_total = sum(v for v in series["WorkerErrors"].values())
    oldest = [v for v in series["QueueOldestAgeSec"].values() if v is not None]
    sent_total = sum(v for v in series["QueueMessagesSent"].values())
    deleted_total = sum(v for v in series["QueueMessagesDeleted"].values())
    router_age = [v for v in series["RouterIteratorAgeMs"].values() if v is not None]

    print("")
    if dur_avg:
        print(f"worker Duration: avg {max(dur_avg):.0f}ms（ピーク分） / "
              f"p99 {max(dur_p99):.0f}ms" if dur_p99 else f"worker Duration avg {max(dur_avg):.0f}ms")
    print(f"worker Errors 合計: {errors_total:g}"
          + ("  ← エラーあり" if errors_total > 0 else ""))
    print(f"worker Throttles 合計: {throttle_total:g}"
          + ("  ← スロットル発生あり" if throttle_total > 0 else "  （スロットルなし）"))
    print(f"unit テーブル WriteThrottleEvents 合計 (T2): {unit_throttle_total:g}"
          + ("  ← オンデマンドの初動スロットルを観測" if unit_throttle_total > 0 else "  （スロットルなし）"))
    if oldest:
        print(f"SQS 最古メッセージ滞留 (最大): {max(oldest):g} 秒")
    print(f"SQS 送信 {sent_total:g} / 削除 {deleted_total:g} 件"
          + ("  （送信=削除。取りこぼしなし）" if sent_total == deleted_total
             else "  ← 送信と削除に差（処理中/未処理が残っている可能性）"))
    if router_age:
        print(f"中継 Lambda IteratorAge (最大): {max(router_age):g} ms  ← 方式 A-Lambda の入口遅れ")
    router_conc = [v for v in series["RouterConcurrent"].values() if v is not None]
    if router_conc:
        print(f"中継 Lambda 同時実行 (最大): {max(router_conc):g}  ← S×P の壁（供給レートの天井）")
    print("────────────────────────────────────────────")


def _parse(ts: str) -> datetime:
    # CloudWatch は ISO8601（末尾 Z）で返す
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


if __name__ == "__main__":
    main()
