import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { accountAccessToken } from "@/lib/parallel-account";
import { accessContext } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Balance = { available: true; invoiced: boolean; balanceCents: number; currency: "USD" };
let balanceCache: { token: string; expires: number; value: Promise<Balance> } | null = null;

// Access failures use the same `{code, error, trace}` shape as /api/[operation].
const denied = {
  401: ["authentication_required", "Sign in to continue."],
  403: ["account_not_permitted", "This account does not have access."],
  503: ["sign_in_unavailable", "Sign-in service is unavailable. Try again."],
} as const;

export async function GET(request: NextRequest) {
  const supplied = request.headers.get("x-request-id") || "";
  const trace = /^[\w.:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  const reply = (body: object, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-Id": trace },
    });
  const fail = (code: string, error: string, status: number) =>
    reply({ code, error, trace }, status);

  const { status } = await accessContext(request);
  if (status !== 200) return fail(denied[status][0], denied[status][1], status);

  // No connected account is an ordinary empty state, so it reports 200 with `available: false`.
  // A dependency that cannot answer is a failure, and reports the matching status instead.
  let token: string | null;
  try {
    token = await accountAccessToken();
  } catch {
    return fail(
      "account_authorization_unavailable",
      "Account authorization unavailable. Retry or reconnect Parallel.",
      503,
    );
  }
  if (!token)
    return reply({
      available: false,
      reason_code: "account_not_connected",
      reason: "Connect a Parallel account to view API credits.",
    });

  if (!balanceCache || balanceCache.token !== token || balanceCache.expires <= Date.now()) {
    balanceCache = {
      token,
      expires: Date.now() + 30000,
      value: (async () => {
        const response = await fetch("https://api.parallel.ai/account/service/v1/balance", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Balance unavailable");
        const data = await response.json();
        if (
          typeof data.will_invoice !== "boolean" ||
          typeof data.credit_balance_cents !== "number" ||
          !Number.isFinite(data.credit_balance_cents)
        )
          throw new Error("Invalid balance");
        // `currency` is this contract's stated assumption, not an upstream field: the balance
        // endpoint returns `credit_balance_cents` with no currency. Naming it here keeps the
        // assumption in the contract instead of leaving each caller to guess (API-CONTRACTS-027).
        return {
          available: true,
          invoiced: data.will_invoice,
          balanceCents: data.credit_balance_cents,
          currency: "USD",
        } as Balance;
      })(),
    };
  }
  const entry = balanceCache;
  try {
    return reply(await entry.value);
  } catch {
    if (balanceCache === entry) balanceCache = null;
    return fail("balance_unavailable", "Could not retrieve the credit balance.", 502);
  }
}
