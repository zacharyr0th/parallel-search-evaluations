export const relevanceLabels = [
  "Irrelevant",
  "Slightly relevant",
  "Mostly relevant",
  "Fully relevant",
] as const;
/** Grade glosses. Shown once above the results and as the per-button tooltip. */
export const relevanceHelp = [
  "Does not help.",
  "Related but offers little useful information.",
  "Useful but misses an important requirement.",
  "Directly meets the information need.",
] as const;
export const rubricNote =
  "Grades 2 and 3 mark a result correct for this query. Verify the page's factual accuracy separately.";
export const issueTags = [
  "Outdated",
  "Wrong entity",
  "Weak evidence",
  "Incomplete excerpt",
  "Duplicate",
  "Broken link",
] as const;
export const rubricVersion = "relevance-v1";
// The grade already answers the binary question: 2 means the result was useful despite missing
// a requirement, and 3 that it met the need outright. Deriving the answer keeps one rubric while
// still reporting, per result, whether it was correct.
export const meetsNeedThreshold = 2;
export type Scored = { relevance?: number | null; issues?: string[]; rubric_version?: string };
export function reviewed(r: Scored) {
  return r.relevance != null;
}
/** Whether the result met the query's information need; null while it is ungraded. */
export function meetsNeed(r: Scored): boolean | null {
  return r.relevance == null ? null : r.relevance >= meetsNeedThreshold;
}
export function meetsNeedLabel(r: Scored) {
  const value = meetsNeed(r);
  return value === null ? "Not yet judged" : value ? "Meets the need" : "Does not meet the need";
}
export function ratingLabel(r: Scored) {
  return r.relevance == null ? "Unrated" : `${r.relevance} — ${relevanceLabels[r.relevance]}`;
}
export function ratingFilter(r: Scored) {
  return r.relevance == null ? "unrated" : String(r.relevance);
}
export function validateRating(value: Record<string, unknown>) {
  if (
    value.relevance !== null &&
    (!Number.isInteger(value.relevance) ||
      Number(value.relevance) < 0 ||
      Number(value.relevance) > 3)
  )
    throw new Error("Choose a relevance score from 0 to 3, or clear the rating.");
  if (
    !Array.isArray(value.issues) ||
    value.issues.length > issueTags.length ||
    new Set(value.issues).size !== value.issues.length ||
    value.issues.some((tag) => !issueTags.includes(tag as (typeof issueTags)[number]))
  )
    throw new Error("Choose valid, unique issue tags.");
}
// Discounted rank weights, and the score a perfect top five would earn.
const rankWeight = (i: number) => 1 / Math.log2(i + 2);
const idealAt5 = 7 * [0, 1, 2, 3, 4].reduce((sum, i) => sum + rankWeight(i), 0);
export function relevanceMetrics(results: Scored[]) {
  const graded = results.filter((r) => r.relevance != null);
  const top = results.slice(0, 5);
  const complete = top.length === 5 && top.every((r) => r.relevance != null);
  return {
    graded: graded.length,
    mean_relevance: graded.length
      ? graded.reduce((sum, r) => sum + r.relevance!, 0) / graded.length
      : null,
    useful_at_5: complete ? top.filter((r) => r.relevance! >= meetsNeedThreshold).length / 5 : null,
    rank_score_at_5: complete
      ? (100 * top.reduce((sum, r, i) => sum + (2 ** r.relevance! - 1) * rankWeight(i), 0)) /
        idealAt5
      : null,
  };
}
export function resultMetrics(results: Scored[]) {
  const metrics = relevanceMetrics(results);
  return {
    ...metrics,
    total: results.length,
    unrated: results.length - metrics.graded,
    coverage: results.length ? metrics.graded / results.length : null,
  };
}

// ---------------------------------------------------------------- agreement
//
// Inter-rater agreement over the 0-3 relevance rubric.
//
// One grade per result tells you what a reviewer thought. It does not tell you whether the
// rubric is being applied consistently, and a mode comparison decided by a single reviewer
// cannot distinguish a real quality gap from one person's bad afternoon. These measures need
// results that at least two reviewers have graded independently.

export type Rating = { result_id: number; actor: string; relevance: number };

const CATEGORIES = relevanceLabels.length;
// Quadratic weights: the conventional choice for an ordinal scale, where 3-vs-0 is a far
// worse disagreement than 3-vs-2. Nominal kappa would treat both as equally wrong.
const gradeWeight = (a: number, b: number) => 1 - (a - b) ** 2 / (CATEGORIES - 1) ** 2;

/**
 * Quadratic-weighted Cohen's kappa for one pair of reviewers.
 * Returns null when the pair shares fewer than two results, or when expected agreement is
 * total — kappa is undefined there rather than perfect.
 */
export function weightedKappa(pairs: [number, number][]): number | null {
  if (pairs.length < 2) return null;
  const n = pairs.length;
  const first = Array<number>(CATEGORIES).fill(0);
  const second = Array<number>(CATEGORIES).fill(0);
  let observed = 0;
  for (const [a, b] of pairs) {
    first[a]++;
    second[b]++;
    observed += gradeWeight(a, b);
  }
  observed /= n;
  let expected = 0;
  for (let a = 0; a < CATEGORIES; a++)
    for (let b = 0; b < CATEGORIES; b++)
      expected += gradeWeight(a, b) * (first[a] / n) * (second[b] / n);
  if (expected >= 1) return null;
  return (observed - expected) / (1 - expected);
}

