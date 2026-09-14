"use client";
import { LoaderCircle, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useRef, useState } from "react";
import { Group } from "@/components/search-fields";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  comparisonRequests,
  type SearchRequest,
  validateSearchRequest,
} from "@/lib/search-request";

export const searchDemos = [
  {
    label: "Search documentation",
    query: "Parallel Search API modes and source filters",
    objective: "Find official documentation explaining search modes and source filtering.",
    criteria: "Correct results directly document Parallel Search modes or source filters.",
    modeA: "advanced",
    modeB: "fast",
    settingsB: {},
  },
  {
    label: "Vendor pricing",
    query: "Intercom customer support pricing plans",
    objective: "Find published plan prices and included customer support features.",
    criteria: "Correct results provide pricing or plan details from Intercom.",
    modeA: "advanced",
    modeB: "advanced",
    settingsB: { source_policy: { include_domains: ["intercom.com"] } },
  },
  {
    label: "Recent announcements",
    query: "Parallel AI product announcements",
    objective: "Find recent product announcements from Parallel.",
    criteria: "Correct results describe a specific Parallel product announcement with a date.",
    modeA: "fast",
    modeB: "fast",
    settingsB: { fetch_policy: { max_age_seconds: 600 } },
  },
];

export function SearchSidebar({
  sharedSettings,
  hasResults = false,
  request,
  onRequest,
  requestB,
  onRequestB,
  criteria,
  onCriteria,
  modeA,
  modeB,
  onModeA,
  onModeB,
  blind,
  onBlind,
  disabled,
  busy,
  onSubmit,
  queryRef,
}: {
  sharedSettings?: ReactNode;
  hasResults?: boolean;
  requestB: SearchRequest;
  onRequestB: (request: SearchRequest) => void;
  request: SearchRequest;
  onRequest: (request: SearchRequest) => void;
  criteria: string;
  onCriteria: (value: string) => void;
  modeA: string;
  modeB: string;
  onModeA: (value: string) => void;
  onModeB: (value: string) => void;
  blind: boolean;
  onBlind: (value: boolean) => void;
  disabled: boolean;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  queryRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const queryChange = (index: number, value: string) =>
    onRequest({
      ...request,
      search_queries: request.search_queries.map((q, i) => (i === index ? value : q)),
    });
  const selected = [modeA, modeB];
  const [codeFormat, setCodeFormat] = useState<"JSON" | "Python">("JSON");
  const [copyStatus, setCopyStatus] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const fieldError = (id: string) =>
    error?.id === id ? (
      <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
        {error.message}
      </p>
    ) : null;
  const ready = request.search_queries.length > 0 && request.search_queries.every((q) => q.trim());
  function showError(id: string, message: string) {
    setError({ id, message });
    const input = formRef.current?.querySelector<HTMLElement>(`#${id}`);
    let group = input?.closest("details");
    while (group) {
      group.open = true;
      group = group.parentElement?.closest("details") || null;
    }
    input?.focus();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    let invalidSide = 0;
    try {
      requests.forEach((r, index) => {
        invalidSide = index;
        validateSearchRequest(r, [r.mode!], blind);
      });
    } catch (caught) {
      const message =
        (requestB ? `Configuration ${invalidSide === 0 ? "A" : "B"}: ` : "") +
        (caught instanceof Error ? caught.message : "Check search settings.");
      const id = "query";
      showError(id, message);
      return;
    }
    setError(null);
    onSubmit(event);
  }
  const requests = comparisonRequests(request, requestB, selected);
  const modified = Boolean(
    request.search_queries.some((query) => query.trim()) ||
      Object.keys(requestB).some((key) => key !== "search_queries") ||
      criteria ||
      blind ||
      modeA !== "advanced" ||
      modeB !== "fast" ||
      Object.keys(request).some((key) => key !== "search_queries"),
  );
  const requestCode =
    codeFormat === "JSON"
      ? JSON.stringify(requests, null, 2)
      : `import json\nimport os\nfrom parallel import Parallel\n\nclient = Parallel(api_key=os.environ["PARALLEL_API_KEY"])\nrequests = json.loads(${JSON.stringify(JSON.stringify(requests))})\nfor request in requests:\n    response = client.search(**request)\n    print(response.model_dump_json(indent=2))\n`;
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(requestCode);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed. Select and copy the code.");
    }
  }
  return (
    <Dialog open={codeOpen} onOpenChange={setCodeOpen}>
      <Card className="search-sidebar min-h-0 gap-0 overflow-hidden py-0">
        <div className="flex shrink-0 items-center justify-between border-b px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <SlidersHorizontal className="size-4" />
            Shared search
          </h2>
          {modified && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setError(null);
                onRequest({ search_queries: [""] });
                onRequestB({ search_queries: [""] });
                onCriteria("");
                onModeA("advanced");
                onModeB("fast");
                onBlind(false);
                queryRef.current?.focus();
              }}
            >
              Reset
            </Button>
          )}
        </div>
        <form
          ref={formRef}
          onSubmit={submit}
          onChange={() => {
            setError(null);
            setCopyStatus("");
          }}
          onInvalid={(event) => {
            const input = event.target as HTMLInputElement;
            showError(input.id, input.validationMessage);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (ready && !disabled) formRef.current?.requestSubmit();
            }
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="search-settings-scroll min-h-0 flex-1 overflow-y-auto px-5">
            <fieldset disabled={disabled} className="min-w-0">
              <div className="setup-fields space-y-5 py-5">
                {hasResults && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Changes apply to your next comparison. Use the saved criteria to rate the
                    current results.
                  </p>
                )}
                <div className="query-fields space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="query">Query</Label>
                    <Textarea
                      ref={queryRef}
                      id="query"
                      rows={2}
                      value={request.search_queries[0] || ""}
                      placeholder="For example, Parallel Search API documentation"
                      maxLength={200}
                      required
                      aria-invalid={error?.id === "query"}
                      onChange={(e) => queryChange(0, e.target.value)}
                    />
                    {fieldError("query")}
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value=""
                      onValueChange={(value) => {
                        const demo = searchDemos.find((item) => item.label === value);
                        if (!demo) return;
                        onRequest({ search_queries: [demo.query], objective: demo.objective });
                        onRequestB({
                          search_queries: [demo.query],
                          advanced_settings: demo.settingsB,
                        });
                        onCriteria(demo.criteria);
                        onModeA(demo.modeA);
                        onModeB(demo.modeB);
                        onBlind(false);
                        setError(null);
                        queryRef.current?.focus();
                      }}
                      disabled={disabled}
                    >
                      <SelectTrigger aria-label="Demo queries" className="min-w-0 flex-1">
                        <SelectValue placeholder="Try a demo query" />
                      </SelectTrigger>
                      <SelectContent>
                        {searchDemos.map((demo) => (
                          <SelectItem key={demo.label} value={demo.label}>
                            {demo.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="criteria">
                      Evaluation criteria{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                      id="criteria"
                      maxLength={2000}
                      rows={3}
                      value={criteria}
                      onChange={(e) => onCriteria(e.target.value)}
                      placeholder="What makes a result correct?"
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      Use these criteria to grade both sides. They are not sent to the Search API.
                    </p>
                  </div>
                </div>
                <div className="search-submit">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" disabled={disabled || !ready}>
                      {busy ? <LoaderCircle className="animate-spin" /> : <Search />}
                      {busy ? "Searching…" : "Run comparison"}
                    </Button>
                    <span className="text-xs text-muted-foreground">2 API calls · Uses credits</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {ready ? <kbd>⌘/Ctrl + Enter</kbd> : "Enter a query to run two searches"}
                  </p>
                </div>
                <Group
                  title="Shared settings and options"
                  detail="Search settings, objective, additional queries, and blind review"
                >
                  {sharedSettings}
                  <div className="space-y-2">
                    {request.search_queries.slice(1).map((query, index) => {
                      const i = index + 1;
                      return (
                        <div key={i} className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Label
                              htmlFor={i ? `query-${i}` : "query"}
                              className="sr-only"
                            >{`Query ${i + 1}`}</Label>
                            <Textarea
                              rows={2}
                              className="min-w-0 flex-1"
                              id={i ? `query-${i}` : "query"}
                              value={query}
                              placeholder={
                                i ? "Another query for the same search" : "Enter search keywords"
                              }
                              aria-invalid={error?.id === (i ? `query-${i}` : "query")}
                              aria-describedby={
                                error?.id === (i ? `query-${i}` : "query")
                                  ? `${error.id}-error`
                                  : undefined
                              }
                              maxLength={200}
                              required
                              onChange={(e) => queryChange(i, e.target.value)}
                            />
                            {request.search_queries.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                disabled={disabled}
                                aria-label={`Remove query ${i + 1}`}
                                onClick={() =>
                                  onRequest({
                                    ...request,
                                    search_queries: request.search_queries.filter(
                                      (_, n) => n !== i,
                                    ),
                                  })
                                }
                              >
                                <X />
                              </Button>
                            )}
                          </div>
                          {fieldError(i ? `query-${i}` : "query")}
                        </div>
                      );
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={request.search_queries.length >= 5 || disabled}
                    onClick={() =>
                      onRequest({ ...request, search_queries: [...request.search_queries, ""] })
                    }
                  >
                    <Plus />
                    Add query
                  </Button>
                  <div className="space-y-2">
                    <Label htmlFor="objective">
                      Objective{" "}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                      id="objective"
                      aria-invalid={error?.id === "objective"}
                      aria-describedby={error?.id === "objective" ? "objective-error" : undefined}
                      value={request.objective ?? ""}
                      maxLength={5000}
                      rows={2}
                      className="objective-input"
                      placeholder="What should the search find?"
                      onChange={(e) =>
                        onRequest({ ...request, objective: e.target.value || undefined })
                      }
                    />
                    {fieldError("objective")}
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="blind-review"
                        checked={blind}
                        disabled={disabled}
                        onCheckedChange={(checked) => onBlind(checked === true)}
                      />
                      <Label htmlFor="blind-review">Blind review</Label>
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Randomly assign configurations to A and B. Hide mode names until you rate five
                      results on each side.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onRequestB(structuredClone(request));
                      onModeB(modeA);
                    }}
                  >
                    Copy A to B
                  </Button>
                  <DialogTrigger
                    render={<Button type="button" size="sm" variant="ghost" />}
                    onClick={() => setCopyStatus("")}
                  >
                    View API code
                  </DialogTrigger>
                </Group>
              </div>
            </fieldset>
          </div>
        </form>
        <DialogContent
          showCloseButton={false}
          className="sm:max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <div className="flex items-center justify-between">
            <DialogTitle>API code</DialogTitle>
            <DialogClose
              render={<Button type="button" variant="ghost" size="icon-xs" />}
              aria-label="Close API code"
            >
              <X />
            </DialogClose>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex gap-1" role="group" aria-label="Code format">
                {(["JSON", "Python"] as const).map((format) => (
                  <Button
                    key={format}
                    type="button"
                    size="xs"
                    variant={codeFormat === format ? "secondary" : "ghost"}
                    aria-pressed={codeFormat === format}
                    onClick={() => {
                      setCodeFormat(format);
                      setCopyStatus("");
                    }}
                  >
                    {format}
                  </Button>
                ))}
              </div>
              <Button type="button" size="xs" variant="outline" onClick={copyCode}>
                Copy code
              </Button>
            </div>
            {copyStatus && (
              <p role="status" className="text-xs text-muted-foreground">
                {copyStatus}
              </p>
            )}
            <DialogDescription>
              This code uses your current settings. Empty fields use API defaults. Set
              PARALLEL_API_KEY on your server.
            </DialogDescription>
            <pre
              className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs select-text"
              tabIndex={0}
              role="region"
              aria-label={codeFormat === "JSON" ? "Search request JSON" : "Python request code"}
            >
              {requestCode}
            </pre>
            <a
              href="https://docs.parallel.ai/search/search-quickstart"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary underline underline-offset-4"
            >
              Parallel Search quickstart
            </a>
          </div>
        </DialogContent>
      </Card>
    </Dialog>
  );
}
