// The grading write path against a real PostgreSQL database.
//
// The write path is a single SQL statement now, so its correctness — per-result version
// guards, the blind reveal condition, the audit-trail inserts — cannot be checked against a
// JavaScript stand-in. The helpers below point lib/cloud-evaluations.ts's Neon HTTP client at
// a throwaway local cluster instead, so these cases exercise the statements Postgres runs.
//
// Set TEST_DATABASE_URL to a scratch database. Never point it at a database holding real
// evaluations: every run truncates the tables.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { test as nodeTest } from "node:test";
import { load } from "./load.mjs";

// ------------------------------------------------------------------ the test database

const root = path.resolve(import.meta.dirname, "..");
const connectionString = process.env.TEST_DATABASE_URL;
const available = Boolean(connectionString);

let pool;
async function open() {
  pool ??= new pg.Pool({ connectionString, max: 8 });
  return pool;
}
async function close() {
  await pool?.end();
  pool = undefined;
}

async function migrate() {
  const client = await open();
  await client.query(fs.readFileSync(path.join(root, "schema.sql"), "utf8"));
}

async function reset() {
  const client = await open();
  await client.query(
    "TRUNCATE evaluation_feedback, evaluation_activity, evaluations, search_budget RESTART IDENTITY CASCADE",
  );
}

async function query(text, params = []) {
  return (await (await open()).query(text, params)).rows;
}

/**
 * Load lib/cloud-evaluations.ts with its Neon HTTP client redirected to the test database
 * and the Parallel Search API replaced by scripted responses.
 */
function backend({ env = {}, search = [], ids } = {}) {
  let counter = 0;
  const nextId = ids || (() => `${String(++counter).padStart(8, "0")}-0000-4000-8000-000000000000`);
  const state = { searchCalls: 0, sqlCalls: [], lastSearch: null };
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/sql")) {
      const { query: text, params } = JSON.parse(options.body);
      state.sqlCalls.push(text.replace(/\s+/g, " ").trim());
      try {
        const rows = (await (await open()).query(text, params)).rows;
        return { ok: true, status: 200, json: async () => ({ rows }) };
      } catch (error) {
        state.lastDatabaseError = error;
        return { ok: false, status: 500, json: async () => ({ message: error.message }) };
      }
    }
    if (String(url).startsWith("https://api.parallel.ai/")) {
      state.lastSearch = { url, options };
      const next = search[Math.min(state.searchCalls++, search.length - 1)];
      if (next === undefined) throw new Error("unscripted provider call");
      if (next instanceof Error) throw next;
      return { ok: next.ok !== false, status: next.status || 200, json: async () => next.body };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const loaded = load("lib/cloud-evaluations.ts", {
    env: {
      PARALLEL_API_KEY: "test-key",
      DATABASE_URL: `postgres://u:p@${"db.test"}/neondb`,
      ...env,
    },
    builtins: { "node:crypto": { randomUUID: nextId, randomInt: () => 0 } },
    globals: { fetch: fetchImpl },
  });
  return { ...loaded, state };
}

/** Insert an evaluation document directly, bypassing the search path. */
async function seed(document) {
  await query("INSERT INTO evaluations(id,data) VALUES($1,$2::jsonb)", [
    document.id,
    JSON.stringify(document),
  ]);
  return document;
}

async function document(id) {
  const [row] = await query("SELECT data,version FROM evaluations WHERE id=$1", [id]);
  return row && { data: row.data, version: Number(row.version) };
}

const db = {
  connectionString,
  available,
  open,
  close,
  migrate,
  reset,
  query,
  backend,
  seed,
  document,
};

// ------------------------------------------------------------------------ the cases

if (!db.available) {
  console.log("SKIP: set TEST_DATABASE_URL to a scratch database to run the grading tests.");
  process.exit(0);
}

