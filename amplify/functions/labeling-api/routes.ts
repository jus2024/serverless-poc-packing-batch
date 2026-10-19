/**
 * labeling-api の純ロジック（design §6.4 / §4.4 / §14 / 要件 8〜11）。
 *
 * `event.httpMethod` + `event.resource` でルーティングを決め、各ルートの入力検証（§14 の表）を
 * 行い、handler が実行すべき「アクション」を返す。副作用（DDB / Lambda invoke）は handler に
 * 閉じ、ここは純関数のみ。POST /labeling-start の条件付き遷移は「遷移を試みる」アクションを返し、
 * handler が ConditionalCheckFailed を 409 に写す（二重起動抑止の唯一の判定点＝API 層。design §6.1）。
 */
import { HttpError } from "../shared/http.js";
import {
  ensureBatchId,
  ensureLotId,
  BATCH_PREFIX,
  LOT_PREFIX,
  ITEM_PREFIX,
} from "../shared/unit-keys.js";
import { SEED_UNIT_COUNT_MAX_DEFAULT } from "../shared/runtime-config.js";
import type { RoastBatchStatus } from "../shared/types.js";

/** ルーティングで扱う 7 ルート（design §4.4 / §3.4）。 */
export type RouteKind =
  | "createBatch"
  | "listBatches"
  | "getBatch"
  | "startLabeling"
  | "roastingComplete"
  | "listUnits"
  | "getConfig"
  | "options";

/** `POST /batches` の検証済み入力（既定補完後）。 */
export interface CreateBatchAction {
  kind: "createBatch";
  item_id: string;
  lot_id: string;
  roast_date: string;
  unit_count: number;
}

/** `GET /batches?status=` の検証済み入力。 */
export interface ListBatchesAction {
  kind: "listBatches";
  status: RoastBatchStatus;
}

/** `GET /batches/{batchId}`。 */
export interface GetBatchAction {
  kind: "getBatch";
  batch_id: string;
}

/** `POST /batches/{batchId}/labeling-start`（条件付き遷移を試みる）。 */
export interface StartLabelingAction {
  kind: "startLabeling";
  batch_id: string;
}

/**
 * `POST /batches/roasting-complete`（複数バッチの焙煎完了一括記録。design §3.4）。
 * `batch_ids` は `ensureBatchId` 正規化済み・dedupe 済み。
 */
export interface RoastingCompleteAction {
  kind: "roastingComplete";
  batch_ids: string[];
}

/** `GET /units?batchId=|lotId=`（排他）。 */
export interface ListUnitsAction {
  kind: "listUnits";
  by: "batch" | "lot";
  value: string;
}

/** `GET /config`。 */
export interface GetConfigAction {
  kind: "getConfig";
}

/** CORS プリフライト。 */
export interface OptionsAction {
  kind: "options";
}

export type RouteAction =
  | CreateBatchAction
  | ListBatchesAction
  | GetBatchAction
  | StartLabelingAction
  | RoastingCompleteAction
  | ListUnitsAction
  | GetConfigAction
  | OptionsAction;

/** `GET /batches?status=` の許容値（design §2.2 / §4.4 / §14。PLANNED を追加）。 */
export const ALLOWED_BATCH_STATUS: RoastBatchStatus[] = [
  "PLANNED",
  "ROASTING_DONE",
  "LABELING",
  "LABELED",
];

/** `POST /batches` の unit_count 既定（design §6.4 / §14。補完は API 層が所有）。 */
export const DEFAULT_UNIT_COUNT = 1000;

/** `POST /batches/roasting-complete` の一括上限（design §3.4）。 */
export const ROASTING_COMPLETE_MAX_BATCHES = 100;

/**
 * ルーティング時の環境依存オプション（design §14）。
 *
 * `seedUnitCountMax` は `POST /batches` の unit_count 上限検証に使う。handler が実行時に
 * `resolveVerificationConfig()` から解決して渡す。未指定時は runtime-config の既定を使い、
 * routes.ts 単体でも自己完結してテストできるようにする（design §14 / §4.1）。
 */
export interface RouteOptions {
  seedUnitCountMax?: number;
}

/** ルーティングの入力（API Gateway プロキシイベントの必要部分）。 */
export interface RouteRequest {
  httpMethod: string;
  resource: string;
  body?: string | null;
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

function validateCreateBatch(
  body: string | null | undefined,
  seedUnitCountMax: number,
): CreateBatchAction {
  if (body === null || body === undefined || body === "") {
    throw new HttpError(400, "BadRequest", "request body is required");
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "BadRequest", "request body is not valid JSON");
  }

