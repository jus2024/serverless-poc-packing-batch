/**
 * QC 画面 `QcPanel`（design §8.0 / §8.4 / 要件 F7, MEDIUM-6）。
 *
 * `listBatches("LABELED")` を出荷可能としてカード一覧（業務ラベル）。best_before/qr_payload は
 * `Unit` 属性で `RoastBatch` には無いため、**一覧には出さず**、カードから個体トレース
 * （`listUnitsByBatch`）に降りて表示する。ロット起点リコール照会は `listUnitsByLot(lot_id)`。
 * 照会キーは可能な限り選択式（カードクリックで補完）。手入力フォールバックは `aria-invalid`/
 * `aria-describedby` でエラーを field に関連付ける（要件 F7-5）。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listBatches,
  listUnitsByBatch,
  listUnitsByLot,
  LabelingApiFailure,
} from "@/src/lib/labeling/api";
import type { RoastBatch, Unit } from "@/src/lib/labeling/types";
import { resolveProductLabel } from "@/src/lib/labeling/product-master";
import styles from "../labeling.module.css";

type TraceBy = "batch" | "lot";

interface QcPanelProps {
  /**
   * このタブが現在アクティブ（表示中）か。全パネルを常時マウントするため（§7.4）、
   * 付番完了（worker 完了）後にこのタブへ切り替えた時だけ最新化できるよう、
   * アクティブ化のたびに出荷可能一覧を再取得する（UX-1）。
   */
  isActive: boolean;
}

export default function QcPanel({ isActive }: QcPanelProps) {
  const [batches, setBatches] = useState<RoastBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // トレース照会の状態
  const [traceBy, setTraceBy] = useState<TraceBy>("batch");
  const [traceKey, setTraceKey] = useState("");
  const [traceKeyError, setTraceKeyError] = useState<string | null>(null);
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [tracing, setTracing] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBatches(await listBatches("LABELED"));
    } catch (err) {
      setError(
        err instanceof LabelingApiFailure
          ? err.message
          : "出荷可能一覧の取得に失敗しました",
      );
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初回マウント時、およびこのタブがアクティブになるたびに出荷可能一覧を再取得する（UX-1）。
  useEffect(() => {
    if (isActive) {
      void load();
    }
  }, [isActive, load]);

  const runTrace = useCallback(async (by: TraceBy, key: string) => {
    const trimmed = key.trim();
    if (trimmed === "") {
      setTraceKeyError(
        by === "batch" ? "batch_id を指定してください" : "lot_id を指定してください",
      );
      return;
    }
    setTraceKeyError(null);
    setTracing(true);
    setTraceError(null);
    setUnits(null);
    try {
      const result =
        by === "batch"
          ? await listUnitsByBatch(trimmed)
          : await listUnitsByLot(trimmed);
      setUnits(result);
    } catch (err) {
      setTraceError(
        err instanceof LabelingApiFailure
          ? err.message
          : "トレース照会に失敗しました",
      );
    } finally {
      setTracing(false);
    }
  }, []);

  function traceFromCard(by: TraceBy, key: string) {
    setTraceBy(by);
    setTraceKey(key);
    void runTrace(by, key);
  }

  return (
    <section aria-labelledby="qc-title">
      <h2 id="qc-title" className={styles.panelTitle}>
        QC: 出荷準備・トレース
      </h2>
      <p className={styles.panelDescription}>
        付番完了（<code>LABELED</code>）のバッチを出荷可能として一覧します。個体の賞味期限や
        QR はカードから個体トレースを開いて確認します。ロット起点のリコール照会もできます。
      </p>

      <dl className={styles.summaryGrid}>
        <div className={styles.summaryItem}>
          <dt className={styles.summaryLabel}>出荷可能</dt>
          <dd className={styles.summaryValue}>{batches.length} 件</dd>
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

      {batches.length === 0 && !loading ? (
        <p className={styles.empty}>出荷可能なバッチはありません。</p>
      ) : (
        <ul className={styles.cardList}>
          {batches.map((b) => {
            const label = resolveProductLabel(b.item_id);
            return (
              <li key={b.batch_id} className={styles.card}>
                <div className={`${styles.listRow} ${styles.listRowFlush}`}>
                  <span title={b.item_id}>
                    <strong>{label.origin}</strong> / {label.roast}
                    {!label.isKnown && (
                      <span className={styles.unknownBadge}>未登録</span>
                    )}
                  </span>
                  <span className={styles.mono}>{b.lot_id}</span>
                  <span>{b.unit_count} 個体</span>
                  <span className={styles.statusBadge}>出荷可（{b.status}）</span>
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.bizButton}
                    type="button"
                    onClick={() => traceFromCard("batch", b.batch_id)}
                    aria-label={`${b.batch_id} の個体トレースを開く`}
                  >
                    トレース/出荷確認を開く
                  </button>{" "}
                  <button
                    className={styles.bizButton}
                    type="button"
                    onClick={() => traceFromCard("lot", b.lot_id)}
                    aria-label={`${b.lot_id} のロット照会（リコール）を開く`}
                  >
                    ロット照会（リコール）
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className={`${styles.summaryLabel} ${styles.spaceTopXl}`}>
        個体トレース照会
      </h3>
      <div className={styles.inlineForm}>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="qc-trace-by">
            照会キー
          </label>
          <select
            id="qc-trace-by"
            className={styles.input}
            value={traceBy}
            onChange={(e) => setTraceBy(e.target.value as TraceBy)}
          >
            <option value="batch">バッチ指定（batch_id）</option>
            <option value="lot">ロット指定（lot_id・リコール）</option>
          </select>
        </div>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="qc-trace-key">
            {traceBy === "batch" ? "batch_id" : "lot_id"}
          </label>
          <input
            id="qc-trace-key"
            className={`${styles.input} ${traceKeyError ? styles.inputInvalid : ""}`}
            type="text"
            value={traceKey}
            placeholder={traceBy === "batch" ? "BATCH#..." : "LOT#..."}
            onChange={(e) => setTraceKey(e.target.value)}
            aria-invalid={traceKeyError ? true : undefined}
            aria-describedby={traceKeyError ? "qc-trace-key-err" : undefined}
          />
          {traceKeyError && (
            <p id="qc-trace-key-err" className={styles.fieldError} role="alert">
              {traceKeyError}
            </p>
          )}
        </div>
        <button
          className={styles.bizButton}
          type="button"
          onClick={() => runTrace(traceBy, traceKey)}
          disabled={tracing}
        >
          {tracing ? "照会中…" : "照会"}
        </button>
      </div>

      {traceError && (
        <div className={styles.error} role="alert">
          {traceError}
        </div>
      )}

      {units !== null &&
        (units.length === 0 ? (
          <p className={styles.empty}>該当する個体はありません。</p>
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>個体トレース結果</caption>
              <thead>
                <tr>
                  <th scope="col">unit_id</th>
                  <th scope="col">status</th>
                  <th scope="col">best_before</th>
                  <th scope="col">qr_payload</th>
                  <th scope="col">labeled_at</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => (
                  <tr key={u.unit_id}>
                    <td className={styles.mono}>{u.unit_id}</td>
                    <td>
                      <span className={styles.statusBadge}>{u.status}</span>
                    </td>
                    <td>{u.best_before ?? "—"}</td>
                    <td className={styles.mono}>{u.qr_payload ?? "—"}</td>
                    <td>{u.labeled_at ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
