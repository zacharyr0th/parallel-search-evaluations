"use client";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { reviewerName, api, type ActivityEvent } from "@/lib/evaluations";
import { kappaLabel, relevanceLabels, type agreementMetrics } from "@/lib/scoring";

type Agreement = ReturnType<typeof agreementMetrics>;
const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);

// Both panels are a collapsed <details> that loads on open and offers a manual reload.
function Panel({
  title,
  intro,
  reloadLabel,
  load,
  error,
  children,
  ...props
}: {
  title: string;
  intro: React.ReactNode;
  reloadLabel: string;
  load: () => void;
  error: string;
  children?: React.ReactNode;
} & React.ComponentProps<"details">) {
  return (
    <details
      {...props}
      className="shrink-0 border-b px-5 py-3 text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open) load();
      }}
    >
      <summary className="cursor-pointer font-medium">{title}</summary>
      <p className="mt-2 text-muted-foreground">{intro}</p>
      <button type="button" className="mt-2 text-primary underline" onClick={load}>
        {reloadLabel}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      {children}
    </details>
  );
}

export function AgreementPanel({ evaluationId }: { evaluationId: string }) {
  const [data, setData] = useState<Agreement | null>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      setData(
        await api<Agreement>(`agreement?id=${encodeURIComponent(evaluationId)}`, undefined, {
          fresh: true,
        }),
      );
      setError("");
    } catch {
      setError("Could not load agreement. Select Reload to try again.");
    }
  }
  return (
    <Panel
      title="Reviewer agreement"
      intro={
        <>
          Compares grades for results reviewed by more than one person.
        </>
      }
      reloadLabel="Reload"
      load={() => {
        void load();
      }}
      error={error}
    >
      {data &&
        (data.double_graded === 0 ? (
          <p className="mt-3 text-muted-foreground">
            No result has been graded by two reviewers yet
            {data.single_graded
              ? `; ${data.single_graded} ${data.single_graded === 1 ? "result has" : "results have"} one grade`
              : ""}
            . Ask a second reviewer to grade the same results to measure agreement.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
              {[
                ["Exact", percent(data.exact_agreement), "Same grade"],
                ["Within one", percent(data.adjacent_agreement), "Within one grade"],
                [
                  "Kappa",
                  data.kappa === null ? "—" : data.kappa.toFixed(2),
                  kappaLabel(data.kappa),
                ],
                ["Results with multiple reviewers", `${data.double_graded}`, `${data.single_graded} results with one grade`],
              ].map(([term, value, hint]) => (
                <div key={term}>
                  <dt className="text-muted-foreground">{term}</dt>
                  <dd className="text-sm font-medium tabular-nums">{value}</dd>
                  <dd className="text-xs text-muted-foreground">{hint}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Quadratic-weighted Cohen&rsquo;s kappa measures agreement. Larger grade
              differences count more heavily. The score adjusts for agreement expected by chance.
            </p>
            {data.pairs.length > 1 && (
              <ul aria-label="Reviewer pairs" className="space-y-1">
                {data.pairs.map((pair) => (
                  <li key={pair.reviewers.join()} className="text-muted-foreground">
                    {pair.reviewers.map(reviewerName).join(" and ")}:{" "}
                    {pair.kappa === null ? "kappa unavailable" : `kappa ${pair.kappa.toFixed(2)}`}{" "}
                    over {pair.overlap} shared {pair.overlap === 1 ? "result" : "results"}
                  </li>
                ))}
              </ul>
            )}
            {data.disputed.length > 0 && (
              <div>
                <p className="font-medium">Grades to review ({data.disputed.length})</p>
                <ul aria-label="Disputed results" className="mt-1 space-y-1">
                  {data.disputed.map((item) => (
                    <li key={item.result_id} className="text-muted-foreground">
                      Result {item.result_id}:{" "}
                      {item.grades
                        .map(
                          ([actor, grade]) =>
                            `${reviewerName(actor)} gave ${grade} (${relevanceLabels[grade]})`,
                        )
                        .join(" · ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
    </Panel>
  );
}

export function ActivityLog({ evaluationId }: { evaluationId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState("");
  const flushPending = useRef<() => Promise<void>>(async () => {});
  async function load() {
    try {
      await flushPending.current();
      setEvents(await api<ActivityEvent[]>(`activity?id=${encodeURIComponent(evaluationId)}`));
      setError("");
    } catch {
      setError("Could not load activity. Select Reload activity to try again.");
    }
  }
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | null = null;
    const queue: { id: string; action: string; target: string }[] = [];
    const flush = (): Promise<void> => {
      if (pending) return pending;
      pending = (async () => {
        while (queue.length) {
          const batch = queue.slice(0, 20);
          const response = await fetch("/api/activity", {
            method: "POST",
            keepalive: true,
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "SearchEvaluations",
            },
            body: JSON.stringify({ evaluation_id: evaluationId, events: batch }),
          });
          if (!response.ok) throw new Error("Activity save failed");
          queue.splice(0, batch.length);
        }
      })().finally(() => {
        pending = null;
      });
      return pending;
    };
    flushPending.current = flush;
    const send = () => {
      void flush().catch(() => {
        if (active)
          setError(
            "Some interactions could not be saved. Select Reload activity to retry. Saved feedback remains in Review history.",
          );
      });
    };
    const record = (action: string, target: string) => {
      if (queue.length >= 200) {
        if (active)
          setError("Activity recording is paused because unsaved events reached the limit. Select Reload activity to retry.");
        return;
      }
      queue.push({ id: crypto.randomUUID(), action, target });
      clearTimeout(timer);
      if (queue.length >= 20) send();
      else timer = setTimeout(send, 750);
    };
    record("opened", "Evaluation");
    const click = (event: MouseEvent) => {
      const element =
        event.target instanceof Element
          ? event.target.closest('button, a, [role="checkbox"]')
          : null;
      if (!element?.closest("main") || element.closest("[data-activity-log]")) return;
      const label = element.getAttribute("aria-label") || element.textContent?.trim();
      const result = element.closest("article")?.getAttribute("aria-label");
      if (label) record("clicked", `${label}${result ? ` · ${result}` : ""}`.slice(0, 200));
    };
    document.addEventListener("click", click);
    const hide = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", send);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("click", click);
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", send);
      send();
    };
  }, [evaluationId]);
  return (
    <Panel
      data-activity-log
      title="Activity"
      intro="Shows the latest 100 interactions, recorded from when you open an evaluation. Clicks do not confirm success. See Review history for saved feedback."
      reloadLabel="Reload activity"
      load={() => {
        void load();
      }}
      error={error}
    >
      <ol className="mt-3 max-h-52 space-y-3 overflow-auto">
        {[...events].reverse().map((event) => (
          <li key={event.id}>
            <p>
              <span className="font-medium">{reviewerName(event.actor)}</span> · {event.action.charAt(0).toUpperCase() + event.action.slice(1)} ·{" "}
              {event.target}
            </p>
            <time className="text-muted-foreground" dateTime={event.created_at}>
              {new Date(event.created_at).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
      {!events.length && !error && (
        <p className="mt-2 text-muted-foreground">No recorded activity yet.</p>
      )}
    </Panel>
  );
}
