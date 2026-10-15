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
import type { RoastBatchStatus } from "../shared/types.js";

/** ルーティングで扱う 6 ルート（design §4.4）。 */
export type RouteKind =
  | "createBatch"
  | "listBatches"
  | "getBatch"
  | "startLabeling"
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
  | ListUnitsAction
  | GetConfigAction
  | OptionsAction;

/** `GET /batches?status=` の許容値（design §4.4 / §14）。 */
export const ALLOWED_BATCH_STATUS: RoastBatchStatus[] = [
  "ROASTING_DONE",
  "LABELING",
  "LABELED",
];

/** `POST /batches` の unit_count 既定（design §6.4 / §14。補完は API 層が所有）。 */
export const DEFAULT_UNIT_COUNT = 1000;

/** ルーティングの入力（API Gateway プロキシイベントの必要部分）。 */
export interface RouteRequest {
  httpMethod: string;
  resource: string;
  body?: string | null;
  pathParameters?: Record<string, string | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
}

function validateCreateBatch(body: string | null | undefined): CreateBatchAction {
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

  // unit_count は任意（既定 1000。補完は API 層が所有。design §6.4）
  let unit_count = DEFAULT_UNIT_COUNT;
  if (parsed.unit_count !== undefined) {
    const n = parsed.unit_count;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new HttpError(400, "BadRequest", "unit_count must be a positive integer");
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
  // API Gateway がデコード済みの batchId をそのまま使う（design §4.4 / MEDIUM-1）
  if (raw === undefined || raw.trim() === "") {
    throw new HttpError(400, "BadRequest", "batchId path parameter is required");
  }
  return ensureBatchId(raw);
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
  return hasBatch
    ? { kind: "listUnits", by: "batch", value: ensureBatchId(batchId as string) }
    : { kind: "listUnits", by: "lot", value: ensureLotId(lotId as string) };
}

/**
 * ルーティング + 入力検証（design §6.4 / §4.4）。handler が実行するアクションを返す。
 * 未知のルートは 404。
 */
export function routeRequest(req: RouteRequest): RouteAction {
  const method = req.httpMethod.toUpperCase();

  if (method === "OPTIONS") {
    return { kind: "options" };
  }

  switch (req.resource) {
    case "/batches":
      if (method === "POST") return validateCreateBatch(req.body);
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