// Each case starts from an empty database. A `beforeEach` hook cannot do this: the file
// registers its cases one at a time with top-level `await test(...)`, so the root suite
// finishes after the first one and tears the hooks down under the rest.
const test = (name, body) =>
  nodeTest(name, async () => {
    await db.reset();
    await body();
  });

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
const legacyResult = (id, rank, judgment = null) => {
  const { relevance, issues, rubric_version, ...rest } = graded(id, rank);
  void relevance;
  void issues;
  void rubric_version;
  return { ...rest, judgment };
};
const run = (mode, results, extra = {}) => ({
  id: `run-${mode}`,
  mode,
  status: "completed",
  elapsed: 1.5,
  error: null,
  results,
  request: { search_queries: ["q"], mode, max_chars_total: 12000 },
  response: { search_id: "s", session_id: null, usage: null, warnings: null },
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
const rate = (api, patch, actor = "ann@parallel.ai") =>
  api.cloudAPI("feedback", null, { evaluation_id: uuid(1), issues: [], ...patch }, actor);

await db.migrate();

// ---------------------------------------------------------- schema

await test("the schema file is idempotent and builds the whole schema", async () => {
  await db.migrate();
  const tables = (
    await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
    )
  ).map((r) => r.table_name);
  assert.deepEqual(tables, [
    "evaluation_activity",
    "evaluation_feedback",
    "evaluations",
    "parallel_account_credentials",
    "search_budget",
  ]);
  const indexes = (
    await db.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'")
  ).map((r) => r.indexname);
  for (const name of [
    "evaluations_data_contains",
    "evaluation_feedback_timeline",
    "evaluation_feedback_actor",
    "evaluations_recent_id",
  ])
    assert.ok(indexes.includes(name), `missing index ${name}`);
});

await test("the containment lookup uses the GIN index rather than scanning", async () => {
  for (let i = 1; i <= 40; i++)
    await db.seed({ ...evaluation([run("fast", [graded(i * 10, 1)])]), id: uuid(i) });
  await db.query("ANALYZE evaluations");
  // At this row count the planner correctly prefers a scan; disabling it proves the index
  // supports the containment operator, which is what the fallback lookup needs at scale.
  await db.query("SET enable_seqscan = off");
  const plan = (
    await db.query("EXPLAIN (FORMAT TEXT) SELECT id FROM evaluations WHERE data @> $1::jsonb", [
      JSON.stringify({ runs: [{ results: [{ id: 200 }] }] }),
    ])
  )
    .map((r) => r["QUERY PLAN"])
    .join("\n");
  await db.query("SET enable_seqscan = on");
  assert.match(plan, /evaluations_data_contains/, `plan was:\n${plan}`);
});

// ------------------------------------------------ concurrent grading

await test("two reviewers grade different results at the same time", async () => {
  await db.seed(
    evaluation([
      run("turbo", [graded(1, 1), graded(2, 2)]),
      run("advanced", [graded(3, 1), graded(4, 2)]),
    ]),
  );
  const api = db.backend();
  const outcomes = await Promise.allSettled([
    rate(api, { result_id: 1, version: 0, relevance: 3 }, "ann@parallel.ai"),
    rate(api, { result_id: 3, version: 0, relevance: 1 }, "bob@parallel.ai"),
  ]);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["fulfilled", "fulfilled"],
    outcomes.map((o) => o.reason?.message).join(" / "),
  );
  const { data } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, 3);
  assert.equal(data.runs[0].results[0].actor, "ann@parallel.ai");
  assert.equal(data.runs[1].results[0].relevance, 1);
  assert.equal(data.runs[1].results[0].actor, "bob@parallel.ai");
});

await test("one reviewer grades twenty results concurrently without a false conflict", async () => {
  const first = Array.from({ length: 10 }, (_, i) => graded(i + 1, i + 1));
  const second = Array.from({ length: 10 }, (_, i) => graded(i + 11, i + 1));
  await db.seed(evaluation([run("turbo", first), run("advanced", second)]));
  const api = db.backend();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      rate(api, { result_id: i + 1, version: 0, relevance: i % 4 }),
    ),
  );
  const rejected = outcomes.filter((o) => o.status === "rejected");
  assert.equal(rejected.length, 0, rejected.map((o) => o.reason.message).join(" / "));
  const { data } = await db.document(uuid(1));
  const stored = data.runs.flatMap((r) => r.results);
  assert.equal(stored.filter((r) => r.relevance !== null).length, 20);
  assert.equal((await db.query("SELECT count(*)::int n FROM evaluation_feedback"))[0].n, 20);
});

await test("two reviewers grading the SAME result still conflict", async () => {
  await db.seed(evaluation([run("turbo", [graded(1, 1)])]));
  const api = db.backend();
  const outcomes = await Promise.allSettled([
    rate(api, { result_id: 1, version: 0, relevance: 3 }, "ann@parallel.ai"),
    rate(api, { result_id: 1, version: 0, relevance: 0 }, "bob@parallel.ai"),
  ]);
  const statuses = outcomes.map((o) => o.status).sort();
  assert.deepEqual(statuses, ["fulfilled", "rejected"], "exactly one writer wins");
  const loser = outcomes.find((o) => o.status === "rejected");
  assert.equal(loser.reason.status, 409);
  assert.match(loser.reason.message, /Reload before saving/);
});

// ------------------------------------------------------- rating writes

await test("a grade is stored, versioned and recorded in both trails", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1), graded(2, 2)])]));
  const api = db.backend();
  const saved = await rate(api, {
    result_id: 1,
    version: 0,
    relevance: 3,
    issues: ["Outdated"],
    notes: "useful",
  });
  assert.equal(saved.relevance, 3);
  assert.equal(saved.version, 1);
  assert.equal(saved.actor, "ann@parallel.ai");
  assert.equal(saved.notes, "useful");
  assert.equal(saved.rubric_version, "relevance-v1");

  const { data, version } = await db.document(uuid(1));
  const stored = data.runs[0].results[0];
  assert.equal(stored.relevance, 3);
  assert.deepEqual(stored.issues, ["Outdated"]);
  assert.equal(stored.version, 1);
  assert.ok(stored.updated_at);
  assert.equal(data.runs[0].results[1].relevance, null, "the sibling result is untouched");
  assert.equal(version, 1);

  const [history] = await db.query("SELECT * FROM evaluation_feedback");
  assert.equal(history.result_id, "1");
  assert.equal(history.relevance, 3);
  assert.deepEqual(history.issues, ["Outdated"]);
  assert.equal(history.actor, "ann@parallel.ai");
  assert.equal(history.notes, "useful");
  const [activity] = await db.query(
    "SELECT * FROM evaluation_activity WHERE action='feedback saved'",
  );
  assert.equal(activity.target, "Result 1: 3 — Fully relevant; notes saved");
});

