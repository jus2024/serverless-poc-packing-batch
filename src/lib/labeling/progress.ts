/**
 * 付番進捗の算術（純関数。design §11.4 / 決定 4 / 要件 10）。
 *
 * 画面 C は進捗バー（`labeled_count / unit_count`）と、ポーリング差分から算出する軽量な
 * 稼働感（経過時間・直近増分・ETA 概算）を出す。CloudWatch の詳細メトリクスはダッシュボード
 * へのリンク誘導に委ねる（決定 4）。ここは副作用のない純関数のみで、ユニットテストで
 * 進捗率・完了判定・ETA を検証する（design §16）。
 */

import type { RoastBatch } from "./types";

/**
 * 付番の進捗率（百分率、0〜100）を返す（要件 10.2）。
 *
 * `unit_count <= 0` のときは 0 を返す（ゼロ除算を避ける）。`labeled_count` が
 * `unit_count` を超える異常値は 100 で頭打ちにする（表示が 100% を超えないため）。
 */
export function progressPercent(labeledCount: number, unitCount: number): number {
  if (unitCount <= 0) {
    return 0;
  }
  const ratio = (labeledCount / unitCount) * 100;
  if (ratio < 0) {
    return 0;
  }
  if (ratio > 100) {
    return 100;
  }
  return ratio;
}

/**
 * バッチが付番完了かを返す（要件 10.4）。
 *
 * 完了の真実は `status === "LABELED"`（worker の完了遷移が確定したときにのみ立つ。
 * design §6.3-4）。`labeled_count === unit_count` だけでは完了遷移前の瞬間を含み得るため、
 * 表示上の「完了」は status を基準にする。
 */
export function isBatchComplete(batch: Pick<RoastBatch, "status">): boolean {
  return batch.status === "LABELED";
}

/** 2 回のポーリング観測（付番済み件数と観測時刻）。 */
export interface ProgressSample {
  /** そのときの `labeled_count`。 */
  labeledCount: number;
  /** 観測時刻（epoch ミリ秒）。 */
  timestampMs: number;
}

/**
 * 直近 2 観測から 1 秒あたりの付番増分（件/秒）を返す（design §11.4）。
 *
 * 時刻が逆行・同一（経過 0）の場合や件数が減った場合は 0 を返す（異常値で稼働感が
 * マイナスやスパイクにならないようにする）。
 */
export function recentRatePerSecond(
  previous: ProgressSample,
  current: ProgressSample,
): number {
  const elapsedMs = current.timestampMs - previous.timestampMs;
  if (elapsedMs <= 0) {
    return 0;
  }
  const delta = current.labeledCount - previous.labeledCount;
  if (delta <= 0) {
    return 0;
  }
  return (delta / elapsedMs) * 1000;
}

/**
 * 残り付番時間の概算（秒）を返す（design §11.4）。
 *
 * `ratePerSecond <= 0`（まだ進んでいない／停滞）や既に完了（残り 0）のときは `null` を返す
 * （「算出不能」を数値 0 と区別する。画面は null のとき ETA を伏せる）。
 */
export function estimateEtaSeconds(
  labeledCount: number,
  unitCount: number,
  ratePerSecond: number,
): number | null {
  const remaining = unitCount - labeledCount;
  if (remaining <= 0) {
    return null;
  }
  if (ratePerSecond <= 0) {
    return null;
  }
  return remaining / ratePerSecond;
}

/** 経過時間（秒）を返す。開始時刻が未確定・未来のときは 0。 */
export function elapsedSeconds(
  labelingStartedAtIso: string | undefined,
  nowMs: number,
): number {
  if (labelingStartedAtIso === undefined || labelingStartedAtIso === "") {
    return 0;
  }
  const startedMs = Date.parse(labelingStartedAtIso);
  if (Number.isNaN(startedMs)) {
    return 0;
  }
  const elapsed = (nowMs - startedMs) / 1000;
  return elapsed < 0 ? 0 : elapsed;
}
