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
    ("QueueVisible", "queue_visible_max"),
    ("QueueInFlight", "queue_inflight_max"),
    ("UnitWriteThrottle", "unit_write_throttle_sum"),
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
    print("")
    print(f"worker Throttles 合計: {throttle_total:g}"
          + ("  ← スロットル発生あり" if throttle_total > 0 else "  （スロットルなし）"))
    print(f"unit テーブル WriteThrottleEvents 合計 (T2): {unit_throttle_total:g}"
          + ("  ← オンデマンドの初動スロットルを観測" if unit_throttle_total > 0 else "  （スロットルなし）"))
    print("────────────────────────────────────────────")


def _parse(ts: str) -> datetime:
    # CloudWatch は ISO8601（末尾 Z）で返す
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


if __name__ == "__main__":
    main()
