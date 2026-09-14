"use client";
import { ArrowUpRight, Check, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { CopyMenu } from "@/components/toolbar-menus";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  type Evaluation,
  type FeedbackEvent,
  type Run,
  reviewerName,
  type SearchResult,
  safeURL,
} from "@/lib/evaluations";
import {
  issueTags,
  meetsNeed,
  meetsNeedLabel,
  ratingFilter,
  ratingLabel,
  relevanceHelp,
  relevanceLabels,
} from "@/lib/scoring";
import { copyResult } from "@/lib/share-evaluations";

export function ResultCard({
  result,
  evaluation,
  run,
  hidden,
  history,
  onUpdate,
  onDirty,
  onSaving,
}: {
  result: SearchResult;
  evaluation: Evaluation;
  run: Run;
  hidden: boolean;
  history: FeedbackEvent[];
  onUpdate: (result: SearchResult) => void | Promise<void>;
  onDirty: (id: number, dirty: boolean) => void;
  onSaving: (id: number, saving: boolean) => void;
}) {
  const [note, setNote] = useState(result.notes);
  const [expanded, setExpanded] = useState(false);
  const excerpt = result.excerpts.join("\n\n");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(result.updated_at ? "Saved" : "Unrated");
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const url = safeURL(result.url);
  async function save(relevance: number | null | undefined, issues = result.issues || []) {
    if (
      lock.current ||
      (relevance === result.relevance &&
        JSON.stringify(issues) === JSON.stringify(result.issues || []) &&
        note === result.notes)
    )
      return;
    lock.current = true;
    setSaving(true);
    onSaving(result.id, true);
    setError(false);
    setStatus("Saving…");
    try {
      const updated = await api<Partial<SearchResult>>("feedback", {
        evaluation_id: evaluation.id,
        result_id: result.id,
        version: result.version,
        relevance: relevance ?? null,
        issues,
        notes: note,
      });
      await onUpdate({ ...result, ...updated });
      onDirty(result.id, false);
      setStatus("Saved");
    } catch (error) {
      setError(true);
      setStatus(error instanceof Error ? error.message : "Could not save feedback.");
    } finally {
      lock.current = false;
      setSaving(false);
      onSaving(result.id, false);
    }
  }
  return (
    <article
      tabIndex={0}
      aria-keyshortcuts="0 1 2 3"
      onKeyDown={(event) => {
        if (
          event.repeat ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (event.target as HTMLElement).closest(
            "input,textarea,select,button,a,summary,[contenteditable=true]",
          )
        )
          return;
        if (["0", "1", "2", "3"].includes(event.key)) {
          event.preventDefault();
          void save(Number(event.key));
        }
      }}
      data-grade={ratingFilter(result)}
      hidden={hidden}
      aria-label={`Result ${result.rank}: ${result.title}`}
      className="result-card relative border-b py-5"
    >
      <div className="flex items-start gap-3">
        <span
          title={`Original rank ${result.rank}`}
          className="pt-0.5 font-mono text-xs text-muted-foreground"
        >
          {String(result.rank).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          {url ? (
            <a
              href={url.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold leading-6 hover:underline"
            >
              {result.title}
              <ArrowUpRight className="ml-1 inline size-3.5" />
            </a>
          ) : (
            <h3 className="text-sm font-semibold">{result.title}</h3>
          )}
          <p className="mt-1 break-all text-xs text-muted-foreground">
            {url?.hostname || result.url}
            {result.publish_date ? ` · ${result.publish_date}` : ""}
          </p>
        </div>
        <CopyMenu
          compact
          label="Copy result"
          blockedReason={
            saving
              ? "Wait for feedback to save."
              : note !== result.notes
                ? "Save notes before copying."
                : undefined
          }
          link={url?.href}
          getText={(format) => copyResult(result, format, evaluation, run)}
        />
      </div>
      <div
        className={`mt-3 whitespace-pre-line text-sm leading-6 text-foreground/80 ${expanded ? "" : "line-clamp-4"}`}
        role="group"
        aria-label={`Excerpt for result ${result.rank}`}
      >
        {excerpt
          ? excerpt.split("\n").map((line, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: excerpt lines are re-derived each render and hold no state.
                key={index}
                className={/^#{1,6}\s/.test(line) ? "block font-semibold" : "block min-h-2"}
              >
                {line.replace(/^#{1,6}\s+/, "")}
              </span>
            ))
          : "No excerpt returned. Open the source to evaluate it."}
      </div>
      {excerpt && (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
      <div
        className="rating-controls mt-3 flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Result feedback"
        aria-describedby="rating-help"
      >
        {relevanceLabels.map((label, score) => (
          <Button
            key={label}
            size="sm"
            variant={result.relevance === score ? "default" : "outline"}
            aria-pressed={result.relevance === score}
            aria-label={`${score} · ${label}`}
            title={`${score} · ${label}. ${relevanceHelp[score]}`}
            disabled={saving}
            onClick={() => save(score)}
          >
            {result.relevance === score && <Check aria-hidden="true" className="size-3.5" />}
            {score}
          </Button>
        ))}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Clear rating"
          title="Clear rating"
          disabled={saving || ratingFilter(result) === "unrated"}
          onClick={() => save(null)}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
        <span
          role="status"
          className={`ml-auto text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status}
        </span>
      </div>
      {result.relevance != null && (
        <p
          className={`mt-2 text-xs font-medium ${meetsNeed(result) ? "text-primary" : "text-muted-foreground"}`}
        >
          {meetsNeedLabel(result)}{" "}
          <span className="font-normal text-muted-foreground">· from grade {result.relevance}</span>
        </p>
      )}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          Issues ({result.issues?.length || 0})
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {issueTags.map((tag) => (
            <Button
              key={tag}
              size="xs"
              variant={result.issues?.includes(tag) ? "secondary" : "outline"}
              aria-pressed={result.issues?.includes(tag) || false}
              disabled={saving}
              onClick={() =>
                save(
                  result.relevance ?? null,
                  result.issues?.includes(tag)
                    ? result.issues.filter((item) => item !== tag)
                    : [...(result.issues || []), tag],
                )
              }
            >
              {tag}
            </Button>
          ))}
        </div>
      </details>
      {result.updated_at && (
        <p className="mt-2 break-words text-xs text-muted-foreground">
          Last saved by{" "}
          {reviewerName(
            result.actor ||
              history.find((event) => event.version === result.version)?.actor ||
              "Unknown reviewer",
          )}{" "}
          · <time dateTime={result.updated_at}>{new Date(result.updated_at).toLocaleString()}</time>
        </p>
      )}
      <details className="mt-4 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {result.notes ? "Notes" : "Add notes"}
        </summary>
        <Textarea
          aria-label={`Notes for result ${result.rank}`}
          className="my-3 min-h-20"
          placeholder="Explain your rating (optional)."
          maxLength={2000}
          value={note}
          disabled={saving}
          onChange={(event) => {
            setNote(event.target.value);
            onDirty(result.id, event.target.value !== result.notes);
            setStatus(event.target.value !== result.notes ? "Unsaved note" : "Saved");
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={saving || note === result.notes}
          onClick={() => save(result.relevance)}
        >
          Save note
        </Button>
      </details>
      {history.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Review history ({history.length})
          </summary>
          <ol className="mt-3 space-y-3">
            {[...history].reverse().map((event) => (
              <li key={event.version} className="rounded-md bg-muted p-3">
                <p className="font-medium">
                  {reviewerName(event.actor || "Unknown reviewer")} · Version {event.version} ·{" "}
                  {ratingLabel(event)} · {event.rubric_version}
                  {event.issues?.length ? ` · ${event.issues.join(", ")}` : ""}
                </p>
                <time className="mt-1 block text-muted-foreground" dateTime={event.created_at}>
                  {new Date(event.created_at).toLocaleString()}
                </time>
                {event.notes && <p className="mt-2 whitespace-pre-wrap">{event.notes}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