  const item_id = parsed.item_id;
  if (typeof item_id !== "string" || !item_id.startsWith(ITEM_PREFIX)) {
    throw new HttpError(400, "BadRequest", "item_id must be a string with ITEM# prefix");
  }
  const lot_id = parsed.lot_id;
  if (typeof lot_id !== "string" || !lot_id.startsWith(LOT_PREFIX)) {
    throw new HttpError(400, "BadRequest", "lot_id must be a string with LOT# prefix");
  }
  const roast_date = parsed.roast_date;
  if (typeof roast_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(roast_date)) {
    throw new HttpError(400, "BadRequest", "roast_date must be an ISO 8601 date (YYYY-MM-DD)");
  }

  // unit_count は任意（既定 1000。補完は API 層が所有。design §6.4）。
  // 範囲は 1〜SEED_UNIT_COUNT_MAX、範囲外は作成時に 400（design §14）。上限超過を作成時に
  // 弾くことで、seeder 起動後の非同期 RuntimeConfigError（LABELING のまま完了遷移しない縮退）
  // に先送りしない。
  let unit_count = DEFAULT_UNIT_COUNT;
  if (parsed.unit_count !== undefined) {
    const n = parsed.unit_count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new HttpError(400, "BadRequest", "unit_count must be a positive integer");
    }
    if (n > seedUnitCountMax) {
      throw new HttpError(
        400,
        "BadRequest",
        `unit_count must be between 1 and ${seedUnitCountMax}`,
      );
    }
    unit_count = n;
  }

  return { kind: "createBatch", item_id, lot_id, roast_date, unit_count };
}

function validateListBatches(
  qs: Record<string, string | undefined> | null | undefined,
): ListBatchesAction {
  const raw = qs?.status;
  // 省略時は ROASTING_DONE（design §4.4 / §14。既定）
  if (raw === undefined || raw === "") {
    return { kind: "listBatches", status: "ROASTING_DONE" };
  }
  if (!ALLOWED_BATCH_STATUS.includes(raw as RoastBatchStatus)) {
    throw new HttpError(
      400,
      "BadRequest",
      `status must be one of ${ALLOWED_BATCH_STATUS.join("/")}`,
    );
  }
  return { kind: "listBatches", status: raw as RoastBatchStatus };
}

function requireBatchIdPath(
  pathParameters: Record<string, string | undefined> | null | undefined,
): string {
  const raw = pathParameters?.batchId;
  if (raw === undefined || raw.trim() === "") {
    throw new HttpError(400, "BadRequest", "batchId path parameter is required");
  }
  // batch_id は `BATCH#...` で `#` を含む。フロントは encodeURIComponent で送るが
  // （MEDIUM-1）、API Gateway（REST + Lambda プロキシ）は pathParameters を
  // **デコードせず** に渡す。そのまま使うと `BATCH%23...` が `BATCH#` 接頭辞判定に
  // 引っかからず ensureBatchId が `BATCH#` を二重付与し、存在しないキーで 404 になる
  // （実機で判明。設計の「API GW がデコード済み」前提は誤り）。ここで decodeURIComponent
  // する。既にデコード済み（`%` を含まない）の値をデコードしても不変なので二重デコードに
  // ならない。不正なエスケープ列は 400 に写す。
  return ensureBatchId(decodePathValue(raw.trim(), "batchId"));
}

/**
 * パスパラメータを percent-decode する。API Gateway がデコードしていてもしていなくても
 * 正しい値になる（デコード済みの値は不変）。不正なエスケープ列（`decodeURIComponent` が
 * 投げる `URIError`）は 400 に写す。
 */
function decodePathValue(raw: string, label: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "BadRequest", `${label} is not a valid URI component`);
  }
}

function validateListUnits(
  qs: Record<string, string | undefined> | null | undefined,
): ListUnitsAction {
  const batchId = qs?.batchId;
  const lotId = qs?.lotId;
  const hasBatch = batchId !== undefined && batchId !== "";
  const hasLot = lotId !== undefined && lotId !== "";
  // 排他: 両方・両方なしは 400（design §14）
  if (hasBatch === hasLot) {
    throw new HttpError(
      400,
      "BadRequest",
      "exactly one of batchId or lotId is required",
    );
  }
  // クエリ値も防御的に decode する（API Gateway はクエリをデコードして渡すが、
  // 万一エンコード済みで届いても ensureBatchId/ensureLotId の接頭辞二重付与を避ける）。
  // decodeURIComponent はデコード済み値に対しては不変。
  return hasBatch
    ? {
        kind: "listUnits",
        by: "batch",
        value: ensureBatchId(decodePathValue(batchId as string, "batchId")),
      }
    : {
        kind: "listUnits",
        by: "lot",
        value: ensureLotId(decodePathValue(lotId as string, "lotId")),
      };
}

