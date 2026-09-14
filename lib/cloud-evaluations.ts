import {
  reviewed as isReviewed,
  resultMetrics,
  validateRating,
  rubricVersion,
  relevanceLabels,
  agreementMetrics,
  type Rating,
} from "./scoring";
import { validateSearchRequest, type SearchRequest } from "./search-request";
import { createHash, randomUUID, randomInt } from "node:crypto";
import {
  blinded,
  modes,
  evaluationSummary,
  type Evaluation,
  type Run,
  type SearchResult,
} from "./evaluations";
type StoredEvaluation = Evaluation & {
  rubric: string;
  feedback_history: NonNullable<Evaluation["feedback_history"]>;
  blind: boolean;
  revealed_at: string | null;
};
export class APIError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: string,
  ) {
    super(message);
  }
}
export async function sql(query: string, params: unknown[] = []) {
  const connection = process.env.DATABASE_URL;
  if (!connection)
    throw new APIError("Database is not configured.", 503, "database_not_configured");
  const host = new URL(connection).hostname;
  const response = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connection,
      "Neon-Raw-Text-Output": "false",
      "Neon-Array-Mode": "false",
    },
    body: JSON.stringify({ query, params }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new APIError(
      "Database unavailable. Reload saved evaluations before retrying.",
      503,
      "database_unavailable",
    );
  return (await response.json()).rows as Record<string, unknown>[];
}
// Browser-only validators: every cache hit still passes auth and checks database versions.
const revision = process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_SHA || randomUUID();
export async function readCacheTag(operation: string, id: string | null, actor: string) {
  const rows =
    operation === "evaluation"
      ? await sql("SELECT id,version FROM evaluations WHERE id=$1", [id || ""])
      : await sql("SELECT id,version FROM evaluations ORDER BY created_at DESC,id DESC LIMIT 100");
  if (operation === "evaluation" && !rows.length) throw new APIError("Evaluation not found.", 404);
  return cacheTag(operation, id, actor, rows);
}
function cacheTag(operation: string, id: string | null, actor: string, rows: unknown[]) {
  return `"${createHash("sha256")
    .update(JSON.stringify([revision, actor, operation, id, rows]))
    .digest("hex")}"`;
}
function decode(value: unknown): StoredEvaluation {
  return typeof value === "string" ? JSON.parse(value) : (value as StoredEvaluation);
}
// Key-order-independent JSON, for comparing a value against one that has been through jsonb.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
async function load(id: string) {
  const rows = await sql("SELECT data,version FROM evaluations WHERE id=$1", [id]);
  if (!rows.length) throw new APIError("Evaluation not found.", 404, "evaluation_not_found");
  return { data: decode(rows[0].data), version: Number(rows[0].version) };
}
// The grading audit trail lives in evaluation_feedback; evaluations saved before that
// table existed keep theirs inside the document, so reads merge both sources.
const HISTORY_LIMIT = 2000;
async function feedbackHistory(id: string) {
  const rows = await sql(
    `SELECT event FROM (
   (SELECT jsonb_build_object('result_id',result_id,'actor',actor,'relevance',relevance,'issues',issues,
      'rubric_version',rubric_version,'notes',notes,'version',version,
      'created_at',created_at) AS event, created_at, version AS tiebreak
     FROM evaluation_feedback WHERE evaluation_id=$1 ORDER BY created_at DESC,id DESC LIMIT ${HISTORY_LIMIT})
   UNION ALL
   (SELECT event,(event->>'created_at')::timestamptz,(event->>'version')::int
     FROM evaluations e CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'feedback_history','[]'::jsonb)) event
     WHERE e.id=$1 ORDER BY 2 DESC LIMIT ${HISTORY_LIMIT})
   ) timeline ORDER BY created_at DESC,tiebreak DESC LIMIT ${HISTORY_LIMIT}`,
    [id],
  );
  return rows.map((row) => row.event).reverse() as StoredEvaluation["feedback_history"];
}

