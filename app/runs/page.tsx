"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { History, Search, Plus, SlidersHorizontal, ChevronDown } from "lucide-react";
import { WorkspaceNav } from "@/components/workspace-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverTrigger, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import {
  reviewerName,
  api,
  modes,
  type EvaluationHistoryItem as HistoryItem,
} from "@/lib/evaluations";
import { Progress } from "@/components/ui/progress";
import { axisAggregates, significanceLevel } from "@/lib/scoring";

/**
 * What every graded comparison says once the ones that varied the same request field are pooled.
 * A single query cannot separate a real quality gap from one query's quirks, so nothing here
 * names a winner until the win-loss split clears an exact two-sided sign test.
 */
function Findings({ runs, truncated }: { runs: HistoryItem[]; truncated: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const { axes, confounded } = axisAggregates(runs);
  // Who graded the pooled comparisons. A finding is only as good as the grades behind it, and
  // some of the grades in the deployed workspace are generated rather than human review.
  const graders = [
    ...new Set(runs.flatMap((run) => (run.reviewers || []).map((entry) => entry.actor))),
  ]
    .map(reviewerName)
    .sort();
  const generated = graders.some((grader) => /\(generated\)/i.test(grader));
  const label = (value: string) => value[0].toUpperCase() + value.slice(1).replaceAll("_", " ");
  if (!axes.length)
    return (
      <p className="rounded-lg border bg-card px-5 py-4 text-sm text-muted-foreground">
        No findings yet. Compare the same settings across several queries. Grade the first five
        results on both sides to compare their scores.
      </p>
    );
  return (
    <section
      aria-label="Findings by axis"
      className="max-h-[45vh] shrink-0 overflow-auto border-b bg-card text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-2">
        <h2 className="font-semibold">
          {generated ? "Demo findings by axis" : "Findings by axis"}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={showDetails}
          aria-controls="finding-rows finding-methodology"
          onClick={() => setShowDetails(!showDetails)}
        >
          {showDetails ? "Hide details" : "Show details"}
          <ChevronDown aria-hidden="true" className={showDetails ? "rotate-180" : ""} />
        </Button>
        {generated && (
          <p className="basis-full pb-1 text-xs text-muted-foreground">
            Includes generated sample grades; these findings do not establish real search quality.
          </p>
        )}
      </div>
      <div
        id="finding-methodology"
        hidden={!showDetails}
        className="space-y-1 border-t px-5 py-3 text-xs text-muted-foreground"
      >
        <p>
          Pooled across queries · Sign test at p &lt; {significanceLevel}
          {confounded > 0 &&
            ` · ${confounded} ${confounded === 1 ? "comparison changes" : "comparisons change"} more than one field ${confounded === 1 ? "and is" : "and are"} excluded`}
          {truncated && " · Covers the 100 most recent evaluations"}
        </p>
        <p>
          Findings compare the first five results on each side once all ten have grades. Full review
          progress includes all results.
        </p>
        {graders.length > 0 && <p>Grades from {graders.join(", ")}.</p>}
      </div>
      <ul id="finding-rows">
        {axes.map((axis) => {
          const [first, second] = axis.values;
          const other = axis.leader === first ? second : first;
          const fasterSide =
            axis.median_elapsed[first] !== null && axis.median_elapsed[second] !== null
              ? axis.median_elapsed[first]! <= axis.median_elapsed[second]!
                ? first
                : second
              : null;
          return (
            <li
              key={`${axis.field}-${axis.values.join()}`}
              className="border-t px-5 py-2.5"
            >
              <div className="grid items-center gap-x-5 gap-y-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
                <div className="min-w-0">
                  <span className="mr-2 text-xs text-muted-foreground">{label(axis.field)}</span>
                  <span className="text-xs break-words">{label(first)} against {label(second)}</span>
                </div>
                <p className="font-medium">
                  {axis.significant
                    ? `${label(axis.leader!)} won ${axis.wins[axis.leader!]} of ${axis.decided} comparisons against ${label(other)}`
                    : axis.decided === 0 && axis.ties === 0
                      ? "Awaiting top-five grades"
                      : axis.leader
                        ? `Insufficient evidence — ${label(axis.leader)} leads ${axis.wins[axis.leader]}–${axis.wins[other]}`
                        : `Insufficient evidence — tied ${axis.wins[first]}–${axis.wins[second]}`}
                </p>
                <span className="text-xs tabular-nums text-muted-foreground lg:text-right">
                  {axis.decided + axis.ties}/{axis.compared} comparisons graded
                  {axis.ties > 0 && ` · ${axis.ties} tied`}
                </span>
              </div>
              <div hidden={!showDetails} className="mt-2 space-y-1 text-xs text-muted-foreground">
                <p>
                  {axis.decided + axis.ties}/{axis.compared} top-five comparisons graded
                  {axis.pending > 0 && ` · ${axis.pending} awaiting top-five grades`}
                </p>
                <p>
                  {fasterSide
                    ? `Median latency: ${label(first)} ${axis.median_elapsed[first]!.toFixed(2)}s; ${label(second)} ${axis.median_elapsed[second]!.toFixed(2)}s.`
                    : "Latency not recorded on both sides."}
                </p>
                <p>
                  {axis.median_delta !== null
                    ? `Median rank-score gap ${axis.median_delta.toFixed(1)}/100.`
                    : "No rank-score gap recorded yet."}
                  {axis.p !== null &&
                    ` Sign test: p ${axis.p < 0.001 ? "< 0.001" : `= ${axis.p.toFixed(3)}`}.`}
                  {!axis.significant &&
                    axis.decided + axis.ties > 0 &&
                    " More graded queries are needed to assess a difference."}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QuerySummary({ value }: { value: string }) {
  const [primary, ...additional] = value.split(" · ");
  return (
    <span title={value}>
      {primary}
      {additional.length > 0 && (
        <span className="ml-2 font-normal text-muted-foreground">
          +{additional.length} {additional.length === 1 ? "query" : "queries"}
        </span>
      )}
    </span>
  );
}

export default function RunsPage() {
  const [runs, setRuns] = useState<HistoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const [progress, setProgress] = useState("all");
  const [sort, setSort] = useState("review");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    api<HistoryItem[]>("evaluations")
      .then((data) => {
        if (active) setRuns(data);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const needsReview = (run: HistoryItem) =>
    ["Not started", "In progress"].includes(run.review_status);
  const attention = (run: HistoryItem) =>
    ["Search failed", "Insufficient results", "No results"].includes(run.review_status);
  const filters = [
    ["all", "All", runs.length],
    ["incomplete", "Needs review", runs.filter(needsReview).length],
    ["complete", "Complete", runs.filter((run) => run.review_status === "Complete").length],
    ["attention", "Needs attention", runs.filter(attention).length],
  ] as const;
  const visible = runs.filter(
    (run) =>
      `${run.query} ${run.criteria}`.toLowerCase().includes(query.toLowerCase()) &&
      (mode === "all" ||
        (mode === "blind" ? run.blind && !run.revealed_at : run.modes.split(",").includes(mode))) &&
      (progress === "all" ||
        (progress === "complete"
          ? run.review_status === "Complete"
          : progress === "attention"
            ? attention(run)
            : needsReview(run))),
  );
  const priority = (run: HistoryItem) =>
    run.review_status === "In progress"
      ? 0
      : run.review_status === "Not started"
        ? 1
        : attention(run)
          ? 2
          : run.review_status === "Searching"
            ? 3
            : 4;
  visible.sort(
    (a, b) =>
      (sort === "review" ? priority(a) - priority(b) : 0) ||
      Date.parse(b.created_at) - Date.parse(a.created_at),
  );
  const selectedStatus = filters.find(([value]) => value === progress)!;
  const filterControls = (
    <>
      <Select
        value={progress}
        onValueChange={(value) => {
          if (value) setProgress(value);
        }}
      >
        <SelectTrigger aria-label="Filter by status" className="w-full lg:w-auto">
          <SelectValue>
            <span className="text-muted-foreground">Status:</span> {selectedStatus[1]}
            <span className="ml-1 tabular-nums text-muted-foreground">
              {loading ? "…" : selectedStatus[2]}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {filters.map(([value, label, count]) => (
            <SelectItem
              key={value}
              value={value}
              aria-label={`${label} · ${loading ? "…" : count}`}
            >
              <span className="whitespace-nowrap">{label}</span>
              <span className="ml-auto pl-4 tabular-nums text-muted-foreground">
                {loading ? "…" : count}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={mode}
        onValueChange={(value) => {
          if (value) setMode(value);
        }}
      >
        <SelectTrigger aria-label="Filter by mode" className="w-full lg:w-auto">
          <SelectValue>
            Mode:{" "}
            {mode === "all"
              ? "All"
              : mode === "blind"
                ? "Blind reviews"
                : mode[0].toUpperCase() + mode.slice(1)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All modes</SelectItem>
          <SelectItem value="blind">Unrevealed blind reviews</SelectItem>
          {modes.map((mode) => (
            <SelectItem key={mode} value={mode}>
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={sort}
        onValueChange={(value) => {
          if (value) setSort(value);
        }}
      >
        <SelectTrigger aria-label="Sort evaluations" className="w-full lg:w-auto">
          <SelectValue>Sort: {sort === "review" ? "Review priority" : "Newest first"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="review">Review priority</SelectItem>
          <SelectItem value="recent">Newest first</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
  const pages = Math.max(1, Math.ceil(visible.length / 25));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * 25;
  const pageRuns = visible.slice(start, start + 25);
  return (
    <div className="app-shell evaluations-page">
      <a
        href="#evaluations"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to evaluations
      </a>
      <header className="shrink-0 border-b bg-card">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-4 px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Image src="/parallel-logo.svg" alt="Parallel" width={28} height={28} />
            <span className="brand-wordmark" aria-hidden="true">
              parallel
            </span>
            <span className="brand-divider" />
            <span className="brand-label">Search evaluations</span>
          </div>
          <WorkspaceNav />
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col gap-5 p-6 lg:px-8">
        <h1 className="sr-only">Saved evaluations</h1>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border bg-card">
          <div
            role="group"
            aria-label="Evaluation controls"
            className="flex shrink-0 items-center gap-2 border-b px-5 py-3"
          >
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search evaluations</span>
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                className="h-9 pl-9"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search evaluations…"
              />
            </label>
            <div className="hidden items-center gap-2 lg:flex">{filterControls}</div>
            <div className="lg:hidden">
              <Popover>
                <PopoverTrigger render={<Button variant="outline" className="h-9 bg-card" />}>
                  <SlidersHorizontal />
                  Filters
                  {(progress !== "all" || mode !== "all") && (
                    <span className="size-1.5 rounded-full bg-primary">
                      <span className="sr-only">Filters active</span>
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent align="end">
                  <PopoverTitle>Filters and sorting</PopoverTitle>
                  {filterControls}
                </PopoverContent>
              </Popover>
            </div>
            <Link href="/" className={cn(buttonVariants(), "h-9")} aria-label="New comparison">
              <Plus />
              <span className="hidden sm:inline">New comparison</span>
            </Link>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {!loading && !error && runs.length > 0 && (
            <Findings runs={runs} truncated={runs.length >= 100} />
          )}
          <section
            id="evaluations"
            aria-label="Saved evaluations"
            aria-busy={loading}
            className="min-h-0 flex-1 overflow-auto bg-card [&_tbody]:max-lg:block [&_tr]:max-lg:block [&_td]:max-lg:block [&_td]:max-lg:min-w-0 [&_td]:max-lg:max-w-none [&_td]:max-lg:py-2"
          >
            <table className="w-full table-fixed text-left text-sm">
              <colgroup className="max-lg:hidden">
                <col className="w-[30%]" />
                <col className="w-[28%]" />
                <col className="w-[22%]" />
                <col className="w-[20%]" />
              </colgroup>
              <thead className="sticky top-0 z-10 max-lg:hidden bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Query</th>
                  <th className="px-5 py-3 font-medium">Configurations</th>
                  <th className="px-5 py-3 font-medium">Comparison</th>
                  <th className="px-5 py-3 font-medium">Review</th>
                </tr>
              </thead>
              <tbody>
                {pageRuns.map((run) => (
                  <tr key={run.id} className="border-t transition-colors hover:bg-muted/30">
                    <td className="px-5 py-3 align-middle">
                      <Link
                        className="font-medium hover:text-primary hover:underline"
                        href={`/?id=${encodeURIComponent(run.id)}`}
                      >
                        <QuerySummary value={run.query} />
                      </Link>
                      <time
                        className="mt-1 block text-xs font-normal text-muted-foreground"
                        dateTime={run.created_at}
                        title={new Date(run.created_at).toLocaleString()}
                      >
                        {new Date(run.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}{" "}
                        ·{" "}
                        {new Date(run.created_at).toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-ring">
                          Evaluation details
                        </summary>
                        <div className="space-y-2 pt-1 leading-relaxed">
                          <p>{run.criteria || "Correct means relevant to the query."}</p>
                          {run.sharedSettings && <p className="break-words">Shared: {run.sharedSettings}</p>}
                          {run.configurations?.map((config) => (
                            <p key={config.label} className="break-words">
                              {config.label}: {config.settings || (run.blind && !run.revealed_at ? "Settings hidden" : "No differing settings")}
                              {config.mean_relevance != null && ` · Mean ${config.mean_relevance.toFixed(2)}/3`}
                            </p>
                          ))}
                          {run.outcome?.detail && <p>{run.outcome.detail}</p>}
                        </div>
                      </details>
                      {run.blind && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.revealed_at
                            ? "Blind review · Revealed"
                            : "Blind review · Modes hidden"}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 align-middle">
                      <div className="space-y-2">
                        {run.configurations?.map((config) => (
                          <div key={config.label} className="text-xs">
                            <div className="grid grid-cols-[1.5rem_auto_1fr] items-center gap-x-2 gap-y-1">
                              <span
                                className={`flex size-6 items-center justify-center rounded-md font-mono text-xs font-medium ${run.outcome?.winner === config.label ? "bg-primary/10 text-secondary-foreground ring-1 ring-primary/20" : "bg-muted text-muted-foreground"}`}
                              >
                                {config.label}
                              </span>
                              <span className="font-medium">
                                {config.mode ? config.mode.charAt(0).toUpperCase() + config.mode.slice(1) : "Hidden"}
                              </span>
                              <span className="tabular-nums text-muted-foreground">
                                {config.status === "completed"
                                  ? config.graded
                                    ? `${config.graded}/${config.total} reviewed`
                                    : `Not reviewed · ${config.total} ${config.total === 1 ? "result" : "results"}`
                                  : config.status === "running"
                                    ? "Searching…"
                                    : "Search failed"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3 align-middle">
                      <p
                        className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${run.outcome?.winner ? "bg-primary/10 text-secondary-foreground" : "bg-muted text-muted-foreground"}`}
                      >
                        {run.outcome?.title || "Not decided"}
                      </p>
                      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {run.configurations?.length === 2 &&
                        !(run.blind && !run.revealed_at) &&
                        run.configurations.every((config) => config.status === "completed" && config.rank_score_at_5 != null)
                          ? `Top-five score /100: ${run.configurations.map((config) => `${config.label} ${config.rank_score_at_5!.toFixed(1)}`).join(" · ")}`
                          : run.outcome?.detail || "Finish rating results to compare."}
                      </p>
                      {attention(run) && (
                        <p className="mt-1 text-xs text-destructive">{run.review_status}</p>
                      )}
                      <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                        {needsReview(run) ? "Review incomplete" : run.review_status} · {run.reviewed}/{run.total} reviewed
                      </p>
                      <Progress
                        value={run.total ? (run.reviewed / run.total) * 100 : 0}
                        aria-label={`Review progress for ${run.query}`}
                        className="mt-1 h-1 max-w-60"
                      />
                    </td>
                    <td className="px-5 py-3 align-middle">
                      <div className="flex min-w-0 flex-col items-start gap-2">
                        <Link
                          className="inline-flex w-full max-w-44 items-center justify-center rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted"
                          href={`/?id=${encodeURIComponent(run.id)}`}
                        >
                          {needsReview(run)
                            ? run.reviewed
                              ? "Resume review"
                              : "Start review"
                            : run.review_status === "Complete"
                              ? "View evaluation"
                              : "Inspect results"}
                        </Link>
                        {run.reviewers?.length ? (
                          <ul aria-label="Reviewers" className="w-full space-y-2 text-xs">
                            {run.reviewers.map((reviewer) => (
                              <li
                                key={reviewer.actor}
                                className="break-words leading-relaxed text-muted-foreground"
                              >
                                {reviewerName(reviewer.actor)}
                                {run.reviewers.length > 1 && (
                                  <span className="mt-1 block text-xs">{reviewer.count} rated</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-xs text-muted-foreground">No ratings yet</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && !error && (
              <div className="flex flex-col items-center gap-3 p-14 text-center text-sm text-muted-foreground">
                <History className="size-6" />
                <p>
                  {loading
                    ? "Loading evaluations…"
                    : runs.length
                      ? "No evaluations match these filters."
                      : "No saved evaluations yet."}
                </p>
                {!runs.length && !loading && (
                  <Link className="font-medium text-primary hover:underline" href="/">
                    Start an evaluation
                  </Link>
                )}
              </div>
            )}
            {!loading && !error && (
              <nav
                className="sticky bottom-0 flex items-center justify-between gap-3 border-t bg-card px-5 py-2 text-xs text-muted-foreground"
                aria-label="Evaluation pagination"
              >
                <span aria-live="polite">
                  {visible.length
                    ? `${start + 1}–${Math.min(start + 25, visible.length)} of ${visible.length} evaluations`
                    : "0 evaluations"}
                </span>
                {pages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={currentPage === 1}
                      onClick={() => setPage(currentPage - 1)}
                    >
                      Previous
                    </Button>
                    <span>
                      {currentPage} / {pages}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={currentPage === pages}
                      onClick={() => setPage(currentPage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </nav>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
