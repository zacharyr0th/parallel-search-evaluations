// The HTTP edge: the API route handlers, the credits route, the page proxy and the
// local-development access bypass. Every dependency below the handler is scripted, so
// these run with no network, no database and no Parallel credits.
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server.js";
import { load } from "./load.mjs";
import { test } from "node:test";

class APIError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------ app/api/[operation]/route.ts

// `env` is handed to the module by reference, so a test can flip VERCEL mid-run.
function apiBackend() {
  const state = {
    access: 200,
    calls: 0,
    versionReads: 0,
    historyReads: 0,
    failure: null,
    env: { PORT: "3000" },
  };
  const routes = load("app/api/[operation]/route.ts", {
    env: state.env,
    mocks: {
      "/auth": {
        accessContext: async () => ({ status: state.access, actor: "reviewer@parallel.ai" }),
      },
      "/cloud-evaluations": {
        APIError,
        readCacheTag: async () => {
          state.versionReads++;
          return '"test-version"';
        },
        readEvaluation: async (actor, id) => {
          assert.equal(actor, "reviewer@parallel.ai");
          state.calls++;
          if (state.failure) throw state.failure;
          return { body: state.body ?? { operation: "evaluation", id }, etag: '"test-version"' };
        },
        readEvaluationHistory: async (actor, id) => {
          assert.equal(actor, "reviewer@parallel.ai");
          state.calls++;
          state.historyReads++;
          if (state.failure) throw state.failure;
          return { body: state.body ?? { operation: "evaluations", id }, etag: '"test-version"' };
        },
        cloudAPI: async (operation, id, payload, actor) => {
          assert.equal(
            actor,
            "reviewer@parallel.ai",
            "identity comes from the verified access context",
          );
          state.calls++;
          if (state.failure) throw state.failure;
          return state.body ?? { operation, id, payload };
        },
      },
      "next/server": { NextResponse: Response },
    },
  });

  state.request = (
    operation = "feedback",
    body = "{}",
    headers = {},
    method = "POST",
    protocol = "http",
  ) => {
    const url = new URL(`${protocol}://127.0.0.1:3000/api/${operation}?id=saved`);
    const request = new Request(url, {
      method,
      headers: {
        host: url.host,
        origin: url.origin,
        "content-type": "application/json",
        "x-requested-with": "SearchEvaluations",
        ...headers,
      },
      ...(method === "POST" ? { body } : {}),
    });
    request.nextUrl = url;
    return routes[method](request, { params: Promise.resolve({ operation }) });
  };
  return state;
}

await test("the API route refuses a request the access context rejects", async () => {
  const api = apiBackend();
  for (const status of [401, 403, 503]) {
    api.access = status;
    assert.equal((await api.request()).status, status);
  }
  assert.equal(api.calls, 0, "a rejected request never reaches the backend");
});

await test("the API route enforces origin, content type and body size", async () => {
  const api = apiBackend();
  for (const [body, headers, status] of [
    ["{}", { origin: "https://other.example" }, 403],
    ["{}", { "x-requested-with": "" }, 403],
    ["{}", { host: "other.example", origin: "http://other.example" }, 403],
    ["{}", { "content-type": "text/plain" }, 415],
    ["{broken", {}, 400],
    ["null", {}, 400],
    ["[]", {}, 400],
    ["x".repeat(131073), {}, 413],
  ])
    assert.equal(
      (await api.request("feedback", body, headers)).status,
      status,
      `${JSON.stringify(headers)} ${body.slice(0, 12)}`,
    );
  assert.equal(
    (await api.request("unknown")).status,
    404,
    "an unknown operation is not dispatched",
  );
  assert.equal(api.calls, 0, "none of these reach the backend");
});

await test("the API route dispatches reads and writes to the backend", async () => {
  const api = apiBackend();
  assert.deepEqual(
    await (await api.request("search", '{"query":"docs","modes":["fast"]}')).json(),
    { operation: "search", id: null, payload: { query: "docs", modes: ["fast"] } },
  );
  for (const operation of ["evaluations", "evaluation", "export"]) {
    const response = await api.request(operation, undefined, {}, "GET");
    assert.equal(
      response.headers.get("cache-control"),
      operation === "export" ? "no-store" : "private, no-cache",
      "reads are private to the signed-in reviewer",
    );
    assert.deepEqual(await response.json(), { operation, id: "saved" });
  }
  assert.equal(api.calls, 4);
});

