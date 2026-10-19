/**
 * 画面 D: 個体トレース照会（design §11.5 / 要件 11）。
 *
 * batch 指定 → `GET /units?batchId=`（GSI1）、lot 指定 → `GET /units?lotId=`（GSI2）で Unit を
 * 照会し、結果テーブルに `status` / `best_before` / `qr_payload` / `labeled_at` を表示する
 * （要件 11.3）。照会キーは排他（batch か lot のどちらか）。
 */
"use client";

import { useState } from "react";
import {
  listUnitsByBatch,
  listUnitsByLot,
  LabelingApiFailure,
} from "@/src/lib/labeling/api";
import type { Unit } from "@/src/lib/labeling/types";
import styles from "./labeling.module.css";

type TraceBy = "batch" | "lot";

export default function UnitTracePanel() {
  const [by, setBy] = useState<TraceBy>("batch");
  const [key, setKey] = useState("");
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleQuery(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (trimmed === "") {
      setError(by === "batch" ? "batch_id を入力してください" : "lot_id を入力してください");
      return;
    }
    setLoading(true);
    setError(null);
    setUnits(null);
    try {
      const result =
        by === "batch"
          ? await listUnitsByBatch(trimmed)
          : await listUnitsByLot(trimmed);
      setUnits(result);
    } catch (err) {
      if (err instanceof LabelingApiFailure) {
        setError(err.message);
      } else {
        setError("照会に失敗しました");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="panel-d-title">
      <h2 id="panel-d-title" className={styles.panelTitle}>
        画面 D: 個体トレース照会
      </h2>
      <p className={styles.panelDescription}>
        batch または lot を指定して個体（Unit）を照会し、付番結果
        （<code>status</code> / <code>best_before</code> / <code>qr_payload</code> /{" "}
        <code>labeled_at</code>）を確認します。
      </p>

      <form className={styles.inlineForm} onSubmit={handleQuery} noValidate>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="trace-by">
            照会キー
          </label>
          <select
            id="trace-by"
            className={styles.input}
            value={by}
            onChange={(e) => {
              setBy(e.target.value as TraceBy);
              setKey("");
            }}
          >
            <option value="batch">batch_id（GSI1）</option>
            <option value="lot">lot_id（GSI2）</option>
          </select>
        </div>
        <div className={styles.inlineField}>
          <label className={styles.label} htmlFor="trace-key">
            {by === "batch" ? "batch_id" : "lot_id"}
          </label>
          <input
            id="trace-key"
            className={`${styles.input} ${error ? styles.inputInvalid : ""}`}
            type="text"
            value={key}
            placeholder={by === "batch" ? "BATCH#..." : "LOT#..."}
            onChange={(e) => setKey(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "trace-key-error" : undefined}
          />
        </div>
        <button className={styles.primaryButton} type="submit" disabled={loading}>
          {loading ? "照会中…" : "照会"}
        </button>
      </form>

      {error && (
        <div id="trace-key-error" className={styles.error} role="alert">
          {error}
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
                  <th scope="col">seq</th>
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
                    <td>{u.seq}</td>
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
