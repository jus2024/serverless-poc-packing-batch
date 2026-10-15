/**
 * API Gateway レスポンスヘルパ（design §6.6 / §13）。
 *
 * labeling-api（画面 A〜D）が返す成功 / エラーレスポンスと CORS ヘッダーを集約する。
 * エラーボディは `{ error, message, details? }` 形式に固定（design §13 / §14、参考 EC PoC 様式）。
 * 入力ミス（400）とシステム異常（500）を型で分け、呼び出し元が受け取る形を 1 箇所で確定する。
 */
import type {
  APIGatewayProxyResult,
  APIGatewayProxyEvent,
} from "aws-lambda";

/** CORS ヘッダー（design §4.4。GET/POST/OPTIONS + Content-Type/Authorization）。 */
export const CORS_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

/** エラーレスポンスボディ（design §13）。 */
export interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** 200 OK（body を JSON 直列化）。 */
export function ok(body: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** 任意のステータスで JSON ボディを返す。 */
export function jsonResponse(
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * エラーレスポンスを組み立てる（design §13）。
 * 許容ステータスは 400/401/404/409/500（design §6.6）。
 */
export function toErrorResponse(
  statusCode: 400 | 401 | 404 | 409 | 500,
  body: ErrorBody,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** API 層のルーティング/検証で投げる型付きエラー（handler がステータスへ写す）。 */
export class HttpError extends Error {
  readonly statusCode: 400 | 401 | 404 | 409 | 500;
  readonly error: string;
  readonly details?: unknown;

  constructor(
    statusCode: 400 | 401 | 404 | 409 | 500,
    error: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.error = error;
    this.details = details;
  }

  toResponse(): APIGatewayProxyResult {
    return toErrorResponse(this.statusCode, {
      error: this.error,
      message: this.message,
      details: this.details,
    });
  }
}

/**
 * リクエストボディを JSON パースする。空ボディ・不正 JSON は 400 の HttpError。
 */
export function parseJsonBody<T = unknown>(
  event: Pick<APIGatewayProxyEvent, "body">,
): T {
  if (event.body === null || event.body === undefined || event.body === "") {
    throw new HttpError(400, "BadRequest", "request body is required");
  }
  try {
    return JSON.parse(event.body) as T;
  } catch {
    throw new HttpError(400, "BadRequest", "request body is not valid JSON");
  }
}