await test("the API route matches the origin against the forwarded protocol", async () => {
  const api = apiBackend();
  assert.equal((await api.request("feedback", "{}", {}, "POST", "https")).status, 200);
  assert.equal(
    (await api.request("feedback", "{}", { origin: "http://127.0.0.1:3000" }, "POST", "https"))
      .status,
    403,
    "an http origin cannot write to an https deployment",
  );
  api.env.VERCEL = "1";
  assert.equal(
    (await api.request("feedback", "{}", { host: "app.example", origin: "https://app.example" }))
      .status,
    200,
  );
});

await test("the API route reports a backend status but never its message", async () => {
  const api = apiBackend();
  api.failure = new APIError("Conflict", 409);
  assert.equal(
    (await api.request("feedback", "{}", { origin: "http://127.0.0.1:3000" })).status,
    409,
  );
  api.failure = new Error("private detail");
  const response = await api.request("feedback", "{}", { origin: "http://127.0.0.1:3000" });
  assert.equal(response.status, 502);
  assert.ok(
    !(await response.text()).includes("private detail"),
    "an unexpected failure is not echoed to the client",
  );
});

await test("the API route answers a known operation reached by the wrong method with 405", async () => {
  const api = apiBackend();
  const read = await api.request("evaluations", "{}", {}, "POST");
  assert.equal(read.status, 405);
  assert.equal(read.headers.get("allow"), "GET", "a read operation names the method it answers");
  const write = await api.request("search", undefined, {}, "GET");
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("allow"), "POST");
  assert.equal(
    (await api.request("unknown", undefined, {}, "GET")).status,
    404,
    "an unknown operation is absent, not method-restricted",
  );
  assert.equal(api.calls, 0, "none of these reach the backend");
  // `activity` is the one operation that answers both methods.
  assert.equal((await api.request("activity", undefined, {}, "GET")).status, 200);
  assert.equal((await api.request("activity", "{}")).status, 200);
});

await test("every API failure carries a stable code and its correlation id", async () => {
  const api = apiBackend();
  for (const [send, code] of [
    [() => api.request("unknown"), "unknown_operation"],
    [
      () => api.request("feedback", "{}", { "content-type": "text/plain" }),
      "unsupported_media_type",
    ],
    [() => api.request("feedback", "{broken"), "invalid_json"],
    [() => api.request("feedback", "x".repeat(131073)), "payload_too_large"],
    [() => api.request("feedback", "{}", { origin: "https://other.example" }), "stale_client"],
  ]) {
    const response = await send();
    const body = await response.json();
    assert.equal(body.code, code, `expected code ${code}`);
    assert.equal(
      body.trace,
      response.headers.get("x-request-id"),
      "the body and the header name one request",
    );
  }
  api.access = 403;
  assert.equal((await (await api.request()).json()).code, "account_not_permitted");
  api.access = 200;
  api.failure = new APIError("Conflict", 409);
  assert.equal(
    (await (await api.request()).json()).code,
    "conflict",
    "a backend status with no code of its own maps by status",
  );
});

await test("a throttled search tells the caller when it may retry", async () => {
  const api = apiBackend();
  api.failure = new APIError("Daily search limit reached.", 429);
  const response = await api.request("search", "{}");
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "rate_limited");
  const retry = Number(response.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 86400, `Retry-After names the reset in seconds, got ${retry}`);
});

await test("a capped list reports its limit and whether it was truncated", async () => {
  const api = apiBackend();
  api.body = Array.from({ length: 100 }, (_unused, index) => ({ id: index }));
  const full = await api.request("evaluations", undefined, {}, "GET");
  assert.equal(full.headers.get("x-items-limit"), "100");
  assert.equal(
    full.headers.get("x-items-truncated"),
    "true",
    "a full page may be hiding older evaluations",
  );
  api.body = [{ id: 1 }];
  assert.equal(
    (await api.request("evaluations", undefined, {}, "GET")).headers.get("x-items-truncated"),
    "false",
  );
  api.body = { id: "one" };
  assert.equal(
    (await api.request("evaluation", undefined, {}, "GET")).headers.get("x-items-limit"),
    null,
    "a single evaluation is not a capped list",
  );
});

await test("an unchanged read answers 304 without loading the evaluation", async () => {
  const api = apiBackend();
  const cached = await api.request(
    "evaluation",
    undefined,
    { "if-none-match": '"test-version"' },
    "GET",
  );
  assert.equal(cached.status, 304);
  assert.equal(api.calls, 0, "a matching validator skips the body entirely");
  assert.equal(cached.headers.get("vary"), "Cookie", "the cache is per reviewer");
  api.access = 401;
  assert.equal(
    (await api.request("evaluation", undefined, { "if-none-match": '"test-version"' }, "GET"))
      .status,
    401,
    "a matching validator still requires authentication",
  );
});