await test("the audit trail no longer grows inside the evaluation document", async () => {
  const results = Array.from({ length: 20 }, (_, i) => graded(i + 1, (i % 10) + 1));
  await db.seed(
    evaluation([run("turbo", results.slice(0, 10)), run("advanced", results.slice(10))]),
  );
  const api = db.backend();
  const [before] = await db.query(
    "SELECT octet_length(data::text) size FROM evaluations WHERE id=$1",
    [uuid(1)],
  );
  for (let pass = 0; pass < 5; pass++)
    for (let i = 1; i <= 20; i++)
      await rate(api, { result_id: i, version: pass, relevance: i % 4 });
  const [after] = await db.query(
    "SELECT octet_length(data::text) size FROM evaluations WHERE id=$1",
    [uuid(1)],
  );
  const growth = after.size / before.size;
  assert.ok(growth < 1.35, `document grew ${(growth * 100 - 100).toFixed(0)}% over 100 ratings`);
  assert.equal((await db.query("SELECT count(*)::int n FROM evaluation_feedback"))[0].n, 100);
  const { data } = await db.document(uuid(1));
  assert.equal(data.feedback_history.length, 0, "ratings do not append to the document");
});

await test("clearing a grade returns the result to unrated", async () => {
  await db.seed(
    evaluation([run("fast", [graded(1, 1, 3, { version: 2, actor: "old@parallel.ai" })])]),
  );
  const api = db.backend();
  const saved = await rate(api, { result_id: 1, version: 2, relevance: null });
  assert.equal(saved.relevance, null);
  const { data } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, null);
  assert.equal(data.runs[0].results[0].version, 3);
});

await test("a binary judgment payload is refused", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  await assert.rejects(
    api.cloudAPI(
      "feedback",
      null,
      { evaluation_id: uuid(1), result_id: 1, version: 0, judgment: "correct" },
      "ann@parallel.ai",
    ),
    /Invalid feedback/,
    "the binary rubric is retired; only a relevance grade is accepted",
  );
  const { data, version } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, null);
  assert.equal(version, 0, "a refused payload writes nothing");
});

await test("grading a result imported without a grade field works", async () => {
  await db.seed(evaluation([run("fast", [legacyResult(1, 1)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 2 });
  const { data } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, 2);
  assert.equal(data.runs[0].results[0].rubric_version, "relevance-v1");
});

await test("a stale version is refused and changes nothing", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1, 3, { version: 5 })])]));
  const api = db.backend();
  await assert.rejects(
    rate(api, { result_id: 1, version: 4, relevance: 0 }),
    (e) => e.status === 409,
  );
  const { data, version } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, 3, "the stored grade is intact");
  assert.equal(version, 0, "a refused write does not bump the document version");
  assert.equal((await db.query("SELECT count(*)::int n FROM evaluation_feedback"))[0].n, 0);
});

await test("an unknown result is a 404, an unknown evaluation is a 404", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  await assert.rejects(
    rate(api, { result_id: 999, version: 0, relevance: 1 }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    api.cloudAPI("feedback", null, {
      evaluation_id: uuid(9),
      result_id: 1,
      version: 0,
      relevance: 1,
      issues: [],
    }),
    (e) => e.status === 404,
  );
});

await test("a repeated save of the same revision records one history row", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 3 });
  await assert.rejects(
    rate(api, { result_id: 1, version: 0, relevance: 3 }),
    (e) => e.status === 409,
  );
  assert.equal((await db.query("SELECT count(*)::int n FROM evaluation_feedback"))[0].n, 1);
});

await test("the evaluation is found from the result id alone", async () => {
  await db.seed(evaluation([run("fast", [graded(4242, 1)])]));
  const api = db.backend();
  await api.cloudAPI(
    "feedback",
    null,
    { result_id: 4242, version: 0, relevance: 2, issues: [] },
    "ann@parallel.ai",
  );
  const { data } = await db.document(uuid(1));
  assert.equal(data.runs[0].results[0].relevance, 2);
});

await test("notes are stored trimmed and bounded", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  const saved = await rate(api, { result_id: 1, version: 0, relevance: 1, notes: "  spaced  " });
  assert.equal(saved.notes, "spaced");
  await assert.rejects(
    rate(api, { result_id: 1, version: 1, relevance: 1, notes: "x".repeat(2001) }),
    /2000 characters/,
  );
});

