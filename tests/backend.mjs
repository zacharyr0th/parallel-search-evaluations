// Exercises every exported backend function against a scripted database and provider.
// No network, no Parallel credits, no writes to the real evaluations database.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { load } from "./load.mjs";
import { test } from "node:test";

// ---------------------------------------------------------------- fixtures

const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const graded = (id, rank, relevance = null, extra = {}) => ({
  id,
  rank,
  url: `https://example.com/${id}`,
  title: `Result ${id}`,
  excerpts: ["excerpt"],
  publish_date: null,
  judgment: null,
  relevance,
  issues: [],
  rubric_version: "relevance-v1",
  notes: "",
  version: 0,
  updated_at: null,
  ...extra,
});
const legacy = (id, rank, judgment = null) => {
  const result = graded(id, rank);
  delete result.relevance;
  delete result.issues;
  delete result.rubric_version;
  return { ...result, judgment };
};
const run = (mode, results, extra = {}) => ({
  id: `run-${mode}`,
  mode,
  status: "completed",
  elapsed: 1.5,
  error: null,
  results,
  request: { search_queries: ["q"], mode, max_chars_total: 12000 },
  ...extra,
});
const evaluation = (runs, extra = {}) => ({
  id: uuid(1),
  query: "q",
  criteria: "",
  created_at: "2026-01-01T00:00:00.000Z",
  rubric: "r",
  blind: false,
  revealed_at: null,
  feedback_history: [],
  activity_history: [],
  runs,
  ...extra,
});

// `sql()` lives inside cloud-evaluations and talks to Neon over HTTP, so the database
// is scripted at the fetch layer. The same mock also answers the Parallel Search API.
function database() {
  const calls = [];
  let handler = () => [];
  return {
    calls,
    on(fn) {
      handler = fn;
    },
    // Reads join evaluation_feedback with the legacy in-document trail. Tests that only
    // script the document supply history here instead of repeating the union query.
    history: [],
    // Returns the rows for one Neon /sql request.
    answer(query, params) {
      calls.push({ query: query.replace(/\s+/g, " ").trim(), params });
      if (query.includes("FROM evaluation_feedback"))
        return this.history.map((event) => ({ event }));
      return handler(query, params) ?? [];
    },
  };
}

function backend({ env = {}, search, db } = {}) {
  const store = db || database();
  let counter = 0;
  const provider = [].concat(search || []);
  let call = 0;
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/sql")) {
      const { query, params } = JSON.parse(options.body);
      let rows;
      try {
        rows = store.answer(query, params);
      } catch (error) {
        if (error.databaseFailure) return { ok: false, status: 500, json: async () => ({}) };
        throw error;
      }
      return { ok: true, status: 200, json: async () => ({ rows }) };
    }
    if (String(url).startsWith("https://api.parallel.ai/")) {
      backend.lastSearch = { url, options };
      const next = provider[Math.min(call++, provider.length - 1)];
      if (next === undefined) throw new Error("unscripted provider call");
      if (next instanceof Error) throw next;
      return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const loaded = load("lib/cloud-evaluations.ts", {
    env: {
      PARALLEL_API_KEY: "test-key",
      DATABASE_URL: "postgres://user:pw@db.example.com/neondb",
      ...env,
    },
    builtins: {
      "node:crypto": { createHash, randomUUID: () => uuid(++counter), randomInt: () => 0 },
    },
    globals: { fetch: fetchImpl },
  });
  return { ...loaded, store, providerCalls: () => call };
}

// ------------------------------------------------------------ lib/scoring.ts

const scoring = load("lib/scoring.ts");
const agreementBoundary = (relevance) => scoring.meetsNeed({ relevance });

await test("scoring.reviewed distinguishes graded, cleared and unrated", () => {
  assert.equal(scoring.reviewed({ relevance: 0 }), true, '0 is a real grade, not "unrated"');
  assert.equal(scoring.reviewed({ relevance: 3 }), true);
  assert.equal(scoring.reviewed({ relevance: null }), false);
  assert.equal(scoring.reviewed({}), false, "a result with no grade field is unrated");
});

await test("scoring.ratingLabel and ratingFilter cover every state", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((relevance) => scoring.ratingLabel({ relevance })),
    ["0 — Irrelevant", "1 — Slightly relevant", "2 — Mostly relevant", "3 — Fully relevant"],
  );
  assert.equal(scoring.ratingLabel({ relevance: null }), "Unrated");
  assert.equal(scoring.ratingLabel({}), "Unrated");
  assert.equal(scoring.ratingFilter({ relevance: 0 }), "0");
  assert.equal(scoring.ratingFilter({ relevance: null }), "unrated");
  assert.equal(scoring.ratingFilter({}), "unrated");
});

await test("scoring.meetsNeed answers the binary question from the grade", () => {
  assert.equal(agreementBoundary(0), false, "0 does not help");
  assert.equal(agreementBoundary(1), false, "1 offers little useful information");
  assert.equal(agreementBoundary(2), true, "2 is useful despite missing a requirement");
  assert.equal(agreementBoundary(3), true, "3 meets the need outright");
  assert.equal(
    scoring.meetsNeed({ relevance: null }),
    null,
    "an ungraded result has no answer yet",
  );
  assert.equal(scoring.meetsNeed({}), null);
  assert.deepEqual(
    [0, 1, 2, 3, null].map((relevance) => scoring.meetsNeedLabel({ relevance })),
    [
      "Does not meet the need",
      "Does not meet the need",
      "Meets the need",
      "Meets the need",
      "Not yet judged",
    ],
  );
});

await test("useful_at_5 counts exactly the results that meet the need", () => {
  const of = (values) => scoring.relevanceMetrics(values.map((relevance) => ({ relevance })));
  assert.equal(of([3, 2, 1, 0, 2]).useful_at_5, 0.6);
  const top = [3, 2, 1, 0, 2];
  assert.equal(
    of(top).useful_at_5 * 5,
    top.filter((v) => scoring.meetsNeed({ relevance: v })).length,
    "the metric and the per-result answer cannot disagree",
  );
});

await test("scoring.validateRating accepts the rubric range and rejects everything else", () => {
  for (const relevance of [0, 1, 2, 3, null]) scoring.validateRating({ relevance, issues: [] });
  for (const relevance of [-1, 4, 1.5, "2", NaN, Infinity, true, undefined])
    assert.throws(
      () => scoring.validateRating({ relevance, issues: [] }),
      /relevance score/,
      `relevance=${String(relevance)}`,
    );
  scoring.validateRating({ relevance: 1, issues: ["Outdated", "Duplicate"] });
  assert.throws(
    () => scoring.validateRating({ relevance: 1, issues: ["Outdated", "Outdated"] }),
    /unique/,
  );
  assert.throws(() => scoring.validateRating({ relevance: 1, issues: ["Made up"] }), /valid/);
  assert.throws(() => scoring.validateRating({ relevance: 1, issues: "Outdated" }), /valid/);
  assert.throws(() => scoring.validateRating({ relevance: 1 }), /valid/);
  assert.throws(
    () => scoring.validateRating({ relevance: 1, issues: [...scoring.issueTags, "Outdated"] }),
    /valid/,
  );
});

await test("scoring.relevanceMetrics computes graded aggregates", () => {
  const m = scoring.relevanceMetrics([
    { relevance: 3 },
    { relevance: 2 },
    { relevance: 1 },
    { relevance: 0 },
    { relevance: 2 },
  ]);
  assert.equal(m.graded, 5);
  assert.equal(m.mean_relevance, 1.6);
  assert.equal(m.useful_at_5, 0.6);
  assert.equal(scoring.relevanceMetrics([]).mean_relevance, null);
  assert.equal(scoring.relevanceMetrics([]).rank_score_at_5, null);
  assert.equal(
    scoring.relevanceMetrics([{ relevance: 3 }]).rank_score_at_5,
    null,
    "fewer than five graded results cannot score",
  );
  assert.equal(scoring.relevanceMetrics([{ relevance: null }]).graded, 0);
});

await test("scoring.rank_score_at_5 is bounded, rank-weighted and gain-weighted", () => {
  const of = (values) =>
    scoring.relevanceMetrics(values.map((relevance) => ({ relevance }))).rank_score_at_5;
  assert.equal(of([3, 3, 3, 3, 3]), 100);
  assert.equal(of([0, 0, 0, 0, 0]), 0);
  assert.ok(of([3, 0, 0, 0, 0]) > of([0, 0, 0, 0, 3]), "earlier relevance is worth more");
  assert.ok(of([3, 3, 0, 0, 0]) > of([2, 2, 2, 2, 2]), "gain is exponential in the grade");
  assert.equal(of([3, 3, 3, 3, 3, 0, 0]), 100, "only the top five count");
  for (const values of [
    [0, 1, 2, 3, 3],
    [1, 1, 1, 1, 1],
    [2, 0, 3, 1, 2],
  ]) {
    const score = of(values);
    assert.ok(score >= 0 && score <= 100, `${values} scored ${score}`);
  }
});

// ------------------------------------------------------- lib/allowed-user.ts

const access = load("lib/allowed-user.ts");

await test("allowedEmail admits parallel.ai and the owner only", () => {
  for (const email of [
    "reviewer@parallel.ai",
    "REVIEWER@Parallel.AI",
    "eas.vone@gmail.com",
    "EAS.VONE@GMAIL.COM",
  ])
    assert.equal(access.allowedEmail(email), true, email);
  for (const email of [
    "reviewer@parallel.ai.evil.com",
    "reviewer@notparallel.ai",
    "reviewer@sub.parallel.ai",
    "a b@parallel.ai",
    "reviewer@parallel_ai",
    "@parallel.ai",
    "eas.vone+x@gmail.com",
    "",
    null,
    undefined,
    42,
    {},
  ])
    assert.equal(access.allowedEmail(email), false, String(email));
});

await test("allowedUser requires a verified address", () => {
  assert.equal(access.allowedUser({ email: "reviewer@parallel.ai", emailVerified: true }), true);
  assert.equal(access.allowedUser({ email: "reviewer@parallel.ai", emailVerified: false }), false);
  assert.equal(access.allowedUser({ email: "reviewer@parallel.ai", emailVerified: "true" }), false);
  assert.equal(access.allowedUser({ email: "reviewer@parallel.ai" }), false);
  assert.equal(access.allowedUser(null), false);
  assert.equal(access.allowedUser(undefined), false);
});

// ------------------------------------------------------ lib/search-request.ts

const search = load("lib/search-request.ts");
const baseRequest = () => ({ search_queries: ["climate policy"], max_chars_total: 12000 });

await test("validateSearchRequest accepts a minimal and a fully populated request", () => {
  search.validateSearchRequest(baseRequest(), ["fast"]);
  search.validateSearchRequest(
    {
      search_queries: ["a", "b"],
      objective: "find sources",
      max_chars_total: 5000,
      session_id: "s",
      client_model: "m",
      advanced_settings: {
        max_results: 10,
        location: "us",
        excerpt_settings: { max_chars_per_result: 500 },
        source_policy: {
          include_domains: ["example.com"],
          exclude_domains: [],
          after_date: "2024-01-01",
        },
        fetch_policy: { max_age_seconds: 600, timeout_seconds: 30, disable_cache_fallback: true },
      },
    },
    ["advanced"],
  );
});