/** Plain-language reading of a kappa value, on the conventional Landis and Koch bands. */
export function kappaLabel(kappa: number | null): string {
  if (kappa === null) return "Kappa unavailable";
  if (kappa < 0.2) return "Poor";
  if (kappa < 0.4) return "Fair";
  if (kappa < 0.6) return "Moderate";
  if (kappa < 0.8) return "Substantial";
  return "Almost perfect";
}

/**
 * Agreement across every reviewer who graded the same results.
 *
 * `ratings` must hold at most one entry per (result, reviewer) — the reviewer's current
 * grade, not their history, or a reviewer who revised their mind would be counted twice.
 */
export function agreementMetrics(ratings: Rating[]) {
  const byResult = new Map<number, Map<string, number>>();
  for (const { result_id, actor, relevance } of ratings) {
    if (!byResult.has(result_id)) byResult.set(result_id, new Map());
    byResult.get(result_id)!.set(actor, relevance);
  }
  const reviewers = [...new Set(ratings.map((r) => r.actor))].sort();
  // Only doubly-graded results can carry agreement; everything below is measured over these.
  const shared = [...byResult.entries()].filter(([, grades]) => grades.size > 1);

  // Every unordered reviewer pair that graded at least one result in common.
  const pairs: {
    reviewers: [string, string];
    kappa: number | null;
    overlap: number;
    exact: number;
    adjacent: number;
  }[] = [];
  for (let i = 0; i < reviewers.length; i++) {
    for (let j = i + 1; j < reviewers.length; j++) {
      const both: [number, number][] = [];
      for (const [, grades] of shared) {
        const a = grades.get(reviewers[i]),
          b = grades.get(reviewers[j]);
        if (a !== undefined && b !== undefined) both.push([a, b]);
      }
      if (!both.length) continue;
      pairs.push({
        reviewers: [reviewers[i], reviewers[j]],
        kappa: weightedKappa(both),
        overlap: both.length,
        exact: both.filter(([a, b]) => a === b).length / both.length,
        adjacent: both.filter(([a, b]) => Math.abs(a - b) <= 1).length / both.length,
      });
    }
  }

  // Across all doubly-graded results, not just one pair.
  const spans = shared.map(([result_id, grades]) => {
    const values = [...grades.values()];
    return {
      result_id,
      spread: Math.max(...values) - Math.min(...values),
      grades: [...grades.entries()],
    };
  });
  const scored = pairs.filter((p) => p.kappa !== null);

  return {
    reviewers,
    double_graded: shared.length,
    single_graded: byResult.size - shared.length,
    exact_agreement: spans.length
      ? spans.filter((s) => s.spread === 0).length / spans.length
      : null,
    adjacent_agreement: spans.length
      ? spans.filter((s) => s.spread <= 1).length / spans.length
      : null,
    // Mean over reviewer pairs; with two reviewers this is simply their kappa.
    kappa: scored.length ? scored.reduce((sum, p) => sum + p.kappa!, 0) / scored.length : null,
    pairs,
    // Worth a second look first: the widest disagreements.
    disputed: spans.filter((s) => s.spread >= 2).sort((a, b) => b.spread - a.spread),
  };
}

// ---------------------------------------------------------------- overlap
//
// A shared URL is the one place two configurations can be compared directly: same page, same
// query, two rankings. Counting the overlap says how much they retrieve in common; the rank
// each side gave a shared page says whether they order it the same way, which is a different
// question and the one a ranking change actually moves.

export type Ranked = Scored & { url: string; rank: number; title?: string };

/**
 * Compare two result lists over the URLs they both returned.
 *
 * Duplicate URLs inside one list stay separate results everywhere else in the application, but
 * a rank comparison needs one position per side, so the best-ranked occurrence is used.
 */
export function overlapMetrics(a: Ranked[], b: Ranked[]) {
  const best = (results: Ranked[]) => {
    const map = new Map<string, Ranked>();
    for (const result of results)
      if (!map.has(result.url) || result.rank < map.get(result.url)!.rank)
        map.set(result.url, result);
    return map;
  };
  const left = best(a),
    right = best(b);
  const shared = [...left.values()]
    .filter((result) => right.has(result.url))
    .map((result) => {
      const other = right.get(result.url)!;
      return {
        url: result.url,
        title: result.title || result.url,
        a: result.rank,
        b: other.rank,
        // Positive means B ranked the page higher than A did.
        move: result.rank - other.rank,
        grades: [result.relevance ?? null, other.relevance ?? null] as [
          number | null,
          number | null,
        ],
      };
    })
    .sort((x, y) => Math.abs(y.move) - Math.abs(x.move) || x.a - y.a);
  const moved = shared.filter((item) => item.move !== 0);
  return {
    shared,
    count: shared.length,
    only_a: left.size - shared.length,
    only_b: right.size - shared.length,
    moved: moved.length,
    unchanged: shared.length - moved.length,
    median_move: median(moved.map((item) => Math.abs(item.move))),
    // The same page graded differently on the two sides is a rubric slip, not a search result.
    regraded: shared.filter(
      (item) =>
        item.grades[0] !== null && item.grades[1] !== null && item.grades[0] !== item.grades[1],
    ).length,
  };
}