// One statement records a rating: it locates the result inside the document, rewrites only
// that element, and appends to both trails. The guard and the merge both read e.data, the row
// being written, so a blocked writer re-checks the committed version under READ COMMITTED
// instead of comparing against its pre-lock snapshot and clobbering it.
const saveFeedback = `WITH located AS MATERIALIZED (
   SELECT ARRAY['runs',(r.ordinal-1)::text,'results',(x.ordinal-1)::text] AS path,
          e.data->>'blind' AS blind,e.data->>'revealed_at' AS revealed_at
   FROM evaluations e
   CROSS JOIN LATERAL jsonb_array_elements(e.data->'runs') WITH ORDINALITY r(value,ordinal)
   CROSS JOIN LATERAL jsonb_array_elements(r.value->'results') WITH ORDINALITY x(result,ordinal)
   WHERE e.id=$1 AND x.result->>'id'=$2 LIMIT 1
 ), updated AS (
   UPDATE evaluations e
   SET data=jsonb_set(e.data,l.path,(e.data #> l.path) || $3::jsonb),version=e.version+1
   FROM located l
   WHERE e.id=$1
     AND e.data #>> (l.path || ARRAY['id'])=$2
     AND (e.data #>> (l.path || ARRAY['version']))::int=$4
   RETURNING (e.data #> l.path) || $3::jsonb AS result,l.blind AS blind,l.revealed_at AS revealed_at
 ), history AS (
   INSERT INTO evaluation_feedback(evaluation_id,result_id,actor,relevance,issues,rubric_version,notes,version)
   SELECT $1,$2::bigint,u.result->>'actor',(u.result->>'relevance')::smallint,
          COALESCE(u.result->'issues','[]'::jsonb),u.result->>'rubric_version',
          COALESCE(u.result->>'notes',''),(u.result->>'version')::int
   FROM updated u ON CONFLICT DO NOTHING RETURNING id
 ), trail AS (
   INSERT INTO evaluation_activity(id,evaluation_id,actor,action,target)
   SELECT $5::uuid,$1,u.result->>'actor','feedback saved',
     left('Result '||$2||': '||
       CASE WHEN u.result->'relevance'='null'::jsonb OR u.result->'relevance' IS NULL THEN 'Unrated'
            ELSE (u.result->>'relevance')||' — '||($6::jsonb->>(u.result->>'relevance')::int) END
       ||'; notes '||CASE WHEN COALESCE(u.result->>'notes','')<>'' THEN 'saved' ELSE 'empty' END,200)
   FROM updated u ON CONFLICT(id) DO NOTHING RETURNING id
 )
 SELECT (SELECT count(*) FROM located) AS located,(SELECT result FROM updated) AS result,
        (SELECT blind FROM updated) AS blind,(SELECT revealed_at FROM updated) AS revealed_at`;

// Reveal a blinded comparison once the first five results on both sides are graded.
// Expressed in SQL so the check reads the document Postgres just wrote, not a stale copy.
const revealBlind = `UPDATE evaluations
 SET data=jsonb_set(data,ARRAY['revealed_at'],to_jsonb($2::text)),version=version+1
 WHERE id=$1 AND data->>'blind'='true' AND data->>'revealed_at' IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(data->'runs') r
     WHERE r.value->>'status'<>'completed' OR jsonb_array_length(r.value->'results')<5
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.value->'results') WITH ORDINALITY x(result,ordinal)
          WHERE x.ordinal<=5 AND (x.result->'relevance' IS NULL OR x.result->'relevance'='null'::jsonb))
   )
 RETURNING data->>'revealed_at' AS revealed_at`;
