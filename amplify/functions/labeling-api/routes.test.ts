import { describe, it, expect } from "vitest";
import {
  routeRequest,
  DEFAULT_UNIT_COUNT,
  ROASTING_COMPLETE_MAX_BATCHES,
  type RouteRequest,
} from "./routes.js";
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

  it("許容 4 値を受理する", () => {
    expect(routeRequest(req("PLANNED"))).toMatchObject({ status: "PLANNED" });
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

  it("percent-encoded な batchId（%23 = #）をデコードし二重接頭辞にしない（実機回帰）", () => {
    // API Gateway がパスパラメータをデコードせず BATCH%232026-... を渡しても、
    // ensureBatchId が BATCH# を二重付与して存在しないキーで 404 になってはいけない。
    const action = routeRequest({
      httpMethod: "GET",
      resource: "/batches/{batchId}",
      pathParameters: { batchId: "BATCH%232026-10-09-AM-01" },
    });
    expect(action).toEqual({ kind: "getBatch", batch_id: "BATCH#2026-10-09-AM-01" });
  });

  it("既にデコード済みの batchId をデコードしても不変（二重デコードしない）", () => {
    const action = routeRequest({
      httpMethod: "GET",
      resource: "/batches/{batchId}",
      pathParameters: { batchId: "BATCH#2026-10-09-AM-01" },
    });
    expect(action).toEqual({ kind: "getBatch", batch_id: "BATCH#2026-10-09-AM-01" });
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

  it("percent-encoded な batchId をデコードして startLabeling にする（実機回帰）", () => {
    const action = routeRequest({
      httpMethod: "POST",
      resource: "/batches/{batchId}/labeling-start",
      pathParameters: { batchId: "BATCH%232026-10-09-AM-01" },
    });
    expect(action).toEqual({
      kind: "startLabeling",
      batch_id: "BATCH#2026-10-09-AM-01",
    });
  });
});

describe("routeRequest: POST /batches/roasting-complete（焙煎完了一括記録。§3.4）", () => {
  const req = (body: unknown): RouteRequest => ({
    httpMethod: "POST",
    resource: "/batches/roasting-complete",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  it("複数 batch_ids を roastingComplete アクションにする（正規化済み）", () => {
    const action = routeRequest(
      req({
        batch_ids: ["BATCH#2026-02-10-AM-01", "BATCH#2026-02-10-AM-02"],
      }),
    );
    expect(action).toEqual({
      kind: "roastingComplete",
      batch_ids: ["BATCH#2026-02-10-AM-01", "BATCH#2026-02-10-AM-02"],
    });
  });

  it("BATCH# 無しの要素に接頭辞を補う（ensureBatchId 正規化）", () => {
    const action = routeRequest(req({ batch_ids: ["2026-02-10-AM-01"] }));
    expect(action).toEqual({
      kind: "roastingComplete",
      batch_ids: ["BATCH#2026-02-10-AM-01"],
    });
  });

  it("正規化後に dedupe する（接頭辞有無違いの実体重複も除去）", () => {
    const action = routeRequest(
      req({
        batch_ids: [
          "BATCH#2026-02-10-AM-01",
          "2026-02-10-AM-01",
          "BATCH#2026-02-10-AM-02",
        ],
      }),
    );
    expect(action).toEqual({
      kind: "roastingComplete",
      batch_ids: ["BATCH#2026-02-10-AM-01", "BATCH#2026-02-10-AM-02"],
    });
  });

  it("batch_ids が配列でなければ 400", () => {
    expect(() => routeRequest(req({ batch_ids: "BATCH#x" }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("空配列は 400", () => {
    expect(() => routeRequest(req({ batch_ids: [] }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("上限 100 件超過は 400", () => {
    const tooMany = Array.from(
      { length: ROASTING_COMPLETE_MAX_BATCHES + 1 },
      (_, i) => `BATCH#b-${i}`,
    );
    expect(() => routeRequest(req({ batch_ids: tooMany }))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("上限 100 件ちょうどは受理する", () => {
    const exactly = Array.from(
      { length: ROASTING_COMPLETE_MAX_BATCHES },
      (_, i) => `BATCH#b-${i}`,
    );
    const action = routeRequest(req({ batch_ids: exactly }));
    expect(action).toMatchObject({ kind: "roastingComplete" });
    expect((action as { batch_ids: string[] }).batch_ids).toHaveLength(
      ROASTING_COMPLETE_MAX_BATCHES,
    );
  });

  it("非文字列要素を含む配列は全体を 400（部分受理しない）", () => {
    expect(() =>
      routeRequest(req({ batch_ids: ["BATCH#2026-02-10-AM-01", 123] })),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("ボディ欠落は 400", () => {
    expect(() => routeRequest(req(undefined))).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("JSON として正しい null 本文は 400（500 に落とさない。BLOCK-1）", () => {
    // 本文が文字列 "null"（= JSON の null）でもオブジェクト性ガードで 400 に写す。
    expect(() =>
      routeRequest({
        httpMethod: "POST",
        resource: "/batches/roasting-complete",
        body: "null",
      }),
    ).toThrowError(expect.objectContaining({ statusCode: 400 }));
  });

  it("配列・プリミティブ本文も 400（オブジェクトでない JSON）", () => {
    for (const body of ["[]", "123", '"BATCH#x"', "true"]) {
      expect(() =>
        routeRequest({
          httpMethod: "POST",
          resource: "/batches/roasting-complete",
          body,
        }),
      ).toThrowError(expect.objectContaining({ statusCode: 400 }));
    }
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
