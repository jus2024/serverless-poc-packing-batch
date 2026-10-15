/**
 * 画面 A: バッチ登録（design §11.2 / 要件 8）。
 *
 * `item_id` / `lot_id` / `roast_date` / `unit_count` を入力し `POST /batches` で RoastBatch を
 * 登録する（`status=ROASTING_DONE`）。各入力は `<label htmlFor>` で関連付け、検証エラーは
 * `aria-invalid` + `aria-describedby` + `role="alert"` で伝える（グローバル規約と同水準。design §11.1）。
 */
"use client";

import { useState } from "react";
import { createBatch, LabelingApiFailure } from "@/src/lib/labeling/api";
import type { RoastBatch } from "@/src/lib/labeling/types";
import styles from "./labeling.module.css";

interface FieldErrors {
  item_id?: string;
  lot_id?: string;
  roast_date?: string;
  unit_count?: string;
}

/** 入力をクライアント側で検証する（送信前の一次チェック。確定検証は API 層が行う）。 */
function validate(values: {
  item_id: string;
  lot_id: string;
  roast_date: string;
  unit_count: string;
}): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.item_id.trim().startsWith("ITEM#")) {
    errors.item_id = "ITEM# で始まる商品 ID を入力してください";
  }
  if (!values.lot_id.trim().startsWith("LOT#")) {
    errors.lot_id = "LOT# で始まるロット ID を入力してください";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.roast_date.trim())) {
    errors.roast_date = "YYYY-MM-DD 形式の焙煎日を入力してください";
  }
  if (values.unit_count.trim() !== "") {
    const n = Number(values.unit_count);
    if (!Number.isInteger(n) || n < 1) {
      errors.unit_count = "1 以上の整数を入力してください";
    }
  }
  return errors;
}

export default function BatchRegisterPanel() {
  const [itemId, setItemId] = useState("ITEM#ETH-YIRG-G1-MEDIUM-DRIP");
  const [lotId, setLotId] = useState("LOT#2026-10-01-003");
  const [roastDate, setRoastDate] = useState("2026-10-09");
  const [unitCount, setUnitCount] = useState("1000");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<RoastBatch | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setApiError(null);
    setCreated(null);

    const values = {
      item_id: itemId,
      lot_id: lotId,
      roast_date: roastDate,
      unit_count: unitCount,
    };
    const fieldErrors = validate(values);
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const batch = await createBatch({
        item_id: itemId.trim(),
        lot_id: lotId.trim(),
        roast_date: roastDate.trim(),
        unit_count: unitCount.trim() === "" ? undefined : Number(unitCount),
      });
      setCreated(batch);
    } catch (err) {
      if (err instanceof LabelingApiFailure) {
        setApiError(err.message);
      } else {
        setApiError("想定外のエラーが発生しました");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="panel-a-title">
      <h2 id="panel-a-title" className={styles.panelTitle}>
        画面 A: バッチ登録
      </h2>
      <p className={styles.panelDescription}>
        焙煎完了（<code>ROASTING_DONE</code>）の RoastBatch を登録します。
        登録後、画面 B で付番を開始できます。
      </p>

      {apiError && (
        <div className={styles.error} role="alert">
          {apiError}
        </div>
      )}
      {created && (
        <div className={styles.success} role="status">
          登録しました: <span className={styles.mono}>{created.batch_id}</span>
          （総数 {created.unit_count}）
        </div>
      )}

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="batch-item-id">
            商品 ID（item_id）
          </label>
          <input
            id="batch-item-id"
            className={`${styles.input} ${errors.item_id ? styles.inputInvalid : ""}`}
            type="text"
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
            aria-invalid={errors.item_id ? true : undefined}
            aria-describedby={errors.item_id ? "batch-item-id-error" : undefined}
          />
          {errors.item_id && (
            <span id="batch-item-id-error" className={styles.fieldError} role="alert">
              {errors.item_id}
            </span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="batch-lot-id">
            ロット ID（lot_id）
          </label>
          <input
            id="batch-lot-id"
            className={`${styles.input} ${errors.lot_id ? styles.inputInvalid : ""}`}
            type="text"
            value={lotId}
            onChange={(e) => setLotId(e.target.value)}
            aria-invalid={errors.lot_id ? true : undefined}
            aria-describedby={errors.lot_id ? "batch-lot-id-error" : undefined}
          />
          {errors.lot_id && (
            <span id="batch-lot-id-error" className={styles.fieldError} role="alert">
              {errors.lot_id}
            </span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="batch-roast-date">
            焙煎日（roast_date）
          </label>
          <input
            id="batch-roast-date"
            className={`${styles.input} ${errors.roast_date ? styles.inputInvalid : ""}`}
            type="date"
            value={roastDate}
            onChange={(e) => setRoastDate(e.target.value)}
            aria-invalid={errors.roast_date ? true : undefined}
            aria-describedby={errors.roast_date ? "batch-roast-date-error" : undefined}
          />
          {errors.roast_date && (
            <span id="batch-roast-date-error" className={styles.fieldError} role="alert">
              {errors.roast_date}
            </span>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="batch-unit-count">
            個体数（unit_count・任意）
          </label>
          <input
            id="batch-unit-count"
            className={`${styles.input} ${errors.unit_count ? styles.inputInvalid : ""}`}
            type="number"
            min={1}
            value={unitCount}
            onChange={(e) => setUnitCount(e.target.value)}
            aria-invalid={errors.unit_count ? true : undefined}
            aria-describedby={
              errors.unit_count ? "batch-unit-count-error" : "batch-unit-count-hint"
            }
          />
          <span id="batch-unit-count-hint" className={styles.hint}>
            省略時は 1000（API 層が既定を補完）
          </span>
          {errors.unit_count && (
            <span id="batch-unit-count-error" className={styles.fieldError} role="alert">
              {errors.unit_count}
            </span>
          )}
        </div>

        <button className={styles.primaryButton} type="submit" disabled={submitting}>
          {submitting ? "登録中…" : "バッチを登録"}
        </button>
      </form>
    </section>
  );
}