// ---------------------------------------------------- app/api/credits/route.ts

function creditsBackend() {
  const state = {
    status: 200,
    calls: 0,
    now: 0,
    ok: true,
    env: {},
    payload: { will_invoice: false, credit_balance_cents: 1250 },
  };
  class Clock extends Date {
    static now() {
      return state.now;
    }
  }
  const route = load("app/api/credits/route.ts", {
    env: state.env,
    mocks: {
      "@/lib/parallel-account": {
        accountAccessToken: async () => state.env.PARALLEL_ACCOUNT_ACCESS_TOKEN || null,
      },
      "@/lib/auth": { accessContext: async () => ({ status: state.status }) },
      "next/server": { NextResponse: Response },
    },
    globals: {
      Date: Clock,
      fetch: async () => {
        state.calls++;
        return { ok: state.ok, json: async () => state.payload };
      },
    },
  });
  state.get = (headers = {}) => route.GET({ headers: new Headers(headers) });
  return state;
}

await test("the credits route refuses a request the access context rejects", async () => {
  const credits = creditsBackend();
  for (const [status, code] of [
    [401, "authentication_required"],
    [403, "account_not_permitted"],
    [503, "sign_in_unavailable"],
  ]) {
    credits.status = status;
    const response = await credits.get();
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code, `${status} carries its own stable code`);
  }
  assert.equal(credits.calls, 0, "no balance is fetched for a rejected request");
});

