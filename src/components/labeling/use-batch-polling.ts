/**
 * 付番進捗ポーリングフック（design §11.4 / 要件 10.1。参考 EC PoC の use-execution-polling 踏襲）。
 *
 * `GET /batches/{id}` を 1〜2 秒間隔でポーリングし、`status=LABELED`（完了）になったら停止する。
 * タブ切替で止めない設計（LabelingDashboard が 4 画面を常時マウントする）のため、停止条件は
 * 「完了」か「停止要求」のみに閉じる。副作用（setInterval/fetch）はフックに、停止判定は純関数
 * `shouldStopPolling` に分け、純関数をユニットテストする（design §16）。
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getBatch, LabelingApiFailure } from "@/src/lib/labeling/api";
import { isBatchComplete } from "@/src/lib/labeling/progress";
import type { RoastBatch } from "@/src/lib/labeling/types";

/** ポーリング間隔の既定（ミリ秒。design §11.4: 参考の 3 秒より短い 1.5 秒）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * ポーリングを停止すべきかを返す純関数（停止条件のテスト対象。design §16）。
 *
 * 停止するのは次のいずれか:
 * - `active` が false（画面が照会対象を持たない／明示停止）
 * - 直近に取得した batch が完了（`status=LABELED`）している
 *
 * エラーでは停止しない（一時的な失敗は次ポーリングで回復し得るため。画面はエラー表示を出す）。
 */
export function shouldStopPolling(args: {
  active: boolean;
  batch: Pick<RoastBatch, "status"> | null;
}): boolean {
  if (!args.active) {
    return true;
  }
  if (args.batch !== null && isBatchComplete(args.batch)) {
    return true;
  }
  return false;
}

export interface UseBatchPollingResult {
  /** 直近に取得した batch（未取得は null）。 */
  batch: RoastBatch | null;
  /** 直近のポーリングエラー（無ければ null）。 */
  error: LabelingApiFailure | null;
  /** ポーリングが現在稼働中か。 */
  isPolling: boolean;
}

/**
 * 指定 batchId を 1〜2 秒間隔でポーリングする。
 *
 * @param batchId  照会対象。null/空のときはポーリングしない。
 * @param intervalMs ポーリング間隔（既定 1.5 秒）。
 */
export function useBatchPolling(
  batchId: string | null,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseBatchPollingResult {
  const [batch, setBatch] = useState<RoastBatch | null>(null);
  const [error, setError] = useState<LabelingApiFailure | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  // 最新の batch を停止判定で参照するための ref（interval クロージャの陳腐化を防ぐ）
  const batchRef = useRef<RoastBatch | null>(null);
  batchRef.current = batch;

  const tick = useCallback(
    async (id: string, signal: AbortSignal) => {
      try {
        const next = await getBatch(id, { signal });
        if (signal.aborted) return;
        setBatch(next);
        setError(null);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof LabelingApiFailure) {
          setError(err);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const id = batchId?.trim();
    // 対象が無ければポーリングしない（状態はリセット）
    if (id === undefined || id === "") {
      setBatch(null);
      setError(null);
      setIsPolling(false);
      return;
    }

    const controller = new AbortController();
    setBatch(null);
    setError(null);
    setIsPolling(true);

    // 初回は即時取得
    void tick(id, controller.signal);

    const timer = setInterval(() => {
      // 完了していれば以降は叩かない（stop 条件。design §16）
      if (
        shouldStopPolling({ active: true, batch: batchRef.current })
      ) {
        clearInterval(timer);
        setIsPolling(false);
        return;
      }
      void tick(id, controller.signal);
    }, intervalMs);

    return () => {
      controller.abort();
      clearInterval(timer);
      setIsPolling(false);
    };
  }, [batchId, intervalMs, tick]);

  return { batch, error, isPolling };
}
