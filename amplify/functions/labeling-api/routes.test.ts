import { describe, it, expect } from "vitest";
import { routeRequest, DEFAULT_UNIT_COUNT, type RouteRequest } from "./routes.js";
import { HttpError } from "../shared/http.js";

/**
 * labeling-api 純ロジックのテスト（design §6.4 / §4.4 / §14 / 要件 8〜11）。
 * ルーティング・入力検証・?status= 分岐・二重起動抑止（startLabeling アクション）を検証する。
 */

const base: RouteRequest = {
  httpMethod: "GET",
  resource: "/batches",
};

describe("routeRequest: POST /batches（画面 A）", () => {
  const req = (body: unknown): RouteRequest => ({
    httpMethod: "POST",
    resource: "/batches",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it("有効な入力を createBatch アクションにする", () => {
    const action = routeRequest(
      req({
        item_id: "ITEM#ETH-YIRG",
        lot_id: "LOT#2026-10-01-003",
        roast_date: "2026-10-09",
        unit_count: 500,
      }),
    );
    expect(action).toEqual({
      kind: "createBatch",
      item_id: "ITEM#ETH-YIRG",
      lot_id: "LOT#2026-10-01-003",
      roast_date: "2026-10-09",
      unit_count: 500,
    });
  });

  it("unit_count 省略時は既定 1000 を補完する（API 層が所有）", () => {
    const action = routeRequest(
      req({
        item_id: "ITEM#ETH-YIRG",
        lot_id: "LOT#2026-10-01-003",
        roast_date: "2026-10-09",
      }),
    );
    expect(action).toMatchObject({ kind: "createBatch", unit_count: DEFAULT_UNIT_COUNT });
    expect(DEFAULT_UNIT_COUNT).toBe(1000);
  });

  it("item_id の ITEM# 接頭辞欠落は 400", () => {
    expect(() =>
      routeRequest(req({ item_id: "ETH", lot_id: "LOT#x", roast_date: "2026-10-09" })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("lot_id の LOT# 接頭辞欠落は 400", () => {
    expect(() =>
      routeRequest(req({ item_id: "ITEM#x", lot_id: "x", roast_date: "2026-10-09" })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("roast_date が ISO 日付でなければ 400", () => {
    expect(() =>
      routeRequest(req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026/10/09" })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("unit_count が負・非整数は 400", () => {
    expect(() =>
      routeRequest(req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026-10-09", unit_count: -1 })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
    expect(() =>
      routeRequest(req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026-10-09", unit_count: 1.5 })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("unit_count が SEED_UNIT_COUNT_MAX 上限超過は作成時に 400（design §14）", () => {
    // 既定上限（SEED_UNIT_COUNT_MAX_DEFAULT=1200）を超える値は弾く
    expect(() =>
      routeRequest(
        req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026-10-09", unit_count: 9999 }),
      ),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
    // options で渡した上限を境界に、上限ちょうどは受理・上限+1 は 400
    expect(
      routeRequest(
        req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026-10-09", unit_count: 500 }),
        { seedUnitCountMax: 500 },
      ),
    ).toMatchObject({ kind: "createBatch", unit_count: 500 });
    expect(() =>
      routeRequest(
        req({ item_id: "ITEM#x", lot_id: "LOT#x", roast_date: "2026-10-09", unit_count: 501 }),
        { seedUnitCountMax: 500 },
      ),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("ボディ欠落は 400", () => {
    expect(() => routeRequest(req(undefined))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("routeRequest: GET /batches ?status=（画面 B）", () => {
  const req = (status?: string): RouteRequest => ({
    ...base,
    queryStringParameters: status === undefined ? null : { status },
  });

  it("status 省略時は既定 ROASTING_DONE", () => {
    expect(routeRequest(req())).toEqual({ kind: "listBatches", status: "ROASTING_DONE" });
  });

  it("許容 3 値を受理する", () => {
    expect(routeRequest(req("LABELING"))).toMatchObject({ status: "LABELING" });
    expect(routeRequest(req("LABELED"))).toMatchObject({ status: "LABELED" });
    expect(routeRequest(req("ROASTING_DONE"))).toMatchObject({ status: "ROASTING_DONE" });
  });

  it("許容外は 400（既定へ読み替えない）", () => {
    expect(() => routeRequest(req("UNKNOWN"))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("routeRequest: GET /batches/{batchId}（画面 C）", () => {
  it("batchId を解決して getBatch にする", () => {
    const action = routeRequest({
      httpMethod: "GET",
      resource: "/batches/{batchId}",
      pathParameters: { batchId: "BATCH#2026-10-09-AM-01" },
    });
    expect(action).toEqual({ kind: "getBatch", batch_id: "BATCH#2026-10-09-AM-01" });
  });

  it("BATCH# 無しの batchId には接頭辞を補う", () => {
    const action = routeRequest({
      httpMethod: "GET",
      resource: "/batches/{batchId}",
      pathParameters: { batchId: "2026-10-09-AM-01" },
    });
    expect(action).toMatchObject({ batch_id: "BATCH#2026-10-09-AM-01" });
  });

  it("空の batchId は 400", () => {
    expect(() =>
      routeRequest({
        httpMethod: "GET",
        resource: "/batches/{batchId}",
        pathParameters: { batchId: "" },
      }),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("routeRequest: POST /labeling-start（二重起動抑止・画面 B）", () => {
  it("startLabeling アクションを返す（handler が条件付き遷移を実行し 409 分岐を持つ）", () => {
    const action = routeRequest({
      httpMethod: "POST",
      resource: "/batches/{batchId}/labeling-start",
      pathParameters: { batchId: "BATCH#2026-10-09-AM-01" },
    });
    expect(action).toEqual({
      kind: "startLabeling",
      batch_id: "BATCH#2026-10-09-AM-01",
    });
  });
});

describe("routeRequest: GET /units（画面 D）", () => {
  it("batchId で listUnits(by=batch)", () => {
    expect(
      routeRequest({
        httpMethod: "GET",
        resource: "/units",
        queryStringParameters: { batchId: "BATCH#2026-10-09-AM-01" },
      }),
    ).toEqual({ kind: "listUnits", by: "batch", value: "BATCH#2026-10-09-AM-01" });
  });

  it("lotId で listUnits(by=lot)", () => {
    expect(
      routeRequest({
        httpMethod: "GET",
        resource: "/units",
        queryStringParameters: { lotId: "LOT#2026-10-01-003" },
      }),
    ).toEqual({ kind: "listUnits", by: "lot", value: "LOT#2026-10-01-003" });
  });

  it("batchId と lotId の両方指定は 400（排他）", () => {
    expect(() =>
      routeRequest({
        httpMethod: "GET",
        resource: "/units",
        queryStringParameters: { batchId: "BATCH#x", lotId: "LOT#y" },
      }),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("両方なしは 400", () => {
    expect(() =>
      routeRequest({ httpMethod: "GET", resource: "/units", queryStringParameters: null }),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("routeRequest: その他", () => {
  it("GET /config は getConfig", () => {
    expect(routeRequest({ httpMethod: "GET", resource: "/config" })).toEqual({
      kind: "getConfig",
    });
  });

  it("OPTIONS は options アクション", () => {
    expect(
      routeRequest({ httpMethod: "OPTIONS", resource: "/batches" }),
    ).toEqual({ kind: "options" });
  });

  it("未知のルートは 404", () => {
    expect(() =>
      routeRequest({ httpMethod: "DELETE", resource: "/batches" }),
    ).toThrowError(expect.objectContaining({ statusCode: 404 }));
    expect(() =>
      routeRequest({ httpMethod: "GET", resource: "/unknown" }),
    ).toThrowError(HttpError);
  });
});
