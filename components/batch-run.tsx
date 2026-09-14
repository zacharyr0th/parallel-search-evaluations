"use client";
import { LoaderCircle, Play } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type Evaluation } from "@/lib/evaluations";
import {
  comparisonRequests,
  type SearchRequest,
  validateSearchRequest,
} from "@/lib/search-request";

/**
 * One axis holds only when it holds over a set of queries, and grading one comparison at a time
 * makes that set expensive to build by hand. A batch reuses the current A and B configurations
 * and swaps only the query.
 *
 * The cap is deliberate: the workspace allows 100 Search API calls per UTC day and a comparison
 * spends two, so an unbounded batch could take the day's whole allowance in one click.
 */
export const batchLimit = 20;
const callsPerComparison = 2;

type Outcome = { query: string; id?: string; error?: string };

export function BatchRun({
  request,
  requestB,
  modes,
  criteria,
  blind,
  disabled,
  onDone,
}: {
  request: SearchRequest;
  requestB: SearchRequest;
  modes: string[];
  criteria: string;
  blind: boolean;
  disabled: boolean;
  onDone: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState("");
  const stopped = useRef(false);
  const queries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tooMany = queries.length > batchLimit;
  const overLong = queries.find((query) => [...query].length > 200);
  const completed = outcomes.filter((outcome) => outcome.id).length;

  async function run() {
    setError("");
    setOutcomes([]);
    stopped.current = false;
    try {
      // Validate the whole set before spending anything: a query that cannot be sent should
      // stop the batch at zero calls, not part-way through.
      for (const query of queries)
        for (const each of comparisonRequests(
          { ...request, search_queries: [query] },
          requestB,
          modes,
        ))
          validateSearchRequest(each, [each.mode!], blind);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check the search settings.");
      return;
    }
    setRunning(true);
    // Sequential on purpose. The daily cap is enforced per request, so running in parallel would
    // race past it, and nothing here retries: the first refusal stops the batch.
    for (const query of queries) {
      if (stopped.current) break;
      try {
        const requests = comparisonRequests(
          { ...request, search_queries: [query] },
          requestB,
          modes,
        );
        const data = await api<Evaluation>("search", {
          idempotency_key: crypto.randomUUID(),
          search_request: { ...requests[0], mode: undefined },
          requests,
          criteria: criteria.trim(),
          modes,
          blind,
        });
        setOutcomes((current) => [...current, { query, id: data.id }]);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Search failed.";
        setOutcomes((current) => [...current, { query, error: message }]);
        setError(`${message} The batch stopped. Saved comparisons remain available.`);
        break;
      }
    }
    setRunning(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (running) return;
        setOpen(next);
        if (!next && completed) onDone(outcomes.findLast((outcome) => outcome.id)!.id!);
      }}
    >
      <DialogTrigger
        render={<Button type="button" size="xs" variant="outline" disabled={disabled} />}
      >
        Compare multiple queries
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogTitle>Compare multiple queries</DialogTitle>
        <DialogDescription>
          Each query runs the current A and B configurations and saves its own evaluation. The
          same criteria and blind review setting apply to every query.
        </DialogDescription>
        <div className="mt-4 space-y-2">
          <Label htmlFor="batch-queries">Queries, one per line</Label>
          <Textarea
            id="batch-queries"
            className="min-h-40 font-mono text-xs"
            placeholder={
              "Parallel Search API modes\nParallel Search source filters\nParallel Search rate limits"
            }
            value={text}
            disabled={running}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {queries.length} {queries.length === 1 ? "query" : "queries"} ·{" "}
            {queries.length * callsPerComparison} Search API{" "}
            {queries.length * callsPerComparison === 1 ? "call" : "calls"} · Uses credits.
            The daily limit is 100 Search API calls, reset at midnight UTC. Each batch allows up to {batchLimit} queries.
          </p>
          {tooMany && (
            <p role="alert" className="text-xs text-destructive">
              Remove {queries.length - batchLimit} {queries.length - batchLimit === 1 ? "query" : "queries"}. Each batch allows up to {batchLimit} queries.
            </p>
          )}
          {overLong && (
            <p role="alert" className="text-xs text-destructive">
              Keep every query within 200 characters.
            </p>
          )}
        </div>
        {outcomes.length > 0 && (
          <ol className="mt-4 max-h-48 space-y-1 overflow-auto text-xs">
            {outcomes.map((outcome, index) => (
              <li
                key={outcome.query}
                className={`flex gap-2 ${outcome.error ? "text-destructive" : ""}`}
              >
                <span className="tabular-nums text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{outcome.query}</span>
                <span className="shrink-0">{outcome.error ? "Failed" : "Saved"}</span>
              </li>
            ))}
          </ol>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {error}
          </p>
        )}
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {running
            ? `Running query ${outcomes.length + 1} of ${queries.length}. Keep this page open until the batch finishes.`
            : completed
              ? `${completed} of ${queries.length} evaluations saved. Open Evaluations to grade the first five results on each side and update the findings.`
              : ""}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          {running ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                stopped.current = true;
              }}
            >
              Stop after this query
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          )}
          <Button
            type="button"
            disabled={running || !queries.length || tooMany || Boolean(overLong)}
            onClick={run}
          >
            {running ? <LoaderCircle className="animate-spin" /> : <Play />}
            {running ? "Running" : `Run ${queries.length * callsPerComparison} searches`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
