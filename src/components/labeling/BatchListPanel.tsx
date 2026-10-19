/**
 * 画面 B: バッチ一覧・付番開始（design §11.3 / 要件 9）。
 *
 * `GET /batches`（既定 `status=ROASTING_DONE`）で付番待ち一覧を表示し、各行の [付番開始] で
 * `POST /batches/{id}/labeling-start` を叩く。ボタンには検証トリガーである旨の注記を付ける
 * （約 1,000 件を一括投入。要件 9.4）。開始後は画面 C で進捗を監視できるよう `onStarted` で
 * batch_id を親（LabelingDashboard）へ渡す。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listBatches,
  startLabeling,
  LabelingApiFailure,
  LabelingApiError,
} from "@/src/lib/labeling/api";
import type { RoastBatch, RoastBatchStatus } from "@/src/lib/labeling/types";
import styles from "./labeling.module.css";

interface BatchListPanelProps {
  /** 付番開始/監視ボタンで選んだ batch_id を親へ渡す（画面 C 連携）。 */
  onMonitor: (batchId: string) => void;
}

const STATUS_FILTERS: RoastBatchStatus[] = [
  "ROASTING_DONE",
  "LABELING",
  "LABELED",
];

export default function BatchListPanel({ onMonitor }: BatchListPanelProps) {
  const [status, setStatus] = useState<RoastBatchStatus>("ROASTING_DONE");
  const [batches, setBatches] = useState<RoastBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (target: RoastBatchStatus) => {
    setLoading(true);
    setError(null);
    try {
      const items = await listBatches(target);
      setBatches(items);
    } catch (err) {
      if (err instanceof LabelingApiFailure) {
        setError(err.message);
      } else {
        setError("一覧の取得に失敗しました");
      }
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(status);
  }, [status, load]);

  async function handleStart(batchId: string) {
    setStartingId(batchId);
    setMessage(null);
    setError(null);
    try {
      await startLabeling(batchId);
      setMessage(`付番を開始しました: ${batchId}。画面 C で進捗を確認できます。`);
      onMonitor(batchId);
      // 一覧を更新（当該バッチは ROASTING_DONE から外れる）
      await load(status);
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

  return (
    <section aria-labelledby="panel-b-title">
      <h2 id="panel-b-title" className={styles.panelTitle}>
        画面 B: バッチ一覧・付番開始
      </h2>
      <p className={styles.panelDescription}>
        付番待ち（<code>ROASTING_DONE</code>）のバッチを一覧し、[付番開始] で検証を実行します。
      </p>
      <p className={styles.note}>
        [付番開始] は<strong>検証トリガー</strong>です（約 1,000 件の個体を一括投入し、
        SQS 経由で付番ワーカーを多重起動します）。
      </p>

      <div className={styles.inlineForm}>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="batch-status-filter">
            ステータスで絞り込み
          </label>
          <select
            id="batch-status-filter"
            className={styles.input}
            value={status}
            onChange={(e) => setStatus(e.target.value as RoastBatchStatus)}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => load(status)}
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

      {batches.length === 0 && !loading ? (
        <p className={styles.empty}>該当するバッチはありません。</p>
      ) : (
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <caption className={styles.srOnly}>バッチ一覧</caption>
            <thead>
              <tr>
                <th scope="col">batch_id</th>
                <th scope="col">item_id</th>
                <th scope="col">lot_id</th>
                <th scope="col">進捗</th>
                <th scope="col">status</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.batch_id}>
                  <td className={styles.mono}>{b.batch_id}</td>
                  <td className={styles.mono}>{b.item_id}</td>
                  <td className={styles.mono}>{b.lot_id}</td>
                  <td>
                    {b.labeled_count}/{b.unit_count}
                  </td>
                  <td>
                    <span className={styles.statusBadge}>{b.status}</span>
                  </td>
                  <td>
                    {b.status === "ROASTING_DONE" ? (
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => handleStart(b.batch_id)}
                        disabled={startingId === b.batch_id}
                        aria-label={`${b.batch_id} の付番を開始`}
                      >
                        {startingId === b.batch_id ? "開始中…" : "付番開始"}
                      </button>
                    ) : (
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => onMonitor(b.batch_id)}
                        aria-label={`${b.batch_id} の進捗を監視`}
                      >
                        進捗を見る
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