/**
 * `POST /batches/roasting-complete` の入力検証（design §3.4 / 要件 B3-6）。
 *
 * 処理順序は **typeof チェック → `ensureBatchId` 正規化 → dedupe** で一意に固定する（NIT-2）。
 * 非文字列要素が 1 つでもあれば配列全体を 400 にする（部分受理しない）。`ensureBatchId` は
 * 引数を `string` と型付けしており非文字列で実行時例外になるため、正規化前に typeof を全件確認する。
 * クエリ値ではなくボディなので percent-decode は不要。
 */
function validateRoastingComplete(
  body: string | null | undefined,
): RoastingCompleteAction {
  if (body === null || body === undefined || body === "") {
    throw new HttpError(400, "BadRequest", "request body is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError(400, "BadRequest", "request body is not valid JSON");
  }
  // JSON として正しくてもオブジェクトでなければ 400（null・配列・プリミティブを弾く）。
  // 特に本文が `null` のとき、後続のプロパティ参照を行う前にここで 400 に揃える
  // （ガードが無いと `parsed.batch_ids` が TypeError になり handler 外周の 500 に落ちる）。
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "BadRequest", "request body must be a JSON object");
  }

  const batchIds = (parsed as Record<string, unknown>).batch_ids;
  if (!Array.isArray(batchIds)) {
    throw new HttpError(400, "BadRequest", "batch_ids must be an array");
  }
  if (batchIds.length === 0) {
    throw new HttpError(400, "BadRequest", "batch_ids must not be empty");
  }
  if (batchIds.length > ROASTING_COMPLETE_MAX_BATCHES) {
    throw new HttpError(
      400,
      "BadRequest",
      `batch_ids must contain at most ${ROASTING_COMPLETE_MAX_BATCHES} items`,
    );
  }
  // 1 つでも非文字列なら配列全体を 400（部分受理しない。ensureBatchId 呼び出し前に確認）
  for (const raw of batchIds) {
    if (typeof raw !== "string") {
      throw new HttpError(400, "BadRequest", "each batch_id must be a string");
    }
  }
  // 全要素が文字列であることを確認した後、正規化 → 正規化後に dedupe
  const normalized = (batchIds as string[]).map((raw) => ensureBatchId(raw));
  const deduped = Array.from(new Set(normalized));
  return { kind: "roastingComplete", batch_ids: deduped };
}

/**
 * ルーティング + 入力検証（design §6.4 / §4.4）。handler が実行するアクションを返す。
 * 未知のルートは 404。
 *
 * @param options 環境依存の検証パラメータ（design §14）。`seedUnitCountMax` は
 *   `POST /batches` の unit_count 上限検証に使う。未指定時は runtime-config の既定。
 */
export function routeRequest(req: RouteRequest, options: RouteOptions = {}): RouteAction {
  const method = req.httpMethod.toUpperCase();
  const seedUnitCountMax = options.seedUnitCountMax ?? SEED_UNIT_COUNT_MAX_DEFAULT;

  if (method === "OPTIONS") {
    return { kind: "options" };
  }

  switch (req.resource) {
    case "/batches":
      if (method === "POST") return validateCreateBatch(req.body, seedUnitCountMax);
      if (method === "GET") return validateListBatches(req.queryStringParameters);
      break;
    case "/batches/{batchId}":
      if (method === "GET") {
        return { kind: "getBatch", batch_id: requireBatchIdPath(req.pathParameters) };
      }
      break;
    case "/batches/{batchId}/labeling-start":
      if (method === "POST") {
        return {
          kind: "startLabeling",
          batch_id: requireBatchIdPath(req.pathParameters),
        };
      }
      break;
    case "/batches/roasting-complete":
      if (method === "POST") return validateRoastingComplete(req.body);
      break;
    case "/units":
      if (method === "GET") return validateListUnits(req.queryStringParameters);
      break;
    case "/config":
      if (method === "GET") return { kind: "getConfig" };
      break;
    default:
      break;
  }

  throw new HttpError(404, "NotFound", `no route for ${method} ${req.resource}`);
}

// 再エクスポート（テスト・handler の参照用）
export { BATCH_PREFIX, LOT_PREFIX };
