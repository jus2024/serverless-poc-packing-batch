/**
 * 付番 API の fetch クライアント（design §4.4 の 6 ルート / §11.1）。
 *
 * ## 何をこの層に閉じ込めているか
 *
 * - ベース URL の解決（`NEXT_PUBLIC_LABELING_API_URL` のみが出典。ハードコードしない）
 * - パス/クエリ値の percent-encode（batch_id は `BATCH#...` で `#` を含む。design §4.4 / MEDIUM-1）
 * - エラー応答 `{ error, message, details? }`（design §13）から型付き例外への変換
 *
 * コンポーネント（画面 A〜D）は `LabelingApiFailure` を捕まえて `kind` で分岐し、
 * HTTP エラーなら `status` でさらに分岐する（404/409 等）。素の `Error` や `Response` を
 * 画面側に漏らさないことで、各パネルが失敗の種別を取り違えないようにする（参考 EC PoC 様式）。
 *
 * ## Lambda 側のモジュールを参照しない
 *
 * 型は `./types` にあり `amplify/functions/shared/` からは import しない（構成越境しない）。
 * `aws-amplify/auth` はフロント専用モジュールなので import してよい。
 *
 * ## Cognito ID トークンを付ける
 *
 * API Gateway に Cognito User Pool 認証を掛けているため、全リクエストに
 * `Authorization: Bearer <idToken>` を付ける。オーソライザーは `Authorization` の JWT を
 * 検証し、本 PoC は参考 EC PoC に合わせ ID トークンを送る（design §4.4）。トークン取得は
 * 毎リクエスト時に `fetchAuthSession()` で行う（Amplify がキャッシュと期限管理を担う）。
 */

import { fetchAuthSession } from "aws-amplify/auth";
import type {
  CreateBatchInput,
  LabelingConfig,
  LabelingErrorBody,
  RoastBatch,
  RoastBatchStatus,
  StartLabelingResponse,
  Unit,
} from "./types";

// ─── 失敗の分類 ───────────────────────────────────────────────────

/**
 * 失敗の種別。画面はまずこれで分岐する。
 *
 * | 種別 | 意味 | 画面の対応 |
 * |------|------|-----------|
 * | `CONFIG` | ベース URL が未設定/不正 | セットアップ手順を案内する（design §11.1） |
 * | `REQUEST` | 呼び出し側の引数不備。送信前に弾いたもの | 入力欄のバリデーションとして扱う |
 * | `NETWORK` | fetch 自体が失敗（オフライン、CORS、中断） | 再試行を促す |
 * | `HTTP` | API がエラー応答を返した | `status` で分岐する（design §13） |
 */
export type LabelingApiFailureKind = "CONFIG" | "REQUEST" | "NETWORK" | "HTTP";

/**
 * 付番 API 呼び出しの失敗。
 *
 * `Object.setPrototypeOf` を各サブクラスで呼ぶのは、`Error` を継承したクラスが
 * ES5 へダウンレベルされた場合に `instanceof` が壊れるのを防ぐためである
 * （画面側が `instanceof` で分岐する）。
 */
export abstract class LabelingApiFailure extends Error {
  abstract readonly kind: LabelingApiFailureKind;
}

/** ベース URL が解決できない（design §11.1）。 */
export class LabelingApiConfigError extends LabelingApiFailure {
  readonly kind = "CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "LabelingApiConfigError";
    Object.setPrototypeOf(this, LabelingApiConfigError.prototype);
  }
}

/** 呼び出し側の引数不備。リクエストを送る前に弾いたもの。 */
export class LabelingApiRequestError extends LabelingApiFailure {
  readonly kind = "REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "LabelingApiRequestError";
    Object.setPrototypeOf(this, LabelingApiRequestError.prototype);
  }
}

/** 通信自体の失敗（オフライン、CORS、`AbortSignal` による中断）。 */
export class LabelingApiNetworkError extends LabelingApiFailure {
  readonly kind = "NETWORK";
  /** 元の例外。ログ出力用。画面には出さない。 */
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "LabelingApiNetworkError";
    this.cause = cause;
    Object.setPrototypeOf(this, LabelingApiNetworkError.prototype);
  }
}

