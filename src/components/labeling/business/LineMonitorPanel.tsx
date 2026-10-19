/**
 * ライン監督画面 `LineMonitorPanel`（design §6.4 / §8.0 / §8.3 / 要件 F6, HIGH-5）。
 *
 * 既存 `useBatchPolling` + `progress.ts` を土台に、稼働ダッシュボード（進捗・同時実行 1000 pinned・
 * 付番レート 件/分・プリンタ能力 500/分比較・ボトルネック判定）を同一画面に折り込む。進捗バーは
 * `labeled_count` ベース（要件 F6-5）。rate サンプル管理はコンポーネント責務で自前に持つ（HIGH-5）。
 *
 * 同時実行は pinned 1000（フロント固定 number）に加え、`GET /config` の `labelingMaxConcurrency`
 * （文字列）を**文字列のまま**副次表示する（数値比較しない。§6.4 NIT-2）。SQS バックログは取得口が
 * 無いため「—」固定（§6.4 / 要件 F6-2）。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useBatchPolling } from "../use-batch-polling";
import { getConfig } from "@/src/lib/labeling/api";
import {
  progressPercent,
  isBatchComplete,
  type ProgressSample,
} from "@/src/lib/labeling/progress";
import {
  PINNED_WORKER_CONCURRENCY,
  PRINTER_CAPACITY_PER_MIN,
  labelingRatePerMinute,
  printerBottleneckVerdict,
  type BottleneckVerdict,
} from "@/src/lib/labeling/operations";
import { resolveProductLabel } from "@/src/lib/labeling/product-master";
import styles from "../labeling.module.css";

interface LineMonitorPanelProps {
  /** 梱包画面から受け取る監視対象 batch_id（未選択は空文字）。 */
  batchId: string;
  /** 入力/選択での batch_id 変更を親へ反映する。 */
  onBatchIdChange: (batchId: string) => void;
  /** 自モードが表示中か（hidden 時はポーリングを止める。§7.3）。 */
  isVisible?: boolean;
}

/** CloudWatch ダッシュボードへの誘導 URL（任意の環境変数）。 */
const CLOUDWATCH_URL = process.env.NEXT_PUBLIC_LABELING_DASHBOARD_URL;

const VERDICT_TEXT: Record<BottleneckVerdict, string> = {
  PRINTER_BOUND: "プリンタが律速（データ処理側は余力あり）",
  WITHIN_CAPACITY: "プリンタ能力の範囲内",
  IDLE: "レート未計測（ポーリング初回/停滞）",
};