await test("validateSearchRequest enforces query count and length", () => {
  assert.throws(() => search.validateSearchRequest({ search_queries: [] }, []), /1–5 queries/);
  assert.throws(
    () => search.validateSearchRequest({ search_queries: ["a", "b", "c", "d", "e", "f"] }, []),
    /1–5 queries/,
  );
  assert.throws(() => search.validateSearchRequest({ search_queries: ["   "] }, []), /1–5 queries/);
  assert.throws(
    () => search.validateSearchRequest({ search_queries: ["x".repeat(201)] }, []),
    /200 characters|maximum/i,
  );
  search.validateSearchRequest({ search_queries: ["x".repeat(200)] }, []);
  search.validateSearchRequest({ search_queries: ["🙂".repeat(200)] }, [], false);
});

await test("validateSearchRequest rejects unknown fields and wrong types", () => {
  assert.throws(
    () => search.validateSearchRequest({ ...baseRequest(), surprise: 1 }, []),
    /unsupported field/,
  );
  assert.throws(
    () => search.validateSearchRequest({ ...baseRequest(), advanced_settings: { nope: 1 } }, []),
    /unsupported field/,
  );
  assert.throws(
    () => search.validateSearchRequest({ search_queries: "one" }, []),
    /expected array/,
  );
  assert.throws(() => search.validateSearchRequest({ search_queries: [1] }, []), /expected string/);
  assert.throws(() => search.validateSearchRequest({}, []), /required/);
  assert.throws(() => search.validateSearchRequest(null, []), /expected object/);
  assert.throws(() => search.validateSearchRequest([], []), /expected object/);
  assert.throws(
    () => search.validateSearchRequest({ ...baseRequest(), mode: "lightning" }, []),
    /unsupported value/,
  );
});

await test("validateSearchRequest enforces numeric floors", () => {
  for (const patch of [{ max_chars_total: 0 }, { max_chars_total: -1 }])
    assert.throws(
      () => search.validateSearchRequest({ ...baseRequest(), ...patch }, []),
      /greater than zero/,
    );
  for (const advanced of [
    { max_results: 0 },
    { excerpt_settings: { max_chars_per_result: 0 } },
    { fetch_policy: { timeout_seconds: 0 } },
  ])
    assert.throws(
      () => search.validateSearchRequest({ ...baseRequest(), advanced_settings: advanced }, []),
      /greater than zero/,
    );
  assert.throws(
    () =>
      search.validateSearchRequest(
        { ...baseRequest(), advanced_settings: { fetch_policy: { max_age_seconds: 599 } } },
        [],
      ),
    /at least 600/,
  );
  search.validateSearchRequest(
    { ...baseRequest(), advanced_settings: { fetch_policy: { max_age_seconds: 600 } } },
    [],
  );
});

await test("validateSearchRequest checks locations, dates and source entries", () => {
  search.validateSearchRequest({ ...baseRequest(), advanced_settings: { location: "US" } }, []);
  assert.throws(
    () =>
      search.validateSearchRequest({ ...baseRequest(), advanced_settings: { location: "zz" } }, []),
    /supported country/,
  );
  const source = (policy) => ({ ...baseRequest(), advanced_settings: { source_policy: policy } });
  assert.throws(
    () => search.validateSearchRequest(source({ after_date: "2024-13-01" }), []),
    /valid publication date/,
  );
  assert.throws(
    () => search.validateSearchRequest(source({ after_date: "2024-02-30" }), []),
    /valid publication date/,
  );
  assert.throws(
    () => search.validateSearchRequest(source({ after_date: "01-01-2024" }), []),
    /valid publication date/,
  );
  search.validateSearchRequest(source({ after_date: "2024-02-29" }), []);
  for (const domain of [
    "https://example.com",
    "exa mple.com",
    "example.com?q=1",
    "ex*mple.com",
    "example.com#a",
    "user@example.com",
    "example.com:443",
    ".",
  ])
    assert.throws(
      () => search.validateSearchRequest(source({ include_domains: [domain] }), []),
      /Source entries/,
      domain,
    );
  search.validateSearchRequest(
    source({ include_domains: ["example.com", ".example.com", "example.com/docs"] }),
    ["fast"],
  );
  assert.throws(
    () =>
      search.validateSearchRequest(source({ include_domains: ["example.com/docs"] }), ["turbo"]),
    /Turbo does not support source paths/,
  );
  assert.throws(
    () =>
      search.validateSearchRequest(
        source({ include_domains: Array.from({ length: 201 }, (_, i) => `d${i}.com`) }),
        [],
      ),
    /no more than 200/,
  );
});

await test("validateSearchRequest enforces the blinded-review result floor", () => {
  assert.throws(
    () =>
      search.validateSearchRequest(
        { ...baseRequest(), advanced_settings: { max_results: 4 } },
        ["fast"],
        true,
      ),
    /at least five/,
  );
  search.validateSearchRequest(
    { ...baseRequest(), advanced_settings: { max_results: 5 } },
    ["fast"],
    true,
  );
  search.validateSearchRequest(
    { ...baseRequest(), advanced_settings: { max_results: 4 } },
    ["fast"],
    false,
  );
});

await test("prepareSearchRequest trims without mutating the input", () => {
  const input = {
    search_queries: ["  a  "],
    advanced_settings: {
      source_policy: { include_domains: [" x.com ", "  "], exclude_domains: [" y.com"] },
    },
  };
  const output = search.prepareSearchRequest(input);
  assert.deepEqual(output.search_queries, ["a"]);
  assert.deepEqual(output.advanced_settings.source_policy.include_domains, ["x.com"]);
  assert.deepEqual(output.advanced_settings.source_policy.exclude_domains, ["y.com"]);
  assert.deepEqual(input.search_queries, ["  a  "], "input is untouched");
});

await test("comparisonRequests shares queries and objective across both sides", () => {
  const shared = { search_queries: [" q "], objective: "obj", max_chars_total: 100 };
  const second = { search_queries: ["different"], objective: "other", max_chars_total: 200 };
  const [a, b] = search.comparisonRequests(shared, second, ["turbo", "advanced"]);
  assert.equal(a.mode, "turbo");
  assert.equal(b.mode, "advanced");
  assert.deepEqual(a.search_queries, ["q"]);
  assert.deepEqual(b.search_queries, ["q"]);
  assert.equal(b.objective, "obj", "the second side cannot diverge on objective");
  assert.equal(b.max_chars_total, 200, "other settings may differ");
  const [x, y] = search.comparisonRequests(shared, null, ["fast", "basic"]);
  assert.equal(x.max_chars_total, y.max_chars_total);
});

await test("settingsDifferences reports changed keys and ignores mode", () => {
  assert.deepEqual(
    search.settingsDifferences(
      { search_queries: ["a"], mode: "fast" },
      { search_queries: ["a"], mode: "turbo" },
    ),
    [],
  );
  assert.deepEqual(
    search.settingsDifferences(
      { search_queries: ["a"], max_chars_total: 1 },
      { search_queries: ["a"], max_chars_total: 2 },
    ),
    ["max_chars_total"],
  );
  assert.deepEqual(
    search.settingsDifferences(
      { search_queries: ["a"], advanced_settings: { max_results: 5 } },
      { search_queries: ["a"], advanced_settings: { max_results: 9 } },
    ),
    ["advanced_settings.max_results"],
  );
  assert.deepEqual(
    search.settingsDifferences({ search_queries: ["a"] }, { search_queries: ["a"] }),
    [],
  );
});

// --------------------------------------------------- lib/evaluations.ts

const summary = load("lib/evaluations.ts").evaluationSummary;

await test("evaluationSummary reports review status through its whole lifecycle", () => {
  assert.equal(summary(evaluation([run("fast", [])])).review_status, "No results");
  assert.equal(summary(evaluation([run("fast", [graded(1, 1)])])).review_status, "Not started");
  assert.equal(
    summary(evaluation([run("fast", [graded(1, 1, 2), graded(2, 2)])])).review_status,
    "In progress",
  );
  assert.equal(summary(evaluation([run("fast", [graded(1, 1, 2)])])).review_status, "Complete");
  assert.equal(
    summary(evaluation([run("fast", [], { status: "running" })])).review_status,
    "Searching",
  );
  assert.equal(
    summary(evaluation([run("fast", [], { status: "failed", error: "boom" })])).review_status,
    "Search failed",
  );
});

await test("evaluationSummary counts a zero grade as reviewed", () => {
  const s = summary(evaluation([run("fast", [graded(1, 1, 0)])]));
  assert.equal(s.reviewed, 1);
  assert.equal(s.review_status, "Complete");
});

await test("evaluationSummary decides a graded comparison by rank score", () => {
  const strong = [3, 3, 3, 3, 3].map((r, i) => graded(i + 1, i + 1, r));
  const weak = [0, 0, 0, 0, 0].map((r, i) => graded(i + 10, i + 1, r));
  const s = summary(evaluation([run("advanced", strong), run("turbo", weak)]));
  assert.equal(s.outcome.winner, "A");
  assert.match(s.outcome.title, /Advanced performed better/);
  assert.match(s.outcome.detail, /Rank-weighted top 5/);
  const tie = summary(
    evaluation([
      run("advanced", strong),
      run(
        "turbo",
        strong.map((r) => ({ ...r, id: r.id + 100 })),
      ),
    ]),
  );
  assert.equal(tie.outcome.winner, null);
  assert.equal(tie.outcome.title, "Tie");
});

await test("evaluationSummary withholds a verdict until both sides are fully graded", () => {
  const full = [3, 3, 3, 3, 3].map((r, i) => graded(i + 1, i + 1, r));
  const partial = [3, 3, 3, 3, null].map((r, i) => graded(i + 10, i + 1, r));
  const s = summary(evaluation([run("advanced", full), run("turbo", partial)]));
  assert.equal(s.outcome.winner, null);
  assert.equal(s.outcome.title, "Not decided");
  const short = summary(evaluation([run("advanced", full), run("turbo", full.slice(0, 4))]));
  assert.equal(short.outcome.winner, null, "fewer than five results on one side cannot decide");
});