/**
 * API がエラー応答を返した（design §13）。
 *
 * `code` を列挙に狭めないのは、応答が想定外のコードを返しても分類ごと失わない
 * ようにするためである。画面は主に `status`（401/404/409 等）で分岐する。
 */
export class LabelingApiError extends LabelingApiFailure {
  readonly kind = "HTTP";
  readonly status: number;
  /** `{ error }` の値（例: `Conflict`）。 */
  readonly code: string;
  /** `{ details }` の値。無ければ `undefined`。 */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "LabelingApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, LabelingApiError.prototype);
  }
}

/**
 * エラー応答の本文が JSON として読めなかったときに使うコード。
 *
 * design §13 の表に無い値をあえて使い、「API がそう答えた」のか「応答が読めなかった」のかを
 * 区別できるようにする（サーバ側コードに丸めない）。
 */
export const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

// ─── ベース URL の解決 ─────────────────────────────────────────────

/** ベース URL を与える環境変数の名前（案内メッセージに使う）。 */
export const LABELING_API_BASE_URL_ENV = "NEXT_PUBLIC_LABELING_API_URL";

const MISSING_BASE_URL_MESSAGE =
  `付番 API のベース URL が設定されていません。` +
  `\`npx ampx sandbox\` の出力（または amplify_outputs.json の custom.labelingApiUrl）に表示された` +
  ` API エンドポイントを \`.env.local\` の ${LABELING_API_BASE_URL_ENV} に設定して、開発サーバを再起動してください。`;

/**
 * 付番 API のベース URL を解決する（design §10 / §11.1）。
 *
 * 出典は `NEXT_PUBLIC_LABELING_API_URL` のみ。相対 URL や `localhost` へ暗黙に
 * フォールバックしない。フォールバックすると「デプロイ済み API を叩いているつもりで
 * 別の宛先を叩いていた」という取り違えが起き、観測結果の出典が分からなくなる。
 *
 * @throws {LabelingApiConfigError} 未設定、または URL として解釈できない場合
 */