await test("a long rating label cannot violate the activity length check", async () => {
  await db.seed(evaluation([run("fast", [graded(Number.MAX_SAFE_INTEGER, 1)])]));
  const api = db.backend();
  await rate(api, {
    result_id: Number.MAX_SAFE_INTEGER,
    version: 0,
    relevance: 3,
    notes: "x".repeat(2000),
  });
  const [activity] = await db.query(
    "SELECT target FROM evaluation_activity WHERE action='feedback saved'",
  );
  assert.ok(activity.target.length <= 200);
});

// --------------------------------------------------------- blind reveal

const blindEvaluation = (gradeA, gradeB) =>
  evaluation(
    [
      run(
        "advanced",
        Array.from({ length: 5 }, (_, i) => graded(i + 1, i + 1, gradeA[i])),
      ),
      run(
        "turbo",
        Array.from({ length: 5 }, (_, i) => graded(i + 11, i + 1, gradeB[i])),
      ),
    ],
    { blind: true, revealed_at: null },
  );

await test("the blind reveal fires on the last required grade", async () => {
  await db.seed(blindEvaluation([3, 3, 3, 3, 3], [3, 3, 3, 3, null]));
  const api = db.backend();
  assert.equal((await db.document(uuid(1))).data.revealed_at, null);
  await rate(api, { result_id: 15, version: 0, relevance: 2 });
  const { data } = await db.document(uuid(1));
  assert.ok(data.revealed_at, "the modes are revealed");
  const view = await api.cloudAPI("evaluation", uuid(1));
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["advanced", "turbo"],
  );
});

await test("the blind reveal waits while any top-five grade is missing", async () => {
  await db.seed(blindEvaluation([3, 3, 3, null, null], [3, 3, 3, 3, null]));
  const api = db.backend();
  await rate(api, { result_id: 4, version: 0, relevance: 2 });
  assert.equal((await db.document(uuid(1))).data.revealed_at, null);
  const view = await api.cloudAPI("evaluation", uuid(1));
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["A", "B"],
    "modes stay hidden",
  );
  assert.equal(view.comparison, null);
});

await test("a zero grade counts toward the blind reveal", async () => {
  await db.seed(blindEvaluation([3, 3, 3, 3, 3], [3, 3, 3, 3, null]));
  const api = db.backend();
  await rate(api, { result_id: 15, version: 0, relevance: 0 });
  assert.ok((await db.document(uuid(1))).data.revealed_at, '0 is a grade, not "unrated"');
});

await test("the blind reveal needs both sides completed with five results", async () => {
  const short = evaluation(
    [
      run(
        "advanced",
        Array.from({ length: 5 }, (_, i) => graded(i + 1, i + 1, 3)),
      ),
      run(
        "turbo",
        Array.from({ length: 4 }, (_, i) => graded(i + 11, i + 1, null)),
      ),
    ],
    { blind: true, revealed_at: null },
  );
  await db.seed(short);
  const api = db.backend();
  for (let i = 0; i < 4; i++) await rate(api, { result_id: 11 + i, version: 0, relevance: 3 });
  assert.equal(
    (await db.document(uuid(1))).data.revealed_at,
    null,
    "four results cannot complete a blind side",
  );

  await db.reset();
  const failedSide = evaluation(
    [
      run(
        "advanced",
        Array.from({ length: 5 }, (_, i) => graded(i + 1, i + 1, 3)),
      ),
      run(
        "turbo",
        Array.from({ length: 5 }, (_, i) => graded(i + 11, i + 1, 3)),
        { status: "failed" },
      ),
    ],
    { blind: true, revealed_at: null },
  );
  await db.seed(failedSide);
  const second = db.backend();
  await rate(second, { result_id: 1, version: 0, relevance: 3 });
  assert.equal((await db.document(uuid(1))).data.revealed_at, null, "a failed side cannot reveal");
});

await test("clearing a grade after the reveal does not un-reveal", async () => {
  await db.seed(blindEvaluation([3, 3, 3, 3, 3], [3, 3, 3, 3, null]));
  const api = db.backend();
  await rate(api, { result_id: 15, version: 0, relevance: 3 });
  const revealed = (await db.document(uuid(1))).data.revealed_at;
  await rate(api, { result_id: 15, version: 1, relevance: null });
  assert.equal((await db.document(uuid(1))).data.revealed_at, revealed, "the reveal is permanent");
});

// ------------------------------------------------------------- reads

