import { ratingLabel, ratingFilter, meetsNeedThreshold } from "./scoring";
import {
  blinded as hidden,
  evaluationSummary,
  type Evaluation,
  type Run,
  type SearchResult,
} from "./evaluations";
import { settingsDifferences } from "./search-request";

// Copying puts one evaluation on the clipboard; exporting writes the whole snapshot to a file.
export type CopyFormat = "text" | "markdown" | "json";
const escapeCell = (text: string) =>
  text.replace(/[\\`*_{}[\]<>#|]/g, "\\$&").replace(/\r?\n/g, " ");
const plain = (text: string) =>
  text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*```[^\n]*\n?/gm, "");
function context(evaluation: Evaluation) {
  return {
    id: evaluation.id,
    query: evaluation.query,
    criteria: evaluation.criteria,
    created_at: evaluation.created_at,
  };
}
function configuration(evaluation: Evaluation, run: Run) {
  const label =
    run.label || String.fromCharCode(65 + evaluation.runs.findIndex((item) => item.id === run.id));
  return hidden(evaluation)
    ? { id: run.id, label }
    : { id: run.id, label, mode: run.mode, request: run.request };
}
function heading(value: string, format: CopyFormat, level: number) {
  return format === "markdown" ? `${"#".repeat(level)} ${escapeCell(value)}` : plain(value);
}
function metadata(evaluation: Evaluation) {
  return `Evaluation: ${evaluation.id}\nQuery: ${evaluation.query}\nCreated: ${evaluation.created_at}\nCriteria: ${evaluation.criteria || "Correct means relevant to the query."}`;
}
function settings(run: Run, format: CopyFormat) {
  const json = JSON.stringify(run.request ?? {}, null, 2);
  return format === "markdown"
    ? `### API settings\n\n\`\`\`json\n${json}\n\`\`\``
    : `API settings:\n${json}`;
}
function resultText(result: SearchResult, format: CopyFormat) {
  const source =
    format === "markdown" && /^https?:\/\//i.test(result.url)
      ? `[Open source](<${result.url.replace(/[<>\s]/g, encodeURIComponent)}>)`
      : result.url;
  return [
    heading(`${result.rank}. ${result.title}`, format, 3),
    source,
    result.publish_date ? `Published: ${result.publish_date}` : "",
    `Rating: ${ratingLabel(result)} · Issues: ${(result.issues || []).join(", ") || "None"}`,
    format === "text" ? plain(result.excerpts.join("\n\n")) : result.excerpts.join("\n\n"),
    result.notes ? `Notes: ${format === "text" ? plain(result.notes) : result.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function copyResult(
  result: SearchResult,
  format: CopyFormat,
  evaluation: Evaluation,
  run: Run,
): string {
  const config = configuration(evaluation, run);
  if (format === "json")
    return JSON.stringify(
      { evaluation: context(evaluation), configuration: config, result },
      null,
      2,
    );
  return [
    metadata(evaluation),
    `Configuration: ${config.label}${config.mode ? ` · ${config.mode}` : " · Mode hidden"}`,
    !hidden(evaluation) ? settings(run, format) : "",
    resultText(result, format),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function copyConfiguration(evaluation: Evaluation, run: Run, format: CopyFormat): string {
  if (hidden(evaluation)) throw new Error("Complete blind review before copying configurations.");
  return copyEvaluation(
    {
      ...evaluation,
      search_request: run.request || undefined,
      runs: [{ ...run, label: configuration(evaluation, run).label }],
    },
    format,
    "all",
    "configuration",
  );
}
export function copyEvaluation(
  evaluation: Evaluation,
  format: CopyFormat,
  filter = "all",
  scope = "evaluation",
): string {
  if (hidden(evaluation)) throw new Error("Complete blind review before copying the evaluation.");
  const data =
    filter === "all"
      ? evaluation
      : {
          ...evaluation,
          runs: evaluation.runs.map((run) => ({
            ...run,
            results: run.results.filter((result) => ratingFilter(result) === filter),
          })),
        };
  if (format === "json") {
    const scoped = scope !== "evaluation" || filter !== "all";
    const ids = new Set(data.runs.flatMap((run) => run.results.map((result) => result.id)));
    return JSON.stringify(
      {
        ...data,
        ...(scoped
          ? {
              activity_history: undefined,
              feedback_history: data.feedback_history?.filter((event) => ids.has(event.result_id)),
            }
          : {}),
        copy_scope: scope,
        result_filter: filter,
      },
      null,
      2,
    );
  }
  const summary = evaluationSummary(data);
  const differences =
    evaluation.runs[0]?.request && evaluation.runs[1]?.request
      ? settingsDifferences(evaluation.runs[0].request, evaluation.runs[1].request)
      : [];
  const comparison =
    format === "markdown"
      ? [
          "| Configuration | Mode | Mean relevance | Reviewed | Results | Latency |",
          "| --- | --- | ---: | ---: | ---: | --- |",
          ...summary.configurations.map(
            (item, index) =>
              `| ${escapeCell(data.runs[index].label || item.label)} | ${escapeCell(item.mode || "Hidden")} | ${item.mean_relevance == null ? "No ratings yet" : item.mean_relevance.toFixed(2) + "/3"} | ${item.graded} | ${item.total} | ${data.runs[index].elapsed == null ? "Unavailable" : `${data.runs[index].elapsed}s`} |`,
          ),
        ].join("\n")
      : summary.configurations
          .map(
            (item, index) =>
              `${data.runs[index].label || item.label} · ${item.mode}: ${item.mean_relevance == null ? "No ratings yet" : `Mean relevance ${item.mean_relevance.toFixed(2)}/3`} · ${item.graded} reviewed · ${item.total} results · Latency: ${data.runs[index].elapsed == null ? "Unavailable" : `${data.runs[index].elapsed}s`}`,
          )
          .join("\n");
  return [
    heading(evaluation.query, format, 1),
    metadata(evaluation),
    `Scope: ${scope} · ${filter === "all" ? "All results" : `Filtered results: ${filter}`}`,
    comparison,
    evaluation.runs.length > 1
      ? `Settings differences: ${differences.length ? differences.join(", ") : "No other settings differ."}`
      : "",
    ...data.runs.map((run) =>
      [
        heading(
          `Configuration ${run.label || configuration(evaluation, run).label} · ${run.mode}`,
          format,
          2,
        ),
        `Status: ${run.status}`,
        run.error ? `Error: ${run.error}` : "",
        settings(run, format),
        ...run.results.map((result) => resultText(result, format)),
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ------------------------------------------------------------------ export

export type ExportFormat = "json" | "csv" | "jsonl";
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Work only from the export API's authorized snapshot, never from raw provider data.
export function exportRows(snapshot: unknown): RecordValue[] {
  const data = record(snapshot);
  return list(data.runs).flatMap((value) => {
    const run = record(value),
      results = list(run.results);
    return (results.length ? results : [null]).map((value) => {
      const result = record(value);
      return {
        session_id: data.id,
        query: data.query,
        criteria: data.criteria,
        rubric: data.rubric,
        created_at: data.created_at,
        exported_at: data.exported_at,
        blind: data.blind,
        revealed_at: data.revealed_at,
        run_id: run.id,
        mode: run.mode,
        side: run.label,
        run_status: run.status,
        elapsed_seconds: run.elapsed,
        error: run.error,
        request: run.request,
        metrics: run.metrics,
        result_id: result.id,
        rank: result.rank,
        url: result.url,
        title: result.title,
        excerpts: result.excerpts,
        publish_date: result.publish_date,
        last_saved_by:
          result.actor ??
          record(
            list(data.feedback_history).find(
              (event) =>
                record(event).result_id === result.id && record(event).version === result.version,
            ),
          ).actor ??
          null,
        relevance: result.relevance ?? null,
        // Derived from the grade so an export answers the binary question directly.
        meets_need:
          typeof result.relevance === "number" ? result.relevance >= meetsNeedThreshold : null,
        issues: result.issues ?? [],
        rubric_version: result.rubric_version ?? "legacy-binary",
        notes: result.notes,
        version: result.version,
        updated_at: result.updated_at,
        feedback_history: list(data.feedback_history).filter(
          (event) => record(event).result_id === result.id,
        ),
      };
    });
  });
}
function csvCell(value: unknown): string {
  let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet formula safety changes CSV presentation only; JSON remains lossless.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function serializeExport(snapshot: unknown, format: ExportFormat) {
  const data = record(snapshot);
  if (!Array.isArray(data.runs) || typeof data.id !== "string")
    throw new Error("Invalid export response. Reload the evaluation and retry.");
  const document = { ...data, exported_at: data.exported_at || new Date().toISOString() };
  if (format === "json")
    return { text: JSON.stringify(document, null, 2), mime: "application/json;charset=utf-8" };
  const rows = exportRows(document);
  if (format === "jsonl")
    return {
      text: rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
      mime: "application/x-ndjson;charset=utf-8",
    };
  if (format !== "csv") throw new Error("Unsupported export format.");
  const columns = rows.length
    ? Object.keys(rows[0])
    : ["session_id", "query", "run_status", "result_id", "relevance"];
  return {
    text:
      "\ufeff" +
      [
        columns.map(csvCell).join(","),
        ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
      ].join("\r\n") +
      "\r\n",
    mime: "text/csv;charset=utf-8",
  };
}
export function downloadEvaluation(snapshot: unknown, format: ExportFormat) {
  const { text, mime } = serializeExport(snapshot, format);
  const id = String(record(snapshot).id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `search-evaluation-${id}.${format}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