await test("evaluationSummary hides modes and settings during an unrevealed blind review", () => {
  const results = [3, 3, 3, 3, 3].map((r, i) => graded(i + 1, i + 1, r));
  const blind = evaluation(
    [
      run("advanced", results),
      run(
        "turbo",
        results.map((r) => ({ ...r, id: r.id + 100 })),
      ),
    ],
    { blind: true, revealed_at: null },
  );
  const s = summary(blind);
  assert.deepEqual(
    s.configurations.map((c) => c.mode),
    [null, null],
  );
  assert.deepEqual(
    s.configurations.map((c) => c.settings),
    [null, null],
  );
  assert.equal(s.sharedSettings, null);
  assert.equal(s.outcome.winner, null, "no verdict before the reveal");
  const revealed = summary({ ...blind, revealed_at: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(
    revealed.configurations.map((c) => c.mode),
    ["advanced", "turbo"],
  );
  assert.equal(revealed.outcome.winner, null, "an exact tie stays a tie after the reveal");
});

await test("evaluationSummary caps a blind review at five results per side", () => {
  const ten = Array.from({ length: 10 }, (_, i) => graded(i + 1, i + 1, 3));
  const s = summary(
    evaluation(
      [
        run("advanced", ten),
        run(
          "turbo",
          ten.map((r) => ({ ...r, id: r.id + 100 })),
        ),
      ],
      { blind: true },
    ),
  );
  assert.equal(s.total, 10, "five per side, not ten");
  assert.deepEqual(
    s.configurations.map((c) => c.total),
    [5, 5],
  );
});

await test("evaluationSummary flags a blind review with too few results", () => {
  const four = Array.from({ length: 4 }, (_, i) => graded(i + 1, i + 1, 3));
  const s = summary(
    evaluation(
      [
        run("advanced", four),
        run(
          "turbo",
          four.map((r) => ({ ...r, id: r.id + 100 })),
        ),
      ],
      { blind: true },
    ),
  );
  assert.equal(s.review_status, "Insufficient results");
});

await test("evaluationSummary separates shared settings from per-side settings", () => {
  const a = run("turbo", [], {
    request: {
      search_queries: ["q"],
      max_chars_total: 9000,
      advanced_settings: { max_results: 5 },
    },
  });
  const b = run("advanced", [], {
    request: {
      search_queries: ["q"],
      max_chars_total: 9000,
      advanced_settings: { max_results: 20 },
    },
  });
  const s = summary(evaluation([a, b]));
  assert.match(s.sharedSettings, /Total characters: 9000/);
  assert.ok(!s.sharedSettings.includes("Maximum results"), "a differing key is not shared");
  assert.match(s.configurations[0].settings, /Maximum results: 5/);
  assert.match(s.configurations[1].settings, /Maximum results: 20/);
});

await test("evaluationSummary attributes reviewers and falls back to feedback history", () => {
  const withActor = graded(1, 1, 3, { actor: "a@parallel.ai", version: 1 });
  const withoutActor = graded(2, 2, 3, { version: 4 });
  const s = summary(
    evaluation([run("fast", [withActor, withoutActor])], {
      feedback_history: [{ result_id: 2, version: 4, actor: "b@parallel.ai" }],
    }),
  );
  assert.deepEqual(
    s.reviewers.sort((x, y) => x.actor.localeCompare(y.actor)),
    [
      { actor: "a@parallel.ai", count: 1 },
      { actor: "b@parallel.ai", count: 1 },
    ],
  );
  const unknown = summary(evaluation([run("fast", [graded(3, 1, 3)])]));
  assert.deepEqual(unknown.reviewers, [{ actor: "Unknown reviewer", count: 1 }]);
});

await test("evaluationSummary explains why a comparison is not decided", () => {
  const full = [3, 3, 3, 3, 3].map((r, i) => graded(i + 1, i + 1, r));
  const partial = [3, 3, null, null, null].map((r, i) => graded(i + 10, i + 1, r));
  assert.match(
    summary(evaluation([run("advanced", full), run("turbo", partial)])).outcome.detail,
    /Grade 3 more top-five results/,
  );
  assert.match(
    summary(evaluation([run("advanced", full), run("turbo", full.slice(0, 4))])).outcome.detail,
    /needs five results/,
  );
  assert.match(
    summary(evaluation([run("advanced", full), run("turbo", full, { status: "failed" })])).outcome
      .detail,
    /Both searches must return results/,
  );
});

await test("evaluationSummary handles a single run and a missing request", () => {
  const s = summary(evaluation([run("fast", [graded(1, 1, 3)], { request: null })]));
  assert.equal(s.outcome.title, "No comparison");
  assert.equal(s.outcome.winner, null);
  assert.equal(s.configurations[0].settings, "Settings not recorded");
});

// ------------------------------------------------------- lib/evaluations.ts

const client = load("lib/evaluations.ts");

await test("evaluations.safeURL admits only http and https", () => {
  assert.equal(client.safeURL("https://example.com/a").href, "https://example.com/a");
  assert.equal(client.safeURL("http://example.com").hostname, "example.com");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "not a url",
    "",
  ])
    assert.equal(client.safeURL(value), null, value);
});

await test("evaluations.reviewerName maps the owner and leaves others alone", () => {
  assert.equal(client.reviewerName("eas.vone@gmail.com"), "Zachary Roth");
  assert.equal(client.reviewerName("EAS.VONE@GMAIL.COM"), "Zachary Roth");
  for (const value of ["reviewer@parallel.ai", "eas.vone+review@gmail.com", "Unknown reviewer"])
    assert.equal(client.reviewerName(value), value);
});

// ---------------------------------------------------- lib/share-evaluations.ts

const exports_ = load("lib/share-evaluations.ts");
const snapshot = () => ({
  id: uuid(1),
  query: "q",
  criteria: "c",
  rubric: "r",
  created_at: "2026-01-01T00:00:00.000Z",
  blind: false,
  revealed_at: null,
  feedback_history: [{ result_id: 1, version: 1, actor: "a@parallel.ai", relevance: 3 }],
  runs: [
    {
      ...run("fast", [graded(1, 1, 3, { version: 1, actor: "a@parallel.ai", notes: "ok" })]),
      label: "A",
      metrics: { precision_at_5: null },
    },
  ],
});

await test("exportRows flattens one row per result and carries grading fields", () => {
  const [row] = exports_.exportRows(snapshot());
  assert.equal(row.result_id, 1);
  assert.equal(row.relevance, 3);
  assert.equal(row.rubric_version, "relevance-v1");
  assert.equal(row.last_saved_by, "a@parallel.ai");
  assert.equal(row.mode, "fast");
  assert.equal(row.side, "A");
  assert.equal(row.feedback_history.length, 1);
});

await test("exportRows emits a placeholder row for a run with no results", () => {
  const data = snapshot();
  data.runs[0].results = [];
  const [row] = exports_.exportRows(data);
  assert.equal(row.result_id, undefined);
  assert.equal(row.relevance, null);
  assert.equal(row.run_status, "completed");
});

await test("exportRows labels a legacy result and tolerates malformed input", () => {
  const data = snapshot();
  data.runs[0].results = [legacy(1, 1, "correct")];
  assert.equal(exports_.exportRows(data)[0].rubric_version, "legacy-binary");
  assert.deepEqual(exports_.exportRows(null), []);
  assert.deepEqual(exports_.exportRows({ runs: "nope" }), []);
  assert.deepEqual(exports_.exportRows({ runs: [{ results: "nope" }] })[0].relevance, null);
});

await test("exports carry the binary answer alongside the grade", () => {
  const data = snapshot();
  data.runs[0].results = [
    graded(1, 1, 3),
    graded(2, 2, 2),
    graded(3, 3, 1),
    graded(4, 4, 0),
    graded(5, 5, null),
  ];
  const rows = exports_.exportRows(data);
  assert.deepEqual(
    rows.map((r) => r.meets_need),
    [true, true, false, false, null],
  );
  assert.deepEqual(
    rows.map((r) => r.relevance),
    [3, 2, 1, 0, null],
  );
  const csv = exports_.serializeExport(data, "csv").text;
  assert.match(csv.split("\r\n")[0], /meets_need/, "the column is named in the CSV header");
});

await test("serializeExport produces valid JSON, JSONL and CSV", () => {
  const json = exports_.serializeExport(snapshot(), "json");
  assert.equal(json.mime, "application/json;charset=utf-8");
  assert.equal(JSON.parse(json.text).id, uuid(1));
  assert.ok(JSON.parse(json.text).exported_at, "an export stamps its own time");
  const jsonl = exports_.serializeExport(snapshot(), "jsonl");
  const lines = jsonl.text.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).relevance, 3);
  const csv = exports_.serializeExport(snapshot(), "csv");
  assert.ok(csv.text.startsWith("﻿"), "CSV carries a BOM for spreadsheets");
  assert.ok(csv.text.includes("\r\n"));
  assert.equal(csv.text.trimEnd().split("\r\n").length, 2);
});

await test("serializeExport neutralizes spreadsheet formulas", () => {
  const data = snapshot();
  data.runs[0].results[0].notes = "=SUM(A1:A9)";
  data.runs[0].results[0].title = "@cmd";
  const csv = exports_.serializeExport(data, "csv").text;
  assert.ok(csv.includes(`"'=SUM(A1:A9)"`), "a leading = is quoted out");
  assert.ok(csv.includes(`"'@cmd"`));
  assert.ok(!exports_.serializeExport(data, "json").text.includes(`'=SUM`), "JSON stays lossless");
});

await test("serializeExport escapes embedded quotes and rejects bad input", () => {
  const data = snapshot();
  data.runs[0].results[0].notes = 'she said "yes", then left';
  assert.ok(exports_.serializeExport(data, "csv").text.includes('""yes""'));
  assert.throws(() => exports_.serializeExport({ id: "x" }, "json"), /Invalid export/);
  assert.throws(() => exports_.serializeExport(snapshot(), "xml"), /Unsupported export format/);
  assert.ok(
    exports_.serializeExport({ id: "x", runs: [] }, "csv").text.includes("session_id"),
    "an empty export still has a header",
  );
});

// ------------------------------------------------------ lib/share-evaluations.ts

const copy = load("lib/share-evaluations.ts");

await test("copy helpers render every supported format", () => {
  const data = snapshot();
  const result = data.runs[0].results[0];
  for (const format of ["markdown", "json", "text"]) {
    const text = copy.copyResult(result, format, data, data.runs[0]);
    assert.ok(typeof text === "string" && text.length > 0, `copyResult/${format}`);
    assert.ok(text.includes(result.url), `copyResult/${format} keeps the URL`);
  }
  for (const format of ["markdown", "json", "text"]) {
    assert.ok(
      copy.copyConfiguration(data, data.runs[0], format).length > 0,
      `copyConfiguration/${format}`,
    );
    assert.ok(copy.copyEvaluation(data, format).length > 0, `copyEvaluation/${format}`);
  }
  const asJSON = JSON.parse(copy.copyResult(result, "json", data, data.runs[0]));
  assert.equal(asJSON.result.relevance, 3);
  assert.equal(asJSON.configuration.mode, "fast");
});

// --------------------------------------------- lib/cloud-evaluations.ts: reads

await test("cloudAPI rejects an unknown operation", async () => {
  const api = backend();
  await assert.rejects(api.cloudAPI("drop-tables", null), /Not found/);
});

await test("cloudAPI.session returns a view with comparison metrics", async () => {
  const api = backend();
  const strong = [3, 3, 3, 3, 3].map((r, i) => graded(i + 1, i + 1, r));
  const weak = [0, 0, 0, 0, 0].map((r, i) => graded(i + 10, i + 1, r));
  const stored = evaluation([run("advanced", strong), run("turbo", weak)]);
  api.store.on(() => [{ data: stored, version: 3 }]);
  const view = await api.cloudAPI("evaluation", stored.id);
  assert.deepEqual(
    view.runs.map((r) => r.label),
    ["A", "B"],
  );
  assert.equal(view.comparison.top_k, 5);
  assert.equal(view.comparison.review_complete, true);
  assert.equal(view.comparison.shared_urls, 0);
  assert.equal(view.scoring.winner, "A");
  assert.equal(view.runs[0].metrics.graded, 5);
  assert.ok("feedback_history" in view, "a session view carries feedback history");
});

await test("cloudAPI.session counts exact URL overlap between modes", async () => {
  const api = backend();
  const shared = [1, 2, 3].map((i) => graded(i, i, 3));
  const other = shared.map((r) => ({ ...r, id: r.id + 100 }));
  other[2].url = "https://example.com/unique";
  api.store.on(() => [
    { data: evaluation([run("advanced", shared), run("turbo", other)]), version: 1 },
  ]);
  const view = await api.cloudAPI("evaluation", uuid(1));
  assert.equal(view.comparison.shared_urls, 2);
});

