import {
  reviewed as isReviewed,
  relevanceMetrics,
  type resultMetrics,
  type Scored,
} from "./scoring";
import type { SearchRequest } from "./search-request";
export type SearchResult = Scored & {
  actor?: string;
  id: number;
  rank: number;
  url: string;
  title: string;
  excerpts: string[];
  publish_date: string | null;
  notes: string;
  version: number;
  updated_at: string | null;
};
export type Run = {
  label?: string;
  metrics?: ReturnType<typeof resultMetrics>;
  id: string;
  mode: string;
  status: string;
  elapsed: number | null;
  error: string | null;
  results: SearchResult[];
  request?: SearchRequest | null;
  response?: {
    search_id?: string;
    session_id?: string;
    usage?: unknown[];
    warnings?: unknown[];
  } | null;
};
export type ActivityEvent = {
  id: string;
  actor: string;
  action: string;
  target: string;
  created_at: string;
};
export type FeedbackEvent = Scored & {
  actor?: string;
  result_id: number;
  notes: string;
  version: number;
  created_at: string;
};
export type Evaluation = {
  activity_history?: ActivityEvent[];
  feedback_history?: FeedbackEvent[];
  search_request?: SearchRequest;
  blind?: boolean;
  revealed_at?: string | null;
  id: string;
  query: string;
  criteria: string;
  created_at: string;
  runs: Run[];
};
export type HistoryItem = Omit<Evaluation, "runs"> & {
  modes: string;
  reviewed: number;
  total: number;
};
export const modes = ["turbo", "fast", "basic", "advanced"];
export const blinded = (e: Pick<Evaluation, "blind" | "revealed_at">) =>
  Boolean(e.blind && !e.revealed_at);