export function resolveLabelingApiBaseUrl(): string {
  // Next.js は `process.env.NEXT_PUBLIC_*` へのリテラルなアクセスのみを
  // ビルド時に埋め込む。変数経由で読むとクライアント側で undefined になる。
  const raw = process.env.NEXT_PUBLIC_LABELING_API_URL;

  if (raw === undefined || raw.trim() === "") {
    throw new LabelingApiConfigError(MISSING_BASE_URL_MESSAGE);
  }

  // 末尾のスラッシュを落とす。`https://host/` + `/batches` が `//batches` になるのを防ぐ
  const trimmed = raw.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new LabelingApiConfigError(
      `${LABELING_API_BASE_URL_ENV} が URL として解釈できません: ${raw}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new LabelingApiConfigError(
      `${LABELING_API_BASE_URL_ENV} は http(s) の URL を指定してください: ${raw}`,
    );
  }

  return trimmed;
}

// ─── 認証トークンの取得 ────────────────────────────────────────────

/**
 * Cognito ID トークンを返す関数の型。取得できなければ `null`。
 *
 * 差し替え可能にしているのは、`aws-amplify/auth` の `fetchAuthSession()` を直に呼ぶと
 * Amplify の設定（`Amplify.configure`）が要り、単体テスト環境で例外になるためである。
 * 既定は `fetchIdTokenFromAmplify`。
 */
export type IdTokenProvider = () => Promise<string | null>;

/**
 * Amplify のセッションから ID トークンを取得する（既定の取得方法）。
 *
 * API Gateway の Cognito オーソライザーは `Authorization` の JWT を検証し、本 PoC は
 * ID トークンを送る（design §4.4）。未ログインや取得失敗時は `null` を返す（アプリは
 * `<Authenticator>` 配下で基本ログイン済みだが防御的に扱う。トークン無しで送ると
 * API Gateway が 401 を返し `LabelingApiError`(HTTP 401) になる）。
 */
export async function fetchIdTokenFromAmplify(): Promise<string | null> {
  try {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? null;
  } catch {
    return null;
  }
}

/** リクエストに使う ID トークンの取得方法。既定は Amplify セッションから取得する。 */
let idTokenProvider: IdTokenProvider = fetchIdTokenFromAmplify;

/** ID トークンの取得方法を差し替える（主にテスト用）。 */
export function setIdTokenProvider(provider: IdTokenProvider): void {
  idTokenProvider = provider;
}

/** ID トークンの取得方法を既定（Amplify セッション）に戻す（主にテスト用）。 */
export function resetIdTokenProvider(): void {
  idTokenProvider = fetchIdTokenFromAmplify;
}

// ─── リクエストの組み立て ──────────────────────────────────────────

/** 各クライアント関数に渡せる共通オプション。 */
export interface LabelingApiOptions {
  /**
   * ベース URL の上書き。省略時は `resolveLabelingApiBaseUrl()`。
   * 環境変数を触らずに宛先を差し替えたい場合（テスト、複数環境の比較）に使う。
   */
  baseUrl?: string;
  /** 中断シグナル。ポーリング中の画面遷移で使う。 */
  signal?: AbortSignal;
}

/** クエリパラメータ。`undefined` の項目は付けない。 */
type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * パス/クエリ値を percent-encode する。
 *
 * batch_id は `BATCH#...` の形式で `#` を含む（design §3.2 / MEDIUM-1）。そのまま URL に
 * 置くと `#` 以降がフラグメントとして落ち `GET /batches/BATCH` を叩くことになる。
 * フロントが `encodeURIComponent` でエンコードし、Lambda は API GW デコード済みの値を
 * そのまま使う（design §4.4）。
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** クエリ文字列を組み立てる（空なら空文字）。値は `URLSearchParams` が percent-encode する。 */
function buildQueryString(params: QueryParams | undefined): string {
  if (params === undefined) {
    return "";
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
}

interface RequestSpec {
  method: "GET" | "POST";
  /** 先頭がスラッシュのパス。可変部分は呼び出し側で encode 済みにする。 */
  path: string;
  query?: QueryParams;
  /** JSON 本文。`undefined` なら本文を送らない。 */
  body?: unknown;
}

/**
 * リクエストを送り JSON を返す。全クライアント関数の唯一の入口。
 *
 * 成功と判定するのは `response.ok`（2xx）である。ステータスは 200 / 201 / 202 と
 * ルートごとに異なる（design §6.4）ため、特定の値との一致は見ない。
 */
async function requestJson<T>(
  spec: RequestSpec,
  options: LabelingApiOptions = {},
): Promise<T> {
  const baseUrl = options.baseUrl ?? resolveLabelingApiBaseUrl();
  const url = `${baseUrl}${spec.path}${buildQueryString(spec.query)}`;

  const init: RequestInit = { method: spec.method };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }

  const headers: Record<string, string> = {};
  if (spec.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(spec.body);
  }
  // Cognito ID トークンを付ける。取得できなければヘッダーを付けずに送り、
  // API Gateway 側で 401 になる（未ログインは基本起こらないが防御的に扱う）
  const idToken = await idTokenProvider();
  if (idToken !== null) {
    headers.Authorization = `Bearer ${idToken}`;
  }
  if (Object.keys(headers).length > 0) {
    init.headers = headers;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // fetch が reject するのは通信レベルの失敗（オフライン、CORS、中断）に限る。
    // HTTP のエラーステータスはここに来ない
    throw new LabelingApiNetworkError(
      `付番 API への通信に失敗しました: ${spec.method} ${spec.path}`,
      error,
    );
  }

  const text = await response.text();

  if (!response.ok) {
    throw toLabelingApiError(response, text);
  }

  // 本文が空（204 等。本 PoC では使わないが防御的に扱う）なら undefined を返す
  if (text.trim() === "") {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LabelingApiError(
      response.status,
      INVALID_RESPONSE_CODE,
      `付番 API の応答が JSON として解釈できません: ${spec.method} ${spec.path}`,
    );
  }
}

/**
 * エラー応答を `LabelingApiError` に変換する（design §13）。
 *
 * 本文が `{ error, message, details? }` の形ならそのコードとメッセージを引き継ぐ。
 * API Gateway 自身が返す応答（認証・スロットル・ルート不一致）はこの形ではないため、
 * ステータスから読めるだけの情報で組み立てる。
 */
function toLabelingApiError(response: Response, text: string): LabelingApiError {
  const body = parseErrorBody(text);

  if (body !== null) {
    return new LabelingApiError(
      response.status,
      body.error,
      body.message,
      body.details,
    );
  }

  return new LabelingApiError(
    response.status,
    INVALID_RESPONSE_CODE,
    `付番 API がエラーを返しました（HTTP ${response.status}${
      response.statusText === "" ? "" : ` ${response.statusText}`
    }）`,
    text === "" ? undefined : text,
  );
}

/** 本文が `{ error, message }` を持つオブジェクトなら返す。そうでなければ null。 */
function parseErrorBody(text: string): LabelingErrorBody | null {
  if (text.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.error !== "string" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }

  const body: LabelingErrorBody = {
    error: candidate.error,
    message: candidate.message,
  };
  if (candidate.details !== undefined) {
    body.details = candidate.details;
  }
  return body;
}

/**
 * 必須の ID を検証する。空文字でリクエストを送ると別のルートに当たってしまう
 * （`GET /batches/` は一覧ルートに落ちる）ため、送信前に弾く。
 */
function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new LabelingApiRequestError(`${label} を指定してください`);
  }
  return trimmed;
}

