# Evaluation methodology

The application compares search configurations using saved relevance grades. This reference defines
the metrics and their limits for reviewers interpreting the results.
The implementation is in [scoring.ts](../lib/scoring.ts) and
[evaluations.ts](../lib/evaluations.ts).

## Grades and result metrics

Reviewers assign each result a relevance grade from 0 to 3. Grades 2 and 3 count as correct for the query;
ungraded results have no verdict. Grades measure relevance, not factual accuracy.

- **Mean relevance** averages graded results and excludes ungraded results.
- **Useful at 5** is the fraction of the first five results graded 2 or 3. It requires five results,
  all graded.
- **Rank score** uses gain `2^grade − 1`, discounted by `1/log2(rank + 1)`, for the first five
  results. Rank starts at one. Five results graded 3 score 100. The metric requires all five grades.
- **URL overlap** matches exact URLs and compares their ranks. For duplicate URLs, this metric uses
  the best-ranked occurrence on each side; the feedback interface retains each result separately.

The application flags different grades for the same URL for review. They may reflect different excerpts,
reviewer judgments, or inconsistent application of the rubric; the flag does not identify the cause.

## Comparing configurations

The comparison controls vary mode, allowed or blocked sources, publication date, country, maximum
results, excerpt length, or cache age. Other settings are shared. **What differs** describes the
actual request differences. Changing one setting helps attribute the observed difference to that setting.

A completed comparison uses the rank scores of the first five results on each side to identify
which configuration scored higher. Full review progress includes all results. A single comparison
supports a judgment about that query, not a general conclusion about a mode.

Blind review randomly assigns configurations to A and B and preserves that assignment. Both sides
must return at least five results. After those results are graded, the application reveals the modes
and latency and enables exports.

## Comparisons across queries

**Compare multiple queries** applies the current configurations, criteria, and blind setting to up
to 20 queries. Each query produces a saved evaluation and makes two Search API calls. The workspace
allows 100 calls per UTC day.

The batch validates all queries before starting, runs comparisons sequentially, and stops on the
first error without automatically retrying. Previously saved comparisons remain available.

The **Evaluations** page groups comparisons from the 100 most recent evaluations by the single
field changed and its pair of values, regardless of A/B assignment. Comparisons with multiple
changed fields are excluded. Unrevealed blind reviews do not contribute to a group.

The application applies an exact two-sided sign test to wins and losses, excluding ties and
ungraded comparisons. It reports a winner when `p < 0.05`; otherwise it shows **Insufficient evidence**.
The test counts which configuration scored higher; it does not use the size of the score difference. The panel also reports the
median absolute score gap among non-tied, graded comparisons and median recorded latency per configuration.

These findings describe the saved sample. The application does not enforce independent or
representative query selection, exclude repeated queries from this test, or adjust for testing
multiple groups. Generated grades demonstrate the interface and must not be treated as evidence
of real search quality.

## Reviewer agreement

Open **Review details**, then **Reviewer agreement**, to compare reviewers’ grades. The panel uses
each reviewer’s latest saved grade for each result. It measures only results graded by more than one reviewer.

- **Exact** measures how often all reviewers gave the same grade.
- **Within one** measures how often the widest grade difference was at most one.
- **Kappa** reports quadratic-weighted Cohen’s kappa for a reviewer pair. With multiple pairs,
  the summary averages the defined pair scores. Undefined scores are omitted.
- **Grades to review** lists results with a grade spread of at least two, widest first.

Agreement measures consistency, not factual correctness. Shared access and visible feedback also
mean the application does not guarantee that reviewers grade independently.
