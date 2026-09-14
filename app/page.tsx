"use client";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { BatchRun } from "@/components/batch-run";
import { ActivityLog, AgreementPanel } from "@/components/evaluation-panels";
import { ComparisonAxes, ConfigurationPanel } from "@/components/search-configuration";
import { SearchSidebar, searchDemos } from "@/components/search-sidebar";
import { CopyMenu, ExportMenu } from "@/components/toolbar-menus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceNav } from "@/components/workspace-nav";
import { api, blinded, type Evaluation, modes, type SearchResult } from "@/lib/evaluations";
import {
  overlapMetrics,
  ratingFilter,
  relevanceHelp,
  resultMetrics,
  rubricNote,
} from "@/lib/scoring";
import {
  comparisonRequests,
  withSharedSettings,
  modeDocs,
  type SearchRequest,
  settingsDifferences,
  usageSummary,
  validateSearchRequest,
} from "@/lib/search-request";
import {
  copyConfiguration,
  copyEvaluation,
  downloadEvaluation,
  type ExportFormat,
} from "@/lib/share-evaluations";

function Picker({
  id,
  value,
  values,
  onChange,
  disabled = false,
}: {
  id: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(value) => {
        if (value) onChange(value);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} className={id === "filter" ? "w-28" : "w-full"}>
        <SelectValue>{value.charAt(0).toUpperCase() + value.slice(1)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {values.map((value) => (
          <SelectItem key={value} value={value}>
            {value.charAt(0).toUpperCase() + value.slice(1)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

import { ResultCard } from "@/components/result-card";

const defaultDemo = searchDemos[0];

export default function Page() {
  const [blindSearch, setBlindSearch] = useState(false);
  const revealRequest = useRef(0);
  const [request, setRequest] = useState<SearchRequest>({
    search_queries: [defaultDemo.query],
    objective: defaultDemo.objective,
  });
  const [requestB, setRequestB] = useState<SearchRequest>({
    search_queries: [defaultDemo.query],
    advanced_settings: defaultDemo.settingsB,
  });
  const [criteria, setCriteria] = useState(defaultDemo.criteria);
  const [modeA, setModeA] = useState(defaultDemo.modeA);
  const [modeB, setModeB] = useState(defaultDemo.modeB);
  const [selectedField, setSelectedField] = useState("mode");
  const [resultView, setResultView] = useState<"readable" | "json">("readable");
  const [current, setCurrent] = useState<Evaluation | null>(null);
  const resultsToolbar = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the evaluation id is a re-run trigger rather than a read; the toolbar is a different node per evaluation, so the observer must re-attach.
  useEffect(() => {
    const toolbar = resultsToolbar.current;
    const grid = toolbar?.closest<HTMLElement>(".workspace-grid");
    if (!toolbar || !grid) return;
    const syncHeight = () =>
      grid.style.setProperty(
        "--results-header-height",
        `${toolbar.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(syncHeight);
    syncHeight();
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      grid.style.removeProperty("--results-header-height");
    };
  }, [current?.id]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const dirty = useRef(new Set<number>());
  const saving = useRef(new Set<number>());
  const operation = useRef(false);
  const queryInput = useRef<HTMLTextAreaElement>(null);
  const searchKey = useRef<{ signature: string; key: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restoreBlind is redefined every render, so listing it would turn this mount-only load of ?id= into a per-render refetch.
  useEffect(() => {
    let active = true;
    const id = new URLSearchParams(window.location.search).get("id");
    if (id)
      api<Evaluation>(`evaluation?id=${encodeURIComponent(id)}`)
        .then((data) => {
          if (!active) return;
          restoreBlind(data);
          setCurrent(data);
          setCriteria(data.criteria);
        })
        .catch((error) => {
          if (active) {
            setError(true);
            setMessage(error.message);
          }
        });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (operation.current || dirty.current.size || saving.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: Event) => {
      if (
        operation.current ||
        saving.current.size ||
        (dirty.current.size && !window.confirm("Discard unsaved notes?"))
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    window.addEventListener("evaluation:navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", guard);
      window.removeEventListener("evaluation:navigate", navigate);
    };
  }, []);
  function restoreBlind(data: Evaluation) {
    setBlindSearch(Boolean(data.blind));
    const saved = data.runs[0]?.request || data.search_request;
    const second = data.runs[1]?.request;
    setRequestB(second || saved || { search_queries: [data.query] });
    if (saved) {
      const { mode, ...shared } = saved;
      void mode;
      setRequest(shared);
    } else setRequest({ search_queries: [data.query] });
    if (modes.includes(data.runs[0]?.mode)) setModeA(data.runs[0].mode);
    if (modes.includes(data.runs[1]?.mode)) setModeB(data.runs[1].mode);
    else setModeB(data.runs[0]?.mode === "fast" ? "advanced" : "fast");
  }
  function notify(text: string, failed = false) {
    setMessage(text);
    setError(failed);
  }
  function canLeave() {
    if (operation.current) return false;
    if (saving.current.size) {
      notify("Wait for feedback to finish saving.", true);
      return false;
    }
    return !dirty.current.size || window.confirm("Discard unsaved notes?");
  }
  async function open(id: string) {
    if (!canLeave()) return;
    operation.current = true;
    setLoading(true);
    try {
      const data = await api<Evaluation>(`evaluation?id=${encodeURIComponent(id)}`, undefined, {
        fresh: true,
      });
      dirty.current.clear();
      setCurrent(data);
      setRevision((value) => value + 1);
      setFilter("all");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?id=${encodeURIComponent(data.id)}`,
      );
      restoreBlind(data);
      setCriteria(data.criteria);
      notify(
        data.runs.some((run) => run.status === "running")
          ? "Search is running. Refresh to check progress."
          : "Evaluation loaded.",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not load evaluation.", true);
    } finally {
      operation.current = false;
      setLoading(false);
    }
  }
  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!request.search_queries[0]?.trim()) {
      queryInput.current?.focus();
      notify("Enter a query.", true);
      return;
    }
    let requests: SearchRequest[];
    try {
      requests = comparisonRequests(request, requestB, [modeA, modeB]);
      requests.forEach((r) => {
        validateSearchRequest(r, [r.mode!], blindSearch);
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Check search settings.", true);
      return;
    }
    if (!canLeave()) return;
    operation.current = true;
    setBusy(true);
    notify("Searching. Results are saved as each mode completes.");
    try {
      // One key per distinct submission. Resubmitting the same settings after a failure reuses
      // the key, so the server returns the original evaluation instead of spending Parallel
      // credits twice; changing any setting mints a new key.
      const signature = JSON.stringify([requests, criteria.trim(), blindSearch]);
      if (searchKey.current?.signature !== signature)
        searchKey.current = { signature, key: crypto.randomUUID() };
      const data = await api<Evaluation>("search", {
        idempotency_key: searchKey.current.key,
        search_request: { ...requests[0], mode: undefined },
        requests,
        criteria: criteria.trim(),
        modes: [modeA, modeB],
        blind: blindSearch,
      });
      searchKey.current = null;
      dirty.current.clear();
      setCurrent(data);
      setRevision((value) => value + 1);
      setFilter("all");
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?id=${encodeURIComponent(data.id)}`,
      );
      restoreBlind(data);
      notify(
        data.runs.every((run) => run.status === "completed")
          ? "Search saved. Review the results below."
          : "Some searches failed. Completed results and errors are saved.",
        data.runs.some((run) => run.status !== "completed"),
      );
    } catch (error) {
      notify(
        `${error instanceof Error ? error.message : "Search failed."} Check saved evaluations before resubmitting.`,
        true,
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      if (current) await open(current.id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not refresh evaluations.", true);
    }
  }
  async function download(exportFormat: ExportFormat) {
    if (!current || saving.current.size || dirty.current.size) {
      notify("Save notes and wait for feedback to finish saving before exporting.", true);
      return;
    }
    try {
      const data = await api(`export?id=${encodeURIComponent(current.id)}`, undefined, {
        fresh: true,
      });
      downloadEvaluation(data, exportFormat);
      notify("Export download requested.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Export failed.", true);
    }
  }
  async function update(result: SearchResult) {
    setCurrent(
      (value) =>
        value && {
          ...value,
          feedback_history: [
            ...(value.feedback_history || []).filter(
              (event) => event.result_id !== result.id || event.version !== result.version,
            ),
            {
              relevance: result.relevance,
              issues: result.issues,
              rubric_version: result.rubric_version,
              actor: result.actor,
              result_id: result.id,
              notes: result.notes,
              version: result.version,
              created_at: result.updated_at!,
            },
          ],
          runs: value.runs.map((run) => ({
            ...run,
            results: run.results.map((item) => (item.id === result.id ? result : item)),
          })),
        },
    );
    if (current?.blind) {
      const request = ++revealRequest.current;
      try {
        const data = await api<Evaluation>(`evaluation?id=${current.id}`, undefined, {
          fresh: true,
        });
        if (request !== revealRequest.current) return;
        setCurrent((value) =>
          value?.id === data.id
            ? {
                ...data,
                runs: data.runs.map((run) => ({
                  ...run,
                  results: run.results.map((item) => {
                    const local = value.runs
                      .flatMap((r) => r.results)
                      .find((r) => r.id === item.id);
                    return local && local.version > item.version ? local : item;
                  }),
                })),
              }
            : value,
        );
        if (data.revealed_at) notify("Saved. Mode names, Useful at 5 scores, and latency are now visible.");
      } catch {
        notify("Feedback saved. Select Refresh to check whether the modes are visible.", true);
      }
    }
  }
  const runs = current?.runs || [];
  const differences =
    current?.runs[0]?.request && current?.runs[1]?.request
      ? settingsDifferences(current.runs[0].request, current.runs[1].request)
      : [];
  const overlap =
    current?.runs.length === 2
      ? overlapMetrics(current.runs[0].results, current.runs[1].results)
      : null;
  const total = resultMetrics(runs.flatMap((run) => run.results));
  const count = runs.reduce((sum, run) => sum + run.results.length, 0);

  /**
   * Move focus to the next result still waiting for a grade, wrapping to the first.
   * Reads the rendered cards rather than tracking a cursor: the visible set changes with the
   * filter and with every save, and the DOM is the one place that is always current.
   */
  function nextUngraded() {
    const cards = [
      ...document.querySelectorAll<HTMLElement>("article.result-card:not([hidden])"),
    ].filter((card) => card.dataset.grade === "unrated");
    if (!cards.length) {
      notify("Every visible result is graded.");
      return;
    }
    const focused = (document.activeElement as HTMLElement | null)?.closest("article");
    const target =
      (focused &&
        cards.find(
          (card) =>
            card !== focused &&
            card.compareDocumentPosition(focused) & Node.DOCUMENT_POSITION_PRECEDING,
        )) ||
      cards[0];
    target.focus();
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  const blindActive = Boolean(current?.blind);
  const revealed = Boolean(current?.revealed_at);
  const hidden = Boolean(current && blinded(current));
  const blindIncomplete =
    blindActive &&
    current?.runs.some((run) => run.status !== "completed" || run.results.length < 5);

  const setupRequests = comparisonRequests(request, requestB, [modeA, modeB]);
  const setupDifferences = [
    ...(modeA !== modeB ? ["mode"] : []),
    ...settingsDifferences(setupRequests[0], setupRequests[1]),
  ];
  const activeField =
    setupDifferences.length > 1 ? "" : setupDifferences[0]?.split(".").at(-1) || selectedField;

  function configuration(index: number) {
    return (
      <ConfigurationPanel
        side={index === 0 ? "A" : "B"}
        field={activeField}
        request={index === 0 ? request : requestB}
        onRequest={(next) => {
          setSelectedField(activeField);
          (index === 0 ? setRequest : setRequestB)(next);
        }}
        mode={index === 0 ? modeA : modeB}
        onMode={(mode) => {
          setSelectedField(activeField);
          (index === 0 ? setModeA : setModeB)(mode);
        }}
        disabled={busy || loading}
      />
    );
  }

  return (
    <div className="app-shell">
      <a
        href="#query"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
      >
        Skip to search
      </a>
      <header className="shrink-0 border-b bg-card">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Image src="/parallel-logo.svg" alt="Parallel" width={28} height={28} />
            <span className="brand-wordmark" aria-hidden="true">
              parallel
            </span>
            <span className="brand-divider" />
            <h1 className="brand-label">Search evaluations</h1>
          </div>
          <WorkspaceNav />
        </div>
      </header>
      <main className="workspace-main mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col gap-5 p-6 lg:px-8">
        <div
          className={`workspace-grid grid min-h-0 flex-1 gap-5 ${!current ? "setup-layout" : ""}`}
        >
          <ComparisonAxes
            requests={setupRequests}
            active={activeField}
            disabled={busy || loading}
            onApply={(pair, field) => {
              setSelectedField(field);
              setRequest(pair[0]);
              setRequestB(pair[1]);
              setModeA(pair[0].mode!);
              setModeB(pair[1].mode!);
            }}
            action={
              <BatchRun
                request={request}
                requestB={requestB}
                modes={[modeA, modeB]}
                criteria={criteria}
                blind={blindSearch}
                disabled={busy || loading}
                onDone={(id) => {
                  void open(id);
                }}
              />
            }
          />
          <SearchSidebar
            sharedSettings={
              activeField ? (
                <ConfigurationPanel
                  side="shared"
                  field={activeField}
                  shared
                  request={request}
                  onRequest={(next) => {
                    setRequest(withSharedSettings(next, request, activeField));
                    setRequestB(withSharedSettings(next, requestB, activeField));
                  }}
                  mode={modeA}
                  onMode={(mode) => {
                    setModeA(mode);
                    setModeB(mode);
                  }}
                  disabled={busy || loading}
                />
              ) : undefined
            }
            hasResults={Boolean(current)}
            request={request}
            onRequest={setRequest}
            requestB={requestB}
            onRequestB={setRequestB}
            criteria={criteria}
            onCriteria={setCriteria}
            modeA={modeA}
            modeB={modeB}
            onModeA={setModeA}
            onModeB={setModeB}
            blind={blindSearch}
            onBlind={setBlindSearch}
            disabled={busy || loading}
            busy={busy}
            onSubmit={search}
            queryRef={queryInput}
          />
          <Card
            className="review-results flex min-h-0 gap-0 overflow-hidden py-0"
            aria-busy={busy || loading}
          >
            {current && (
              <div
                ref={resultsToolbar}
                className="results-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Results</h2>
                  <Badge variant="secondary">{count}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    role="radiogroup"
                    aria-label="Result view"
                    className="flex rounded-md border p-1"
                  >
                    {(["readable", "json"] as const).map((view) => (
                      <Button
                        key={view}
                        role="radio"
                        size="xs"
                        variant={resultView === view ? "secondary" : "ghost"}
                        aria-checked={resultView === view}
                        onClick={() => setResultView(view)}
                      >
                        {view === "readable" ? "Readable" : "JSON"}
                      </Button>
                    ))}
                  </div>
                  <Label htmlFor="filter" className="text-xs text-muted-foreground">
                    Show
                  </Label>
                  <Picker
                    id="filter"
                    value={filter}
                    values={["all", "unrated", "0", "1", "2", "3"]}
                    onChange={setFilter}
                  />
                  <Button
                    variant="outline"
                    size="xs"
                    title="Focus the next result waiting for a grade. Shortcut: n"
                    disabled={busy || loading}
                    onClick={nextUngraded}
                  >
                    Next ungraded
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Refresh"
                    title="Refresh"
                    disabled={busy || loading}
                    onClick={refresh}
                  >
                    <RefreshCw />
                  </Button>
                  <CopyMenu
                    compact
                    label="Copy evaluation"
                    disabled={busy || loading}
                    blockedReason={hidden ? "Complete blind review before copying." : undefined}
                    filteredLabel={filter !== "all" ? `Filtered results: ${filter}` : undefined}
                    getText={(format, filtered) => {
                      if (saving.current.size || dirty.current.size)
                        throw new Error("Save notes and wait for feedback to finish saving before copying.");
                      return copyEvaluation(current, format, filtered ? filter : "all");
                    }}
                  />
                  <ExportMenu
                    disabled={busy || loading || (blindActive && !revealed)}
                    onExport={download}
                  />
                </div>
              </div>
            )}
            {message && (
              <div
                role={error ? "alert" : "status"}
                className={`shrink-0 border-b px-5 py-3 text-xs ${error ? "bg-destructive/5 text-destructive" : "bg-muted/50 text-muted-foreground"}`}
              >
                {message}
              </div>
            )}
            {current && (
              <section
                aria-label="Review context"
                className="review-context shrink-0 space-y-2 overflow-auto border-b px-5 py-3"
              >
                <div className="flex items-start justify-between gap-4">
                  <h2 className="text-sm font-semibold">
                    <span className="text-muted-foreground">Saved query: </span>
                    {current.query}
                  </h2>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {total.graded}/{count} reviewed
                  </span>
                </div>
                <div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium">Saved criteria: </span>
                    {current.criteria ||
                      "Grade each result from 0 to 3 for relevance to the query. Grades do not verify factual accuracy."}
                  </p>
                  {/* One legend for every card below, referenced by each rating group's
                      aria-describedby, so the rubric is not repeated per result. */}
                  <p id="rating-help" className="mt-1 text-xs text-muted-foreground">
                    <span className="font-medium">Grades: </span>
                    {relevanceHelp.map((help, score) => `${score} ${help}`).join(" ")}
                  </p>
                </div>
                <Progress
                  value={count ? (total.graded / count) * 100 : 0}
                  aria-label="Review progress"
                  className="h-1"
                />
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Review details</summary>
                  <p className="mt-2">
                    Focus a result and press 0–3 to grade it. Select Clear rating to remove its grade. Results keep their original order.
                  </p>
                  <p className="mt-2">
                    Mean relevance excludes ungraded results. Top-five metrics require grades for the first
                    five results on each side. Rank score rewards relevance near the top. A score of
                    100 means all five results are fully relevant.{" "}
                    {rubricNote}
                  </p>
                  {overlap && (
                    <>
                      <p className="mt-2">
                        {overlap.count} shared {overlap.count === 1 ? "URL" : "URLs"} ·{" "}
                        {overlap.only_a} only in A · {overlap.only_b} only in B ·{" "}
                        {differences.length
                          ? "Configurations use different settings."
                          : "Same queries and search settings."}
                        {total.graded < count ? " Review is incomplete." : ""}
                      </p>
                      {overlap.count > 0 && (
                        <p className="mt-1">
                          {overlap.moved} of {overlap.count} shared{" "}
                          {overlap.moved === 1 ? "page changed rank" : "pages changed rank"}
                          {overlap.median_move !== null &&
                            `, by a median of ${overlap.median_move} ${overlap.median_move === 1 ? "position" : "positions"}`}
                          . Both configurations returned these pages.
                          {overlap.regraded > 0 &&
                            ` ${overlap.regraded} shared ${overlap.regraded === 1 ? "page carries" : "pages carry"} different grades on the two sides. Review the excerpts and criteria before treating this as a quality difference.`}
                        </p>
                      )}
                      {overlap.moved > 0 && (
                        <ul className="mt-2 space-y-1">
                          {overlap.shared
                            .filter((item) => item.move !== 0)
                            .slice(0, 3)
                            .map((item) => (
                              <li key={item.url} className="flex items-baseline gap-2">
                                <span className="w-20 shrink-0 tabular-nums">
                                  A {item.a} → B {item.b}
                                </span>
                                <span
                                  className={`w-10 shrink-0 tabular-nums ${item.move > 0 ? "text-primary" : ""}`}
                                >
                                  {item.move > 0 ? "+" : ""}
                                  {item.move}
                                </span>
                                <span className="min-w-0 truncate">{item.title}</span>
                              </li>
                            ))}
                        </ul>
                      )}
                    </>
                  )}
                  <AgreementPanel key={`agreement-${current.id}`} evaluationId={current.id} />
                  <ActivityLog key={current.id} evaluationId={current.id} />
                </details>
              </section>
            )}
            {blindActive && (
              <div className="shrink-0 space-y-1 border-b bg-primary/5 px-5 py-3">
                <p className="text-xs font-medium">
                  {revealed ? "Modes revealed" : `Blind review · ${total.graded}/10 rated`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {revealed
                    ? "You can still change ratings. Revealed modes stay visible. One query is not enough to identify an overall winner."
                    : "Rate the first five results on each side to reveal mode names and search times. A/B placement stays fixed for this evaluation."}
                </p>
                {blindIncomplete && (
                  <p role="alert" className="text-xs text-destructive">
                    Incomplete comparison: both modes must finish and return at least five results.
                  </p>
                )}
              </div>
            )}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the region is already
                focusable, and the shortcut only supplements the Next ungraded button. */}
            <CardContent
              className="results-scroll min-h-0 flex-1 overflow-auto p-5"
              tabIndex={0}
              role="region"
              aria-label="Scrollable search results"
              aria-keyshortcuts="n"
              onKeyDown={(event) => {
                if (
                  event.key !== "n" ||
                  event.repeat ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.altKey ||
                  (event.target as HTMLElement).closest(
                    "input,textarea,select,[contenteditable=true]",
                  )
                )
                  return;
                event.preventDefault();
                nextUngraded();
              }}
            >
              {resultView === "json" && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    This JSON contains the saved evaluation, available API responses, and feedback.
                    Mode details stay hidden until a blind review is complete.
                  </p>
                  <pre
                    tabIndex={0}
                    role="region"
                    aria-label="Evaluation JSON"
                    className="overflow-auto rounded-md bg-muted p-4 text-xs"
                  >
                    {JSON.stringify(current, null, 2)}
                  </pre>
                </div>
              )}
              <div hidden={resultView === "json"} className="h-full">
                {!current ? (
                  <div className="configuration-lanes grid content-start min-h-full lg:grid-cols-2">
                    {[0, 1].map((index) => (
                      <section key={index} className="configuration-lane min-w-0">
                        {configuration(index)}
                      </section>
                    ))}
                    <p className="configuration-empty col-span-full text-sm text-muted-foreground" role="status">
                      {busy || loading ? "Searching…" : "Run a comparison to review results side by side."}
                    </p>
                  </div>
                ) : (
                  <div
                    className={`result-lanes grid min-h-full ${current.runs.length === 2 ? "lg:grid-cols-2" : ""}`}
                  >
                    {runs.map((run, index) => {
                      const reviewedResults = blindActive ? run.results.slice(0, 5) : run.results;
                      const score = resultMetrics(reviewedResults);
                      const label = blindActive
                        ? `${run.label || (index === 0 ? "A" : "B")}${hidden ? "" : " · " + run.mode.charAt(0).toUpperCase() + run.mode.slice(1)}`
                        : `${run.label || (index === 0 ? "A" : "B")} · ${run.mode.charAt(0).toUpperCase() + run.mode.slice(1)}`;
                      const visible = reviewedResults.filter(
                        (result) => filter === "all" || ratingFilter(result) === filter,
                      );
                      return (
                        <section
                          key={run.id}
                          aria-label={`${label} results`}
                          className="result-lane min-w-0"
                        >
                          <div className="mode-summary relative border-b pb-3 pr-10">
                            <div className="flex items-baseline justify-between gap-2">
                              <h3 className="text-sm font-semibold">{label}</h3>
                              <span className="text-xs text-muted-foreground">
                                {!hidden &&
                                  `${
                                    run.request?.advanced_settings?.source_policy?.include_domains
                                      ?.length
                                      ? `Only ${run.request.advanced_settings.source_policy.include_domains.join(", ")}`
                                      : "All sources"
                                  } · `}
                                {run.status.charAt(0).toUpperCase() + run.status.slice(1)}
                                {/* The measured time next to the budget the docs publish for
                                    this mode, so a slow run is visible as a slow run. */}
                                {!hidden && run.elapsed !== null
                                  ? ` · ${run.elapsed}s${modeDocs[run.mode] ? ` · Documented latency: ${modeDocs[run.mode].latency}` : ""}`
                                  : ""}
                              </span>
                            </div>
                            <div className="absolute right-0 top-0">
                              <CopyMenu
                                compact
                                label="Copy configuration"
                                disabled={busy || loading}
                                blockedReason={
                                  hidden ? "Complete blind review before copying." : undefined
                                }
                                getText={(format) => {
                                  if (saving.current.size || dirty.current.size)
                                    throw new Error(
                                      "Save notes and wait for feedback to finish saving before copying.",
                                    );
                                  return copyConfiguration(current, run, format);
                                }}
                              />
                            </div>
                            <p className="mt-1 text-xs font-medium">
                              {score.mean_relevance === null
                                ? "No ratings yet"
                                : `Mean relevance ${score.mean_relevance.toFixed(2)}/3`}{" "}
                              · {score.graded}/{reviewedResults.length} graded
                              {score.useful_at_5 !== null
                                ? ` · Useful at 5: ${Math.round(score.useful_at_5 * 100)}% · Rank score: ${score.rank_score_at_5!.toFixed(1)}/100`
                                : " · Top-five scores pending"}
                              {!hidden && usageSummary(run.response?.usage)
                                ? ` · ${usageSummary(run.response?.usage)}`
                                : ""}
                            </p>
                            {!hidden && (
                              <details className="mt-2 text-xs">
                                <summary className="cursor-pointer text-muted-foreground">
                                  <span className="flex items-center gap-2">
                                    <SlidersHorizontal aria-hidden="true" className="size-3.5" />
                                    Settings for next comparison
                                  </span>
                                </summary>
                                {configuration(index)}
                              </details>
                            )}
                          </div>

                          {run.error && (
                            <p
                              role="alert"
                              className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive"
                            >
                              {run.error}
                            </p>
                          )}
                          {!!run.response?.warnings?.length && (
                            <p className="text-xs text-muted-foreground">
                              Search API warnings: {JSON.stringify(run.response.warnings)}
                            </p>
                          )}
                          {!visible.length && (
                            <p className="p-4 text-sm text-muted-foreground">
                              {run.status === "running"
                                ? "Search is running. Refresh to check progress."
                                : run.results.length
                                  ? "No results match this filter."
                                  : "No results returned."}
                            </p>
                          )}
                          {reviewedResults.map((result) => (
                            <ResultCard
                              key={`${revision}-${result.id}`}
                              result={result}
                              evaluation={current}
                              run={run}
                              history={(current.feedback_history || []).filter(
                                (event) => event.result_id === result.id,
                              )}
                              hidden={filter !== "all" && ratingFilter(result) !== filter}
                              onUpdate={update}
                              onDirty={(id, value) => {
                                if (value) dirty.current.add(id);
                                else dirty.current.delete(id);
                              }}
                              onSaving={(id, value) => {
                                if (value) saving.current.add(id);
                                else saving.current.delete(id);
                              }}
                            />
                          ))}
                          {run.request && !hidden && (
                            <details className="border-t py-3 text-xs">
                              <summary className="cursor-pointer font-medium">
                                Saved API request and response details
                              </summary>
                              <dl className="my-3 space-y-1 break-all">
                                <div>
                                  <dt className="inline text-muted-foreground">Search ID: </dt>
                                  <dd className="inline">
                                    {run.response?.search_id || "Not returned"}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="inline text-muted-foreground">API session ID: </dt>
                                  <dd className="inline">
                                    {run.response?.session_id || "Not returned"}
                                  </dd>
                                </div>
                              </dl>
                              <pre
                                className="max-h-64 overflow-auto rounded bg-muted p-3"
                                tabIndex={0}
                              >
                                {JSON.stringify(
                                  { request: run.request, usage: run.response?.usage ?? null },
                                  null,
                                  2,
                                )}
                              </pre>
                            </details>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
