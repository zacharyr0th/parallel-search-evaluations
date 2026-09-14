"use client";
import { type ReactNode, useState } from "react";
import { Group, NumberField } from "@/components/search-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  locations,
  modeDocs,
  type SearchRequest,
  settingsDifferences,
  validateSearchRequest,
} from "@/lib/search-request";

export function ConfigurationPanel({
  side,
  request,
  onRequest,
  mode,
  onMode,
  disabled,
  field,
  shared = false,
}: {
  field?: string;
  shared?: boolean;
  side: string;
  request: SearchRequest;
  onRequest: (request: SearchRequest) => void;
  mode: string;
  onMode: (mode: string) => void;
  disabled: boolean;
}) {
  const show = (key: string) => !field || (shared ? key !== field : key === field);
  const a = request.advanced_settings || {},
    source = a.source_policy || {},
    fetch = a.fetch_policy || {};
  const advanced = (patch: Partial<NonNullable<SearchRequest["advanced_settings"]>>) =>
    onRequest({ ...request, advanced_settings: { ...a, ...patch } });
  const includeCount = source.include_domains?.filter((s) => s.trim()).length || 0,
    excludeCount = source.exclude_domains?.filter((s) => s.trim()).length || 0;
  const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
  const editor = (
    <div className="space-y-3">
      {show("mode") && (
        <>
          <Label htmlFor={`${side}-mode`}>Search mode</Label>
          <Select
            value={mode}
            onValueChange={(value) => {
              if (value) onMode(value);
            }}
            disabled={disabled}
          >
            <SelectTrigger
              aria-label={shared ? "Shared settings" : `Configuration ${side}`}
              id={`${side}-mode`}
              className="w-full"
            >
              <SelectValue>{mode.charAt(0).toUpperCase() + mode.slice(1)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.keys(modeDocs).map((value) => (
                <SelectItem key={value} value={value}>
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {modeDocs[mode].latency} · {modeDocs[mode].detail}
          </p>
        </>
      )}
      <div role="group" aria-label="Search settings">
        {(show("include_domains") || show("exclude_domains") || show("after_date")) && (
          <Group
            title="Sources"
            detail={
              includeCount || excludeCount || source.after_date
                ? `${includeCount} allowed · ${excludeCount} blocked${source.after_date ? " · Date filter" : ""}`
                : "All sources · No publication date filter"
            }
          >
            {show("include_domains") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-include-domains"}>Allowed sources</Label>
                <Textarea
                  id={side + "-include-domains"}
                  placeholder={"docs.python.org/3\n.gov"}
                  value={source.include_domains?.join("\n") ?? ""}
                  onChange={(e) =>
                    advanced({
                      source_policy: { ...source, include_domains: e.target.value.split("\n") },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Search only these sources. Enter one source per line.
                </p>
              </div>
            )}
            {show("exclude_domains") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-exclude-domains"}>Blocked sources</Label>
                <Textarea
                  id={side + "-exclude-domains"}
                  placeholder={"reddit.com\nyoutube.com/shorts"}
                  value={source.exclude_domains?.join("\n") ?? ""}
                  onChange={(e) =>
                    advanced({
                      source_policy: { ...source, exclude_domains: e.target.value.split("\n") },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Exclude these sources when Allowed sources is empty.
                </p>
              </div>
            )}
            {includeCount > 0 && excludeCount > 0 && (
              <p
                role="status"
                className="rounded-md bg-secondary p-3 text-xs text-secondary-foreground"
              >
                Parallel ignores Blocked sources while Allowed sources has entries.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Enter domains, paths, or extensions such as .gov. Omit https:// and wildcards. Both
              lists allow 200 entries combined. Turbo accepts domains and extensions, but not paths.
            </p>
            {show("after_date") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-after-date"}>Published on or after</Label>
                <Input
                  id={side + "-after-date"}
                  type="date"
                  value={source.after_date ?? ""}
                  onChange={(e) =>
                    advanced({
                      source_policy: { ...source, after_date: e.target.value || undefined },
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Filters publication dates. Cache age is configured separately.
                </p>
              </div>
            )}
          </Group>
        )}
        {(show("max_chars_total") || show("max_results") || show("max_chars_per_result")) && (
          <Group title="Results and excerpts" detail={`${a.max_results ?? 10} results maximum`}>
            {show("max_chars_total") && (
              <NumberField
                id={side + "-max-chars-total"}
                label="Total excerpt characters"
                value={request.max_chars_total}
                onChange={(max_chars_total) => onRequest({ ...request, max_chars_total })}
              />
            )}
            {show("max_results") && (
              <NumberField
                id={side + "-max-results"}
                label="Maximum results"
                value={a.max_results}
                onChange={(max_results) => advanced({ max_results })}
                hint="Default: 10 results. Public modes return at most 20 results; fewer may be available."
              />
            )}
            {a.max_results != null && a.max_results > 20 && (
              <p role="status" className="text-xs text-muted-foreground">
                Parallel returns at most 20 results and includes a warning.
              </p>
            )}
            {show("max_chars_per_result") && (
              <NumberField
                id={side + "-max-chars-per-result"}
                label="Excerpt characters per result"
                value={a.excerpt_settings?.max_chars_per_result}
                onChange={(max_chars_per_result) =>
                  advanced({ excerpt_settings: { max_chars_per_result } })
                }
                hint="Excerpts may be shorter than this limit."
              />
            )}
          </Group>
        )}
        {show("location") && (
          <Group
            title="Location"
            detail={
              a.location
                ? countryNames.of(a.location.toUpperCase()) || a.location
                : "Automatic country selection"
            }
          >
            {show("location") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-location"}>Target country</Label>
                <Select
                  value={a.location?.toLowerCase() || "automatic"}
                  onValueChange={(location) =>
                    advanced({ location: location === "automatic" ? undefined : location })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger id={side + "-location"} className="w-full">
                    <SelectValue>
                      {a.location
                        ? `${countryNames.of(a.location.toUpperCase())} (${a.location.toUpperCase()})`
                        : "Automatic"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="automatic">Automatic</SelectItem>
                    {locations.map((code) => (
                      <SelectItem key={code} value={code}>
                        {countryNames.of(code.toUpperCase())} ({code.toUpperCase()})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Prioritize results from this country.
                </p>
              </div>
            )}
          </Group>
        )}
        {(show("max_age_seconds") || show("timeout_seconds") || show("disable_cache_fallback")) && (
          <Group
            title="Freshness"
            detail={
              fetch.max_age_seconds == null
                ? "Cached content by default"
                : `Refresh content older than ${fetch.max_age_seconds.toLocaleString()} seconds`
            }
          >
            <p className="text-xs text-muted-foreground">
              Fetching live pages can take longer. Leave these fields empty to use API defaults.
            </p>
            {show("max_age_seconds") && (
              <NumberField
                id={side + "-cache-age"}
                label="Maximum cache age (seconds)"
                value={fetch.max_age_seconds}
                min={600}
                onChange={(max_age_seconds) =>
                  advanced({ fetch_policy: { ...fetch, max_age_seconds } })
                }
                hint="Minimum: 600 seconds. One day: 86,400 seconds."
              />
            )}
            {show("timeout_seconds") && (
              <NumberField
                id={side + "-fetch-timeout"}
                label="Fetch timeout (seconds)"
                value={fetch.timeout_seconds}
                step="any"
                min={0.001}
                onChange={(timeout_seconds) =>
                  advanced({ fetch_policy: { ...fetch, timeout_seconds } })
                }
              />
            )}
            {show("disable_cache_fallback") && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={side + "-no-cache-fallback"}
                    checked={fetch.disable_cache_fallback ?? false}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      advanced({
                        fetch_policy: { ...fetch, disable_cache_fallback: checked === true },
                      })
                    }
                  />
                  <Label htmlFor={side + "-no-cache-fallback"}>Disable cache fallback</Label>
                </div>
                <p className="text-xs text-muted-foreground">
                  Return an error if live fetching fails, instead of using older cached content.
                </p>
              </div>
            )}
          </Group>
        )}
        {(show("session_id") || show("client_model")) && (
          <Group
            title="API context"
            detail={
              request.session_id || request.client_model
                ? "Custom context"
                : "New API session · No client model"
            }
          >
            {show("session_id") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-session-id"}>API session ID</Label>
                <Input
                  id={side + "-session-id"}
                  maxLength={1000}
                  value={request.session_id ?? ""}
                  placeholder="Generated by Parallel when omitted"
                  onChange={(e) =>
                    onRequest({ ...request, session_id: e.target.value || undefined })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Reuse a Search or Extract session for related calls. This differs from a saved
                  evaluation ID.
                </p>
              </div>
            )}
            {show("client_model") && (
              <div className="space-y-2">
                <Label htmlFor={side + "-client-model"}>Client model</Label>
                <Input
                  id={side + "-client-model"}
                  value={request.client_model ?? ""}
                  placeholder="For example, gpt-5.4"
                  onChange={(e) =>
                    onRequest({ ...request, client_model: e.target.value || undefined })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  The AI model that will use the results. Leave empty for human review.
                </p>
              </div>
            )}
          </Group>
        )}
      </div>
    </div>
  );
  return (
    <fieldset
      disabled={disabled}
      aria-label={shared ? "Shared settings" : `Configuration ${side}`}
      className="configuration-panel min-w-0 rounded-lg border bg-card p-3 space-y-2"
    >
      <legend className="sr-only">{shared ? "Shared settings" : `Configuration ${side}`}</legend>
      <h2 className="configuration-heading text-sm font-semibold">
        {shared ? "Shared settings" : `Configuration ${side}`}
      </h2>
      {shared && <p className="text-xs text-muted-foreground">Applies to both configurations.</p>}
      {editor}
    </fieldset>
  );
}

type Settings = NonNullable<SearchRequest["advanced_settings"]>;
type Axis = {
  /** The v1 request field this axis moves, shown verbatim in the selector. */
  key: string;
  label: string;
  note: string;
  input?: { label: string; kind: "text" | "date" | "country"; initial: string; hint?: string };
  apply: (pair: [SearchRequest, SearchRequest], value: string) => void;
};
const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const settings = (request: SearchRequest) => request.advanced_settings as Settings;
const oneYearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);

// Every axis holds A at the baseline and moves exactly one documented parameter on B, so a
// difference in the results is attributable to that parameter and nothing else.
const axes: Axis[] = [
  {
    key: "mode",
    label: "Search mode",
    note: "Choose a search mode on each side. All other settings are shared.",
    apply: (pair) => {
      pair[1].mode = pair[0].mode === "advanced" ? "fast" : "advanced";
    },
  },
  {
    key: "include_domains",
    label: "Allowed sources",
    note: "Compare unrestricted sources with Allowed sources. Parallel ignores Blocked sources when Allowed sources has entries.",
    input: {
      label: "Allowed sources",
      kind: "text",
      initial: "docs.parallel.ai",
      hint: "Domains, paths, or extensions, separated by commas.",
    },
    apply: (pair, value) => {
      settings(pair[1]).source_policy = {
        ...settings(pair[0]).source_policy,
        include_domains: list(value),
      };
    },
  },
  {
    key: "exclude_domains",
    label: "Blocked sources",
    note: "Compare all sources with a search that excludes the blocked sources.",
    input: {
      label: "Blocked sources",
      kind: "text",
      initial: "reddit.com, youtube.com/shorts",
      hint: "Domains, paths, or extensions, separated by commas.",
    },
    apply: (pair, value) => {
      settings(pair[0]).source_policy = { ...settings(pair[0]).source_policy, include_domains: [] };
      settings(pair[1]).source_policy = {
        ...settings(pair[0]).source_policy,
        exclude_domains: list(value),
      };
    },
  },
  {
    key: "after_date",
    label: "Publication date",
    note: "Compare all publication dates with a chosen start date. Cache age is a separate setting.",
    input: { label: "Published on or after", kind: "date", initial: oneYearAgo },
    apply: (pair, value) => {
      settings(pair[1]).source_policy = { ...settings(pair[0]).source_policy, after_date: value };
    },
  },
  {
    key: "location",
    label: "Country",
    note: "Compare automatic country selection with a chosen country.",
    input: { label: "Target country", kind: "country", initial: "jp" },
    apply: (pair, value) => {
      settings(pair[1]).location = value;
    },
  },
  {
    key: "max_results",
    label: "Maximum results",
    note: "Compare limits of five and 20 results. The API may return fewer results.",
    apply: (pair) => {
      settings(pair[0]).max_results = 5;
      settings(pair[1]).max_results = 20;
    },
  },
  {
    key: "max_chars_per_result",
    label: "Excerpt length",
    note: "Compare excerpt limits of 1,000 and 6,000 characters per result. Both configurations allow 60,000 characters in total.",
    apply: (pair) => {
      settings(pair[0]).excerpt_settings = { max_chars_per_result: 1000 };
      settings(pair[1]).excerpt_settings = { max_chars_per_result: 6000 };
      pair.forEach((request) => {
        request.max_chars_total = 60000;
      });
    },
  },
  {
    key: "max_age_seconds",
    label: "Cache age",
    note: "Compare cached content with pages refreshed after ten minutes. Fetching live pages can take longer.",
    apply: (pair) => {
      settings(pair[1]).fetch_policy = { ...settings(pair[0]).fetch_policy, max_age_seconds: 600 };
    },
  },
];

const fieldLabels: Record<string, string> = {
  mode: "Search mode",
  max_chars_total: "Total excerpt characters",
  session_id: "API session ID",
  client_model: "Client model",
  "advanced_settings.max_results": "Maximum results",
  "advanced_settings.location": "Target country",
  "advanced_settings.source_policy.include_domains": "Allowed sources",
  "advanced_settings.source_policy.exclude_domains": "Blocked sources",
  "advanced_settings.source_policy.after_date": "Published on or after",
  "advanced_settings.excerpt_settings.max_chars_per_result": "Excerpt characters per result",
  "advanced_settings.fetch_policy.max_age_seconds": "Maximum cache age (seconds)",
  "advanced_settings.fetch_policy.timeout_seconds": "Fetch timeout (seconds)",
  "advanced_settings.fetch_policy.disable_cache_fallback": "Disable cache fallback",
};

export function ComparisonAxes({
  requests,
  onApply,
  disabled,
  action,
  active,
}: {
  requests: SearchRequest[];
  onApply: (requests: SearchRequest[], field: string) => void;
  active: string;
  disabled: boolean;
  action?: ReactNode;
}) {
  const [notice, setNotice] = useState("");
  const differences = [
    ...(requests[0].mode !== requests[1].mode ? ["mode"] : []),
    ...settingsDifferences(requests[0], requests[1]),
  ];
  function value(request: SearchRequest, path: string) {
    const item = path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
        request,
      );
    return item == null
      ? "API default"
      : Array.isArray(item)
        ? item.join(", ") || "None"
        : String(item);
  }
  /** Rebuild both requests from the shared query plus one axis. Never runs a search. */
  function apply(key: string) {
    const chosen = axes.find((item) => item.key === key);
    const entered = chosen?.input?.initial ?? "";
    const base: SearchRequest = {
      ...structuredClone(requests[0]),
      advanced_settings: { ...structuredClone(requests[0].advanced_settings) },
    };
    const pair: [SearchRequest, SearchRequest] = [structuredClone(base), structuredClone(base)];
    try {
      if (chosen?.input && !entered.trim())
        throw new Error(`Enter a value for ${chosen.input.label.toLowerCase()}.`);
      chosen?.apply(pair, entered.trim());
      // Validate before applying, so an invalid entry leaves the current configuration alone.
      pair.forEach((request) => {
        validateSearchRequest(
          {
            ...request,
            search_queries: request.search_queries.every((query) => query.trim())
              ? request.search_queries
              : ["Preview"],
          },
          [request.mode!],
        );
      });
      onApply(pair, key);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Check the comparison settings.");
    }
  }
  return (
    <section
      aria-label="Comparison axes"
      className="experiment-toolbar col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3"
    >
      <span className="text-xs font-medium">Compare:</span>
      <Select
        value={active || null}
        disabled={disabled}
        onValueChange={(key) => {
          if (key && key !== active) apply(key);
        }}
      >
        <SelectTrigger aria-label="Comparison axis" className="w-52 max-w-full">
          <SelectValue>{axes.find((item) => item.key === active)?.label || "Multiple fields"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {axes.map((item) => (
            <SelectItem key={item.key} value={item.key} title={item.note}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {notice && (
        <span role="status" className="text-xs text-destructive">
          {notice}
        </span>
      )}
      <span className="ml-auto">{action}</span>
      <p
        role="group"
        aria-label="Configuration differences"
        className="min-w-0 basis-full text-xs text-muted-foreground break-words"
      >
        <span className="font-medium text-foreground">What differs: </span>
        {differences.length
          ? differences
              .map(
                (path) =>
                  `${fieldLabels[path] || path} — A: ${value(requests[0], path)} → B: ${value(requests[1], path)}`,
              )
              .join(" · ")
          : "Both configurations send the same request body."}
        {active
          ? `${differences.length ? "." : ""} Other settings are shared.`
          : " Multiple fields differ. Choose one setting to compare."}
      </p>
    </section>
  );
}