function view(
  evaluation: StoredEvaluation,
  exported = false,
  history?: StoredEvaluation["feedback_history"],
) {
  let data = history ? { ...evaluation, feedback_history: history } : evaluation;
  if (!data.search_request && data.runs[0]?.request) {
    const { mode, ...shared } = data.runs[0].request;
    void mode;
    data = { ...data, search_request: shared };
  }
  const runs = data.runs.map((run, index) => {
    const results = data.blind ? run.results.slice(0, 5) : run.results;
    return { ...run, results, label: index === 0 ? "A" : "B", metrics: resultMetrics(results) };
  });
  if (blinded(data))
    return {
      ...data,
      feedback_history: data.feedback_history,
      runs: runs.map((r) => ({
        id: r.id,
        label: r.label,
        mode: r.label,
        status: r.status,
        elapsed: null,
        error: r.error,
        results: r.results,
        metrics: r.metrics,
      })),
      comparison: null,
    };
  let comparison = null;
  if (runs.length === 2) {
    const [a, b] = runs,
      k = Math.min(5, a.results.length, b.results.length),
      complete =
        k > 0 &&
        runs.every((r) => r.status === "completed" && r.results.slice(0, k).every(isReviewed));
    comparison = {
      top_k: k,
      review_complete: complete,
      shared_urls: new Set(
        a.results.filter((x) => b.results.some((y) => y.url === x.url)).map((x) => x.url),
      ).size,
      rank_score_at_5: Object.fromEntries(
        runs.map((r) => [
          runs[0].mode === runs[1].mode ? r.label : r.mode,
          r.metrics.rank_score_at_5,
        ]),
      ),
    };
  }
  return {
    ...data,
    runs,
    comparison,
    scoring: evaluationSummary(data).outcome,
    ...(exported
      ? { exported_at: new Date().toISOString() }
      : { feedback_history: data.feedback_history }),
  };
}
function text(value: unknown, max: number, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new APIError(`Enter ${required ? "1–" : "up to "}${max} characters.`);
  return value.trim();
}
export const historyQuery = `SELECT jsonb_build_object(
  'id',e.id,'query',e.data->'query','criteria',e.data->'criteria','created_at',e.data->'created_at',
  'blind',e.data->'blind','revealed_at',e.data->'revealed_at',
  'runs',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'mode',run->'mode','status',run->'status','elapsed',run->'elapsed',
    'request',CASE WHEN jsonb_typeof(run->'request')='object' THEN jsonb_build_object('advanced_settings',run->'request'->'advanced_settings','max_chars_total',run->'request'->'max_chars_total','session_id',run->'request'->'session_id','client_model',run->'request'->'client_model') ELSE NULL END,
    'results',COALESCE((SELECT jsonb_agg(jsonb_build_object('actor',result->'actor','relevance',result->'relevance','issues',result->'issues','rubric_version',result->'rubric_version') ORDER BY rank)
      FROM jsonb_array_elements(run->'results') WITH ORDINALITY r(result,rank)),'[]'::jsonb)
  ) ORDER BY position) FROM jsonb_array_elements(e.data->'runs') WITH ORDINALITY r(run,position)),'[]'::jsonb)
) AS data,e.id,e.version FROM (SELECT id,version,data,created_at FROM evaluations ORDER BY created_at DESC,id DESC LIMIT 100) e ORDER BY e.created_at DESC,e.id DESC`;

// One current grade per (result, reviewer): a reviewer's own revisions collapse to their
// latest, so changing your mind does not register as disagreeing with yourself.
const agreementQuery = `SELECT DISTINCT ON (result_id,actor) result_id,actor,relevance
  FROM evaluation_feedback WHERE evaluation_id=$1 AND relevance IS NOT NULL
  ORDER BY result_id,actor,version DESC`;

// Read summaries and their cache versions from the same database snapshot.
export async function readEvaluationHistory(actor: string, id: string | null = null) {
  const rows = await sql(historyQuery);
  const body = rows.map((row) => {
    const d = decode(row.data);
    return {
      ...evaluationSummary(d),
      id: d.id,
      query: d.query,
      criteria: d.criteria,
      created_at: d.created_at,
      blind: d.blind,
      revealed_at: d.revealed_at,
      modes: blinded(d) ? "A,B" : d.runs.map((r) => r.mode).join(","),
      reviewed: d.runs.reduce(
        (n, r) => n + (d.blind ? r.results.slice(0, 5) : r.results).filter(isReviewed).length,
        0,
      ),
      total: d.runs.reduce(
        (n, r) => n + (d.blind ? Math.min(5, r.results.length) : r.results.length),
        0,
      ),
    };
  });
  return {
    body,
    etag: cacheTag(
      "evaluations",
      id,
      actor,
      rows.map(({ id, version }) => ({ id, version })),
    ),
  };
}

// Fetch the document and its review history concurrently; the document supplies its own version.
export async function readEvaluation(actor: string, id: string, exported = false) {
  const [{ data, version }, history] = await Promise.all([load(id), feedbackHistory(id)]);
  return {
    body: view(data, exported, history),
    etag: cacheTag("evaluation", id, actor, [{ id, version }]),
  };
}

