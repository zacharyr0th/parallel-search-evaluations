import {
  readCacheTag,
  readEvaluationHistory,
  readEvaluation,
  cloudAPI,
  APIError,
} from "../../../lib/cloud-evaluations";
import { recordActivity } from "../../../lib/telemetry";
import { accessContext } from "../../../lib/auth";
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Which method each operation answers. A known operation reached by the other method is a 405
// with `Allow`, not a 404: the resource exists, the method does not (RFC 9110 §15.5.6).
const methods: Record<string, "GET" | "POST"> = {
  evaluations: "GET",
  evaluation: "GET",
  export: "GET",
  agreement: "GET",
  search: "POST",
  feedback: "POST",
};
// The only operation that answers both. Reading returns the timeline; writing appends to it.
const bothMethods = "activity";
// Documented response caps. A caller cannot otherwise tell a full page from a truncated one.
const listLimits: Record<string, number> = { evaluations: 100, activity: 100 };
// Backend failures carry their own code where the condition is specific; the rest map by status.
const codes: Record<number, string> = {
  400: "invalid_request",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  500: "internal_error",
  502: "upstream_unavailable",
  503: "service_unavailable",
};

/** Seconds until the daily search budget resets, for `Retry-After` on a 429. */
const untilBudgetReset = () => {
  const now = new Date();
  return Math.ceil(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) /
      1000,
  );
};

/**
 * Correlate one request for tracing. Caller-supplied when it is a safe opaque token, generated
 * otherwise. This identifier never carries authority: it is not authentication, authorization or
 * an idempotency key (see `idempotency_key` on `search` for that).
 */
const correlation = (request: NextRequest) => {
  const supplied = request.headers.get("x-request-id") || "";
  return /^[\w.:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
};

async function forward(request: NextRequest, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  const trace = correlation(request);
  const fail = (
    code: string,
    message: string,
    status: number,
    headers: Record<string, string> = {},
  ) =>
    NextResponse.json(
      { code, error: message, trace },
      { status, headers: { "Cache-Control": "no-store", "X-Request-Id": trace, ...headers } },
    );
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    NextResponse.json(body, { headers: { "X-Request-Id": trace, ...headers } });

  const method = methods[operation];
  if (!method && operation !== bothMethods) return fail("unknown_operation", "Not found.", 404);
  const write = request.method === "POST";
  if (method && method !== request.method) {
    return fail("method_not_allowed", `Use ${method} for this operation.`, 405, { Allow: method });
  }
  const { status: access, actor, userId } = await accessContext(request);
  if (access !== 200) {
    const denied = {
      401: ["authentication_required", "Sign in to continue."],
      403: ["account_not_permitted", "This account does not have access."],
      503: ["sign_in_unavailable", "Sign-in service is unavailable. Try again."],
    }[access];
    return fail(denied[0], denied[1], access);
  }
  const host = request.headers.get("host");
  const port = process.env.PORT || "3000";
  if (!process.env.VERCEL && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host || "")) {
    return fail("local_address_required", "Use the local application address.", 403);
  }
  if (
    write &&
    (request.headers.get("origin") !==
      `${process.env.VERCEL ? "https:" : request.nextUrl.protocol}//${host}` ||
      request.headers.get("x-requested-with") !== "SearchEvaluations")
  ) {
    return fail("stale_client", "Reload the application before submitting.", 403);
  }
  try {
    if (write) {
      if (request.headers.get("content-type") !== "application/json")
        return fail("unsupported_media_type", "Send the request as JSON.", 415);
      // Bound the stream before buffering; Content-Length alone can be omitted or forged.
      const reader = request.body?.getReader();
      if (!reader) return fail("invalid_body", "Send a JSON object.", 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 131072) {
          await reader.cancel();
          return fail("payload_too_large", "Request too large.", 413);
        }
        chunks.push(value);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body);
      } catch {
        return fail("invalid_json", "Send valid JSON.", 400);
      }
      if (!payload || Array.isArray(payload) || typeof payload !== "object")
        return fail("invalid_body", "Send a JSON object.", 400);
      const result = await cloudAPI(operation, null, payload, actor);
      if (operation === "search") await recordActivity("comparison_run", userId);
      if (operation === "feedback") await recordActivity("grade_saved", userId);
      return ok(result, { "Cache-Control": "no-store" });
    }
    const id = request.nextUrl.searchParams.get("id");
    if (operation === "evaluation" || operation === "evaluations") {
      const snapshot = !request.headers.has("if-none-match")
        ? operation === "evaluations"
          ? await readEvaluationHistory(actor!, id)
          : await readEvaluation(actor!, id || "")
        : null;
      const etag = snapshot?.etag ?? (await readCacheTag(operation, id, actor!));
      const headers: Record<string, string> = {
        "Cache-Control": "private, no-cache",
        Vary: "Cookie",
        ETag: etag,
        "X-Request-Id": trace,
      };
      if (request.headers.get("if-none-match") === etag)
        return new NextResponse(null, { status: 304, headers });
      const body = snapshot?.body ?? (await cloudAPI(operation, id, undefined, actor));
      return NextResponse.json(body, { headers: { ...headers, ...listHeaders(operation, body) } });
    }
    const body = await cloudAPI(operation, id, undefined, actor);
    return ok(body, { "Cache-Control": "no-store", ...listHeaders(operation, body) });
  } catch (e) {
    if (e instanceof APIError) {
      const retry: Record<string, string> =
        e.status === 429 ? { "Retry-After": String(untilBudgetReset()) } : {};
      return fail(e.code || codes[e.status] || "request_failed", e.message, e.status, retry);
    }
    return fail(
      "upstream_unavailable",
      "Evaluation service is unavailable. Refresh saved evaluations before retrying.",
      502,
    );
  }
}

/** Signal a capped list so a caller can tell a complete page from a truncated one. */
function listHeaders(operation: string, body: unknown): Record<string, string> {
  const limit = listLimits[operation];
  if (limit === undefined || !Array.isArray(body)) return {};
  return { "X-Items-Limit": String(limit), "X-Items-Truncated": String(body.length >= limit) };
}

export const GET = forward;
export const POST = forward;