export default function LineMonitorPanel({
  batchId,
  onBatchIdChange,
  isVisible = true,
}: LineMonitorPanelProps) {
  const { batch, error, isPolling } = useBatchPolling(
    (isVisible ? batchId.trim() : "") || null,
  );

  // rate サンプル管理はコンポーネント責務（operations.ts は純関数のみ。§8.3 HIGH-5）
  const prevSampleRef = useRef<ProgressSample | null>(null);
  const [ratePerMin, setRatePerMin] = useState(0);

  // config の実値（labelingMaxConcurrency）は文字列のまま副次表示に使う（§6.4 NIT-2）
  const [maxConcurrency, setMaxConcurrency] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getConfig();
        if (!cancelled) setMaxConcurrency(cfg.labelingMaxConcurrency);
      } catch {
        // 取得失敗は副次表示を伏せるだけ（pinned 表示は維持）
        if (!cancelled) setMaxConcurrency(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (batch === null) {
      prevSampleRef.current = null;
      setRatePerMin(0);
      return;
    }
    const current: ProgressSample = {
      labeledCount: batch.labeled_count,
      timestampMs: Date.now(),
    };
    if (prevSampleRef.current !== null) {
      setRatePerMin(labelingRatePerMinute(prevSampleRef.current, current));
    }
    prevSampleRef.current = current;
  }, [batch]);

  const percent = batch
    ? progressPercent(batch.labeled_count, batch.unit_count)
    : 0;
  const complete = batch ? isBatchComplete(batch) : false;
  const verdict = printerBottleneckVerdict(ratePerMin);
  const label = batch ? resolveProductLabel(batch.item_id) : null;

  return (
    <section aria-labelledby="line-monitor-title">
      <h2 id="line-monitor-title" className={styles.panelTitle}>
        ライン監督: 付番モニタ
      </h2>
      <p className={styles.panelDescription}>
        付番中のバッチの進捗と稼働状況を監視します。進捗の根拠は付番済み個体数
        （<code>labeled_count</code>）です。
      </p>

      <div className={styles.inlineForm}>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="monitor-batch-id-biz">
            監視対象の batch_id
          </label>
          <input
            id="monitor-batch-id-biz"
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
          梱包担当で付番を開始するか、batch_id を入力するとモニタを表示します。
        </p>
      ) : (
        <>
          <dl className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>進捗（labeled_count）</dt>
              <dd className={styles.summaryValue}>{percent.toFixed(1)}%</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>付番レート（算出）</dt>
              <dd className={styles.summaryValue}>
                {ratePerMin > 0 ? `${Math.round(ratePerMin)} 件/分` : "—"}
              </dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>
                同時実行（フロント固定）
              </dt>
              <dd className={styles.summaryValue}>
                {PINNED_WORKER_CONCURRENCY}
              </dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>
                プリンタ能力（フロント固定）
              </dt>
              <dd className={styles.summaryValue}>
                {PRINTER_CAPACITY_PER_MIN} 枚/分
              </dd>
            </div>
          </dl>

          <div className={styles.card}>
            <div className={styles.progressHeader}>
              <span className={styles.mono} title={batch.item_id}>
                {label ? `${label.origin} / ${label.roast}` : batch.batch_id}
              </span>
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
              <div
                className={styles.progressBarFill}
                style={{ width: `${percent}%` }}
              />
            </div>

            {complete ? (
              <div
                className={`${styles.success} ${styles.spaceTopMd}`}
                role="status"
              >
                付番完了（status: LABELED
                {batch.labeling_finished_at
                  ? `・${batch.labeling_finished_at}`
                  : ""}
                ）
              </div>
            ) : verdict === "PRINTER_BOUND" ? (
              <div className={styles.warn} role="alert">
                <span aria-hidden="true">⚠</span>
                <span>
                  律速: {VERDICT_TEXT.PRINTER_BOUND}（付番{" "}
                  {Math.round(ratePerMin)} 件/分 &gt; プリンタ{" "}
                  {PRINTER_CAPACITY_PER_MIN} 枚/分）
                </span>
              </div>
            ) : (
              <p className={`${styles.hint} ${styles.spaceTopSm}`}>
                判定: {VERDICT_TEXT[verdict]}
                {verdict === "WITHIN_CAPACITY" &&
                  `（付番 ${Math.round(ratePerMin)} 件/分 <= プリンタ ${PRINTER_CAPACITY_PER_MIN} 枚/分）`}
              </p>
            )}
          </div>

          <dl className={`${styles.summaryGrid} ${styles.spaceTopMd}`}>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>
                SQS バックログ（CloudWatch 非取得）
              </dt>
              <dd className={styles.summaryValue}>—</dd>
            </div>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>
                同時実行 実値（GET /config）
              </dt>
              <dd className={styles.summaryValue}>
                {maxConcurrency ?? "—"}
              </dd>
            </div>
          </dl>

          <p className={`${styles.hint} ${styles.spaceTopSm}`}>
            ポーリング: {isPolling ? "稼働中" : "停止"}（完了で自動停止）。
            同時実行は pinned {PINNED_WORKER_CONCURRENCY}（フロント固定）／実値 config:{" "}
            {maxConcurrency ?? "—"}。
          </p>
        </>
      )}

      <p className={styles.note}>
        同時実行カーブや SQS キュー深度など詳細メトリクスは CloudWatch ダッシュボードで
        確認してください。
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
