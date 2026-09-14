import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { recordActivity } from "../../../../lib/telemetry";
import { allowedEmail } from "@/lib/allowed-user";

export const dynamic = "force-dynamic";
const handlers = auth.handler();
// The only sign-in endpoints this application needs, each with the one method it answers.
// Anything else is a 404; a listed path reached by the other method is a 405 with `Allow`.
const paths: Record<string, "GET" | "POST"> = {
  "get-session": "GET",
  "sign-in/social": "POST",
  "sign-in/email-otp": "POST",
  "email-otp/send-verification-otp": "POST",
  "sign-out": "POST",
};

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/");
  const supplied = request.headers.get("x-request-id") || "";
  const trace = /^[\w.:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  // Better Auth's client reads `message`, so these responses keep that shape rather than
  // introducing a second one. `code` and `trace` are additive (API-CONTRACTS-003, -018).
  const fail = (
    code: string,
    message: string,
    status: number,
    headers: Record<string, string> = {},
  ) =>
    NextResponse.json(
      { code, message, trace },
      { status, headers: { "Cache-Control": "no-store", "X-Request-Id": trace, ...headers } },
    );

  const method = paths[path];
  if (!method) return fail("unknown_endpoint", "Not found.", 404);
  if (method !== request.method)
    return fail("method_not_allowed", `Use ${method} for this endpoint.`, 405, { Allow: method });
  if (request.method === "POST") {
    if (
      request.headers.get("origin") !==
      `${process.env.VERCEL ? "https:" : request.nextUrl.protocol}//${request.headers.get("host")}`
    )
      return fail("invalid_origin", "Invalid origin.", 403);
    const reader = request.clone().body?.getReader();
    let size = 0;
    if (reader)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          void reader.cancel();
          return fail("payload_too_large", "Request too large.", 413);
        }
      }
    if (path === "sign-in/email-otp" || path === "email-otp/send-verification-otp") {
      let body: { email?: unknown } | undefined;
      try {
        body = await request.clone().json();
      } catch {
        return fail("invalid_json", "Send valid JSON.", 400);
      }
      if (!allowedEmail(body?.email)) {
        await recordActivity("sign_in_failed");
        return fail("email_not_permitted", "Use your @parallel.ai email or an approved account.", 403);
      }
    }
  }
  const signIn = path === "sign-in/social" || path === "sign-in/email-otp" || path === "email-otp/send-verification-otp";
  if (signIn && path !== "sign-in/email-otp") await recordActivity("sign_in_started");
  try {
    const response = await handlers[method](request, context);
    if (signIn && !response.ok) await recordActivity("sign_in_failed");
    response.headers.set("X-Request-Id", trace);
    return response;
  } catch {
    if (signIn) await recordActivity("sign_in_failed");
    return fail("sign_in_unavailable", "Sign-in service is unavailable. Try again.", 503);
  }
}
export const GET = handle;
export const POST = handle;