export function safeURL(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
const pendingReads = new Map<string, Promise<unknown>>();
export function clearAPIReads() {
  pendingReads.clear();
}
export async function api<T>(
  path: string,
  body?: unknown,
  options: { fresh?: boolean } = {},
): Promise<T> {
  const read = body === undefined;
  if (!read) clearAPIReads();
  if (read && !options.fresh && pendingReads.has(path))
    return structuredClone(await pendingReads.get(path)) as T;
  const request = (async () => {
    const response = await fetch(
      `/api/${path}`,
      read
        ? { cache: options.fresh ? "no-store" : "no-cache" }
        : {
            method: "POST",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "SearchEvaluations",
            },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Request failed. Refresh saved evaluations before retrying.");
    return data;
  })();
  if (read && !options.fresh) pendingReads.set(path, request);
  try {
    return structuredClone(await request) as T;
  } finally {
    if (!read) clearAPIReads();
    if (pendingReads.get(path) === request) pendingReads.delete(path);
  }
}

export function reviewerName(email: string): string {
  return email.toLowerCase() === "eas.vone@gmail.com" ? "Zachary Roth" : email;
}

// ----------------------------------------------------------------- summary

export function evaluationSummary(evaluation: Evaluation) {
  const hidden = blinded(evaluation);
  // A blinded evaluation reports only the five results both sides are compared on.
  const visible = (run: Run) => (evaluation.blind ? run.results.slice(0, 5) : run.results);
  const settingValues = evaluation.runs.map((run) => {
    const request = run.request,
      advanced = request?.advanced_settings,
      source = advanced?.source_policy;
    const included = source?.include_domains?.filter(Boolean) || [],
      excluded = source?.exclude_domains?.filter(Boolean) || [];
    return {
      Sources: included.length
        ? `Only ${included.join(", ")}`
        : excluded.length
          ? `Exclude ${excluded.join(", ")}`
          : "All sources",
      "Published since": source?.after_date,
      Country: advanced?.location?.toUpperCase(),
      "Maximum results": advanced?.max_results,
      "Characters per result": advanced?.excerpt_settings?.max_chars_per_result,
      "Total characters": request?.max_chars_total,
      "Cache age (s)": advanced?.fetch_policy?.max_age_seconds,
      "Fetch timeout (s)": advanced?.fetch_policy?.timeout_seconds,
      "Cache fallback":
        advanced?.fetch_policy?.disable_cache_fallback == null
          ? undefined
          : advanced.fetch_policy.disable_cache_fallback
            ? "Off"
            : "On",
      "API session": request?.session_id,
      "Client model": request?.client_model,
    };
  });
  const keys = Object.keys(settingValues[0] || {}) as (keyof (typeof settingValues)[number])[];
  const activeKeys = keys.filter((key) => settingValues.some((settings) => settings[key] != null));
  const sharedKeys =
    evaluation.runs.length > 1 && evaluation.runs.every((run) => run.request)
      ? activeKeys.filter((key) =>
          settingValues.every((settings) => settings[key] === settingValues[0][key]),
        )
      : [];
  const describe = (settings: (typeof settingValues)[number], key: keyof typeof settings) =>
    key === "Sources" ? settings[key] : `${key}: ${settings[key] ?? "API default"}`;
  // The request field each display label stands for, so pooled findings name what was sent.
  const apiFields: Record<string, string> = {
    Sources: "source_policy",
    "Published since": "after_date",
    Country: "location",
    "Maximum results": "max_results",
    "Characters per result": "max_chars_per_result",
    "Total characters": "max_chars_total",
    "Cache age (s)": "max_age_seconds",
    "Fetch timeout (s)": "timeout_seconds",
    "Cache fallback": "disable_cache_fallback",
    "API session": "session_id",
    "Client model": "client_model",
  };
  // Which request fields this comparison actually varied. Empty while a blinded evaluation is
  // unrevealed, so an unfinished blind review contributes nothing to the pooled findings.
  const differences =
    hidden || evaluation.runs.length !== 2 || !evaluation.runs.every((run) => run.request)
      ? []
      : [
          ...(evaluation.runs[0].mode !== evaluation.runs[1].mode
            ? [{ field: "mode", a: evaluation.runs[0].mode, b: evaluation.runs[1].mode }]
            : []),
          ...activeKeys
            .filter((key) => !sharedKeys.includes(key))
            .map((key) => ({
              field: apiFields[key] || String(key),
              a: String(settingValues[0][key] ?? "API default"),
              b: String(settingValues[1][key] ?? "API default"),
            })),
        ];
  const sharedSettings = hidden
    ? null
    : sharedKeys.map((key) => describe(settingValues[0], key)).join(" · ");
  const configurations = evaluation.runs.map((run, index) => {
    const results = visible(run);
    return {
      ...relevanceMetrics(results),
      label: index === 0 ? "A" : "B",
      mode: hidden ? null : run.mode,
      elapsed: hidden ? null : (run.elapsed ?? null),
      status: run.status,
      settings: hidden
        ? null
        : !run.request
          ? "Settings not recorded"
          : activeKeys
              .filter((key) => !sharedKeys.includes(key))
              .map((key) => describe(settingValues[index], key))
              .join(" · "),
      total: results.length,
    };
  });
  const reviewed = configurations.reduce((sum, run) => sum + run.graded, 0);
  const total = configurations.reduce((sum, run) => sum + run.total, 0);
  const incomplete = configurations.some((run) => run.status !== "completed");
  const status = configurations.some((run) => run.status === "running")
    ? "Searching"
    : incomplete
      ? "Search failed"
      : evaluation.blind && configurations.some((run) => run.total < 5)
        ? "Insufficient results"
        : total === 0
          ? "No results"
          : reviewed === total
            ? "Complete"
            : reviewed === 0
              ? "Not started"
              : "In progress";
  const reviewers = new Map<string, number>();
  for (const run of evaluation.runs)
    for (const result of visible(run)) {
      if (!isReviewed(result)) continue;
      const actor =
        result.actor ||
        evaluation.feedback_history?.find(
          (event) => event.result_id === result.id && event.version === result.version,
        )?.actor ||
        "Unknown reviewer";
      reviewers.set(actor, (reviewers.get(actor) || 0) + 1);
    }
  let outcome = {
    title: "No comparison",
    detail: "This evaluation contains one search.",
    winner: null as string | null,
  };
  if (evaluation.runs.length === 2) {
    const [a, b] = configurations;
    const ready =
      !hidden && !incomplete && a.rank_score_at_5 !== null && b.rank_score_at_5 !== null;
    const ungraded = evaluation.runs
      .flatMap((run) => run.results.slice(0, 5))
      .filter((result) => result.relevance == null).length;
    const winner =
      ready && Math.abs(a.rank_score_at_5! - b.rank_score_at_5!) > 0.000001
        ? a.rank_score_at_5! > b.rank_score_at_5!
          ? "A"
          : "B"
        : null;
    const names = configurations.map((configuration) => {
      const mode = configuration.mode;
      const name = mode ? mode[0].toUpperCase() + mode.slice(1) : configuration.label;
      return a.mode === b.mode
        ? `${name} · ${configuration.settings || configuration.label}`
        : name;
    });
    const winnerName = names[winner === "A" ? 0 : 1];
    outcome = ready
      ? {
          title: winner
            ? `${winnerName} ${reviewed < total ? "leads" : "performed better"}`
            : "Tie",
          winner,
          detail: `Rank-weighted top 5: ${names[0]} ${a.rank_score_at_5!.toFixed(1)}/100 · ${names[1]} ${b.rank_score_at_5!.toFixed(1)}/100${reviewed < total ? ". Top five graded on both sides; full review is incomplete." : ""}`,
        }
      : {
          title: "Not decided",
          winner: null,
          detail: incomplete
            ? "Both searches must return results."
            : evaluation.runs.some((run) => run.results.length < 5)
              ? "Each configuration needs five results to compare."
              : hidden && !ungraded
                ? "Complete the blind review to reveal the comparison."
                : `Grade ${ungraded} more top-five ${ungraded === 1 ? "result" : "results"} to compare.`,
        };
  }
  return {
    outcome,
    differences,
    sharedSettings,
    configurations,
    review_status: status,
    reviewed,
    total,
    reviewers: [...reviewers].map(([actor, count]) => ({ actor, count })),
  };
}
export type EvaluationHistoryItem = HistoryItem & ReturnType<typeof evaluationSummary>;