await test("the session view merges table history with legacy document history", async () => {
  const legacyDocument = evaluation(
    [run("fast", [graded(1, 1, 2, { version: 1, actor: "old@parallel.ai" })])],
    {
      feedback_history: [
        {
          result_id: 1,
          version: 1,
          actor: "old@parallel.ai",
          relevance: 2,
          issues: [],
          notes: "",
          judgment: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  );
  await db.seed(legacyDocument);
  const api = db.backend();
  await rate(api, { result_id: 1, version: 1, relevance: 3 }, "new@parallel.ai");
  const view = await api.cloudAPI("evaluation", uuid(1));
  assert.equal(view.feedback_history.length, 2, "both eras of history are visible");
  assert.deepEqual(
    view.feedback_history.map((e) => e.actor),
    ["old@parallel.ai", "new@parallel.ai"],
    "oldest first",
  );
  assert.equal(view.feedback_history.at(-1).relevance, 3);
});

await test("the activity timeline merges the table and the document", async () => {
  await db.seed(
    evaluation([run("fast", [graded(1, 1)])], {
      activity_history: [
        {
          id: uuid(7),
          actor: "ann@parallel.ai",
          action: "created",
          target: "Evaluation",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  const api = db.backend();
  await api.cloudAPI(
    "activity",
    null,
    { evaluation_id: uuid(1), events: [{ id: uuid(8), action: "opened", target: "Result 1" }] },
    "ann@parallel.ai",
  );
  await rate(api, { result_id: 1, version: 0, relevance: 3 });
  const events = await api.cloudAPI("activity", uuid(1));
  assert.deepEqual(
    events.map((e) => e.action),
    ["created", "opened", "feedback saved"],
  );
});

await test("duplicate activity events are ignored", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  const event = { id: uuid(8), action: "clicked", target: "Result 1" };
  await api.cloudAPI("activity", null, { evaluation_id: uuid(1), events: [event] });
  await api.cloudAPI("activity", null, { evaluation_id: uuid(1), events: [event] });
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM evaluation_activity WHERE action='clicked'"))[0].n,
    1,
  );
});

await test("the history list summarizes stored evaluations", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1, 3), graded(2, 2, null)])]));
  await db.seed({
    ...evaluation([run("turbo", [graded(3, 1, 1)])]),
    id: uuid(2),
    created_at: "2026-01-02T00:00:00.000Z",
  });
  const api = db.backend();
  const rows = await api.cloudAPI("evaluations", null);
  assert.equal(rows.length, 2);
  const first = rows.find((r) => r.id === uuid(1));
  assert.equal(first.reviewed, 1);
  assert.equal(first.total, 2);
  assert.equal(first.review_status, "In progress");
  assert.equal(first.modes, "fast");
});

await test("a graded rating is visible in the history list", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 3 });
  const [row] = await api.cloudAPI("evaluations", null);
  assert.equal(row.review_status, "Complete");
  assert.equal(row.reviewed, 1);
  assert.deepEqual(row.reviewers, [{ actor: "ann@parallel.ai", count: 1 }]);
});

// -------------------------------------------------------------- search

