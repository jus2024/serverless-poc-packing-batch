/**
 * 画面 C: 付番進捗モニタ（design §11.4 / 決定 4 / 要件 10）。
 *
 * `use-batch-polling` が `GET /batches/{id}` を 1〜2 秒ポーリングし、進捗バー
 * （`labeled_count / unit_count`）と軽量な稼働感（経過時間・直近増分・ETA）を出す。進捗の根拠は
 * SQS キュー深度ではなく `labeled_count`（要件 10.2）。`status=LABELED` で完了表示（要件 10.4）。
 * 同時実行の時系列など詳細メトリクスは CloudWatch ダッシュボードへのリンク誘導に委ねる（決定 4）。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useBatchPolling } from "./use-batch-polling";
import {
  progressPercent,
  isBatchComplete,
  recentRatePerSecond,
  estimateEtaSeconds,
  elapsedSeconds,
  type ProgressSample,
} from "@/src/lib/labeling/progress";
import styles from "./labeling.module.css";

interface ProgressMonitorPanelProps {
  /** 画面 B で開始/選択した batch_id（未選択は空文字）。 */
  batchId: string;
  /** 入力欄での batch_id 変更を親へ反映する。 */
  onBatchIdChange: (batchId: string) => void;
}

/** CloudWatch ダッシュボードへの誘導 URL（任意の環境変数。未設定ならコンソール案内のみ）。 */
const CLOUDWATCH_URL = process.env.NEXT_PUBLIC_LABELING_DASHBOARD_URL;

function formatSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m} 分 ${s} 秒`;
}

export default function ProgressMonitorPanel({
  batchId,
  onBatchIdChange,
}: ProgressMonitorPanelProps) {
  const { batch, error, isPolling } = useBatchPolling(batchId.trim() || null);

  // 直近 2 観測から増分・ETA を算出するための前回サンプル
  const prevSampleRef = useRef<ProgressSample | null>(null);
  const [ratePerSec, setRatePerSec] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (batch === null) {
      prevSampleRef.current = null;
      setRatePerSec(0);
      return;
    }
    const current: ProgressSample = {
      labeledCount: batch.labeled_count,
      timestampMs: Date.now(),
    };
    if (prevSampleRef.current !== null) {
      setRatePerSec(recentRatePerSecond(prevSampleRef.current, current));
    }
    prevSampleRef.current = current;
    setNowMs(current.timestampMs);
  }, [batch]);

  const percent = batch ? progressPercent(batch.labeled_count, batch.unit_count) : 0;
  const complete = batch ? isBatchComplete(batch) : false;
  const eta = batch
    ? estimateEtaSeconds(batch.labeled_count, batch.unit_count, ratePerSec)
    : null;
  const elapsed = batch ? elapsedSeconds(batch.labeling_started_at, nowMs) : 0;

  return (
    <section aria-labelledby="panel-c-title">
      <h2 id="panel-c-title" className={styles.panelTitle}>
        画面 C: 付番進捗モニタ
      </h2>
      <p className={styles.panelDescription}>
        対象バッチを 1〜2 秒間隔でポーリングし、<code>labeled_count / unit_count</code> の進捗を表示します。
        進捗の根拠は SQS キュー深度ではなく付番済み件数です。
      </p>

      <div className={styles.inlineForm}>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="monitor-batch-id">
            監視対象の batch_id
          </label>
          <input
            id="monitor-batch-id"
            className={styles.input}
            type="text"
            value={batchId}
            placeholder="BATCH#..."
            onChange={(e) => onBatchIdChange(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          進捗取得に失敗しました（再試行します）: {error.message}
        </div>
      )}

      {batch === null ? (
        <p className={styles.empty}>
          画面 B で付番を開始するか、batch_id を入力すると進捗を表示します。
        </p>
      ) : (
        <div className={styles.progressSection}>
          <div className={styles.progressHeader}>
            <span className={styles.mono}>{batch.batch_id}</span>
            <span className={styles.progressCount}>
              {batch.labeled_count}/{batch.unit_count}
            </span>
          </div>
          <div
            className={styles.progressBarTrack}
            role="progressbar"
            aria-valuenow={Math.round(percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`付番進捗 ${batch.labeled_count} / ${batch.unit_count}`}
          >
            <div className={styles.progressBarFill} style={{ width: `${percent}%` }} />
          </div>

          {complete ? (
            <div className={styles.success} role="status" style={{ marginTop: "1rem" }}>
              付番完了（status: LABELED
              {batch.labeling_finished_at
                ? `・${batch.labeling_finished_at}`
                : ""}
              ）
            </div>
          ) : (
            <div className={styles.metricsGrid}>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>進捗率</div>
                <div className={styles.metricValue}>{percent.toFixed(1)}%</div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>経過時間</div>
                <div className={styles.metricValue}>{formatSeconds(elapsed)}</div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>直近の増分</div>
                <div className={styles.metricValue}>
                  {ratePerSec > 0 ? `${ratePerSec.toFixed(0)} 件/秒` : "—"}
                </div>
              </div>
              <div className={styles.metricCard}>
                <div className={styles.metricLabel}>ETA（概算）</div>
                <div className={styles.metricValue}>
                  {eta !== null ? formatSeconds(eta) : "—"}
                </div>
              </div>
            </div>
          )}

          <p className={styles.hint} style={{ marginTop: "0.75rem" }}>
            ポーリング: {isPolling ? "稼働中" : "停止"}（完了で自動停止）
          </p>
        </div>
      )}

      <p className={styles.note}>
        同時実行（<code>ConcurrentExecutions</code>）の立ち上がりカーブなど詳細メトリクスは
        CloudWatch ダッシュボードで確認してください（決定 4）。
        {CLOUDWATCH_URL ? (
          <>
            {" "}
            <a href={CLOUDWATCH_URL} target="_blank" rel="noopener noreferrer">
              ダッシュボードを開く
            </a>
          </>
        ) : (
          <> AWS コンソール → CloudWatch → ダッシュボード（kiro-roasters-labeling-*）。</>
        )}
      </p>
    </section>
  );
}
