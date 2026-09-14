import schema from "./search-schema.json";

/** Documented mode behaviour, from the Search API quickstart and the request schema.
    The latency figures are the published budgets, not a measurement. */
export const modeDocs: Record<string, { latency: string; detail: string }> = {
  turbo: { latency: "Median: 200 ms", detail: "Fastest. Source paths are not supported." },
  fast: { latency: "~700 ms", detail: "Designed for searches that need to finish within one second." },
  basic: { latency: "Low latency", detail: "Works best with two or three high-quality queries." },
  advanced: {
    latency: "~3 s",
    detail: "Advanced retrieval and compression. The API default.",
  },
};
/** `usage` entries name a billed SKU, for example `sku_search`. */
export function usageSummary(usage: unknown[] | null | undefined) {
  const entries = (usage || []).filter(
    (item): item is { name: string; count: number } =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { name?: unknown }).name === "string" &&
      typeof (item as { count?: unknown }).count === "number",
  );
  return entries.map((item) => `${item.name} ×${item.count}`).join(", ");
}

export const locations =
  "ar au at be br ca cl cn dk fi fr de gr hk in id it jp my mx nl nz no ph pl pt ru sa za kr es se ch tw tr gb us".split(
    " ",
  );
export type SearchRequest = {
  search_queries: string[];
  objective?: string | null;
  mode?: string | null;
  max_chars_total?: number | null;
  session_id?: string | null;
  client_model?: string | null;
  advanced_settings?: {
    max_results?: number | null;
    location?: string | null;
    excerpt_settings?: { max_chars_per_result?: number | null } | null;
    source_policy?: {
      include_domains?: string[];
      exclude_domains?: string[];
      after_date?: string | null;
    } | null;
    fetch_policy?: {
      max_age_seconds?: number | null;
      timeout_seconds?: number | null;
      disable_cache_fallback?: boolean;
    } | null;
  } | null;
};
type Schema = {
  type?: string;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  maxLength?: number;
  items?: Schema;
};
export function prepareSearchRequest(request: SearchRequest): SearchRequest {
  const copy: SearchRequest = JSON.parse(JSON.stringify(request));
  copy.search_queries = copy.search_queries.map((q) => q.trim());
  const source = copy.advanced_settings?.source_policy;
  for (const key of ["include_domains", "exclude_domains"] as const) {
    if (source?.[key]) source[key] = source[key].map((s) => s.trim()).filter(Boolean);
  }
  return copy;
}
// Validate the checked-in endpoint schema before either backend spends API credits.
function matches(value: unknown, rule: Schema, path: string): void {
  if (rule.anyOf) {
    if (value === null && rule.anyOf.some((r) => r.type === "null")) return;
    matches(value, rule.anyOf.find((r) => r.type !== "null")!, path);
    return;
  }
  const valid =
    rule.type === "object"
      ? value !== null && typeof value === "object" && !Array.isArray(value)
      : rule.type === "array"
        ? Array.isArray(value)
        : rule.type === "integer"
          ? Number.isSafeInteger(value)
          : rule.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : rule.type === "null"
              ? value === null
              : typeof value === rule.type;
  if (!valid) throw new Error(`${path}: expected ${rule.type}.`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path}: unsupported value.`);
  if (typeof value === "string" && rule.maxLength && [...value].length > rule.maxLength)
    throw new Error(`${path}: maximum ${rule.maxLength} characters.`);
  if (Array.isArray(value))
    value.forEach((item, i) => {
      matches(item, rule.items!, `${path}[${i + 1}]`);
    });
  if (rule.type === "object") {
    const object = value as Record<string, unknown>;
    for (const key of rule.required || [])
      if (!(key in object)) throw new Error(`${path}.${key} is required.`);
    for (const [key, item] of Object.entries(object)) {
      if (!rule.properties?.[key]) throw new Error(`${path}.${key}: unsupported field.`);
      matches(item, rule.properties[key], `${path}.${key}`);
    }
  }
}
export function validateSearchRequest(
  value: unknown,
  modes: string[],
  blind = false,
): SearchRequest {
  matches(value, schema, "Search");
  const request = value as SearchRequest,
    a = request.advanced_settings,
    source = a?.source_policy;
  const queries = request.search_queries;
  if (
    !queries.length ||
    queries.length > 5 ||
    queries.some((q) => !q.trim() || [...q].length > 200)
  )
    throw new Error("Enter 1–5 queries, each with 1–200 characters.");
  if (request.objective && [...request.objective].length > 5000)
    throw new Error("Keep the search objective within 5,000 characters.");
  for (const [name, number] of [
    ["Total excerpt characters", request.max_chars_total],
    ["Excerpt characters per result", a?.excerpt_settings?.max_chars_per_result],
    ["Maximum results", a?.max_results],
    ["Fetch timeout", a?.fetch_policy?.timeout_seconds],
  ] as const) {
    if (number != null && number <= 0) throw new Error(`${name} must be greater than zero.`);
  }
  if (a?.fetch_policy?.max_age_seconds != null && a.fetch_policy.max_age_seconds < 600)
    throw new Error("Cache age must be at least 600 seconds.");
  if (a?.location && !locations.includes(a.location.toLowerCase()))
    throw new Error("Choose a supported country.");
  const domains = [...(source?.include_domains || []), ...(source?.exclude_domains || [])];
  if (domains.length > 200)
    throw new Error("Use no more than 200 source entries across both lists.");
  for (const domain of domains) {
    if (
      !domain ||
      /[\s?#*]/u.test(domain) ||
      /[:@\\]/u.test(domain.split("/")[0]) ||
      !domain.split("/")[0].replace(/^\./, "")
    )
      throw new Error(
        "Source entries must omit schemes, ports, spaces, wildcards, query strings, and fragments.",
      );
    if (modes.includes("turbo") && domain.split("/").slice(1).some(Boolean))
      throw new Error(
        "Turbo does not support source paths. Use domains or extensions, or choose another mode.",
      );
  }
  if (
    source?.after_date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(source.after_date) ||
      !Number.isFinite(Date.parse(source.after_date)) ||
      new Date(source.after_date).toISOString().slice(0, 10) !== source.after_date)
  )
    throw new Error("Enter a valid publication date (YYYY-MM-DD).");
  if (blind && a?.max_results != null && a.max_results < 5)
    throw new Error("Blind review requires at least five results per mode.");
  return request;
}

export function comparisonRequests(
  shared: SearchRequest,
  second: SearchRequest | null,
  modes: string[],
): SearchRequest[] {
  return modes.map((mode, index) => ({
    ...prepareSearchRequest(
      index === 1 && second
        ? { ...second, search_queries: shared.search_queries, objective: shared.objective }
        : shared,
    ),
    mode,
  }));
}

export function settingsDifferences(a: SearchRequest, b: SearchRequest): string[] {
  const flatten = (value: unknown, prefix = ""): Record<string, string> => {
    if (value == null) return {};
    if (typeof value !== "object" || Array.isArray(value))
      return { [prefix]: JSON.stringify(value) };
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "mode")
        .flatMap(([key, child]) =>
          Object.entries(flatten(child, prefix ? `${prefix}.${key}` : key)),
        ),
    );
  };
  const left = flatten(a),
    right = flatten(b);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (key) => left[key] !== right[key],
  );
}

/** Apply shared settings while preserving the one field being compared. */
export function withSharedSettings(
  shared: SearchRequest,
  original: SearchRequest,
  field: string,
): SearchRequest {
  const result = structuredClone(shared);
  const group = ["include_domains", "exclude_domains", "after_date"].includes(field)
    ? "source_policy"
    : ["max_age_seconds", "timeout_seconds", "disable_cache_fallback"].includes(field)
      ? "fetch_policy"
      : field === "max_chars_per_result"
        ? "excerpt_settings"
        : null;
  const path = group
    ? ["advanced_settings", group, field]
    : ["max_results", "location"].includes(field)
      ? ["advanced_settings", field]
      : [field];
  let target = result as Record<string, unknown>;
  let source = original as Record<string, unknown> | undefined;
  for (const key of path.slice(0, -1)) {
    target[key] ??= {};
    target = target[key] as Record<string, unknown>;
    source = source?.[key] as Record<string, unknown> | undefined;
  }
  if (source?.[field] === undefined) delete target[field];
  else target[field] = structuredClone(source[field]);
  return result;
}