await test("cloudAPI.export stamps a time and keeps the full feedback history", async () => {
  const api = backend();
  const data = evaluation([run("fast", [graded(1, 1, 3, { version: 1 })])], {
    feedback_history: [{ result_id: 1, version: 1, actor: "a@parallel.ai", relevance: 3 }],
  });
  api.store.on(() => [{ data, version: 1 }]);
  api.store.history = [
    {
      result_id: 1,
      version: 1,
      actor: "a@parallel.ai",
      relevance: 3,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ];
  const view = await api.cloudAPI("export", data.id);
  assert.ok(view.exported_at, "an export is stamped");
  assert.equal(view.feedback_history.length, 1, "exports document the full audit trail");
  const reopened = await api.cloudAPI("evaluation", data.id);
  assert.equal(reopened.exported_at, undefined);
  assert.equal(reopened.feedback_history.length, 1);
});

await test("cloudAPI.evaluation hides modes and elapsed time before a blind reveal", async () => {
  const api = backend();
  const ten = Array.from({ length: 10 }, (_, i) => graded(i + 1, i + 1, 3));
  const data = evaluation(
    [
      run("advanced", ten),
      run(
        "turbo",
        ten.map((r) => ({ ...r, id: r.id + 100 })),
      ),
    ],
    { blind: true, revealed_at: null },
  );
  api.store.on(() => [{ data, version: 1 }]);
  const view = await api.cloudAPI("evaluation", data.id);
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["A", "B"],
    "the mode name is replaced by the side label",
  );
  assert.deepEqual(
    view.runs.map((r) => r.elapsed),
    [null, null],
  );
  assert.equal(view.comparison, null);
  assert.deepEqual(
    view.runs.map((r) => r.results.length),
    [5, 5],
    "only the reviewable window is sent",
  );
  assert.equal(view.runs[0].request, undefined, "the request would leak the mode");
});

await test("cloudAPI.session reveals modes after revealed_at is set", async () => {
  const api = backend();
  const five = Array.from({ length: 5 }, (_, i) => graded(i + 1, i + 1, 3));
  const data = evaluation(
    [
      run("advanced", five),
      run(
        "turbo",
        five.map((r) => ({ ...r, id: r.id + 100 })),
      ),
    ],
    { blind: true, revealed_at: "2026-01-02T00:00:00.000Z" },
  );
  api.store.on(() => [{ data, version: 1 }]);
  const view = await api.cloudAPI("evaluation", data.id);
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["advanced", "turbo"],
  );
  assert.ok(view.comparison);
});

await test("cloudAPI.session raises 404 for a missing evaluation", async () => {
  const api = backend();
  api.store.on(() => []);
  await assert.rejects(
    api.cloudAPI("evaluation", "nope"),
    (e) => e.status === 404 && /not found/i.test(e.message),
  );
});

await test("cloudAPI.sessions summarizes history rows", async () => {
  const api = backend();
  const data = evaluation([run("fast", [graded(1, 1, 3), graded(2, 2, null)])]);
  api.store.on(() => [{ data }]);
  const [row] = await api.cloudAPI("evaluations", null);
  assert.equal(row.id, data.id);
  assert.equal(row.modes, "fast");
  assert.equal(row.reviewed, 1);
  assert.equal(row.total, 2);
  assert.equal(row.review_status, "In progress");
});

await test("cloudAPI.sessions masks modes for an unrevealed blind review", async () => {
  const api = backend();
  const five = Array.from({ length: 5 }, (_, i) => graded(i + 1, i + 1, 3));
  api.store.on(() => [
    { data: evaluation([run("advanced", five), run("turbo", five)], { blind: true }) },
  ]);
  const [row] = await api.cloudAPI("evaluations", null);
  assert.equal(row.modes, "A,B");
});

await test("cloudAPI.sessions decodes a JSON string payload from the driver", async () => {
  const api = backend();
  api.store.on(() => [{ data: JSON.stringify(evaluation([run("fast", [graded(1, 1, 3)])])) }]);
  const [row] = await api.cloudAPI("evaluations", null);
  assert.equal(row.review_status, "Complete");
});

// ------------------------------------------ lib/cloud-evaluations.ts: feedback
//
// Storing a rating is one SQL statement whose correctness lives in Postgres (per-result
// version guards, the audit-trail inserts, the blind reveal). Those are covered end to end
// in tests/grading.mjs against a real database. What belongs here is the validation that
// rejects a request before it ever reaches the database.

function rejectingBackend() {
  const api = backend();
  api.store.on(() => {
    throw new Error("validation should reject before querying");
  });
  return api;
}

await test("feedback validates identifiers, grades and note length before querying", async () => {
  const api = rejectingBackend();
  const send = (patch) =>
    api.cloudAPI("feedback", null, {
      evaluation_id: uuid(1),
      result_id: 1,
      version: 0,
      relevance: 1,
      issues: [],
      ...patch,
    });
  await assert.rejects(send({ result_id: 1.5 }), /Invalid feedback/);
  await assert.rejects(send({ result_id: "1" }), /Invalid feedback/);
  await assert.rejects(send({ result_id: Number.MAX_VALUE }), /Invalid feedback/);
  await assert.rejects(send({ version: "0" }), /Invalid feedback/);
  await assert.rejects(send({ version: -1 }), /Invalid feedback/);
  await assert.rejects(send({ version: 1.5 }), /Invalid feedback/);
  await assert.rejects(send({ relevance: 9 }), /relevance score/);
  await assert.rejects(send({ relevance: 1.5 }), /relevance score/);
  await assert.rejects(send({ issues: ["nope"] }), /issue tags/);
  await assert.rejects(send({ issues: ["Outdated", "Outdated"] }), /issue tags/);
  await assert.rejects(send({ notes: "x".repeat(2001) }), /2000 characters/);
  await assert.rejects(send({ notes: 42 }), /characters/);
  await assert.rejects(send({ evaluation_id: "" }), /characters/);
  await assert.rejects(send({ evaluation_id: "x".repeat(101) }), /characters/);
  await assert.rejects(
    api.cloudAPI("feedback", null, { evaluation_id: uuid(1), result_id: 1, version: 0 }),
    /Invalid feedback/,
  );
  await assert.rejects(
    api.cloudAPI("feedback", null, {
      evaluation_id: uuid(1),
      result_id: 1,
      version: 0,
      judgment: "maybe",
    }),
    /Invalid feedback/,
  );
});

await test("feedback falls back to a containment lookup and reports a missing result", async () => {
  const api = backend();
  api.store.on((query) => (query.includes("data @>") ? [] : []));
  await assert.rejects(
    api.cloudAPI("feedback", null, { result_id: 1, version: 0, relevance: 1, issues: [] }),
    (e) => e.status === 404 && /Result not found/.test(e.message),
  );
  assert.ok(
    api.store.calls.some((c) => c.query.includes("data @>")),
    "the lookup runs when no evaluation id is supplied",
  );
});

// ------------------------------------------ lib/cloud-evaluations.ts: activity

await test("activity validates event shape and batch size", async () => {
  const api = backend();
  api.store.on(() => [{ ok: true }]);
  const send = (events) => api.cloudAPI("activity", null, { evaluation_id: uuid(1), events });
  await assert.rejects(send([]), /1–20 activity events/);
  await assert.rejects(
    send(Array.from({ length: 21 }, () => ({ id: uuid(2), action: "opened", target: "t" }))),
    /1–20 activity events/,
  );
  await assert.rejects(send("nope"), /1–20 activity events/);
  await assert.rejects(
    send([{ id: "not-a-uuid", action: "opened", target: "t" }]),
    /Invalid activity/,
  );
  await assert.rejects(send([{ id: uuid(2), action: "deleted", target: "t" }]), /Invalid activity/);
  await assert.rejects(send([{ id: uuid(2), action: "opened", target: "" }]), /characters/);
  await assert.rejects(
    send([{ id: uuid(2), action: "opened", target: "x".repeat(201) }]),
    /characters/,
  );
  await assert.rejects(send([null]), /Invalid activity/);
  assert.deepEqual(await send([{ id: uuid(2), action: "opened", target: "Result 1" }]), {
    saved: true,
  });
});

await test("activity reads merge the table and legacy in-document events", async () => {
  const api = backend();
  api.store.on(() => [
    {
      event: {
        id: uuid(2),
        actor: "a@parallel.ai",
        action: "opened",
        target: "t",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    },
    {
      event: {
        id: uuid(3),
        actor: "a@parallel.ai",
        action: "created",
        target: "Evaluation",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    },
  ]);
  const events = await api.cloudAPI("activity", uuid(1));
  assert.equal(events.length, 2);
  assert.equal(
    events[0].created_at,
    "2026-01-01T00:00:00.000Z",
    "events are returned oldest first",
  );
});

// -------------------------------------------- lib/cloud-evaluations.ts: search

// Postgres stores jsonb with object keys ordered by length, then bytewise — never in the order
// they were written. A plain JavaScript store hands objects back in insertion order, which is
// kinder than the real thing, so reads are reordered here to match what Postgres returns.
function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, jsonbOrder(item)]),
  );
}

function searchBackend({ responses, env, budget = [{ calls: 2 }] } = {}) {
  const store = database();
  const state = new Map();
  store.on((query, params) => {
    if (query.startsWith("INSERT INTO search_budget")) return budget;
    if (query.startsWith("SELECT 1 FROM evaluations")) return state.has(params[0]) ? [{}] : [];
    // The real insert is ON CONFLICT DO NOTHING, so a taken id returns no row.
    if (query.startsWith("INSERT INTO evaluations")) {
      if (state.has(params[0])) return [];
      state.set(params[0], JSON.parse(params[1]));
      return [{ id: params[0] }];
    }
    if (query.startsWith("UPDATE evaluations SET data=jsonb_set")) {
      const data = state.get(params[1]);
      if (!data) return [];
      const index = Number(params[2]);
      if (data.runs[index].id !== params[3] || data.runs[index].status !== "running") return [];
      data.runs[index] = JSON.parse(params[0]);
      return [{ id: params[1] }];
    }
    if (query.startsWith("SELECT data,version")) {
      const data = state.get(params[0]);
      return data ? [{ data: jsonbOrder(data), version: 1 }] : [];
    }
    return [];
  });
  const api = backend({ env, search: responses, db: store });
  return { api, store, state, fetches: api.providerCalls };
}

