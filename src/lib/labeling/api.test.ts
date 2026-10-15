/**
 * api.ts のユニットテスト（design §16）。
 *
 * 検証対象:
 * - ベース URL 解決（`NEXT_PUBLIC_LABELING_API_URL` のみ・未設定/不正で CONFIG）
 * - エラー分類（CONFIG / REQUEST / NETWORK / HTTP）
 * - ID トークン付与（provider 差し替え）
 * - `#` を含む batchId のパス/クエリエンコード（MEDIUM-1）
 *
 * `aws-amplify/auth` は Amplify 設定が無いと例外になるためモックする。`fetch` は
 * テストごとに差し替え、送信先 URL とヘッダーを観測する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// aws-amplify/auth をモック（import 時に Amplify.configure を要求しないように）
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: vi.fn(async () => ({ tokens: undefined })),
}));

import {
  createBatch,
  getBatch,
  startLabeling,
  listUnitsByBatch,
  listBatches,
  getConfig,
  resolveLabelingApiBaseUrl,
  setIdTokenProvider,
  resetIdTokenProvider,
  LabelingApiConfigError,
  LabelingApiRequestError,
  LabelingApiNetworkError,
  LabelingApiError,
  LABELING_API_BASE_URL_ENV,
} from "./api";

const BASE = "https://example.test/poc";

/** 任意の JSON ボディ・ステータスで fetch をモックする。送信を記録する。 */
function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      text: async () => text,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

beforeEach(() => {
  // provider を既定の null 返しに差し替え（ヘッダー無しを基準にする）
  setIdTokenProvider(async () => null);
  delete process.env[LABELING_API_BASE_URL_ENV];
});

afterEach(() => {
  resetIdTokenProvider();
  vi.unstubAllGlobals();
  delete process.env[LABELING_API_BASE_URL_ENV];
});

describe("resolveLabelingApiBaseUrl", () => {
  it("環境変数から解決し末尾スラッシュを落とす", () => {
    process.env[LABELING_API_BASE_URL_ENV] = "https://host/poc/";
    expect(resolveLabelingApiBaseUrl()).toBe("https://host/poc");
  });

  it("未設定は CONFIG エラー", () => {
    expect(() => resolveLabelingApiBaseUrl()).toThrow(LabelingApiConfigError);
  });

  it("URL として解釈できない値は CONFIG エラー", () => {
    process.env[LABELING_API_BASE_URL_ENV] = "not a url";
    expect(() => resolveLabelingApiBaseUrl()).toThrow(LabelingApiConfigError);
  });

  it("http(s) 以外のスキームは CONFIG エラー", () => {
    process.env[LABELING_API_BASE_URL_ENV] = "ftp://host/poc";
    expect(() => resolveLabelingApiBaseUrl()).toThrow(LabelingApiConfigError);
  });
});

describe("ベース URL 未設定時のクライアント関数", () => {
  it("CONFIG エラーを投げる（baseUrl オプションも環境変数も無い）", async () => {
    await expect(listBatches()).rejects.toBeInstanceOf(LabelingApiConfigError);
  });
});

describe("# を含む batchId のエンコード（MEDIUM-1）", () => {
  it("getBatch はパスセグメントを encodeURIComponent する", async () => {
    const calls = mockFetch(200, { batch_id: "BATCH#2026-10-09-AM-01" });
    await getBatch("BATCH#2026-10-09-AM-01", { baseUrl: BASE });
    expect(calls[0].url).toBe(`${BASE}/batches/BATCH%232026-10-09-AM-01`);
  });

  it("startLabeling はパスをエンコードする", async () => {
    const calls = mockFetch(202, {
      batch_id: "BATCH#x",
      status: "LABELING",
      labeling_started_at: "2026-10-09T00:00:00Z",
    });
    await startLabeling("BATCH#x", { baseUrl: BASE });
    expect(calls[0].url).toBe(`${BASE}/batches/BATCH%23x/labeling-start`);
  });

  it("listUnitsByBatch はクエリ値を percent-encode する", async () => {
    const calls = mockFetch(200, []);
    await listUnitsByBatch("BATCH#2026-10-09", { baseUrl: BASE });
    expect(calls[0].url).toBe(`${BASE}/units?batchId=BATCH%232026-10-09`);
  });
});

describe("ID トークン付与（provider 差し替え）", () => {
  it("provider がトークンを返すと Authorization ヘッダーを付ける", async () => {
    setIdTokenProvider(async () => "ID-TOKEN-123");
    const calls = mockFetch(200, []);
    await listBatches("ROASTING_DONE", { baseUrl: BASE });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ID-TOKEN-123");
  });

  it("provider が null を返すと Authorization を付けない", async () => {
    setIdTokenProvider(async () => null);
    const calls = mockFetch(200, []);
    await listBatches("ROASTING_DONE", { baseUrl: BASE });
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("リクエスト組み立て", () => {
  it("createBatch は POST + JSON 本文を送る", async () => {
    const calls = mockFetch(201, { batch_id: "BATCH#x" });
    await createBatch(
      { item_id: "ITEM#A", lot_id: "LOT#1", roast_date: "2026-10-09" },
      { baseUrl: BASE },
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/batches`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      item_id: "ITEM#A",
      lot_id: "LOT#1",
      roast_date: "2026-10-09",
    });
  });

  it("listBatches は status クエリを付ける", async () => {
    const calls = mockFetch(200, []);
    await listBatches("LABELED", { baseUrl: BASE });
    expect(calls[0].url).toBe(`${BASE}/batches?status=LABELED`);
  });

  it("getConfig は GET /config を叩く", async () => {
    const calls = mockFetch(200, {
      bestBeforeDays: 365,
      seedUnitCountMax: 1200,
      relayMode: "pipes",
      labelingMaxConcurrency: "1000",
    });
    const cfg = await getConfig({ baseUrl: BASE });
    expect(calls[0].url).toBe(`${BASE}/config`);
    expect(cfg.relayMode).toBe("pipes");
  });
});

describe("エラー分類", () => {
  it("空文字 ID は REQUEST エラー（送信前に弾く）", async () => {
    await expect(getBatch("   ", { baseUrl: BASE })).rejects.toBeInstanceOf(
      LabelingApiRequestError,
    );
  });

  it("fetch 自体の失敗は NETWORK エラー", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fn);
    await expect(listBatches("ROASTING_DONE", { baseUrl: BASE })).rejects.toBeInstanceOf(
      LabelingApiNetworkError,
    );
  });

  it("API エラー応答は HTTP エラー（status/code/message を引き継ぐ）", async () => {
    mockFetch(409, { error: "Conflict", message: "already started" });
    await expect(
      startLabeling("BATCH#x", { baseUrl: BASE }),
    ).rejects.toMatchObject({
      kind: "HTTP",
      status: 409,
      code: "Conflict",
    });
  });

  it("エラー本文が JSON でないときは INVALID_RESPONSE で HTTP エラー", async () => {
    mockFetch(500, "<html>gateway error</html>");
    await expect(
      listBatches("ROASTING_DONE", { baseUrl: BASE }),
    ).rejects.toBeInstanceOf(LabelingApiError);
  });

  it("成功応答が JSON でないときは INVALID_RESPONSE", async () => {
    mockFetch(200, "not json");
    await expect(
      getConfig({ baseUrl: BASE }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