// ------------------------------------------------------------ across queries
//
// One query decides nothing. A rank score on a single comparison is an anecdote: the two
// configurations differ, but so would two runs of the same configuration on a different day.
// These functions pool every comparison that varied the same request field and report whether
// the split is wider than chance, on the same rule the per-result metrics follow — withhold the
// verdict until the evidence for it exists.

/**
 * Exact two-sided sign test on paired wins and losses; ties are excluded by the caller.
 * Returns the probability of a split at least this lopsided under a fair coin, or null with
 * no decided comparisons. The sign test assumes nothing about the size of each difference,
 * which is the right choice here: rank-score deltas are not comparable across queries.
 */
export function signTest(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (!n) return null;
  const k = Math.max(wins, losses);
  let coefficient = 1;
  for (let i = 0; i < k; i++) coefficient = (coefficient * (n - i)) / (i + 1);
  let tail = 0;
  for (let i = k; i <= n; i++) {
    tail += coefficient;
    coefficient = (coefficient * (n - i)) / (i + 1);
  }
  return Math.min(1, tail / 2 ** (n - 1));
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The conventional threshold. Above it the app reports no winner rather than a weak one. */
export const significanceLevel = 0.05;

export type Comparison = {
  id: string;
  differences?: { field: string; a: string; b: string }[] | null;
  configurations?: {
    label: string;
    rank_score_at_5: number | null;
    elapsed: number | null;
  }[];
};

/**
 * Pool comparisons by the single request field they varied.
 *
 * Comparisons that moved more than one field are counted but never pooled: their outcome
 * cannot be attributed to any one field. Blinded evaluations report no differences until they
 * are revealed, so they drop out here rather than being grouped under a placeholder.
 */
export function axisAggregates(comparisons: Comparison[]) {
  const groups = new Map<
    string,
    {
      field: string;
      values: [string, string];
      wins: Record<string, number>;
      elapsed: Record<string, number[]>;
      deltas: number[];
      ties: number;
      pending: number;
    }
  >();
  let confounded = 0;
  for (const comparison of comparisons) {
    // Anything without a recorded difference contributes nothing: an evaluation saved before
    // this field existed, a single-run evaluation, or an unrevealed blind review.
    const differences = comparison.differences || [];
    if (differences.length > 1) {
      confounded++;
      continue;
    }
    const [difference] = differences;
    if (!difference || comparison.configurations?.length !== 2) continue;
    // Group on the pair of values, not on A and B: a blinded evaluation assigns the sides at
    // random, so grouping by side would split one axis across two buckets.
    const values = [difference.a, difference.b].sort() as [string, string];
    const key = `${difference.field}\u0000${values.join("\u0000")}`;
    if (!groups.has(key))
      groups.set(key, {
        field: difference.field,
        values,
        wins: { [values[0]]: 0, [values[1]]: 0 },
        elapsed: { [values[0]]: [], [values[1]]: [] },
        deltas: [],
        ties: 0,
        pending: 0,
      });
    const group = groups.get(key)!;
    const sides = comparison.configurations.map((configuration, index) => ({
      value: index === 0 ? difference.a : difference.b,
      score: configuration.rank_score_at_5,
      elapsed: configuration.elapsed,
    }));
    for (const side of sides)
      if (side.elapsed !== null) group.elapsed[side.value]?.push(side.elapsed);
    if (sides.some((side) => side.score === null)) {
      group.pending++;
      continue;
    }
    const [first, second] = sides;
    if (first.score === second.score) group.ties++;
    else {
      const winner = first.score! > second.score! ? first : second;
      group.wins[winner.value] = (group.wins[winner.value] ?? 0) + 1;
      group.deltas.push(Math.abs(first.score! - second.score!));
    }
  }
  const axes = [...groups.values()]
    .map((group) => {
      const [first, second] = group.values;
      const decided = group.wins[first] + group.wins[second];
      const leader =
        group.wins[first] === group.wins[second]
          ? null
          : group.wins[first] > group.wins[second]
            ? first
            : second;
      const p = signTest(group.wins[first], group.wins[second]);
      return {
        ...group,
        decided,
        compared: decided + group.ties + group.pending,
        leader,
        p,
        median_delta: median(group.deltas),
        median_elapsed: {
          [first]: median(group.elapsed[first]),
          [second]: median(group.elapsed[second]),
        },
        // A leader that has not cleared the threshold is reported as undecided, never as a
        // weak winner: the whole point of pooling is to stop calling noise a result.
        significant: leader !== null && p !== null && p < significanceLevel,
      };
    })
    .sort((a, b) => b.decided - a.decided || a.field.localeCompare(b.field));
  return { axes, confounded };
}
