/**
 * 焙煎担当画面 `RoastingPanel`（design §8.0 / §8.1 / 要件 F4）。
 *
 * 焙煎計画（`PLANNED`）の一覧をカード風の行で表示し、焙煎担当が「これとこれは完了した」を
 * 複数選択チェックボックスで入力して `POST /batches/roasting-complete` を 1 回呼ぶ。成功すると
 * PLANNED → ROASTING_DONE に遷移し、次工程（梱包担当の付番開始）が動き出す。
 *
 * 2 段構成（§8.0）: 上段サマリーカード群（焙煎計画 N 件 / 選択中 M 件）+ 下段業務一覧。
 * 業務ラベル（産地・焙煎度・ロット・焙煎日・AM/PM・unit_count）を主表示し、生 ID は副次/
 * ツールチップに留める（生 ID の手入力欄は作らない。要件 F4-5）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listBatches,
  recordRoastingComplete,
  LabelingApiFailure,
} from "@/src/lib/labeling/api";
import type { RoastBatch } from "@/src/lib/labeling/types";
import type { RoastingCompleteResponse } from "@/src/lib/labeling/types";
import { resolveProductLabel } from "@/src/lib/labeling/product-master";
import styles from "../labeling.module.css";

/** batch_id から AM/PM を導出する（`BATCH#YYYY-MM-DD-{AM|PM}-NN`）。 */
function amPmOf(batchId: string): string {
  const m = batchId.match(/-(AM|PM)-/);
  return m ? m[1] : "—";
}

export default function RoastingPanel() {
  const [batches, setBatches] = useState<RoastBatch[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RoastingCompleteResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await listBatches("PLANNED");
      setBatches(items);
      // 一覧更新後、存在しなくなった選択を落とす
      setSelected((prev) => {
        const ids = new Set(items.map((b) => b.batch_id));
        return new Set(Array.from(prev).filter((id) => ids.has(id)));
      });
    } catch (err) {
      setError(
        err instanceof LabelingApiFailure
          ? err.message
          : "焙煎計画の取得に失敗しました",
      );
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(batchId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(batches.map((b) => b.batch_id)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  async function handleRecord() {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await recordRoastingComplete(Array.from(selected));
      setResult(res);
      await load();
    } catch (err) {
      setError(
        err instanceof LabelingApiFailure
          ? err.message
          : "焙煎完了の記録に失敗しました",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // 全件失敗/不明主体かどうかで role を切り替える（成功 0 件なら alert）
  const resultIsAlert =
    result !== null && result.completed.length === 0;

  return (
    <section aria-labelledby="roasting-title">
      <h2 id="roasting-title" className={styles.panelTitle}>
        焙煎担当: 焙煎完了の記録
      </h2>
      <p className={styles.panelDescription}>
        焙煎計画（焙煎前）の一覧です。焙煎が完了したバッチを選んで「焙煎完了を記録」すると、
        次工程（梱包の付番準備）へ進みます。
      </p>

      <dl className={styles.summaryGrid}>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>焙煎計画</dt>
          <dd className={styles.summaryValue}>{batches.length} 件</dd>
        </div>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>選択中</dt>
          <dd className={styles.summaryValue}>{selected.size} 件</dd>
        </div>
      </dl>

      <div className={styles.inlineForm}>
        <button
          className={styles.bizButton}
          type="button"
          onClick={selectAll}
          disabled={batches.length === 0}
        >
          全選択
        </button>
        <button
          className={styles.bizButton}
          type="button"
          onClick={clearAll}
          disabled={selected.size === 0}
        >
          全解除
        </button>
        <button
          className={styles.bizButton}
          type="button"
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? "更新中…" : "再読み込み"}
        </button>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={handleRecord}
          disabled={submitting || selected.size === 0}
        >
          {submitting
            ? "記録中…"
            : `焙煎完了を記録（${selected.size} 件）`}
        </button>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {result && (
        <div
          className={resultIsAlert ? styles.error : styles.success}
          role={resultIsAlert ? "alert" : "status"}
        >
          {result.completed.length} 件を焙煎完了にしました（スキップ{" "}
          {result.skipped.length} 件 / 無効 {result.invalid.length} 件 / 不明{" "}
          {result.not_found.length} 件）。
        </div>
      )}

      {batches.length === 0 && !loading ? (
        <p className={styles.empty}>焙煎計画（焙煎前）のバッチはありません。</p>
      ) : (
        <ul className={styles.cardList}>
          {batches.map((b) => {
            const label = resolveProductLabel(b.item_id);
            const isSelected = selected.has(b.batch_id);
            const ariaLabel = `${label.origin} ${label.roast} ${b.lot_id} を選択`;
            return (
              <li
                key={b.batch_id}
                className={`${styles.listRow} ${
                  isSelected ? styles.cardSelected : ""
                }`}
              >
                <label className={styles.checkOption}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(b.batch_id)}
                    aria-label={ariaLabel}
                  />
                  <span title={b.item_id}>
                    <strong>{label.origin}</strong> / {label.roast}
                    {!label.isKnown && (
                      <span className={styles.unknownBadge}>未登録</span>
                    )}
                  </span>
                </label>
                <span className={styles.mono}>{b.lot_id}</span>
                <span>{b.roast_date}</span>
                <span>{amPmOf(b.batch_id)}</span>
                <span>{b.unit_count} 個体</span>
                <span className={styles.statusBadge}>{b.status}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