const providerResults = (n, prefix = "a") =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/${prefix}${i}`,
    title: `Title ${i}`,
    excerpts: ["snippet"],
    publish_date: null,
  }));

await test("search runs one mode and stores normalized results", async () => {
  const { api, state } = searchBackend({
    responses: [{ body: { search_id: "s1", results: providerResults(3) } }],
  });
  const view = await api.cloudAPI(
    "search",
    null,
    { query: "climate policy", modes: ["fast"] },
    "a@parallel.ai",
  );
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].status, "completed");
  assert.equal(view.runs[0].results.length, 3);
  assert.deepEqual(
    view.runs[0].results.map((r) => r.rank),
    [1, 2, 3],
  );
  assert.equal(
    view.runs[0].results[0].relevance,
    null,
    "new results start ungraded, not undefined",
  );
  assert.equal(view.runs[0].results[0].rubric_version, "relevance-v1");
  assert.ok(view.runs[0].elapsed >= 0);
  assert.equal(view.query, "climate policy");
  const stored = [...state.values()][0];
  assert.equal(stored.runs[0].response.search_id, "s1");
});

await test("search runs two modes and builds a comparison", async () => {
  const { api, fetches } = searchBackend({
    responses: [
      { body: { search_id: "s1", results: providerResults(5, "a") } },
      { body: { search_id: "s2", results: providerResults(5, "a") } },
    ],
  });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] });
  assert.equal(fetches(), 2);
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["turbo", "advanced"],
  );
  assert.equal(view.comparison.shared_urls, 5, "identical URLs overlap completely");
  assert.equal(view.comparison.review_complete, false);
});

await test("search keeps a completed mode when the other one fails", async () => {
  const { api } = searchBackend({
    responses: [
      { body: { search_id: "s1", results: providerResults(3) } },
      { ok: false, status: 500, body: {} },
    ],
  });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] });
  assert.equal(view.runs[0].status, "completed");
  assert.equal(view.runs[1].status, "failed");
  assert.match(view.runs[1].error, /HTTP 500/);
  assert.equal(view.runs[0].results.length, 3, "the good side survives");
});

await test("search records a transport failure as a failed run", async () => {
  const { api } = searchBackend({ responses: [new Error("socket hang up")] });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
  assert.equal(view.runs[0].status, "failed");
  assert.match(view.runs[0].error, /Search interrupted/);
});

await test("search rejects a malformed provider response", async () => {
  for (const body of [
    { results: [] },
    { search_id: "s", results: "nope" },
    { search_id: "s", results: [{ url: 1, excerpts: [] }] },
    { search_id: "s", results: [{ url: "https://e.com", excerpts: "no" }] },
    { search_id: "s", results: [{ url: "https://e.com", excerpts: [1] }] },
    { search_id: "s", results: [{ url: "https://e.com", excerpts: [], title: 5 }] },
  ]) {
    const { api } = searchBackend({ responses: [{ body }] });
    const view = await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
    assert.equal(view.runs[0].status, "failed", JSON.stringify(body));
    assert.match(view.runs[0].error, /Invalid Search response/);
  }
});

await test("search validates modes and blind preconditions", async () => {
  const make = () =>
    searchBackend({ responses: [{ body: { search_id: "s", results: providerResults(5) } }] }).api;
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: [] }),
    /one or two supported modes/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: ["turbo", "fast", "basic"] }),
    /one or two supported modes/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: ["lightning"] }),
    /one or two supported modes/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: "fast" }),
    /one or two supported modes/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: ["fast"], blind: true }),
    /Blind review requires two modes/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", modes: ["fast"], blind: "yes" }),
    /Blind review requires two modes/,
  );
});

await test("search validates the query and criteria", async () => {
  const make = () =>
    searchBackend({ responses: [{ body: { search_id: "s", results: providerResults(1) } }] }).api;
  await assert.rejects(
    make().cloudAPI("search", null, { query: "   ", modes: ["fast"] }),
    /characters/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "x".repeat(201), modes: ["fast"] }),
    /characters/,
  );
  await assert.rejects(
    make().cloudAPI("search", null, { query: "q", criteria: "x".repeat(2001), modes: ["fast"] }),
    /characters/,
  );
  await assert.rejects(make().cloudAPI("search", null, { modes: ["fast"] }), /characters/);
});

await test("a retried search reuses its idempotency key instead of searching twice", async () => {
  const { api, state, fetches } = searchBackend({
    responses: [{ body: { search_id: "s1", results: providerResults(3) } }],
  });
  const key = "11111111-1111-4111-8111-111111111111";
  const body = { idempotency_key: key, query: "climate policy", modes: ["fast"] };
  const first = await api.cloudAPI("search", null, body, "a@parallel.ai");
  assert.equal(first.id, key, "the key becomes the evaluation id");
  assert.equal(fetches(), 1);
  const replay = await api.cloudAPI("search", null, body, "a@parallel.ai");
  assert.equal(replay.id, key, "a replay returns the original evaluation");
  assert.equal(replay.runs[0].results.length, 3);
  assert.equal(fetches(), 1, "a replay never calls the Search API again");
  assert.equal(state.size, 1, "a replay creates no second evaluation");
  await assert.rejects(
    api.cloudAPI("search", null, { ...body, query: "a different question" }, "a@parallel.ai"),
    (e) => e.status === 409 && e.code === "idempotency_key_conflict",
  );
  assert.equal(fetches(), 1, "a conflicting reuse spends no credit either");
  await assert.rejects(
    api.cloudAPI("search", null, { ...body, idempotency_key: "not-a-uuid" }, "a@parallel.ai"),
    (e) => e.status === 400 && e.code === "invalid_idempotency_key",
  );
});

await test("a blinded search replays despite its shuffled run order", async () => {
  const responses = [
    { body: { search_id: "s1", results: providerResults(5) } },
    { body: { search_id: "s2", results: providerResults(5, "b") } },
  ];
  const { api, fetches } = searchBackend({ responses });
  const key = "22222222-2222-4222-8222-222222222222";
  const body = {
    idempotency_key: key,
    query: "climate policy",
    modes: ["turbo", "fast"],
    blind: true,
  };
  await api.cloudAPI("search", null, body, "a@parallel.ai");
  const calls = fetches();
  const replay = await api.cloudAPI("search", null, body, "a@parallel.ai");
  assert.equal(replay.id, key);
  assert.equal(fetches(), calls, "the stored run order does not break the replay check");
});

await test("search enforces the daily call budget", async () => {
  const { api, fetches } = searchBackend({
    responses: [{ body: { search_id: "s", results: [] } }],
    budget: [],
  });
  await assert.rejects(
    api.cloudAPI("search", null, { query: "q", modes: ["fast"] }),
    (e) => e.status === 429 && /Daily search limit/.test(e.message),
  );
  assert.equal(fetches(), 0, "no provider call is made once the budget is spent");
});

await test("search requires a configured provider key", async () => {
  const { api, fetches } = searchBackend({
    responses: [{ body: {} }],
    env: { PARALLEL_API_KEY: "" },
  });
  await assert.rejects(
    api.cloudAPI("search", null, { query: "q", modes: ["fast"] }),
    (e) => e.status === 503,
  );
  assert.equal(fetches(), 0);
});

await test("search accepts per-configuration requests that share query and objective", async () => {
  const { api, state } = searchBackend({
    responses: [
      { body: { search_id: "s1", results: providerResults(2) } },
      { body: { search_id: "s2", results: providerResults(2) } },
    ],
  });
  const shared = { search_queries: ["q"], objective: "obj", max_chars_total: 12000 };
  const view = await api.cloudAPI("search", null, {
    modes: ["turbo", "advanced"],
    search_request: shared,
    requests: [
      { ...shared, mode: "turbo", max_chars_total: 5000 },
      { ...shared, mode: "advanced", max_chars_total: 9000 },
    ],
  });
  assert.equal(view.runs.length, 2);
  const stored = [...state.values()][0];
  assert.equal(stored.runs[0].request.max_chars_total, 5000);
  assert.equal(stored.runs[1].request.max_chars_total, 9000);
});

await test("search rejects per-configuration requests that diverge or mismatch", async () => {
  const shared = { search_queries: ["q"], objective: "obj" };
  const send = (requests, modes = ["turbo", "advanced"]) =>
    searchBackend({
      responses: [{ body: { search_id: "s", results: [] } }],
    }).api.cloudAPI("search", null, { modes, search_request: shared, requests });
  await assert.rejects(send([{ ...shared, mode: "turbo" }]), /one request per configuration/);
  await assert.rejects(
    send([
      { ...shared, mode: "advanced" },
      { ...shared, mode: "turbo" },
    ]),
    /match the selected modes/,
  );
  await assert.rejects(
    send([
      { ...shared, mode: "turbo" },
      { search_queries: ["other"], objective: "obj", mode: "advanced" },
    ]),
    /share queries/,
  );
  await assert.rejects(
    send([
      { ...shared, mode: "turbo" },
      { ...shared, objective: "different", mode: "advanced" },
    ]),
    /share queries/,
  );
});

await test("search sends the validated request body to the provider", async () => {
  const { api } = searchBackend({ responses: [{ body: { search_id: "s", results: [] } }] });
  await api.cloudAPI("search", null, { query: "climate policy", modes: ["fast"] });
  const sent = backend.lastSearch;
  assert.equal(sent.url, "https://api.parallel.ai/v1/search");
  assert.equal(sent.options.headers["x-api-key"], "test-key");
  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.search_queries, ["climate policy"]);
  assert.equal(body.mode, "fast");
  assert.equal(body.max_chars_total, 12000);
});

await test("search stores distinct result identifiers across both runs", async () => {
  const { api } = searchBackend({
    responses: [
      { body: { search_id: "s1", results: providerResults(5, "a") } },
      { body: { search_id: "s2", results: providerResults(5, "b") } },
    ],
  });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] });
  const ids = view.runs.flatMap((r) => r.results.map((x) => x.id));
  assert.equal(new Set(ids).size, ids.length, "result ids are unique within an evaluation");
  for (const id of ids) assert.ok(Number.isSafeInteger(id), `${id} is a safe integer`);
});

await test("resultMetrics reports coverage and graded means", () => {
  const mixed = scoring.resultMetrics([graded(1, 1, 3), graded(2, 2, 1), graded(3, 3, null)]);
  assert.equal(mixed.total, 3);
  assert.equal(mixed.graded, 2);
  assert.equal(mixed.unrated, 1);
  assert.equal(mixed.coverage, 2 / 3);
  assert.equal(mixed.mean_relevance, 2);
  assert.equal(mixed.rank_score_at_5, null, "fewer than five graded results cannot score");
  assert.equal(scoring.resultMetrics([]).coverage, null);
});

// ------------------------------------------------------------ lib/scoring.ts

const agreement = load("lib/scoring.ts");
const rate_ = (result_id, actor, relevance) => ({ result_id, actor, relevance });

await test("weightedKappa matches hand-computed values", () => {
  // Perfect agreement over a spread of grades.
  assert.equal(
    agreement.weightedKappa([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
    1,
  );
  // Systematic maximal disagreement scores below zero.
  assert.ok(
    agreement.weightedKappa([
      [0, 3],
      [3, 0],
      [0, 3],
      [3, 0],
    ]) < 0,
  );
  // Too little overlap, and a column with no variation, are undefined rather than perfect.
  assert.equal(agreement.weightedKappa([[2, 2]]), null);
  assert.equal(
    agreement.weightedKappa([
      [2, 2],
      [2, 2],
    ]),
    null,
    "expected agreement is total",
  );
  // Ordinal weighting: a one-grade gap must score higher than a three-grade gap.
  const near = agreement.weightedKappa([
    [0, 0],
    [1, 2],
    [2, 2],
    [3, 3],
  ]);
  const far = agreement.weightedKappa([
    [0, 3],
    [1, 2],
    [2, 2],
    [3, 3],
  ]);
  assert.ok(near > far, `${near} should beat ${far}`);
});

await test("kappaLabel names the conventional bands", () => {
  assert.equal(agreement.kappaLabel(null), "Kappa unavailable");
  assert.equal(agreement.kappaLabel(0.1), "Poor");
  assert.equal(agreement.kappaLabel(0.3), "Fair");
  assert.equal(agreement.kappaLabel(0.5), "Moderate");
  assert.equal(agreement.kappaLabel(0.7), "Substantial");
  assert.equal(agreement.kappaLabel(0.95), "Almost perfect");
});

await test("agreementMetrics separates doubly graded results from single ones", () => {
  const m = agreement.agreementMetrics([
    rate_(1, "ann@parallel.ai", 3),
    rate_(1, "bob@parallel.ai", 3),
    rate_(2, "ann@parallel.ai", 2),
    rate_(2, "bob@parallel.ai", 1),
    rate_(3, "ann@parallel.ai", 0),
  ]);
  assert.deepEqual(m.reviewers, ["ann@parallel.ai", "bob@parallel.ai"]);
  assert.equal(m.double_graded, 2);
  assert.equal(
    m.single_graded,
    1,
    "a result only one reviewer touched is not evidence of agreement",
  );
  assert.equal(m.exact_agreement, 0.5);
  assert.equal(m.adjacent_agreement, 1);
  assert.equal(m.pairs.length, 1);
  assert.equal(m.pairs[0].overlap, 2);
});

await test("agreementMetrics reports nothing to measure from a single reviewer", () => {
  const m = agreement.agreementMetrics([
    rate_(1, "ann@parallel.ai", 3),
    rate_(2, "ann@parallel.ai", 0),
  ]);
  assert.equal(m.double_graded, 0);
  assert.equal(m.single_graded, 2);
  assert.equal(m.exact_agreement, null);
  assert.equal(m.kappa, null);
  assert.deepEqual(m.pairs, []);
  assert.deepEqual(m.disputed, []);
  assert.deepEqual(agreement.agreementMetrics([]).reviewers, []);
});

await test("agreementMetrics surfaces the widest disagreements first", () => {
  const m = agreement.agreementMetrics([
    rate_(1, "ann@parallel.ai", 3),
    rate_(1, "bob@parallel.ai", 0),
    rate_(2, "ann@parallel.ai", 3),
    rate_(2, "bob@parallel.ai", 1),
    rate_(3, "ann@parallel.ai", 2),
    rate_(3, "bob@parallel.ai", 2),
  ]);
  assert.deepEqual(
    m.disputed.map((d) => d.result_id),
    [1, 2],
    "only gaps of two or more, widest first",
  );
  assert.equal(m.disputed[0].spread, 3);
  assert.equal(m.exact_agreement, 1 / 3);
});

await test("agreementMetrics averages kappa across three reviewers", () => {
  const m = agreement.agreementMetrics([
    rate_(1, "a@parallel.ai", 3),
    rate_(1, "b@parallel.ai", 3),
    rate_(1, "c@parallel.ai", 0),
    rate_(2, "a@parallel.ai", 0),
    rate_(2, "b@parallel.ai", 0),
    rate_(2, "c@parallel.ai", 3),
    rate_(3, "a@parallel.ai", 2),
    rate_(3, "b@parallel.ai", 1),
    rate_(3, "c@parallel.ai", 1),
  ]);
  assert.equal(m.reviewers.length, 3);
  assert.equal(m.pairs.length, 3, "every reviewer pair is compared");
  assert.equal(m.double_graded, 3);
  const ab = m.pairs.find((p) => p.reviewers.join() === "a@parallel.ai,b@parallel.ai");
  const ac = m.pairs.find((p) => p.reviewers.join() === "a@parallel.ai,c@parallel.ai");
  assert.ok(ab.kappa > ac.kappa, "the reviewer who inverted the scale agrees least");
});

// ------------------------------------------------------------ lib/cloud-evaluations.ts

function cacheBackend(rows) {
  let current = rows;
  const loaded = load("lib/cloud-evaluations.ts", {
    env: { DATABASE_URL: "postgres://user:pw@db.example.com/neondb" },
    globals: {
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ rows: current }) }),
    },
  });
  return {
    ...loaded,
    set: (value) => {
      current = value;
    },
  };
}

await test("readCacheTag varies by actor, operation and stored version", async () => {
  const cache = cacheBackend([{ id: "one", version: 1 }]);
  const base = await cache.readCacheTag("evaluation", "one", "a@parallel.ai");
  assert.equal(
    await cache.readCacheTag("evaluation", "one", "a@parallel.ai"),
    base,
    "stable for identical inputs",
  );
  assert.notEqual(
    await cache.readCacheTag("evaluation", "one", "b@parallel.ai"),
    base,
    "a different reviewer gets a different tag",
  );
  assert.notEqual(
    await cache.readCacheTag("evaluations", "one", "a@parallel.ai"),
    base,
    "a different operation gets a different tag",
  );
  cache.set([{ id: "one", version: 2 }]);
  assert.notEqual(
    await cache.readCacheTag("evaluation", "one", "a@parallel.ai"),
    base,
    "a write invalidates the tag",
  );
  assert.match(base, /^"[0-9a-f]{64}"$/, "a strong quoted validator");
});

await test("readCacheTag raises 404 when the evaluation is gone", async () => {
  const cache = cacheBackend([]);
  await assert.rejects(
    cache.readCacheTag("evaluation", "one", "a@parallel.ai"),
    (e) => e.status === 404,
  );
  assert.ok(
    await cache.readCacheTag("evaluations", null, "a@parallel.ai"),
    "an empty list is still cacheable",
  );
});

// ------------------------------------------------------- lib/parallel-account.ts

function accountBackend({ rows, fetchImpl, key = Buffer.alloc(32, 7).toString("base64") } = {}) {
  let state = rows;
  const sql = async (query, params = []) => {
    if (query.startsWith("SELECT encrypted")) return state;
    if (query.startsWith("UPDATE parallel_account_credentials SET lease=$1"))
      return state.length ? [{ encrypted: state[0].encrypted }] : [];
    if (query.startsWith("UPDATE parallel_account_credentials SET encrypted=")) {
      state = [{ encrypted: params[0] }];
      return [{ id: "balance" }];
    }
    return [];
  };
  const loaded = load("lib/parallel-account.ts", {
    env: { PARALLEL_ACCOUNT_ENCRYPTION_KEY: key },
    mocks: { "./cloud-evaluations": { sql, APIError: Error } },
    globals: {
      fetch:
        fetchImpl ||
        (async () => {
          throw new Error("unexpected fetch");
        }),
    },
  });
  return { ...loaded, state: () => state };
}

await test("parallel-account encrypts and decrypts a credential round trip", async () => {
  const credentials = {
    access_token: "live",
    refresh_token: "r",
    client_id: "c",
    expires_at: Date.now() + 3600000,
  };
  const account = accountBackend({ rows: [] });
  const encrypted = account.encryptCredentials(credentials);
  assert.notEqual(encrypted, JSON.stringify(credentials));
  assert.ok(!encrypted.includes("live"), "the token is not readable in the stored value");
  const reader = accountBackend({ rows: [{ encrypted }] });
  assert.equal(await reader.accountAccessToken(), "live");
});

await test("parallel-account returns null when the feature is unconfigured", async () => {
  const account = accountBackend({ rows: [{ encrypted: "x" }], key: "" });
  assert.equal(await account.accountAccessToken(), null);
  const empty = accountBackend({ rows: [] });
  assert.equal(await empty.accountAccessToken(), null);
});

await test("parallel-account refreshes an expired token and stores the new one", async () => {
  const seed = accountBackend({ rows: [] });
  const encrypted = seed.encryptCredentials({
    access_token: "stale",
    refresh_token: "r1",
    client_id: "c",
    expires_at: Date.now() - 1000,
  });
  let body;
  const account = accountBackend({
    rows: [{ encrypted }],
    fetchImpl: async (_url, options) => {
      body = options.body.toString();
      return {
        ok: true,
        json: async () => ({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }),
      };
    },
  });
  assert.equal(await account.accountAccessToken(), "fresh");
  assert.match(body, /grant_type=refresh_token/);
  assert.match(body, /refresh_token=r1/);
  const reread = accountBackend({ rows: account.state() });
  assert.equal(await reread.accountAccessToken(), "fresh", "the refreshed token is persisted");
});

await test("parallel-account rejects an invalid refresh response", async () => {
  const seed = accountBackend({ rows: [] });
  const expired = {
    access_token: "stale",
    refresh_token: "r",
    client_id: "c",
    expires_at: Date.now() - 1000,
  };
  for (const body of [
    { access_token: "" },
    { access_token: "x" },
    { access_token: "x", expires_in: 0 },
    { access_token: "x", expires_in: -1 },
    { access_token: "x", expires_in: "soon" },
    { access_token: "x", expires_in: 60, refresh_token: "" },
  ]) {
    const account = accountBackend({
      rows: [{ encrypted: seed.encryptCredentials(expired) }],
      fetchImpl: async () => ({ ok: true, json: async () => body }),
    });
    await assert.rejects(
      account.accountAccessToken(),
      /Invalid account authorization/,
      JSON.stringify(body),
    );
  }
  const failed = accountBackend({
    rows: [{ encrypted: seed.encryptCredentials(expired) }],
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  await assert.rejects(failed.accountAccessToken(), /reconnected/);
});

await test("parallel-account refuses a wrong-size encryption key", async () => {
  const account = accountBackend({
    rows: [{ encrypted: "x" }],
    key: Buffer.alloc(16).toString("base64"),
  });
  await assert.rejects(account.accountAccessToken(), /encryption is not configured/);
});

await test("parallel-account rejects a tampered ciphertext", async () => {
  const seed = accountBackend({ rows: [] });
  const encrypted = Buffer.from(
    seed.encryptCredentials({
      access_token: "live",
      refresh_token: "r",
      client_id: "c",
      expires_at: Date.now() + 3600000,
    }),
    "base64",
  );
  encrypted[encrypted.length - 1] ^= 0xff;
  const account = accountBackend({ rows: [{ encrypted: encrypted.toString("base64") }] });
  await assert.rejects(account.accountAccessToken());
});

// ------------------------------------- lib/share-evaluations.ts: the download

await test("serializeExport round-trips a document without loss", () => {
  const data = {
    id: "export-test",
    query: '=HYPERLINK("bad")',
    criteria: "Référence, official",
    rubric: "Relevant",
    exported_at: "2026-09-11",
    runs: [
      {
        id: "run",
        mode: "A",
        status: "completed",
        results: [
          {
            id: 7,
            rank: 1,
            title: 'A "quoted" title\nnext line',
            url: "https://example.com",
            publish_date: null,
            excerpts: ["First, excerpt", "Second\nline"],
            judgment: null,
            notes: "+SUM(1,2)",
            version: 0,
          },
          {
            id: 8,
            rank: 2,
            title: "B",
            excerpts: [],
            judgment: "incorrect",
            notes: "",
            version: 1,
          },
        ],
      },
    ],
    feedback_history: [{ result_id: 8, judgment: "incorrect" }],
  };
  assert.deepEqual(
    JSON.parse(exports_.serializeExport(data, "json").text),
    data,
    "JSON is the lossless format",
  );
  const rows = exports_.exportRows(data);
  // A field the app no longer writes survives in the JSON export above, but earns no CSV
  // column of its own: the flattened row reports the grade, and meets_need derives from it.
  assert.ok(!("judgment" in rows[0]), "the retired binary column is gone from flattened rows");
  assert.equal(rows[0].relevance, null);
  assert.equal(rows[1].feedback_history.length, 1);
  const csv = exports_.serializeExport(data, "csv").text;
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'), "a leading = is quoted out");
  assert.ok(csv.includes('"\'+SUM(1,2)"'), "a leading + is quoted out too");
  assert.ok(
    csv.includes('"A ""quoted"" title\nnext line"'),
    "an embedded newline stays inside the field",
  );
  assert.ok(csv.includes("Référence, official"), "non-ASCII survives");
});

await test("downloadEvaluation builds, clicks and discards a single anchor", () => {
  let appended = false,
    removed = false,
    clicked = false;
  const anchor = {
    click() {
      clicked = true;
    },
    remove() {
      removed = true;
    },
  };
  const dom = load("lib/share-evaluations.ts", {
    globals: {
      Blob,
      URL,
      setTimeout: (callback) => callback(),
      document: {
        createElement: () => anchor,
        body: {
          append() {
            appended = true;
          },
        },
      },
    },
  });
  dom.downloadEvaluation({ id: "export-test", runs: [] }, "csv");
  assert.ok(appended && clicked && removed, "the anchor is added, activated and cleaned up");
  assert.equal(anchor.download, "search-evaluation-export-test.csv");
});

// --------------------------------------- lib/evaluations.ts: the read pipeline

await test("evaluations.api deduplicates concurrent reads and honours fresh", async () => {
  let calls = 0,
    resolve;
  const client = load("lib/evaluations.ts", {
    globals: {
      fetch: async (url, options) => {
        calls++;
        return new Promise((done) => {
          resolve = () => done({ ok: true, json: async () => ({ url, cache: options.cache }) });
        });
      },
    },
  });
  const a = client.api("evaluations"),
    b = client.api("evaluations");
  assert.equal(calls, 1, "two readers in flight share one request");
  resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, "each caller gets its own copy to mutate");
  assert.equal(first.cache, "no-cache");

  const fresh = client.api("evaluations", undefined, { fresh: true });
  assert.equal(calls, 2, "an explicit fresh read is never served from an in-flight one");
  resolve();
  assert.equal((await fresh).cache, "no-store");

  const later = client.api("evaluations");
  assert.equal(calls, 3, "resolved reads are revalidated, not retained as stale snapshots");
  resolve();
  await later;
});

// ------------------------------- lib/evaluations.ts: the settings report

await test("evaluationSummary names every recorded API setting", () => {
  const configured = (advanced) =>
    run("advanced", [], {
      request: {
        search_queries: ["q"],
        session_id: "session-123",
        client_model: "example-model",
        advanced_settings: { max_results: 10, location: "us", ...advanced },
      },
    });
  const s = summary(
    evaluation([
      configured({}),
      configured({
        fetch_policy: { max_age_seconds: 600, timeout_seconds: 1.5, disable_cache_fallback: true },
      }),
    ]),
  );
  assert.match(s.sharedSettings, /Maximum results: 10/);
  assert.match(s.sharedSettings, /Country: US/);
  assert.match(s.sharedSettings, /API session: session-123/);
  assert.match(s.sharedSettings, /Client model: example-model/);
  assert.doesNotMatch(s.sharedSettings, /Cache age/, "a key only one side sets is not shared");
  assert.match(s.configurations[0].settings, /Cache age \(s\): API default/);
  assert.match(s.configurations[1].settings, /Cache age \(s\): 600/);
  assert.match(s.configurations[1].settings, /Fetch timeout \(s\): 1.5/);
  assert.match(s.configurations[1].settings, /Cache fallback: Off/);
  assert.doesNotMatch(
    s.configurations[1].settings,
    /Maximum results/,
    "a shared key is not repeated per side",
  );
  const identical = summary(evaluation([configured({}), configured({})]));
  assert.ok(
    identical.configurations.every((c) => c.settings === ""),
    "identical sides have nothing of their own",
  );
});

// ---------------------------------- lib/search-request.ts: the schema contract

await test("the request fixture exercises every property in the published schema", () => {
  const cases = JSON.parse(fs.readFileSync("tests/search-cases.json", "utf8"));
  const schema = JSON.parse(fs.readFileSync("lib/search-schema.json", "utf8"));
  const paths = (rule, prefix = "") => {
    if (rule.anyOf)
      return paths(
        rule.anyOf.find((r) => r.type !== "null"),
        prefix,
      );
    return Object.entries(rule.properties || {}).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return [path, ...paths(child, path)];
    });
  };
  const complete = { ...cases.request, mode: "fast" };
  for (const path of paths(schema))
    assert.notEqual(
      path.split(".").reduce((value, key) => value?.[key], complete),
      undefined,
      `the full request fixture must cover ${path}`,
    );
  assert.equal(search.validateSearchRequest(cases.request, ["fast"]), cases.request);
  for (const request of cases.invalid)
    assert.throws(() => search.validateSearchRequest(request, ["fast"]));
  assert.throws(
    () => search.validateSearchRequest(cases.request, ["turbo"]),
    "the fixture request is not valid for every mode",
  );
  // Every optional property may be omitted by passing null.
  const nulls = Object.keys(schema.properties)
    .filter((key) => key !== "search_queries")
    .map((key) => [key, null]);
  search.validateSearchRequest({ search_queries: ["x"], ...Object.fromEntries(nulls) }, ["fast"]);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        search.prepareSearchRequest({
          search_queries: [" x "],
          advanced_settings: { source_policy: { exclude_domains: [" reddit.com ", ""] } },
        }),
      ),
    ),
    {
      search_queries: ["x"],
      advanced_settings: { source_policy: { exclude_domains: ["reddit.com"] } },
    },
    "preparation trims entries and drops empty ones",
  );
});

await test("a rejected search never reaches the database or spends a credit", async () => {
  const cases = JSON.parse(fs.readFileSync("tests/search-cases.json", "utf8"));
  const statements = [];
  const cloud = load("lib/cloud-evaluations.ts", {
    env: { DATABASE_URL: "postgres://u:p@db.test/neondb", PARALLEL_API_KEY: "test-only" },
    globals: {
      fetch: async (url, options) => {
        if (!String(url).endsWith("/sql"))
          throw new Error("no search may be issued for an invalid request");
        statements.push(JSON.parse(options.body).query.replace(/\s+/g, " ").trim());
        return { ok: true, status: 200, json: async () => ({ rows: [] }) };
      },
    },
  });
  for (const search_request of cases.invalid)
    await assert.rejects(cloud.cloudAPI("search", null, { search_request, modes: ["fast"] }));
  for (const modes of [[], ["fast", "turbo", "basic"], ["nope"]])
    await assert.rejects(cloud.cloudAPI("search", null, { search_request: cases.request, modes }));
  await assert.rejects(
    cloud.cloudAPI("search", null, { search_request: cases.request, modes: ["fast"], blind: true }),
  );
  await assert.rejects(
    cloud.cloudAPI("search", null, {
      search_request: cases.request,
      requests: [cases.request],
      modes: ["fast", "turbo"],
    }),
  );
  assert.deepEqual(statements, [], "no statement ran for any rejected request");
});

// ------------------------------ lib/share-evaluations.ts: formatting and blinding

await test("copyResult keeps every excerpt, the saved note and the rating", () => {
  const result = {
    id: 1,
    rank: 1,
    title: "A [source]",
    url: "https://example.com/a",
    publish_date: null,
    excerpts: ["Full excerpt", "Second paragraph"],
    judgment: null,
    notes: "Saved note",
    version: 0,
    updated_at: null,
  };
  const data = {
    id: "copy-test",
    query: "Example query",
    criteria: "Official sources",
    created_at: "2026-09-11T12:00:00Z",
    runs: [
      {
        id: "a",
        mode: "advanced",
        status: "completed",
        elapsed: 1,
        error: null,
        results: [result],
        request: { search_queries: ["Example query"], mode: "advanced" },
      },
    ],
  };
  for (const format of ["text", "markdown", "json"]) {
    const text = copy.copyResult(result, format, data, data.runs[0]);
    assert.ok(text.includes("Second paragraph"), `${format} keeps later excerpts`);
    assert.ok(text.includes("Saved note"), `${format} keeps the note`);
    if (format === "json") assert.deepEqual(JSON.parse(text).result, result);
    else assert.ok(text.includes("Rating: Unrated"));
  }
  assert.ok(
    copy.copyResult(result, "markdown", data, data.runs[0]).includes("A \\[source\\]"),
    "markdown escapes a bracket in a title",
  );
  assert.ok(
    copy
      .copyResult(
        { ...result, excerpts: ["# Heading\n**Bold** [Link](https://example.com)"] },
        "text",
        data,
        data.runs[0],
      )
      .includes("Heading\nBold Link (https://example.com)"),
    "plain text strips markdown rather than passing it through",
  );
  assert.ok(copy.copyEvaluation(data, "markdown").includes("| Configuration |"));
  assert.ok(copy.copyEvaluation(data, "text").includes("API settings:"));
  assert.equal(
    JSON.parse(copy.copyEvaluation(data, "json", "correct")).runs[0].results.length,
    0,
    "a rating filter that matches nothing copies nothing",
  );
});

await test("copying an unrevealed blind evaluation cannot leak the mode", () => {
  const result = {
    id: 1,
    rank: 1,
    title: "A",
    url: "https://example.com/a",
    publish_date: null,
    excerpts: ["e"],
    judgment: null,
    notes: "",
    version: 0,
    updated_at: null,
  };
  const open = {
    id: "blind-test",
    query: "q",
    criteria: "c",
    created_at: "2026-09-11T12:00:00Z",
    runs: [
      {
        id: "a",
        mode: "advanced",
        status: "completed",
        elapsed: 1,
        error: null,
        results: [result],
        request: { search_queries: ["q"], mode: "advanced" },
      },
    ],
  };
  const blind = { ...open, blind: true, revealed_at: null };
  for (const format of ["text", "markdown", "json"]) {
    assert.throws(() => copy.copyEvaluation(blind, format), `copyEvaluation/${format} refuses`);
    assert.throws(
      () => copy.copyConfiguration(blind, blind.runs[0], format),
      `copyConfiguration/${format} refuses`,
    );
    assert.ok(
      !copy.copyResult(result, format, blind, blind.runs[0]).includes("advanced"),
      `copyResult/${format} omits the mode`,
    );
  }
});

// ---------------------- lib/parallel-account.ts: contention on a shared refresh

await test("parallel-account refuses to refresh while another worker holds the lease", async () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const seed = accountBackend({ rows: [], key });
  const expired = seed.encryptCredentials({
    access_token: "stale",
    refresh_token: "r",
    client_id: "c",
    expires_at: 0,
  });

  let lease = "another-worker",
    calls = 0;
  const sql = async (query, params = []) => {
    if (query.startsWith("SELECT")) return [{ encrypted: expired }];
    if (query.includes("SET lease=$1")) {
      if (lease) return [];
      lease = params[0];
      return [{ encrypted: expired }];
    }
    if (query.includes("SET encrypted")) {
      assert.equal(params[1], lease);
      return [{ id: "balance" }];
    }
    if (query.includes("SET lease=NULL")) {
      if (lease === params[0]) lease = null;
      return [];
    }
    throw new Error(query);
  };
  const account = load("lib/parallel-account.ts", {
    env: { PARALLEL_ACCOUNT_ENCRYPTION_KEY: key },
    mocks: { "./cloud-evaluations": { sql, APIError: Error } },
    globals: {
      fetch: async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({ access_token: "new", refresh_token: "r2", expires_in: 600 }),
        };
      },
    },
  });
  await assert.rejects(account.accountAccessToken(), "a held lease blocks the refresh");
  assert.equal(calls, 0, "and no token request is sent");

  lease = null;
  assert.equal(await account.accountAccessToken(), "new");
  assert.equal(calls, 1);
  assert.equal(lease, null, "the lease is released after a successful refresh");
});

// ------------------------------------------------------- pooling across queries

await test("signTest matches the exact two-sided binomial", () => {
  // Hand-computed from Binomial(n, 0.5): 2 * P(X >= k).
  assert.equal(scoring.signTest(0, 0), null, "no decided comparisons has no p-value");
  assert.equal(scoring.signTest(1, 0), 1, "one comparison can never be conclusive");
  assert.equal(scoring.signTest(5, 0), 2 / 32);
  assert.equal(scoring.signTest(6, 0), 2 / 64);
  assert.equal(scoring.signTest(4, 1), (2 * 6) / 32);
  assert.equal(scoring.signTest(0, 5), 2 / 32, "the test is two-sided, so losses read the same");
  assert.equal(scoring.signTest(3, 3), 1, "an even split is exactly what chance predicts");
  // Six decided comparisons is the floor: a clean sweep of five still lands at p = 0.0625, so
  // no axis can be called on fewer, however lopsided it looks.
  assert.ok(scoring.signTest(5, 0) > scoring.significanceLevel, "a 5-0 sweep is not enough");
  assert.ok(scoring.signTest(6, 0) < scoring.significanceLevel, "6-0 is the smallest that clears");
  assert.ok(scoring.signTest(4, 1) > scoring.significanceLevel, "4-1 does not clear it");
});

await test("median handles both parities and reports nothing for no values", () => {
  assert.equal(scoring.median([]), null);
  assert.equal(scoring.median([7]), 7);
  assert.equal(scoring.median([3, 1, 2]), 2);
  assert.equal(scoring.median([4, 1, 3, 2]), 2.5);
});

const comparison = (id, field, a, b, scoreA, scoreB, elapsed = [1, 2]) => ({
  id,
  differences: field ? [{ field, a, b }] : [],
  configurations: [
    { label: "A", rank_score_at_5: scoreA, elapsed: elapsed[0] },
    { label: "B", rank_score_at_5: scoreB, elapsed: elapsed[1] },
  ],
});

await test("axisAggregates pools one field and withholds an unproven winner", () => {
  const { axes, confounded } = scoring.axisAggregates([
    comparison("1", "mode", "fast", "advanced", 60, 80),
    comparison("2", "mode", "fast", "advanced", 70, 75),
    comparison("3", "mode", "fast", "advanced", 90, 50),
  ]);
  assert.equal(confounded, 0);
  assert.equal(axes.length, 1);
  const [axis] = axes;
  assert.deepEqual(axis.values, ["advanced", "fast"], "values are sorted, not A and B");
  assert.deepEqual(axis.wins, { advanced: 2, fast: 1 });
  assert.equal(axis.leader, "advanced");
  assert.equal(axis.significant, false, "2-1 is not evidence of anything");
  assert.equal(axis.decided, 3);
  assert.equal(axis.median_delta, 20, "the median of gaps 20, 5 and 40");
});

await test("axisAggregates declares a winner only once the split clears the sign test", () => {
  const wins = Array.from({ length: 6 }, (_, i) =>
    comparison(String(i), "mode", "fast", "advanced", 50, 80),
  );
  const [axis] = scoring.axisAggregates(wins).axes;
  assert.equal(axis.leader, "advanced");
  assert.equal(axis.significant, true, "6-0 clears p < 0.05");
  assert.ok(axis.p < scoring.significanceLevel);
});

await test("axisAggregates groups a flipped comparison with its own axis", () => {
  // A blinded evaluation assigns the sides at random, so the same axis arrives both ways round.
  const { axes } = scoring.axisAggregates([
    comparison("1", "mode", "fast", "advanced", 50, 80),
    comparison("2", "mode", "advanced", "fast", 80, 50),
  ]);
  assert.equal(axes.length, 1, "one axis, not one per side ordering");
  assert.deepEqual(axes[0].wins, { advanced: 2, fast: 0 });
});

await test("axisAggregates refuses to attribute a confounded comparison", () => {
  const both = comparison("1", "mode", "fast", "advanced", 50, 80);
  both.differences.push({ field: "max_results", a: "5", b: "20" });
  const { axes, confounded } = scoring.axisAggregates([both]);
  assert.equal(confounded, 1);
  assert.equal(axes.length, 0, "a comparison that moved two fields joins no axis");
});

await test("axisAggregates counts ungraded and tied comparisons apart from decided ones", () => {
  const { axes } = scoring.axisAggregates([
    comparison("1", "mode", "fast", "advanced", 50, 80),
    comparison("2", "mode", "fast", "advanced", 70, 70),
    comparison("3", "mode", "fast", "advanced", null, 80),
    comparison("4", "mode", "fast", "advanced", 60, null),
  ]);
  const [axis] = axes;
  assert.equal(axis.decided, 1);
  assert.equal(axis.ties, 1);
  assert.equal(axis.pending, 2);
  assert.equal(axis.compared, 4);
  assert.equal(axis.median_elapsed.fast, 1, "latency is pooled even from ungraded comparisons");
  assert.equal(axis.median_elapsed.advanced, 2);
});

await test("axisAggregates ignores an evaluation with no recorded difference", () => {
  const { axes, confounded } = scoring.axisAggregates([comparison("1", null, null, null, 50, 80)]);
  assert.equal(axes.length, 0, "an unrevealed blind review reports no differences");
  assert.equal(confounded, 0);
});

// ------------------------------------------------------------------- overlap

const ranked = (url, rank, relevance = null) => ({ url, rank, relevance, title: url });

await test("overlapMetrics separates a ranking change from a retrieval one", () => {
  const overlap = scoring.overlapMetrics(
    [ranked("a", 1), ranked("b", 2), ranked("c", 3), ranked("d", 4)],
    [ranked("c", 1), ranked("a", 2), ranked("b", 3), ranked("e", 4)],
  );
  assert.equal(overlap.count, 3, "a, b and c came back from both");
  assert.equal(overlap.only_a, 1, "d only from A");
  assert.equal(overlap.only_b, 1, "e only from B");
  assert.equal(overlap.moved, 3);
  assert.equal(overlap.unchanged, 0);
  assert.equal(overlap.median_move, 1, "moves of 1, 1 and 2 positions");
  assert.deepEqual(
    overlap.shared.map((item) => [item.url, item.move]),
    [
      ["c", 2],
      ["a", -1],
      ["b", -1],
    ],
    "biggest mover first; positive means B ranked it higher",
  );
});

await test("overlapMetrics reports a page graded differently on the two sides", () => {
  const overlap = scoring.overlapMetrics(
    [ranked("a", 1, 3), ranked("b", 2, 2), ranked("c", 3, null)],
    [ranked("a", 1, 1), ranked("b", 2, 2), ranked("c", 3, 3)],
  );
  assert.equal(overlap.moved, 0, "identical ranking");
  assert.equal(overlap.unchanged, 3);
  assert.equal(overlap.median_move, null, "no movement means no median to report");
  assert.equal(overlap.regraded, 1, "only a, graded 3 against 1; c is ungraded on one side");
});

await test("overlapMetrics compares the best-ranked occurrence of a duplicated URL", () => {
  const overlap = scoring.overlapMetrics(
    [ranked("a", 3), ranked("a", 1)],
    [ranked("a", 2), ranked("a", 5)],
  );
  assert.equal(overlap.count, 1, "one URL, however many times it came back");
  assert.deepEqual(
    overlap.shared.map((item) => [item.a, item.b, item.move]),
    [[1, 2, -1]],
  );
  assert.equal(overlap.only_a, 0);
});

await test("overlapMetrics reports nothing shared when the two sides disjoin", () => {
  const overlap = scoring.overlapMetrics([ranked("a", 1)], [ranked("b", 1)]);
  assert.equal(overlap.count, 0);
  assert.equal(overlap.only_a, 1);
  assert.equal(overlap.only_b, 1);
  assert.equal(overlap.median_move, null);
  assert.equal(overlap.regraded, 0);
});

await test("partial reviews name the leading configuration and qualify the top-five score", () => {
  const strong = Array.from({ length: 10 }, (_, i) => graded(i + 1, i + 1, i < 5 ? 3 : null));
  const weak = Array.from({ length: 10 }, (_, i) => graded(i + 20, i + 1, i < 5 ? 0 : null));
  const result = summary(evaluation([run("advanced", strong), run("fast", weak)]));
  assert.equal(result.outcome.title, "Advanced leads");
  assert.match(result.outcome.detail, /full review is incomplete/);
  const reversed = summary(evaluation([run("fast", weak), run("advanced", strong)]));
  assert.equal(reversed.outcome.title, "Advanced leads");
  const sameMode = summary(
    evaluation([
      run("fast", strong),
      run("fast", weak, {
        request: { search_queries: ["q"], mode: "fast", advanced_settings: { max_results: 20 } },
      }),
    ]),
  );
  assert.match(sameMode.outcome.title, /Fast · .* leads/);
});

await test("shared settings preserve only the selected field, including nested defaults", () => {
  const shared = {
    search_queries: ["q"],
    advanced_settings: {
      max_results: 20,
      source_policy: { include_domains: ["example.com"], after_date: "2026-01-01" },
    },
  };
  const original = {
    search_queries: ["old"],
    advanced_settings: {
      max_results: 5,
      source_policy: { include_domains: ["parallel.ai"] },
    },
  };
  const next = search.withSharedSettings(shared, original, "include_domains");
  assert.deepEqual(next.advanced_settings.source_policy, {
    include_domains: ["parallel.ai"],
    after_date: "2026-01-01",
  });
  assert.equal(next.advanced_settings.max_results, 20);
  assert.deepEqual(
    search.withSharedSettings(shared, { search_queries: ["q"] }, "include_domains")
      .advanced_settings.source_policy,
    { after_date: "2026-01-01" },
  );
  assert.deepEqual(shared.advanced_settings.source_policy.include_domains, ["example.com"]);
  assert.equal(
    search.withSharedSettings(shared, original, "max_results").advanced_settings.max_results,
    5,
  );
});

await test("evaluation history uses one snapshot for summaries and cache versions", async () => {
  const api = backend();
  const data = evaluation([run("fast", [graded(1, 1, 3)])]);
  api.store.on(() => [{ id: data.id, version: 4, data }]);
  const history = await api.readEvaluationHistory("reviewer", null);
  assert.equal(api.store.calls.length, 1);
  assert.equal(history.body[0].id, data.id);
  api.store.on(() => [{ id: data.id, version: 4 }]);
  assert.equal(history.etag, await api.readCacheTag("evaluations", null, "reviewer"));
  assert.notEqual(history.etag, await api.readCacheTag("evaluations", null, "another reviewer"));
  api.store.on(() => [{ id: data.id, version: 5 }]);
  assert.notEqual(history.etag, await api.readCacheTag("evaluations", null, "reviewer"));
});

await test("saved evaluation starts document and history reads together and uses its stored version", async () => {
  const data = evaluation([run("fast", [graded(1, 1, 3)])]);
  const pending = [];
  const api = load("lib/cloud-evaluations.ts", {
    env: { DATABASE_URL: "postgres://user:pw@db.example.com/neondb" },
    globals: {
      fetch: (_url, options) =>
        new Promise((resolve) => pending.push({ query: JSON.parse(options.body).query, resolve })),
    },
  });
  const read = api.readEvaluation("reviewer", data.id);
  assert.equal(pending.length, 2, "neither read waits for the other");
  assert.match(pending[0].query, /SELECT data,version/);
  assert.match(pending[1].query, /evaluation_feedback/);
  pending[0].resolve({ ok: true, json: async () => ({ rows: [{ data, version: 7 }] }) });
  pending[1].resolve({ ok: true, json: async () => ({ rows: [] }) });
  const snapshot = await read;
  assert.equal(snapshot.body.id, data.id);
  const validator = api.readCacheTag("evaluation", data.id, "reviewer");
  pending[2].resolve({ ok: true, json: async () => ({ rows: [{ id: data.id, version: 7 }] }) });
  assert.equal(snapshot.etag, await validator);
});
