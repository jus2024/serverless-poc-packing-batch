/**
 * 梱包担当画面 `PackingPanel`（design §8.0 / §8.2 / 要件 F5）。
 *
 * 付番待ち（`ROASTING_DONE`）と付番中（`LABELING`）のバッチをカード風の行で業務ラベル表示する。
 * `ROASTING_DONE` に [付番開始]（既存 `startLabeling` を挙動不変で呼ぶ。約 1,000 個体を一括投入
 * する検証トリガー）、`LABELING` に [モニタを見る]（batch_id をライン監督へ受け渡し）。
 * 409 は「すでに付番開始済み」を表示して多重起動しない（既存 BatchListPanel の分岐を踏襲）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listBatches,
  startLabeling,
  LabelingApiFailure,
  LabelingApiError,
} from "@/src/lib/labeling/api";
import type { RoastBatch } from "@/src/lib/labeling/types";
import { resolveProductLabel } from "@/src/lib/labeling/product-master";
import styles from "../labeling.module.css";

interface PackingPanelProps {
  /** [モニタを見る] で選んだ batch_id をライン監督画面へ渡す。 */
  onMonitor: (batchId: string) => void;
  /**
   * このタブが現在アクティブ（表示中）か。全パネルを常時マウントするため（§7.4）、
   * 焙煎完了など前工程の操作後にこのタブへ切り替えた時だけ最新化できるよう、
   * アクティブ化のたびに一覧を再取得する（UX-1）。
   */
  isActive: boolean;
}

function amPmOf(batchId: string): string {
  const m = batchId.match(/-(AM|PM)-/);
  return m ? m[1] : "—";
}

export default function PackingPanel({ onMonitor, isActive }: PackingPanelProps) {
  const [waiting, setWaiting] = useState<RoastBatch[]>([]);
  const [inProgress, setInProgress] = useState<RoastBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [waitingItems, labelingItems] = await Promise.all([
        listBatches("ROASTING_DONE"),
        listBatches("LABELING"),
      ]);
      setWaiting(waitingItems);
      setInProgress(labelingItems);
    } catch (err) {
      setError(
        err instanceof LabelingApiFailure
          ? err.message
          : "一覧の取得に失敗しました",
      );
      setWaiting([]);
      setInProgress([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初回マウント時、およびこのタブがアクティブになるたびに一覧を再取得する（UX-1）。
  // 非アクティブ時は取得しない（常時マウントでも裏側の無駄な再取得を避ける）。
  useEffect(() => {
    if (isActive) {
      void load();
    }
  }, [isActive, load]);

  async function handleStart(batchId: string) {
    setStartingId(batchId);
    setMessage(null);
    setError(null);
    try {
      await startLabeling(batchId);
      setMessage(`付番を開始しました: ${batchId}。ライン監督でモニタできます。`);
      onMonitor(batchId);
      await load();
    } catch (err) {
      if (err instanceof LabelingApiError && err.status === 409) {
        setError(`すでに付番開始済みです: ${batchId}`);
      } else if (err instanceof LabelingApiFailure) {
        setError(err.message);
      } else {
        setError("付番開始に失敗しました");
      }
    } finally {
      setStartingId(null);
    }
  }

  function renderCard(b: RoastBatch, action: React.ReactNode) {
    const label = resolveProductLabel(b.item_id);
    return (
      <li key={b.batch_id} className={styles.listRow}>
        <span title={b.item_id}>
          <strong>{label.origin}</strong> / {label.roast}
          {!label.isKnown && (
            <span className={styles.unknownBadge}>未登録</span>
          )}
        </span>
        <span className={styles.mono}>{b.lot_id}</span>
        <span>{b.roast_date}</span>
        <span>{amPmOf(b.batch_id)}</span>
        <span>
          {b.labeled_count}/{b.unit_count}
        </span>
        <span className={styles.statusBadge}>{b.status}</span>
        {action}
      </li>
    );
  }

  return (
    <section aria-labelledby="packing-title">
      <h2 id="packing-title" className={styles.panelTitle}>
        梱包担当: 付番ワークリスト
      </h2>
      <p className={styles.panelDescription}>
        付番待ちのバッチで「付番開始」すると個体への付番が始まります。進行中のバッチは
        ライン監督でモニタできます。
      </p>
      <p className={styles.note}>
        [付番開始] は<strong>約 1,000 個体を一括投入する検証トリガー</strong>です
        （SQS 経由で付番ワーカーを多重起動します）。
      </p>

      <dl className={styles.summaryGrid}>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>付番待ち</dt>
          <dd className={styles.summaryValue}>{waiting.length} 件</dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>付番中</dt>
          <dd className={styles.summaryValue}>{inProgress.length} 件</dd>
        </div>
      </dl>

      <div className={styles.inlineForm}>
        <button
          className={styles.bizButton}
          type="button"
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? "更新中…" : "再読み込み"}
        </button>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className={styles.success} role="status">
          {message}
        </div>
      )}

      <h3 className={styles.summaryLabel}>付番待ち（ROASTING_DONE）</h3>
      {waiting.length === 0 && !loading ? (
        <p className={styles.empty}>付番待ちのバッチはありません。</p>
      ) : (
        <ul className={styles.cardList}>
          {waiting.map((b) =>
            renderCard(
              b,
              <button
                className={styles.bizButton}
                type="button"
                onClick={() => handleStart(b.batch_id)}
                disabled={startingId === b.batch_id}
                aria-label={`${b.batch_id} の付番を開始`}
              >
                {startingId === b.batch_id ? "開始中…" : "付番開始"}
              </button>,
            ),
          )}
        </ul>
      )}

      <h3 className={`${styles.summaryLabel} ${styles.spaceTopLg}`}>
        付番中（LABELING）
      </h3>
      {inProgress.length === 0 && !loading ? (
        <p className={styles.empty}>付番中のバッチはありません。</p>
      ) : (
        <ul className={styles.cardList}>
          {inProgress.map((b) =>
            renderCard(
              b,
              <button
                className={styles.bizButton}
                type="button"
                onClick={() => onMonitor(b.batch_id)}
                aria-label={`${b.batch_id} のモニタを見る`}
              >
                モニタを見る
              </button>,
            ),
          )}
        </ul>
      )}
    </section>
  );
}
