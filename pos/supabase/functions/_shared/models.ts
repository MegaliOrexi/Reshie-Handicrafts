// Request / response body models for OUR edge-function APIs.
//   • egoal-gateway  POST /token, POST /sales
//   • egoal-export   POST {sale_id} | {shop_id} | {}
// eGoal's own wire format (EgoalBody / EgoalResponse) lives in egoal.ts — the only file that knows it.
//
// Type-only module (no runtime code) so it also loads under `node --experimental-strip-types`
// (scripts/egoal-send.mjs) as well as Deno.

import type { EgoalBody, EgoalEnv, EgoalResponse } from "./egoal.ts";

// ============================================================ shared

/** Every gateway response carries this, so a caller can find the pair in api_logs. */
export interface Correlated {
  correlation_id: string;
}

/** Generic gateway error (bad method, unknown route, bad/expired token, server error). */
export interface GatewayError extends Correlated {
  ok: false;
  error: string;
}

// ============================================================ egoal-gateway  POST /token

export interface TokenRequest {
  email: string;
  password: string;
}

export interface TokenResponse extends Correlated {
  ok: true;
  access_token: string;
  token_type: "Bearer";
  /** seconds */
  expires_in: number;
}

/** 200 → TokenResponse · 400 missing credentials · 401 invalid credentials · 500 auth/signing failure */
export type TokenResult = TokenResponse | GatewayError;

// ============================================================ egoal-gateway  POST /sales
// Header: Authorization: Bearer <access_token>

/** The request body IS the eGoal invoice-wise body (one shop, one business day). */
export type SalesRequest = EgoalBody;

/** 200 — eGoal accepted it (201), or stub mode (nothing sent). */
export interface SalesAccepted extends Correlated {
  ok: true;
  /** true when EGOAL_ENV is unset → validated + logged only */
  stub: boolean;
  egoal_env: EgoalEnv;
  /** eGoal HTTP status (201 = inserted); null in stub mode */
  egoal_status: number | null;
  egoal_response: EgoalResponse;
  /** number of invoices in the upload */
  invoices: number;
}

/** 422 — failed our pre-checks (validateEgoalBody); nothing was sent to eGoal. */
export interface SalesValidationError extends Correlated {
  ok: false;
  errors: string[];
}

/** eGoal's 4xx status passed through, or 502 when eGoal returned 5xx / was unreachable. */
export interface SalesUpstreamError extends Correlated {
  ok: false;
  error: string | null;
  egoal_env: EgoalEnv;
  /** null when eGoal could not be reached */
  egoal_status: number | null;
  egoal_response: EgoalResponse;
}

/** 401 bad token → GatewayError. */
export type SalesResult = SalesAccepted | SalesValidationError | SalesUpstreamError | GatewayError;

// ============================================================ egoal-export

/**
 * • {sale_id} — the till, right after a sale (staff JWT; RLS must allow the sale)
 * • {shop_id} — owner's "Retry failed" (owner JWT)
 * • {}        — pg_cron retry job (service_role key only)
 */
export type ExportRequest = { sale_id: string } | { shop_id: string } | Record<string, never>;

export type EgoalSaleStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

/** The patch written to `sales`, echoed back per sale. */
export interface ExportSaleResult {
  sale_id: string;
  receipt_no: string;
  egoal_status: Extract<EgoalSaleStatus, "sent" | "failed" | "skipped">;
  egoal_attempts: number;
  /** null on a clean LIVE send; a note for stub/UAT sends; the reason on failure/skip */
  egoal_error: string | null;
  /** ISO timestamp, only when sent */
  egoal_sent_at?: string;
}

export interface ExportResponse {
  ok: true;
  processed: number;
  results: ExportSaleResult[];
}

/** 400 missing ids · 401 unauthorized · 403 owner only · 404 sale not found · 500 claim failed */
export interface ExportError {
  ok: false;
  error: string;
  step?: "claim";
}

export type ExportResult = ExportResponse | ExportError;