export async function cloudAPI(
  operation: string,
  id: string | null,
  payload?: Record<string, unknown>,
  actor = "Unknown reviewer",
) {
  if (operation === "activity") {
    if (!payload) {
      // Read only the latest events, never the full search responses.
      const rows = await sql(
        `SELECT event FROM (
       (SELECT jsonb_build_object('id',id,'actor',actor,'action',action,'target',target,'created_at',created_at) AS event, created_at
        FROM evaluation_activity WHERE evaluation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100)
       UNION ALL
       (SELECT event,(event->>'created_at')::timestamptz AS created_at
        FROM evaluations e CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.data->'activity_history','[]'::jsonb)) event
        WHERE e.id=$1 ORDER BY created_at DESC LIMIT 100)
       ) timeline ORDER BY created_at DESC,event->>'id' DESC LIMIT 100`,
        [id || ""],
      );
      return rows.map((row) => row.event).reverse();
    }
    const evaluationId = text(payload.evaluation_id, 100, true);
    if (!Array.isArray(payload.events) || !payload.events.length || payload.events.length > 20)
      throw new APIError("Send 1–20 activity events.");
    const events = payload.events.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new APIError("Invalid activity.");
      const event = value as Record<string, unknown>,
        id = text(event.id, 36, true),
        action = text(event.action, 30, true),
        target = text(event.target, 200, true);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        !["opened", "clicked"].includes(action)
      )
        throw new APIError("Invalid activity.");
      return { id, action, target };
    });
    await sql(
      `INSERT INTO evaluation_activity(id,evaluation_id,actor,action,target)
     SELECT event.id,$1,$2,event.action,event.target
     FROM jsonb_to_recordset($3::jsonb) AS event(id uuid,action text,target text)
     ON CONFLICT(id) DO NOTHING`,
      [evaluationId, actor, JSON.stringify(events)],
    );
    return { saved: true };
  }
  if (operation === "agreement") {
    const rows = await sql(agreementQuery, [id || ""]);
    return agreementMetrics(
      rows.map((row) => ({
        result_id: Number(row.result_id),
        actor: String(row.actor),
        relevance: Number(row.relevance),
      })) as Rating[],
    );
  }
  if (operation === "evaluations") return (await readEvaluationHistory(actor || "", id)).body;
  if (operation === "evaluation" || operation === "export")
    return (await readEvaluation(actor || "", id || "", operation === "export")).body;
  if (operation === "feedback") {
    const p = payload!,
      rid = p.result_id;
    if (!Number.isSafeInteger(rid) || !Number.isSafeInteger(p.version) || (p.version as number) < 0)
      throw new APIError("Invalid feedback.");
    if (!("relevance" in p)) throw new APIError("Invalid feedback.");
    try {
      validateRating(p);
    } catch (e) {
      throw new APIError((e as Error).message);
    }
    const notes = "notes" in p ? text(p.notes, 2000) : undefined;
    let evaluationId = p.evaluation_id === undefined ? null : text(p.evaluation_id, 100, true);
    if (!evaluationId) {
      const rows = await sql("SELECT id FROM evaluations WHERE data @> $1::jsonb", [
        JSON.stringify({ runs: [{ results: [{ id: rid }] }] }),
      ]);
      if (!rows.length) throw new APIError("Result not found.", 404, "result_not_found");
      evaluationId = String(rows[0].id);
    }
    const updatedAt = new Date().toISOString(),
      version = (p.version as number) + 1;
    const patch = {
      relevance: p.relevance,
      issues: p.issues,
      rubric_version: rubricVersion,
      ...(notes === undefined ? {} : { notes }),
      actor,
      version,
      updated_at: updatedAt,
    };
    const [row] = await sql(saveFeedback, [
      evaluationId,
      String(rid),
      JSON.stringify(patch),
      p.version,
      randomUUID(),
      JSON.stringify(relevanceLabels),
    ]);
    if (!row || !Number(row.located))
      throw new APIError("Result not found.", 404, "result_not_found");
    if (!row.result)
      throw new APIError("Result changed. Reload before saving.", 409, "stale_result_version");
    const result = row.result as SearchResult;
    if (row.blind === "true" && !row.revealed_at) await sql(revealBlind, [evaluationId, updatedAt]);
    return {
      relevance: result.relevance,
      issues: result.issues,
      rubric_version: result.rubric_version,
      actor,
      result_id: rid,
      notes: result.notes ?? "",
      version,
      updated_at: updatedAt,
    };
  }
  if (operation !== "search") throw new APIError("Not found.", 404, "unknown_operation");
  const p = payload!,
    criteria = text(p.criteria ?? "", 2000),
    selected = p.modes;
  let sharedRequest: SearchRequest;
  try {
    sharedRequest = validateSearchRequest(
      p.search_request ?? { search_queries: [text(p.query, 200, true)], max_chars_total: 12000 },
      Array.isArray(selected) ? (p.requests === undefined ? selected : selected.slice(0, 1)) : [],
      p.blind === true,
    );
  } catch (e) {
    throw new APIError(e instanceof Error ? e.message : "Invalid search settings.");
  }
  const { mode: ignoredMode, ...search_request } = sharedRequest;
  void ignoredMode;
  const query = search_request.search_queries.join(" · ");
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length > 2 ||
    selected.some((m) => !modes.includes(m))
  )
    throw new APIError("Choose one or two supported modes.");
  if ((p.blind !== undefined && typeof p.blind !== "boolean") || (p.blind && selected.length !== 2))
    throw new APIError("Blind review requires two modes.");
  let requests = selected.map((mode) => ({ ...search_request, mode }));
  if (p.requests !== undefined) {
    if (!Array.isArray(p.requests) || p.requests.length !== selected.length)
      throw new APIError("Provide one request per configuration.");
    try {
      requests = p.requests.map((value, index) => {
        const request = validateSearchRequest(value, [selected[index]], p.blind === true);
        if (
          request.mode !== selected[index] ||
          JSON.stringify(request.search_queries) !==
            JSON.stringify(search_request.search_queries) ||
          (request.objective || "") !== (search_request.objective || "")
        )
          throw new Error(
            "Configurations must share queries and objective, and match the selected modes.",
          );
        return { ...request, mode: selected[index] };
      });
    } catch (e) {
      throw new APIError(e instanceof Error ? e.message : "Invalid configuration.");
    }
  }
  if (p.blind && randomInt(2)) requests.reverse();
  if (!process.env.PARALLEL_API_KEY)
    throw new APIError("Search is not configured.", 503, "search_not_configured");
  // A search spends Parallel credits, so a submission retried after a timeout must not run
  // twice. The caller's idempotency key becomes the evaluation id: a replay finds the stored
  // row and returns the original evaluation instead of searching again. Reusing one key for a
  // different search is rejected rather than silently answered with the wrong evaluation.
  const key = p.idempotency_key === undefined ? null : text(p.idempotency_key, 36, true);
  if (key && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
    throw new APIError("Send idempotency_key as a UUID.", 400, "invalid_idempotency_key");
  // Blinded searches shuffle run order, so the fingerprint sorts the requests to stay stable.
  // The stored side has been through jsonb, which reorders object keys by length then bytewise,
  // so both sides are serialized with sorted keys. Comparing raw JSON.stringify would make every
  // replay a false conflict — exactly the retry this key exists to make free.
  const fingerprint = (rs: unknown[]) =>
    JSON.stringify([query, criteria, p.blind === true, rs.map((r) => canonical(r ?? null)).sort()]);
  const submitted = fingerprint(requests);
  const replay = async () => {
    const { data: existing } = await load(key!);
    if (fingerprint(existing.runs.map((r) => r.request)) !== submitted)
      throw new APIError(
        "This idempotency_key was used for a different search.",
        409,
        "idempotency_key_conflict",
      );
    return view(existing, false, await feedbackHistory(key!));
  };
  if (key && (await sql("SELECT 1 FROM evaluations WHERE id=$1", [key])).length) return replay();
  // ponytail: shared interview workspace; a fixed daily cap bounds API spending.
  const budget = await sql(
    "INSERT INTO search_budget(day,calls) VALUES(CURRENT_DATE,$1) ON CONFLICT(day) DO UPDATE SET calls=search_budget.calls+$1 WHERE search_budget.calls+$1<=100 RETURNING calls",
    [selected.length],
  );
  if (!budget.length) throw new APIError("Daily search limit reached. Try again after midnight UTC.", 429, "daily_search_limit");
  const refund = async () => {
    try {
      await sql("UPDATE search_budget SET calls=GREATEST(calls-$1,0) WHERE day=CURRENT_DATE", [
        selected.length,
      ]);
    } catch {
      /* the cap resets daily; a lost refund only tightens it */
    }
  };
  const data: StoredEvaluation = {
    search_request,
    blind: p.blind === true,
    revealed_at: null,
    id: key ?? randomUUID(),
    query,
    criteria,
    created_at: new Date().toISOString(),
    rubric:
      "Grades 2 and 3 count as correct for the query and evaluation criteria. Grades measure relevance, not factual accuracy.",
    activity_history: [
      {
        id: randomUUID(),
        actor,
        action: "created",
        target: "Evaluation",
        created_at: new Date().toISOString(),
      },
    ],
    feedback_history: [],
    runs: requests.map((request) => ({
      id: randomUUID(),
      mode: request.mode,
      request,
      status: "running",
      elapsed: null,
      error: null,
      results: [],
    })),
  };
  // Two identical submissions can race past the lookup above; the loser's insert conflicts and
  // it returns the winner's evaluation, so one key never produces two searches.
  let claimed: Record<string, unknown>[];
  try {
    claimed = await sql(
      "INSERT INTO evaluations(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING RETURNING id",
      [data.id, JSON.stringify(data)],
    );
  } catch (e) {
    await refund();
    throw e;
  }
  if (!claimed.length) {
    await refund();
    return replay();
  }
  // Save each completed mode independently; merge against the latest document to preserve concurrent feedback.
  await Promise.all(
    data.runs.map(async (initial, index) => {
      const started = Date.now(),
        run: Run = { ...initial };
      const request = run.request!;
      try {
        const response = await fetch("https://api.parallel.ai/v1/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.PARALLEL_API_KEY!,
          },
          body: JSON.stringify(request),
          cache: "no-store",
          signal: AbortSignal.timeout(90000),
        });
        if (!response.ok) throw new APIError(`Search returned HTTP ${response.status}.`);
        const raw = await response.json();
        if (
          typeof raw.search_id !== "string" ||
          !Array.isArray(raw.results) ||
          raw.results.some(
            (r: SearchResult) =>
              !r ||
              typeof r.url !== "string" ||
              !Array.isArray(r.excerpts) ||
              r.excerpts.some((x) => typeof x !== "string") ||
              (r.title != null && typeof r.title !== "string") ||
              (r.publish_date != null && typeof r.publish_date !== "string"),
          )
        )
          throw new APIError("Invalid Search response.");
        run.response = {
          search_id: raw.search_id,
          session_id: raw.session_id ?? null,
          usage: raw.usage ?? null,
          warnings: raw.warnings ?? null,
        };
        // 48 random bits stay within JavaScript's safe integer range.
        run.results = raw.results.map((r: SearchResult, rank: number) => ({
          id: parseInt(randomUUID().replaceAll("-", "").slice(0, 12), 16),
          rank: rank + 1,
          url: r.url,
          title: r.title || r.url,
          excerpts: r.excerpts,
          publish_date: r.publish_date || null,
          relevance: null,
          issues: [],
          rubric_version: rubricVersion,
          notes: "",
          version: 0,
          updated_at: null,
        }));
        run.status = "completed";
      } catch (e) {
        run.status = "failed";
        run.error =
          e instanceof APIError
            ? e.message
            : "Search interrupted. Check saved evaluations before retrying.";
      }
      run.elapsed = (Date.now() - started) / 1000;
      const saved = await sql(
        `UPDATE evaluations SET data=jsonb_set(data,ARRAY['runs',$3],$1::jsonb),version=version+1
   WHERE id=$2 AND data #>> ARRAY['runs',$3,'id']=$4 AND data #>> ARRAY['runs',$3,'status']='running' RETURNING id`,
        [JSON.stringify(run), data.id, String(index), run.id],
      );
      if (!saved.length)
        throw new APIError(
          "Could not save search. Reload evaluations.",
          409,
          "concurrent_run_write",
        );
    }),
  );
  return (await readEvaluation(actor || "", data.id)).body;
}