const providerResults = (n, prefix = "a") =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/${prefix}${i}`,
    title: `Title ${i}`,
    excerpts: ["snippet"],
    publish_date: null,
  }));

await test("a search stores results and only the response fields the app reads", async () => {
  const api = db.backend({
    search: [
      {
        body: {
          search_id: "s1",
          session_id: "sess",
          usage: [{ tokens: 1 }],
          warnings: ["w"],
          results: providerResults(3),
        },
      },
    ],
  });
  const view = await api.cloudAPI(
    "search",
    null,
    { query: "climate policy", modes: ["fast"] },
    "ann@parallel.ai",
  );
  assert.equal(view.runs[0].status, "completed");
  assert.equal(view.runs[0].results.length, 3);
  const { data } = await db.document(view.id);
  assert.deepEqual(Object.keys(data.runs[0].response).sort(), [
    "search_id",
    "session_id",
    "usage",
    "warnings",
  ]);
  assert.equal(data.runs[0].response.search_id, "s1");
  assert.equal(
    "results" in data.runs[0].response,
    false,
    "the verbatim result copy is not stored twice",
  );
  assert.equal("search_id" in data.runs[0], false, "no duplicated top-level search id");
});

await test("the stored document is materially smaller than the provider payload", async () => {
  const big = Array.from({ length: 10 }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `Title ${i}`,
    excerpts: ["x".repeat(1200)],
    publish_date: null,
  }));
  const api = db.backend({ search: [{ body: { search_id: "s", results: big } }] });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
  const [row] = await db.query(
    "SELECT octet_length(data::text) size FROM evaluations WHERE id=$1",
    [view.id],
  );
  const payload = JSON.stringify({ search_id: "s", results: big }).length;
  assert.ok(row.size < payload * 1.4, `document ${row.size} vs provider payload ${payload}`);
});

await test("a search consumes budget and refuses once the day is spent", async () => {
  await db.query("INSERT INTO search_budget(day,calls) VALUES(CURRENT_DATE,99)");
  const api = db.backend({ search: [{ body: { search_id: "s", results: [] } }] });
  await assert.rejects(
    api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] }),
    (e) => e.status === 429,
  );
  assert.equal(
    (await db.query("SELECT calls FROM search_budget WHERE day=CURRENT_DATE"))[0].calls,
    99,
    "a refused search spends nothing",
  );
  await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
  assert.equal(
    (await db.query("SELECT calls FROM search_budget WHERE day=CURRENT_DATE"))[0].calls,
    100,
  );
});

await test("budget is returned when the evaluation cannot be created", async () => {
  const api = db.backend({
    search: [{ body: { search_id: "s", results: [] } }],
    ids: () => "not-a-uuid-but-fine",
  });
  await db.query("INSERT INTO evaluations(id,data) VALUES($1,$2::jsonb)", [
    "not-a-uuid-but-fine",
    "{}",
  ]);
  await assert.rejects(api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] }));
  const rows = await db.query("SELECT calls FROM search_budget WHERE day=CURRENT_DATE");
  assert.equal(rows[0]?.calls ?? 0, 0, "the two reserved calls are handed back");
});

await test("a failed mode does not lose the completed mode", async () => {
  const api = db.backend({
    search: [
      { body: { search_id: "s1", results: providerResults(3) } },
      { ok: false, status: 502, body: {} },
    ],
  });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["turbo", "advanced"] });
  assert.equal(view.runs[0].status, "completed");
  assert.equal(view.runs[1].status, "failed");
  const { data } = await db.document(view.id);
  assert.equal(data.runs[0].results.length, 3);
  assert.equal(data.runs[1].results.length, 0);
});

await test("a blinded search stores both modes and hides them until the reveal", async () => {
  const api = db.backend({
    search: [
      { body: { search_id: "s1", results: providerResults(5, "a") } },
      { body: { search_id: "s2", results: providerResults(5, "b") } },
    ],
  });
  const view = await api.cloudAPI("search", null, {
    query: "q",
    modes: ["turbo", "advanced"],
    blind: true,
  });
  assert.deepEqual(
    view.runs.map((r) => r.mode),
    ["A", "B"],
  );
  assert.deepEqual(
    view.runs.map((r) => r.elapsed),
    [null, null],
  );
  assert.equal(view.comparison, null);
  const { data } = await db.document(view.id);
  assert.equal(data.blind, true);
  assert.deepEqual(
    data.runs.map((r) => r.mode).sort(),
    ["advanced", "turbo"],
    "the assignment is stored, not lost",
  );
});

await test("a searching evaluation can be rated as soon as one mode lands", async () => {
  const api = db.backend({ search: [{ body: { search_id: "s1", results: providerResults(2) } }] });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
  const target = view.runs[0].results[0];
  const saved = await api.cloudAPI(
    "feedback",
    null,
    { evaluation_id: view.id, result_id: target.id, version: 0, relevance: 3, issues: [] },
    "ann@parallel.ai",
  );
  assert.equal(saved.relevance, 3);
});

// ------------------------------------- full request and response round trips

const searchCases = JSON.parse(
  fs.readFileSync(new URL("./search-cases.json", import.meta.url), "utf8"),
);

await test("a fully populated request survives storage and export unchanged", async () => {
  const api = db.backend({
    search: [
      {
        body: {
          search_id: "s1",
          session_id: "sess",
          usage: [{ name: "search", count: 1 }],
          results: providerResults(6),
        },
      },
      {
        body: {
          search_id: "s2",
          session_id: "sess",
          usage: [{ name: "search", count: 1 }],
          results: providerResults(6),
        },
      },
    ],
  });
  const view = await api.cloudAPI("search", null, {
    search_request: searchCases.request,
    modes: ["fast", "advanced"],
    criteria: "Reviewer only",
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(view.search_request)),
    searchCases.request,
    "shared settings round trip",
  );
  const sent = JSON.parse(api.state.lastSearch.options.body);
  const { mode, ...withoutMode } = sent;
  void mode;
  assert.deepEqual(
    withoutMode,
    searchCases.request,
    "the provider receives the validated request verbatim",
  );
  const saved = await api.cloudAPI("export", view.id);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.runs[0].request)), {
    ...searchCases.request,
    mode: "fast",
  });
  assert.equal(saved.runs[0].response.session_id, "sess");
  assert.deepEqual(saved.runs[0].response.usage, [{ name: "search", count: 1 }]);
  assert.equal(saved.criteria, "Reviewer only");
});

await test("independent per-configuration requests round trip through export", async () => {
  const independent = [
    {
      search_queries: ["documentation"],
      mode: "advanced",
      advanced_settings: {
        max_results: 7,
        source_policy: { include_domains: ["docs.python.org/3"] },
      },
    },
    {
      search_queries: ["documentation"],
      mode: "turbo",
      advanced_settings: {
        max_results: 10,
        source_policy: { include_domains: ["docs.python.org"] },
      },
    },
  ];
  const api = db.backend({
    search: [
      { body: { search_id: "s1", results: providerResults(3) } },
      { body: { search_id: "s2", results: providerResults(3) } },
    ],
  });
  const view = await api.cloudAPI("search", null, {
    search_request: independent[0],
    requests: independent,
    modes: ["advanced", "turbo"],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(view.runs.map((r) => r.request))), independent);
  const saved = await api.cloudAPI("export", view.id);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.runs.map((r) => r.request))), independent);
});

await test("stored results and response survive a rating unchanged", async () => {
  const api = db.backend({
    search: [{ body: { search_id: "s1", session_id: "sess", results: providerResults(4) } }],
  });
  const view = await api.cloudAPI("search", null, { query: "q", modes: ["fast"] });
  const before = await api.cloudAPI("export", view.id);
  await api.cloudAPI(
    "feedback",
    null,
    {
      evaluation_id: view.id,
      result_id: before.runs[0].results[0].id,
      version: 0,
      relevance: 3,
      issues: [],
      notes: "Official source",
    },
    "ann@parallel.ai",
  );
  const after = await api.cloudAPI("export", view.id);
  assert.deepEqual(after.runs[0].response, before.runs[0].response);
  assert.deepEqual(
    after.runs[0].results.map((r) => ({ rank: r.rank, url: r.url, excerpts: r.excerpts })),
    before.runs[0].results.map((r) => ({ rank: r.rank, url: r.url, excerpts: r.excerpts })),
  );
  assert.equal(after.runs[0].results[0].notes, "Official source");
});

await test("a blinded comparison runs, hides, reveals and keeps side order", async () => {
  const api = db.backend({
    search: [
      { body: { search_id: "s1", results: providerResults(6, "a") } },
      { body: { search_id: "s2", results: providerResults(6, "b") } },
    ],
  });
  const blind = await api.cloudAPI("search", null, {
    query: "Docs",
    modes: ["fast", "advanced"],
    blind: true,
  });
  assert.ok(
    blind.runs.every(
      (r) =>
        ["A", "B"].includes(r.mode) &&
        r.request === undefined &&
        r.response === undefined &&
        r.elapsed === null &&
        r.results.length === 5,
    ),
  );
  const order = blind.runs.map((r) => r.id).join(",");
  const results = blind.runs.flatMap((r) => r.results);
  for (const result of results.slice(0, 9))
    await api.cloudAPI(
      "feedback",
      null,
      { evaluation_id: blind.id, result_id: result.id, version: 0, relevance: 3, issues: [] },
      "ann@parallel.ai",
    );
  const hidden = await api.cloudAPI("evaluation", blind.id);
  assert.equal(hidden.feedback_history.length, 9);
  assert.ok(hidden.runs.every((r) => ["A", "B"].includes(r.mode) && !r.request && !r.response));
  assert.equal((await api.cloudAPI("export", blind.id)).revealed_at, null);
  assert.equal((await api.cloudAPI("evaluations", null))[0].modes, "A,B");

  await api.cloudAPI(
    "feedback",
    null,
    { evaluation_id: blind.id, result_id: results[9].id, version: 0, relevance: 1, issues: [] },
    "ann@parallel.ai",
  );
  const revealed = await api.cloudAPI("export", blind.id);
  assert.ok(revealed.revealed_at);
  assert.equal(
    revealed.runs.map((r) => r.id).join(","),
    order,
    "sides keep their assignment through the reveal",
  );
  assert.ok(revealed.runs.every((r) => r.request && r.response));
  assert.ok(
    revealed.runs.every((r) => r.results.length === 5),
    "a blind comparison stays scoped to the top five it was reviewed on, before and after the reveal",
  );
  const { data } = await db.document(blind.id);
  assert.ok(
    data.runs.every((r) => r.results.length === 6),
    "the unreviewed remainder is still stored",
  );
});

await test("a blinded comparison stays hidden when a side fails or returns too few results", async () => {
  for (const scenario of ["failed", "short"]) {
    await db.reset();
    const api = db.backend({
      search:
        scenario === "failed"
          ? [
              { body: { search_id: "s1", results: providerResults(6) } },
              { ok: false, status: 500, body: {} },
            ]
          : [
              { body: { search_id: "s1", results: providerResults(3) } },
              { body: { search_id: "s2", results: providerResults(3) } },
            ],
    });
    const partial = await api.cloudAPI("search", null, {
      query: "Docs",
      modes: ["fast", "advanced"],
      blind: true,
    });
    for (const result of partial.runs.flatMap((r) => r.results))
      await api.cloudAPI(
        "feedback",
        null,
        { evaluation_id: partial.id, result_id: result.id, version: 0, relevance: 3, issues: [] },
        "ann@parallel.ai",
      );
    const snapshot = await api.cloudAPI("export", partial.id);
    assert.equal(snapshot.revealed_at, null, scenario);
    assert.ok(
      snapshot.runs.some((r) => r.status === "completed"),
      scenario,
    );
    if (scenario === "failed") assert.ok(snapshot.runs.some((r) => r.status === "failed"));
  }
});

await test("an invalid rating leaves the document byte-identical", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  const before = JSON.stringify((await db.document(uuid(1))).data);
  await assert.rejects(
    api.cloudAPI("feedback", null, {
      evaluation_id: uuid(1),
      result_id: 1,
      version: 0,
      judgment: "invalid",
    }),
  );
  await assert.rejects(rate(api, { result_id: 1, version: 0, relevance: 7 }));
  assert.equal(JSON.stringify((await db.document(uuid(1))).data), before);
});

// ----------------------------------------------- cross-evaluation stats

await test("grading statistics are queryable without unpacking documents", async () => {
  await db.seed(
    evaluation([
      run("turbo", [graded(1, 1), graded(2, 2)]),
      run("advanced", [graded(3, 1), graded(4, 2)]),
    ]),
  );
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 3 }, "ann@parallel.ai");
  await rate(api, { result_id: 2, version: 0, relevance: 1 }, "ann@parallel.ai");
  await rate(api, { result_id: 3, version: 0, relevance: 2 }, "bob@parallel.ai");
  const rows = await db.query(
    "SELECT actor, count(*)::int n, round(avg(relevance),2)::float mean FROM evaluation_feedback WHERE relevance IS NOT NULL GROUP BY actor ORDER BY actor",
  );
  assert.deepEqual(rows, [
    { actor: "ann@parallel.ai", n: 2, mean: 2 },
    { actor: "bob@parallel.ai", n: 1, mean: 2 },
  ]);
});

await test("every revision of a rating is retained for disagreement analysis", async () => {
  await db.seed(evaluation([run("fast", [graded(1, 1)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 3 }, "ann@parallel.ai");
  await rate(api, { result_id: 1, version: 1, relevance: 1 }, "bob@parallel.ai");
  const rows = await db.query(
    "SELECT actor, relevance, version FROM evaluation_feedback WHERE result_id=1 ORDER BY version",
  );
  assert.deepEqual(
    rows,
    [
      { actor: "ann@parallel.ai", relevance: 3, version: 1 },
      { actor: "bob@parallel.ai", relevance: 1, version: 2 },
    ],
    "the earlier reviewer’s grade is not lost when a second reviewer overwrites it",
  );
});

// ------------------------------------------------- inter-rater agreement

await test("agreement reads each reviewer current grade, not their history", async () => {
  await db.seed(evaluation([run("turbo", [graded(1, 1), graded(2, 2), graded(3, 3)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 0 }, "ann@parallel.ai");
  await rate(api, { result_id: 1, version: 1, relevance: 3 }, "ann@parallel.ai"); // Ann revised
  await rate(api, { result_id: 1, version: 2, relevance: 3 }, "bob@parallel.ai");
  const m = await api.cloudAPI("agreement", uuid(1));
  assert.deepEqual(m.reviewers, ["ann@parallel.ai", "bob@parallel.ai"]);
  assert.equal(m.double_graded, 1);
  assert.equal(m.exact_agreement, 1, "Ann’s superseded 0 must not count against her");
});

await test("agreement measures two reviewers over shared results", async () => {
  const results = Array.from({ length: 4 }, (_, i) => graded(i + 1, i + 1));
  await db.seed(evaluation([run("turbo", results)]));
  const api = db.backend();
  const grades = [
    [3, 3],
    [2, 1],
    [0, 3],
    [1, 1],
  ];
  const version = 0;
  for (const [i, [ann, bob]] of grades.entries()) {
    await rate(api, { result_id: i + 1, version: 0, relevance: ann }, "ann@parallel.ai");
    await rate(api, { result_id: i + 1, version: 1, relevance: bob }, "bob@parallel.ai");
  }
  void version;
  const m = await api.cloudAPI("agreement", uuid(1));
  assert.equal(m.double_graded, 4);
  assert.equal(m.single_graded, 0);
  assert.equal(m.exact_agreement, 0.5);
  assert.equal(m.adjacent_agreement, 0.75);
  assert.equal(m.pairs.length, 1);
  assert.ok(typeof m.kappa === "number");
  assert.deepEqual(
    m.disputed.map((d) => d.result_id),
    [3],
    "the 0-vs-3 result needs adjudication",
  );
});

await test("agreement is empty for an evaluation nobody has graded twice", async () => {
  await db.seed(evaluation([run("turbo", [graded(1, 1), graded(2, 2)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 3 }, "ann@parallel.ai");
  const m = await api.cloudAPI("agreement", uuid(1));
  assert.equal(m.double_graded, 0);
  assert.equal(m.kappa, null);
  assert.equal(m.exact_agreement, null);
});

await test("agreement ignores cleared grades", async () => {
  await db.seed(evaluation([run("turbo", [graded(1, 1)])]));
  const api = db.backend();
  await rate(api, { result_id: 1, version: 0, relevance: 2 }, "ann@parallel.ai");
  await rate(api, { result_id: 1, version: 1, relevance: null }, "bob@parallel.ai");
  const m = await api.cloudAPI("agreement", uuid(1));
  assert.equal(m.double_graded, 0, "clearing a rating is not a second opinion");
  assert.deepEqual(m.reviewers, ["ann@parallel.ai"]);
});

await db.close();