await test("the credits route echoes a safe caller correlation id and replaces an unsafe one", async () => {
  const credits = creditsBackend();
  credits.status = 401;
  assert.equal(
    (await credits.get({ "x-request-id": "run-42" })).headers.get("x-request-id"),
    "run-42",
  );
  const forged = await credits.get({ "x-request-id": "a".repeat(200) });
  assert.notEqual(
    forged.headers.get("x-request-id"),
    "a".repeat(200),
    "an oversized id is not reflected",
  );
  assert.match(forged.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

await test("the credits route reports nothing without a stored authorization", async () => {
  const credits = creditsBackend();
  const body = await (await credits.get()).json();
  assert.equal(body.available, false);
  assert.equal(
    body.reason_code,
    "account_not_connected",
    "an unconnected account is an ordinary empty state",
  );
  assert.equal(credits.calls, 0);
});

await test("the credits route caches a balance and re-reads it after the window", async () => {
  const credits = creditsBackend();
  credits.env.PARALLEL_ACCOUNT_ACCESS_TOKEN = "test-only";
  assert.deepEqual(
    await (await credits.get()).json(),
    { available: true, invoiced: false, balanceCents: 1250, currency: "USD" },
    "the balance names its currency rather than leaving each caller to assume one",
  );
  await credits.get();
  assert.equal(credits.calls, 1, "repeated reads share the cached balance");
  credits.now += 30001;
  credits.payload = { will_invoice: true, credit_balance_cents: 0 };
  assert.equal(
    (await (await credits.get()).json()).invoiced,
    true,
    "an invoiced workspace is reported as such",
  );
});

await test("the credits route reports a malformed or failed upstream balance as a failure", async () => {
  const credits = creditsBackend();
  credits.env.PARALLEL_ACCOUNT_ACCESS_TOKEN = "test-only";
  credits.payload = { will_invoice: false, credit_balance_cents: "1250" };
  // An upstream that cannot answer is a failure, not a 200 that says the balance is unavailable.
  const malformed = await credits.get();
  assert.equal(malformed.status, 502, "a string balance is not trusted");
  assert.equal((await malformed.json()).code, "balance_unavailable");
  credits.now += 30001;
  credits.ok = false;
  assert.equal((await credits.get()).status, 502);
  assert.equal((await credits.get()).headers.get("cache-control"), "no-store");
  const before = credits.calls;
  await credits.get();
  assert.equal(credits.calls, before + 1, "a failure is never cached");
});

// ------------------------------------------------------------------- proxy.ts

function proxyBackend() {
  const state = { result: null, calls: 0, access: 403, local: false };
  const proxy = load("proxy.ts", {
    mocks: {
      "next/server": { NextRequest, NextResponse },
      "./lib/auth": {
        accessContext: async () => ({ status: state.access }),
        localDevelopment: () => state.local,
        auth: {
          handler: () => ({
            GET: async (request, options) => {
              state.calls++;
              assert.equal(
                request.nextUrl.searchParams.get("neon_auth_session_verifier"),
                "test-only",
              );
              assert.deepEqual((await options.params).path.join("/"), "get-session");
              if (state.result instanceof Error) throw state.result;
              return state.result;
            },
          }),
          middleware: () => async () => NextResponse.next(),
        },
      },
    },
  });
  state.proxy = proxy.proxy;
  state.callback = () =>
    new NextRequest("http://localhost:3000/sign-in?neon_auth_session_verifier=test-only");
  return state;
}

await test("a successful sign-in callback sets the session and returns home", async () => {
  const edge = proxyBackend();
  edge.result = Response.json(
    { session: { id: "test" }, user: { email: "reviewer@parallel.ai" } },
    { headers: { "Set-Cookie": "test-session=test; HttpOnly; Path=/" } },
  );
  const response = await edge.proxy(edge.callback());
  assert.equal(response.headers.get("location"), "http://localhost:3000/");
  assert.match(response.headers.get("set-cookie"), /test-session=test/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

await test("a failed sign-in callback sets no cookie and reports the error", async () => {
  const edge = proxyBackend();
  for (const result of [
    Response.json(null),
    Response.json({ user: {} }),
    new Response(null, { status: 401 }),
    new Error("unavailable"),
  ]) {
    edge.result = result;
    const response = await edge.proxy(edge.callback());
    assert.equal(response.headers.get("location"), "http://localhost:3000/sign-in?google_error=1");
    assert.equal(
      response.headers.has("set-cookie"),
      false,
      "a failure never establishes a session",
    );
  }
});

await test("the proxy exchanges a verifier only when one is present", async () => {
  const edge = proxyBackend();
  await edge.proxy(new NextRequest("http://localhost:3000/sign-in"));
  assert.equal(edge.calls, 0, "a plain sign-in visit is not a callback");
  const response = await edge.proxy(new NextRequest("http://localhost:3000/"));
  assert.equal(
    response.headers.get("location"),
    "http://localhost:3000/sign-in?denied=1",
    "an unauthenticated page request is still denied",
  );
});

await test("local development serves the sign-in page instead of redirecting home", async () => {
  const edge = proxyBackend();
  edge.local = true;
  for (const path of ["/sign-in", "/"]) {
    const response = await edge.proxy(new NextRequest(`http://localhost:3000${path}`));
    assert.equal(response.headers.has("location"), false, path);
  }
});

// ----------------------------------------------------------------- lib/auth.ts

function accessBackend() {
  const state = { calls: 0, env: { NODE_ENV: "development" } };
  const access = load("lib/auth.ts", {
    env: state.env,
    mocks: {
      "@neondatabase/auth/next/server": {
        createNeonAuth: () => ({
          handler: () => ({
            GET: async () => {
              state.calls++;
              return Response.json(null);
            },
          }),
        }),
      },
      "next/server": { NextRequest },
      "./allowed-user": { allowedUser: () => false },
    },
  });
  state.accessContext = access.accessContext;
  state.request = (host = "127.0.0.1:3000", urlHost = host) =>
    new NextRequest(`http://${urlHost}/api/evaluations`, { headers: { host } });
  return state;
}

await test("only a loopback development host skips authentication", async () => {
  const access = accessBackend();
  for (const host of ["127.0.0.1:3000", "localhost:3000"])
    assert.equal((await access.accessContext(access.request(host))).status, 200, host);
  assert.equal(access.calls, 0, "the bypass never asks the auth service");
  for (const host of ["evil.example:3000", "localhost:3001", "localhost.evil.example:3000"])
    assert.equal((await access.accessContext(access.request(host))).status, 401, host);
  assert.equal(
    (await access.accessContext(access.request("localhost:3000", "evil.example:3000"))).status,
    401,
    "a spoofed Host header cannot unlock a foreign URL",
  );
});

await test("the bypass never applies outside local development", async () => {
  const access = accessBackend();
  access.env.VERCEL = "1";
  assert.equal(
    (await access.accessContext(access.request())).status,
    401,
    "a deployment always authenticates",
  );
  delete access.env.VERCEL;
  for (const mode of ["production", "test", undefined]) {
    access.env.NODE_ENV = mode;
    assert.equal((await access.accessContext(access.request())).status, 401, String(mode));
  }
});

await test("a locally saved grade is attributed to the named reviewer", async () => {
  const access = accessBackend();
  // The default cannot be mistaken for a signed-in account.
  assert.equal((await access.accessContext(access.request())).actor, "Local development");
  access.env.DEV_REVIEWER = "reviewer@example.com";
  assert.equal((await access.accessContext(access.request())).actor, "reviewer@example.com");
  assert.equal(
    (await access.accessContext(access.request("evil.example:3000"))).actor,
    undefined,
    "naming a reviewer never grants access where the bypass does not apply",
  );
});

await test("initial evaluations load reads summaries and validator together", async () => {
  const api = apiBackend();
  const response = await api.request("evaluations", undefined, {}, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"test-version"');
  assert.equal(api.historyReads, 1);
  assert.equal(api.versionReads, 0, "no serial version query before the initial data read");
  const cached = await api.request(
    "evaluations",
    undefined,
    { "if-none-match": '"test-version"' },
    "GET",
  );
  assert.equal(cached.status, 304);
  assert.equal(api.historyReads, 1, "a cache hit reads only versions");
  assert.equal(api.versionReads, 1);
  const changed = await api.request(
    "evaluations",
    undefined,
    { "if-none-match": '"old-version"' },
    "GET",
  );
  assert.equal(changed.status, 200);
  assert.equal(api.calls, 2, "a changed version reloads the data");
  api.access = 401;
  assert.equal((await api.request("evaluations", undefined, {}, "GET")).status, 401);
  assert.equal(api.calls, 2, "authentication still precedes the data read");
});

await test("an initial saved evaluation uses the document version without a separate query", async () => {
  const api = apiBackend();
  const response = await api.request("evaluation", undefined, {}, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"test-version"');
  assert.equal(api.calls, 1);
  assert.equal(api.versionReads, 0);
});

await test("only the verified owner can read telemetry; responses cannot be cached", async () => {
  let access = { status: 401 };
  let reads = 0;
  const routes = load("app/api/telemetry/route.ts", { mocks: {
    "/auth": { accessContext: async () => access },
    "/cloud-evaluations": { sql: async () => { reads++; return []; } },
    "next/server": { NextResponse: Response },
  }});
  const request = new NextRequest("https://example.com/api/telemetry");
  for (const denied of [{ status: 401 }, { status: 403 }, { status: 503 }, { status: 200, actor: "reviewer@parallel.ai" }, { status: 200, actor: "Local development" }]) {
    access = denied;
    const result = await routes.GET(request);
    assert.equal(result.status, denied.status === 200 ? 403 : denied.status);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.equal(reads, 0);
  access = { status: 200, actor: "eas.vone@gmail.com" };
  assert.equal((await routes.GET(request)).status, 200);
  assert.equal(reads, 1);
});

await test("telemetry stores only fixed event fields and hashes session IDs; failures are nonfatal", async () => {
  const calls = [];
  let fail = false;
  const env = { VERCEL: "1" };
  const { recordActivity } = load("lib/telemetry.ts", { env, mocks: {
    "/cloud-evaluations": { sql: async (query, params) => { if (fail) throw new Error("database failed"); calls.push({ query, params }); } },
  }});
  await recordActivity("sign_in_succeeded", "internal-user", "private-session-id");
  await recordActivity("sign_in_succeeded", "internal-user", "private-session-id");
  assert.equal(calls[0].params[0], calls[1].params[0]);
  assert.match(calls[0].query, /ON CONFLICT \(id\) DO NOTHING/);
  assert.deepEqual(calls[0].params.slice(1), ["sign_in_succeeded", "internal-user"]);
  assert.ok(!JSON.stringify(calls).includes("private-session-id"));
  await recordActivity("sign_in_started");
  assert.equal(calls.at(-1).params[2], null);
  fail = true;
  await assert.doesNotReject(recordActivity("grade_saved", "internal-user"));
  delete env.VERCEL;
  await recordActivity("workspace_opened", "internal-user");
  assert.equal(calls.length, 3);
});

await test("verified sessions log internal identity; denied accounts do not log success", async () => {
  const events = [];
  let allowed = true;
  const { accessContext } = load("lib/auth.ts", { env: { VERCEL: "1" }, mocks: {
    "@neondatabase/auth/next/server": { createNeonAuth: () => ({ handler: () => ({ GET: async () => Response.json({ session: { id: "session-1" }, user: { id: "user-1", email: "reviewer@parallel.ai", emailVerified: true } }) }) }) },
    "next/server": { NextRequest },
    "./allowed-user": { allowedUser: () => allowed },
    "/telemetry": { recordActivity: async (...args) => events.push(args) },
  }});
  const request = new NextRequest("https://example.com/");
  assert.equal((await accessContext(request)).status, 200);
  assert.deepEqual(events, [["sign_in_succeeded", "user-1", "session-1"]]);
  allowed = false;
  assert.equal((await accessContext(request)).status, 403);
  assert.equal(events.length, 1);
});