// ─── クライアント関数（design §4.4 の 6 ルート）──────────────────────

/**
 * RoastBatch を登録する（`POST /batches`。画面 A。要件 8）。
 * `unit_count` 省略時は API 層が既定 1000 を補完して PutItem する（design §6.4）。
 */
export function createBatch(
  input: CreateBatchInput,
  options?: LabelingApiOptions,
): Promise<RoastBatch> {
  return requestJson<RoastBatch>(
    { method: "POST", path: "/batches", body: input },
    options,
  );
}

/**
 * バッチ一覧を取得する（`GET /batches?status=`。画面 B。要件 9.1）。
 * `status` 省略時は API 層が既定 `ROASTING_DONE` を使う（design §4.4）。
 */
export function listBatches(
  status?: RoastBatchStatus,
  options?: LabelingApiOptions,
): Promise<RoastBatch[]> {
  return requestJson<RoastBatch[]>(
    { method: "GET", path: "/batches", query: { status } },
    options,
  );
}

/**
 * 単一バッチを取得する（`GET /batches/{batchId}`。画面 C のポーリング。要件 10.1）。
 * `batchId`（`BATCH#...`）は `encodeURIComponent` でパスをエンコードする（MEDIUM-1）。
 */
export async function getBatch(
  batchId: string,
  options?: LabelingApiOptions,
): Promise<RoastBatch> {
  const id = requireId(batchId, "バッチ ID");
  return requestJson<RoastBatch>(
    { method: "GET", path: `/batches/${encodePathSegment(id)}` },
    options,
  );
}

/**
 * 付番を開始する（`POST /batches/{batchId}/labeling-start`。画面 B。要件 9.2）。
 * 条件成功時のみ 202、既に開始済みなら 409（`LabelingApiError`。design §6.4）。
 */
export async function startLabeling(
  batchId: string,
  options?: LabelingApiOptions,
): Promise<StartLabelingResponse> {
  const id = requireId(batchId, "バッチ ID");
  return requestJson<StartLabelingResponse>(
    { method: "POST", path: `/batches/${encodePathSegment(id)}/labeling-start` },
    options,
  );
}

/**
 * batch 指定で Unit を照会する（`GET /units?batchId=`。GSI1。画面 D。要件 11.1）。
 * クエリ値は `URLSearchParams`（内部で percent-encode）で安全化する（MEDIUM-1）。
 */
export async function listUnitsByBatch(
  batchId: string,
  options?: LabelingApiOptions,
): Promise<Unit[]> {
  const id = requireId(batchId, "バッチ ID");
  return requestJson<Unit[]>(
    { method: "GET", path: "/units", query: { batchId: id } },
    options,
  );
}

/**
 * lot 指定で Unit を照会する（`GET /units?lotId=`。GSI2。画面 D。要件 11.2）。
 */
export async function listUnitsByLot(
  lotId: string,
  options?: LabelingApiOptions,
): Promise<Unit[]> {
  const id = requireId(lotId, "ロット ID");
  return requestJson<Unit[]>(
    { method: "GET", path: "/units", query: { lotId: id } },
    options,
  );
}

/** デプロイ済みの検証パラメータを取得する（`GET /config`。非機能 5）。 */
export function getConfig(
  options?: LabelingApiOptions,
): Promise<LabelingConfig> {
  return requestJson<LabelingConfig>(
    { method: "GET", path: "/config" },
    options,
  );
}
