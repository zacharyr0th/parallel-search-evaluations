// Every browser check that needs `npm run dev` on http://127.0.0.1:3000: the workspace shell
// (theme, navigation, the evaluations table and its toolbar), the review loop end to end,
// grading with the agreement panel and activity log, and responsive layout.
//
// API responses are fixtures except where a case states otherwise, so no credits are spent.
import assert from "node:assert/strict";
import { base, scenario, finish, option } from "./browser.mjs";
import { load } from "./load.mjs";

// ---------------------------------------------------------------------- theme

const dark = (page) =>
  page.locator("html").evaluate((element) => element.classList.contains("dark"));

async function choose(page, value) {
  if ((await dark(page)) !== (value === "Dark"))
    await page.getByRole("button", { name: `Switch to ${value.toLowerCase()} mode` }).click();
  await page
    .getByRole("button", { name: `Switch to ${value === "Dark" ? "light" : "dark"} mode` })
    .waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector("input");
    return (
      input &&
      getComputedStyle(input).backgroundColor ===
        (document.documentElement.classList.contains("dark")
          ? "rgb(17, 17, 19)"
          : "rgb(255, 255, 255)")
    );
  });
}

await scenario(
  "the theme follows the system until the reviewer overrides it",
  async (page, { context, errors }) => {
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: "Switch to light mode" }).waitFor();
    assert.equal(await dark(page), true, "a dark system starts dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));

    await choose(page, "Dark");
    await page.reload();
    await page.getByRole("button", { name: "Switch to light mode" }).waitFor();
    assert.equal(await dark(page), true, "an explicit choice survives a reload");

    const other = await context.newPage();
    await other.goto(`${base}/`);
    await choose(page, "Light");
    await other.waitForFunction(() => document.documentElement.dataset.themePreference === "light");
    assert.equal(await dark(other), false, "the choice reaches an already open tab");

    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await dark(page), false, "an explicit light choice overrides a dark system");
    assert.equal(await page.getByRole("combobox", { name: "Color theme" }).count(), 0);

    for (const theme of ["Light", "Dark"]) {
      await choose(page, theme);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        `${theme} fits a narrow viewport`,
      );
    }
    assert.deepEqual(errors, []);
  },
  { colorScheme: "dark", viewport: { width: 1440, height: 1000 } },
);

await scenario(
  "a theme choice holds when storage is unavailable",
  async (page) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new Error("Storage unavailable");
      };
      Storage.prototype.setItem = () => {
        throw new Error("Storage unavailable");
      };
    });
    await page.goto(`${base}/`);
    await choose(page, "Light");
    assert.equal(await dark(page), false);
    await page.emulateMedia({ colorScheme: "light" });
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(
      await dark(page),
      false,
      "the manual preference survives system changes without storage",
    );
  },
  { colorScheme: "dark" },
);

await scenario("credit loading survives navigation between workspace pages", async (page) => {
  let release;
  let requests = 0;
  await page.route("**/api/credits", async (route) => {
    requests++;
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: { available: true, invoiced: false, balanceCents: 968, currency: "USD" },
    });
  });
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: [] }));
  const started = page.waitForRequest("**/api/credits");
  await page.goto(base);
  await started;
  await page.getByText("Checking credits…", { exact: true }).waitFor();
  const link = page.getByRole("link", { name: "Evaluations", exact: true });
  await link.hover();
  const initialRequests = requests;
  await link.click();
  await page.waitForURL("**/runs");
  release();
  await page.getByText("$9.68 API credits", { exact: true }).waitFor();
  assert.equal(requests, initialRequests, "navigation shares the in-flight balance request");
});

// ----------------------------------------------------------------- navigation

const navigationFixture = {
  id: "navigation-test",
  query: "Test",
  criteria: "Relevant",
  created_at: new Date().toISOString(),
  feedback_history: [],
  runs: [
    {
      id: "a",
      mode: "advanced",
      status: "completed",
      elapsed: 1,
      request: { search_queries: ["Test"], mode: "advanced" },
      results: [
        {
          id: 1,
          rank: 1,
          url: "https://example.com",
          title: "Example",
          excerpts: ["Excerpt"],
          judgment: null,
          notes: "",
          version: 0,
          updated_at: null,
        },
      ],
    },
  ],
};

await scenario("navigating the workspace keeps the document and unsaved notes", async (page) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/evaluation"
          ? navigationFixture
          : path === "/api/evaluations"
            ? []
            : path === "/api/activity"
              ? route.request().method() === "GET"
                ? []
                : { saved: true }
              : null,
    });
  });
  await page.goto(`${base}/?id=navigation-test`);
  const card = page.getByRole("article").first();
  await card.waitFor();
  assert.equal(
    await card.evaluate((element) => getComputedStyle(element).contentVisibility),
    "auto",
    "offscreen results defer their layout",
  );

  await card.getByText("Add notes", { exact: true }).click();
  await card.getByRole("textbox").fill("Unsaved note");
  await page.evaluate(() => {
    window.navigationSentinel = "same document";
  });
  page.once("dialog", (dialog) => dialog.dismiss());
  const evaluations = page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Evaluations", exact: true });
  await evaluations.click();
  assert.ok(page.url().includes("id=navigation-test"), "leaving with an unsaved note is refused");
  assert.equal(await card.getByRole("textbox").inputValue(), "Unsaved note");

  await card.getByRole("textbox").fill("");
  await evaluations.click();
  await page.waitForURL("**/runs");
  assert.equal(
    await page.evaluate(() => window.navigationSentinel),
    "same document",
    "the workspace navigates without reloading the document",
  );
});

// ------------------------------------------------------- the evaluations table

const paged = Array.from({ length: 57 }, (_, index) => ({
  id: String(index),
  query: `Query ${index}`,
  criteria: "",
  modes: "fast,advanced",
  created_at: new Date(2026, 0, 1, 0, index).toISOString(),
  review_status: "Not started",
  reviewed: 0,
  total: 10,
  configurations: [],
  reviewers: [],
}));

await scenario("the evaluations table pages through history and filters it", async (page) => {
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: paged }));
  await page.goto(`${base}/runs`);
  await page.getByText("1–25 of 57 evaluations", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 25);

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText("26–50 of 57 evaluations", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 25);

  await page.getByRole("button", { name: "Next", exact: true }).click();
  assert.equal(await page.locator("tbody tr").count(), 7, "the last page holds the remainder");
  assert.equal(await page.getByRole("button", { name: "Next", exact: true }).isDisabled(), true);

  await page.getByPlaceholder("Search evaluations…").fill("Query 56");
  await page.getByText("1–1 of 1 evaluations", { exact: true }).waitFor();
  assert.equal(await page.locator("tbody tr").count(), 1, "a filter resets the page");
});

await scenario("pooled findings name a winner only once the sign test clears", async (page) => {
  const comparison = (index, field, a, b, scoreA, scoreB, elapsed) => ({
    id: `pooled-${index}`,
    query: `Pooled query ${index}`,
    criteria: "Documents the subject.",
    created_at: `2026-09-0${(index % 9) + 1}T10:00:00Z`,
    blind: false,
    revealed_at: null,
    modes: "fast,advanced",
    reviewed: 10,
    total: 10,
    review_status: "Complete",
    sharedSettings: "",
    reviewers: [{ actor: "reviewer@parallel.ai", count: 10 }],
    differences: [{ field, a, b }],
    outcome: { title: "Decided", winner: scoreA > scoreB ? "A" : "B", detail: "" },
    configurations: [a, b].map((value, side) => ({
      label: side === 0 ? "A" : "B",
      mode: value,
      elapsed: elapsed[side],
      status: "completed",
      settings: "",
      total: 5,
      graded: 5,
      mean_relevance: 2,
      useful_at_5: 0.8,
      rank_score_at_5: side === 0 ? scoreA : scoreB,
    })),
  });
  const rows = [
    // Six clean wins for advanced: the smallest sweep the sign test can call.
    ...[61, 55, 68, 49, 72, 58].map((score, index) =>
      comparison(index, "mode", "fast", "advanced", score, score + 18, [0.66, 3.02]),
    ),
    // One win each on a second axis, which must stay undecided.
    comparison(7, "max_results", "5", "20", 70, 64, [0.7, 0.7]),
    comparison(8, "max_results", "5", "20", 58, 73, [0.7, 0.7]),
  ];
  rows[0].reviewers = [{ actor: "Sample grader A (generated)", count: 10 }];
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: rows }));
  await page.goto(`${base}/runs`);
  const findings = page.getByRole("region", { name: "Findings by axis", exact: true });
  await findings.waitFor();
  const firstRow = page.locator("tbody tr").first();
  assert.match(await firstRow.innerText(), /Top-five score \/100: A 58.0 · B 73.0/);
  assert.ok((await firstRow.boundingBox()).height < 150, "evaluation rows stay compact");
  const toggle = findings.getByRole("button", { name: "Show details", exact: true });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.match(await findings.innerText(), /Advanced won 6 of 6 comparisons/);
  assert.doesNotMatch(await findings.innerText(), /Median latency:/);
  const compactHeight = (await findings.boundingBox()).height;
  assert.ok(compactHeight < 220, `compact findings occupy ${compactHeight}px`);
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await findings.getByRole("button", { name: "Hide details" }).getAttribute("aria-expanded"),
    "true",
  );
  const text = await findings.innerText();
  assert.match(text, /Demo findings by axis/);
  assert.match(text, /Includes generated sample grades/);
  assert.match(text, /6\/6 top-five comparisons graded/);
  assert.match(text, /Advanced won 6 of 6 comparisons/, text);
  assert.match(text, /p = 0\.031/, "the exact two-sided sign test result is shown");
  assert.match(
    text,
    /Median latency: Advanced 3\.02s; Fast 0\.66s/,
    "the quality gain is reported against its latency cost",
  );
  assert.match(text, /Insufficient evidence — tied 1–1/, text);
  assert.ok(
    text.includes("More graded queries are needed to assess a difference"),
    "an inconclusive axis asks for more evidence without promising a result",
  );

  await findings.getByRole("button", { name: "Hide details" }).click();
  assert.doesNotMatch(await findings.innerText(), /Median latency:/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await findings.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "findings fit a narrow viewport",
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // A comparison that moved two fields is counted but never attributed to either.
  rows[0].differences.push({ field: "location", a: "API default", b: "JP" });
  await page.reload();
  await findings.waitFor();
  await findings.getByRole("button", { name: "Show details" }).click();
  const confounded = await findings.innerText();
  assert.ok(confounded.includes("1 comparison changes more than one field"), confounded);
  assert.ok(
    !confounded.includes("Advanced won"),
    "dropping one comparison drops the axis below the threshold",
  );
});

await scenario(
  "a batch runs one comparison per query and stops on the first refusal",
  async (page) => {
    const sent = [];
    let refuseFrom = null;
    await page.route("**/api/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.endsWith("/search")) return route.fulfill({ json: [] });
      const body = route.request().postDataJSON();
      const query = body.requests[0].search_queries[0];
      if (refuseFrom !== null && sent.length >= refuseFrom)
        return route.fulfill({
          status: 429,
          json: { error: { code: "daily_search_limit", message: "Daily search limit reached." } },
        });
      sent.push({ query, modes: body.modes, criteria: body.criteria, key: body.idempotency_key });
      return route.fulfill({
        json: {
          id: `batch-${sent.length}`,
          query,
          criteria: body.criteria,
          created_at: "2026-09-11T20:00:00Z",
          rubric: "r",
          blind: false,
          revealed_at: null,
          feedback_history: [],
          runs: body.requests.map((request, index) => ({
            id: String(index),
            mode: request.mode,
            status: "completed",
            elapsed: 1,
            error: null,
            request,
            response: { search_id: "s", session_id: null, usage: null, warnings: null },
            results: [],
          })),
        },
      });
    });
    await page.goto(base);
    await page.getByLabel("Evaluation criteria").fill("Documents the subject.");
    await page.getByRole("button", { name: "Compare multiple queries", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();

    // The cost is stated before anything is spent, and the count follows the query list.
    await dialog.getByLabel("Queries, one per line").fill("alpha query\n\nbeta query\ngamma query");
    await dialog.getByText("3 queries · 6 Search API calls", { exact: false }).waitFor();
    assert.equal(sent.length, 0, "opening the dialog spends nothing");

    await dialog.getByRole("button", { name: "Run 6 searches", exact: true }).click();
    await dialog.getByText("3 of 3 evaluations saved", { exact: false }).waitFor();
    assert.deepEqual(
      sent.map((call) => call.query),
      ["alpha query", "beta query", "gamma query"],
      "one comparison per non-empty line, in order, blank lines dropped",
    );
    assert.equal(new Set(sent.map((call) => call.key)).size, 3, "each comparison gets its own key");
    assert.ok(
      sent.every((call) => call.criteria === "Documents the subject."),
      "the shared criteria travel with every query",
    );

    // A refusal stops the batch where it is; nothing retries and saved work is kept.
    sent.length = 0;
    refuseFrom = 2;
    await dialog.getByRole("button", { name: "Run 6 searches", exact: true }).click();
    await dialog.getByText("The batch stopped", { exact: false }).waitFor();
    assert.equal(sent.length, 2, "the third query is never attempted after the refusal");
    assert.equal(
      await dialog.getByText("2 of 3 evaluations saved", { exact: false }).isVisible(),
      true,
      "comparisons already saved are reported, not discarded",
    );

    // An invalid batch is refused before it costs anything.
    sent.length = 0;
    refuseFrom = null;
    await dialog.getByLabel("Queries, one per line").fill("x".repeat(201));
    await dialog.getByText("Keep every query within 200 characters", { exact: false }).waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: /^Run \d+ searches$/ }).isDisabled(),
      true,
      "an over-long query blocks the run before it costs anything",
    );
    assert.equal(sent.length, 0);
  },
);

await scenario("the footer sits flush and centred on both workspace pages", async (page) => {
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: paged }));
  for (const path of ["/runs", "/"]) {
    await page.goto(base + path);
    await page
      .locator(path === "/" ? ".workspace-grid" : "tbody tr")
      .first()
      .waitFor();
    const footer = await page.evaluate(() => {
      const element = document.querySelector("footer"),
        rect = element.getBoundingClientRect();
      return {
        height: rect.height,
        bottom: innerHeight - rect.bottom,
        centres: [...element.children].map((child) => {
          const box = child.getBoundingClientRect();
          return Math.abs((box.top + box.bottom) / 2 - (rect.top + rect.bottom) / 2);
        }),
      };
    });
    assert.equal(footer.height, 60, path);
    assert.equal(footer.bottom, 0, `${path} footer reaches the bottom`);
    assert.ok(
      footer.centres.every((offset) => offset < 1),
      `${path} footer contents are centred`,
    );
  }
});

// ----------------------------------------------------------------- the toolbar

const twoEvaluations = [
  {
    id: "one",
    query: "Pending query",
    criteria: "",
    created_at: "2026-09-11T12:00:00Z",
    modes: "fast",
    review_status: "Not started",
    reviewed: 0,
    total: 5,
  },
  {
    id: "two",
    query: "Finished query",
    criteria: "",
    created_at: "2026-09-11T11:00:00Z",
    modes: "advanced",
    review_status: "Complete",
    reviewed: 5,
    total: 5,
  },
];

await scenario("the evaluation toolbar aligns its controls and filters by status", async (page) => {
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: twoEvaluations }));
  await page.goto(`${base}/runs`);
  await page.getByRole("link", { name: "Pending query", exact: true }).waitFor();

  const bar = page.getByRole("group", { name: "Evaluation controls" });
  const boxes = await Promise.all(
    [
      bar.getByRole("textbox"),
      bar.getByRole("combobox", { name: "Filter by status" }),
      bar.getByRole("combobox", { name: "Filter by mode" }),
      bar.getByRole("combobox", { name: "Sort evaluations" }),
      bar.getByRole("link", { name: "New comparison" }),
    ].map((locator) => locator.boundingBox()),
  );
  assert.ok(
    boxes.every((box) => box && box.y === boxes[0].y && box.height === 36),
    JSON.stringify(boxes),
  );

  await page.getByRole("combobox", { name: "Filter by status" }).click();
  const heights = await page
    .locator('[data-slot="select-content"][data-open]')
    .getByRole("option")
    .evaluateAll((items) => items.map((item) => item.clientHeight));
  assert.ok(
    heights.every((height) => height === heights[0]),
    `status options stay on one line: ${heights}`,
  );
  await option(page, "Complete · 1").click();
  assert.equal(await page.getByRole("link", { name: "Pending query", exact: true }).count(), 0);
});

await scenario("the toolbar collapses into a filter sheet on a narrow viewport", async (page) => {
  await page.route("**/api/evaluations", (route) => route.fulfill({ json: twoEvaluations }));
  await page.goto(`${base}/runs`);
  await page.getByRole("link", { name: "Pending query", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });

  const bar = page.getByRole("group", { name: "Evaluation controls" });
  assert.equal(await bar.getByRole("combobox").count(), 0, "the inline filters are hidden");
  await page.getByRole("button", { name: /Filters/ }).click();
  await page.getByRole("combobox", { name: "Filter by status" }).click();
  await option(page, "All · 2").click();
  await page.keyboard.press("Escape");

  await page.getByRole("textbox", { name: "Search evaluations" }).fill("Pending");
  assert.ok(await page.getByRole("link", { name: "Pending query", exact: true }).isVisible());
  assert.equal(await page.getByRole("link", { name: "Finished query", exact: true }).count(), 0);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "nothing overflows the narrow viewport",
  );
});

await scenario("select menus keep a compact, evenly spaced shape", async (page) => {
  await page.goto(`${base}/`);
  for (const name of ["Demo queries", "Configuration A"]) {
    await page.getByRole("combobox", { name, exact: true }).click();
    const menu = page.locator("[data-slot=select-content][data-open]");
    await menu.waitFor();
    assert.equal(await menu.evaluate((element) => getComputedStyle(element).textWrap), "pretty");
    const width = await menu.evaluate((element) => element.clientWidth);
    assert.ok(width >= 240 && width <= 320, `${name}: compact standard menu, got ${width}`);
    if (name === "Configuration A") {
      assert.deepEqual(
        await menu.getByRole("option").allTextContents(),
        ["Turbo", "Fast", "Basic", "Advanced"],
      );
    }
    const rows = await page
      .locator('[data-slot="select-content"][data-open]')
      .getByRole("option")
      .evaluateAll((items) => items.map((item) => item.clientHeight));
    assert.ok(
      rows.every((height) => height === 36),
      `${name}: consistent menu rows ${rows}`,
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  }
});

// ----------------------------------------------------------- panes and scrolling

await scenario(
  "the shared search pane matches the results toolbar at every width",
  async (page) => {
    const response = await page.request.get(`${base}/api/evaluations`);
    const saved = (await response.json()).find((run) => run.total > 0 && !run.blind);
    assert.ok(saved, "a saved evaluation is required");
    await page.goto(`${base}/?id=${encodeURIComponent(saved.id)}`);
    await page.locator(".results-toolbar").waitFor();
    for (const width of [1440, 1000, 900, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(
        () => {
          const left = document
            .querySelector(".search-sidebar > div:first-child")
            .getBoundingClientRect();
          const right = document.querySelector(".results-toolbar").getBoundingClientRect();
          return (
            Math.abs(left.height - right.height) < 1 && Math.abs(left.bottom - right.bottom) < 1
          );
        },
        undefined,
        { timeout: 10000 },
      );
    }
  },
);

await scenario("a scrollbar appears while scrolling and fades when idle", async (page) => {
  await page.goto(`${base}/`);
  await page.getByLabel("Query", { exact: true }).waitFor();
  await page.evaluate(() => {
    const pane = document.createElement("div");
    pane.id = "scroll-test";
    pane.style.cssText = "overflow:auto;height:50px;width:100px";
    pane.innerHTML = '<div style="height:500px">Scroll fixture</div>';
    document.body.append(pane);
  });
  const pane = page.locator("#scroll-test");
  const idle = await pane.evaluate((element) => getComputedStyle(element).scrollbarColor);
  assert.equal(idle, "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)");
  await pane.evaluate((element) => {
    element.scrollTop = 100;
  });
  await page.waitForFunction(() =>
    document.querySelector("#scroll-test").hasAttribute("data-scrolling"),
  );
  assert.notEqual(await pane.evaluate((element) => getComputedStyle(element).scrollbarColor), idle);
  await page.waitForFunction(
    () => !document.querySelector("#scroll-test").hasAttribute("data-scrolling"),
  );
  assert.equal(await pane.evaluate((element) => getComputedStyle(element).scrollbarColor), idle);
  assert.equal(
    await pane.evaluate((element) => element.scrollTop),
    100,
    "fading never moves the content",
  );
});

// ------------------------------------------- the evaluations table in detail

const historyRow = (id, review_status, reviewed, total, blind = false) => ({
  id,
  query: `Query ${id}`,
  criteria: `Criteria ${id}`,
  created_at: "2026-09-11T20:00:00Z",
  review_status,
  reviewed,
  total,
  blind,
  reviewers: [{ actor: "reviewer@example.com", count: reviewed }],
  modes: blind ? "A,B" : "advanced,fast",
  configurations: [
    {
      label: "A",
      mode: blind ? null : "advanced",
      status: review_status === "Search failed" ? "failed" : "completed",
      mean_relevance: reviewed ? 2.5 : null,
      graded: reviewed,
      total,
      settings: blind ? null : "All sources · Up to 10 results",
    },
  ],
});

await scenario(
  "the history table sorts, filters and offers the next review action",
  async (page, { errors }) => {
    await page.route("**/api/evaluations", (route) =>
      route.fulfill({
        json: [
          historyRow("new", "Not started", 0, 10),
          historyRow("partial", "In progress", 2, 10, true),
          historyRow("done", "Complete", 10, 10),
          historyRow("failed", "Search failed", 0, 0),
        ],
      }),
    );
    await page.goto(`${base}/runs`);
    await page.getByText("Query new", { exact: true }).waitFor();
    assert.equal(await page.locator("tbody tr").count(), 4);
    assert.ok(
      (await page.locator("tbody tr").first().innerText()).includes("Query partial"),
      "review priority leads with the partly graded evaluation",
    );

    const fresh = page.locator("tbody tr").filter({ hasText: "Query new" });
    assert.equal(await fresh.getByText("Criteria new", { exact: true }).isVisible(), false);
    const details = fresh.locator("summary");
    await details.focus();
    await page.keyboard.press("Enter");
    assert.ok(await fresh.getByText("Criteria new", { exact: true }).isVisible());
    assert.match(await fresh.locator("details").innerText(), /All sources · Up to 10 results/);
    assert.ok(await fresh.getByRole("list", { name: "Reviewers", exact: true }).isVisible());
    await details.click();
    assert.equal(await fresh.getByText("Criteria new", { exact: true }).isVisible(), false);

    await page.getByRole("combobox", { name: "Sort evaluations", exact: true }).click();
    await option(page, "Newest first").click();
    assert.ok((await page.locator("tbody tr").first().innerText()).includes("Query new"));
    await page.getByRole("combobox", { name: "Sort evaluations", exact: true }).click();
    await option(page, "Review priority").click();
    assert.ok(await page.getByRole("link", { name: "Start review", exact: true }).isVisible());
    assert.ok(await page.getByRole("link", { name: "Resume review", exact: true }).isVisible());

    const blind = page.locator("tbody tr").filter({ hasText: "Query partial" });
    assert.ok(
      await blind.getByText("Hidden", { exact: true }).isVisible(),
      "a blind evaluation hides its modes",
    );
    assert.ok(
      await blind.getByText("2/10 reviewed", { exact: true }).isVisible(),
      "a partially graded configuration reports its review progress",
    );

    assert.match(await blind.innerText(), /Review incomplete · 2\/10 reviewed/);
    assert.doesNotMatch(await blind.innerText(), /Top-five score/);
    await blind.locator("summary").click();
    assert.match(await blind.locator("details").innerText(), /Mean 2.50\/3/);
    await blind.locator("summary").click();

    for (const [name, rows] of [
      ["Needs review · 2", 2],
      ["Needs attention · 1", 1],
    ]) {
      await page.getByRole("combobox", { name: "Filter by status", exact: true }).click();
      await option(page, name).click();
      assert.equal(await page.locator("tbody tr").count(), rows, name);
    }
    assert.ok(await page.getByRole("link", { name: "Inspect results", exact: true }).isVisible());

    await page.getByRole("combobox", { name: "Filter by status", exact: true }).click();
    await option(page, "All · 4").click();
    await page
      .getByRole("textbox", { name: "Search evaluations", exact: true })
      .fill("Criteria done");
    assert.equal(
      await page.locator("tbody tr").count(),
      1,
      "the search covers the criteria, not only the query",
    );
    assert.ok(await page.getByRole("link", { name: "View evaluation", exact: true }).isVisible());
    assert.deepEqual(errors, []);
  },
);

await scenario("the history table separates shared settings from per-side ones", async (page) => {
  const summary = load("lib/evaluations.ts").evaluationSummary;
  const evaluation = {
    id: "settings",
    query: "Freshness comparison",
    criteria: "Relevant documentation",
    created_at: "2026-09-11T20:00:00Z",
    runs: [{}, { fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true } }].map(
      (advanced) => ({
        mode: "fast",
        status: "completed",
        request: {
          session_id: "saved-session",
          advanced_settings: { max_results: 10, ...advanced },
        },
        results: [{ judgment: null }],
      }),
    ),
  };
  await page.route("**/api/evaluations", (route) =>
    route.fulfill({
      json: [{ ...evaluation, ...summary(evaluation), modes: "fast,fast" }],
    }),
  );
  await page.goto(`${base}/runs`);
  await page.getByText("Freshness comparison", { exact: true }).waitFor();

  const settings = page.locator("tbody details");
  await settings.locator("summary").click();
  const text = await settings.innerText();
  assert.equal(await settings.getByText(/Shared: All sources/).count(), 1);
  assert.ok(text.includes("API session: saved-session"));
  assert.ok(text.includes("Cache age (s): API default"), "the side that set nothing says so");
  assert.ok(text.includes("Cache age (s): 600"));
  assert.equal(await settings.locator("input,button").count(), 0, "settings remain read-only");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

// ===================================================== the review loop end to end

await scenario("the review loop works end to end in a browser", async (page, { errors }) => {
  // The real API still answers reads, and still refuses writes that skip the browser bridge.
  const live = await page.request.get(`${base}/api/evaluations`);
  assert.equal(live.status(), 200, "Existing saved data is reachable through Next.js");
  assert.ok(Array.isArray(await live.json()));
  const blocked = await page.request.post(`${base}/api/feedback`, {
    data: {},
    headers: { Origin: "https://example.com" },
  });
  assert.equal(blocked.status(), 403, "Foreign origins cannot write");
  const invalid = await page.request.post(`${base}/api/feedback`, {
    data: {},
    headers: { Origin: base, "X-Requested-With": "SearchEvaluations" },
  });
  assert.equal(
    invalid.status(),
    400,
    "The backend validates feedback behind the authenticated bridge",
  );

  const result = (id, rank) => ({
    id,
    rank,
    url: `https://example.com/${rank}`,
    title: `Search documentation ${rank}`,
    excerpts: ["Official documentation for search and result evaluation. ".repeat(8)],
    publish_date: null,
    judgment: null,
    relevance: null,
    issues: [],
    rubric_version: "relevance-v1",
    notes: "",
    version: 0,
    updated_at: null,
    actor: undefined,
  });
  const session = {
    id: "fixture",
    query: "Enterprise search documentation",
    criteria: "Official documentation",
    created_at: "2026-09-11T20:00:00Z",
    rubric: "r",
    blind: false,
    revealed_at: null,
    feedback_history: [],
    runs: ["fast", "advanced"].map((mode, index) => ({
      id: mode,
      mode,
      status: "completed",
      elapsed: 0.4 + index,
      error: null,
      request: { search_queries: ["Enterprise search documentation"], mode },
      response: { search_id: mode, session_id: null, usage: null, warnings: null },
      results: Array.from({ length: 5 }, (_, rank) => result(index * 10 + rank, rank + 1)),
    })),
  };
  const every = () => session.runs.flatMap((run) => run.results);

  let searches = 0;
  await page.route("**/api/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data;
    if (path.endsWith("/sessions")) {
      data = searches
        ? [
            {
              ...session,
              modes: "fast,advanced",
              total: every().length,
              reviewed: every().filter((r) => r.relevance !== null).length,
            },
          ]
        : [];
    } else if (path.endsWith("/search")) {
      const body = route.request().postDataJSON();
      assert.deepEqual(body.modes, ["advanced", "fast"], "both configurations are submitted");
      searches++;
      data = session;
    } else if (path.endsWith("/feedback")) {
      const body = route.request().postDataJSON();
      const target = every().find((r) => r.id === body.result_id);
      assert.equal(body.version, target.version, "the client sends the version it last saw");
      assert.equal(typeof body.evaluation_id, "string", "the evaluation is addressed directly");
      Object.assign(target, {
        relevance: body.relevance,
        issues: body.issues ?? [],
        notes: body.notes ?? target.notes,
        version: target.version + 1,
        updated_at: new Date().toISOString(),
        actor: "reviewer@parallel.ai",
      });
      data = target;
    } else if (path.endsWith("/activity")) data = [];
    else data = session;
    await route.fulfill({ json: data });
  });

  await page.goto(base);
  await page.getByLabel("Query", { exact: true }).fill(session.query);
  await page.getByLabel("Evaluation criteria").fill(session.criteria);
  await page.getByRole("button", { name: "Run comparison", exact: true }).click();

  // Rate the first result on the 0–3 relevance rubric.
  const first = page.getByRole("article").first();
  await first.getByRole("button", { name: "3 · Fully relevant", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('article button[aria-pressed="true"]')
      ?.getAttribute("aria-label")
      ?.includes("Fully relevant"),
  );
  assert.equal(
    await first
      .getByRole("button", { name: "3 · Fully relevant", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );

  // Next ungraded skips the result just graded and reaches the following one.
  await page.getByRole("button", { name: "Next ungraded", exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Result 2: Search documentation 2",
    "focus lands on the next result still waiting for a grade",
  );
  // The same jump on the keyboard, and it wraps rather than dead-ending.
  await page.keyboard.press("n");
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Result 3: Search documentation 3",
  );

  // A keyboard grade reaches the same save path.
  const second = page.getByRole("article").nth(1);
  await second.click();
  await second.press("1");
  await page.waitForFunction(
    () => document.querySelectorAll('article button[aria-pressed="true"]').length >= 2,
  );

  await first.getByText("Add notes", { exact: true }).click();
  await first.getByRole("textbox").fill("Official source; meets the criteria.");
  await first.getByRole("button", { name: "Save note" }).click();
  await page.waitForFunction(
    () => document.querySelector("article [role=status]")?.textContent === "Saved",
  );

  assert.match(await page.getByText(/\d+\/\d+ reviewed/).innerText(), /2\/10 reviewed/);

  // The saved grade and note survive reopening the stored evaluation by id.
  await page.goto(`${base}/?id=${session.id}`);
  await page.getByRole("article").first().waitFor();
  const reloaded = page.getByRole("article").first();
  assert.equal(
    await reloaded
      .getByRole("button", { name: "3 · Fully relevant", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await reloaded.getByText("Notes", { exact: true }).click();
  assert.equal(
    await reloaded.getByRole("textbox").inputValue(),
    "Official source; meets the criteria.",
  );

  // Clearing a rating returns the result to unrated.
  await reloaded.getByRole("button", { name: "Clear rating" }).click();
  await page.waitForFunction(() => document.querySelector("article")?.dataset.grade === "unrated");

  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true,
    "Desktop shell fits the viewport",
  );
  await page.locator(".results-scroll").evaluate((element) => {
    element.scrollTop = 200;
  });
  assert.ok(
    (await page.locator(".results-scroll").evaluate((element) => element.scrollTop)) > 0,
    "Results remain scrollable",
  );
  // Scrollbars stay thin; the thumb only takes colour while the element is scrolling.
  assert.equal(
    await page
      .locator(".results-scroll")
      .evaluate((element) => getComputedStyle(element).scrollbarWidth),
    "thin",
  );
  await page.locator(".results-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "Mobile has no horizontal overflow",
  );

  assert.deepEqual(errors, [], "No browser exceptions");
});

// ================================ grading, the agreement panel and the activity log

// --------------------------------------------------------------- grading a result

const gradedResult = (id) => ({
  id,
  rank: 1,
  title: "Example",
  url: "https://example.com",
  excerpts: ["Evidence excerpt"],
  publish_date: null,
  relevance: null,
  issues: [],
  rubric_version: "relevance-v1",
  notes: "",
  version: 0,
  updated_at: null,
});

await scenario(
  "a grade saves, survives a reload, reports failure and clears",
  async (page) => {
    const evaluation = {
      id: "graded-test",
      query: "Search quality",
      criteria: "Relevant evidence",
      created_at: new Date().toISOString(),
      feedback_history: [],
      runs: ["advanced", "fast"].map((mode, index) => ({
        id: mode,
        mode,
        status: "completed",
        elapsed: 1,
        error: null,
        request: { search_queries: ["Search quality"], mode },
        results: [gradedResult(index + 1)],
      })),
    };
    let refuse = false;
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data = evaluation;
      if (path === "/api/feedback") {
        if (refuse) {
          refuse = false;
          return route.fulfill({ status: 503, json: { error: "Save unavailable" } });
        }
        const body = route.request().postDataJSON();
        const result = evaluation.runs
          .flatMap((run) => run.results)
          .find((item) => item.id === body.result_id);
        assert.equal(body.version, result.version, "the browser sends the version it last saw");
        Object.assign(result, {
          relevance: body.relevance,
          issues: body.issues,
          notes: body.notes,
          rubric_version: "relevance-v1",
          actor: "reviewer@parallel.ai",
          version: result.version + 1,
          updated_at: new Date().toISOString(),
        });
        evaluation.feedback_history.push({
          ...result,
          result_id: result.id,
          created_at: result.updated_at,
        });
        data = result;
      } else if (path === "/api/activity") data = [];
      else if (path === "/api/credits") data = { available: false };
      else if (path.startsWith("/api/auth/")) data = null;
      await route.fulfill({ json: data });
    });

    await page.goto(`${base}/?id=graded-test`);
    const card = page.getByRole("article").first();
    await card.getByText("Unrated", { exact: true }).waitFor();

    await card.getByRole("button", { name: "3 · Fully relevant", exact: true }).click();
    await card.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(evaluation.runs[0].results[0].relevance, 3);
    // The brief asks whether each result was correct; the card answers it from the grade.
    await card.getByText("Meets the need", { exact: false }).waitFor();

    await card.getByText("Issues (0)", { exact: true }).click();
    await card.getByRole("button", { name: "Outdated", exact: true }).click();
    await card.getByText("Issues (1)", { exact: true }).waitFor();
    await card.getByText("Add notes", { exact: true }).click();
    await card.getByRole("textbox").fill("Needs newer evidence");
    await card.getByRole("button", { name: "Save note", exact: true }).click();
    await card.getByRole("status").filter({ hasText: "Saved" }).waitFor();

    await page.reload();
    await card.getByRole("button", { name: "3 · Fully relevant", exact: true }).waitFor();
    assert.equal(
      await card
        .getByRole("button", { name: "3 · Fully relevant", exact: true })
        .getAttribute("aria-pressed"),
      "true",
      "the saved grade comes back pressed",
    );
    await card.getByText("Notes", { exact: true }).click();
    assert.equal(await card.getByRole("textbox").inputValue(), "Needs newer evidence");

    refuse = true;
    await card.getByRole("button", { name: "0 · Irrelevant", exact: true }).click();
    await card.getByText("Save unavailable", { exact: true }).waitFor();
    assert.equal(evaluation.runs[0].results[0].relevance, 3, "a refused save changes nothing");

    await card.getByRole("button", { name: "0 · Irrelevant", exact: true }).click();
    await card.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(evaluation.runs[0].results[0].relevance, 0, "a retry succeeds");
    await card.getByText("Does not meet the need", { exact: false }).waitFor();

    await card.getByRole("button", { name: "Clear rating", exact: true }).click();
    await card.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(evaluation.runs[0].results[0].relevance, null);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "the graded card fits a narrow viewport",
    );
  },
  { viewport: { width: 1440, height: 1000 } },
);

// ------------------------------------------------------------ reviewer agreement

const agreementResult = (id, rank) => ({
  id,
  rank,
  url: `https://example.com/${rank}`,
  title: `Result ${rank}`,
  excerpts: ["excerpt"],
  publish_date: null,
  relevance: 3,
  issues: [],
  rubric_version: "relevance-v1",
  notes: "",
  version: 1,
  updated_at: new Date().toISOString(),
  actor: "ann@parallel.ai",
});

await scenario(
  "the agreement panel reports both the empty and the measured state",
  async (page, { errors }) => {
    const evaluation = {
      id: "agreement-test",
      query: "Search quality",
      criteria: "Relevant evidence",
      created_at: new Date().toISOString(),
      rubric: "r",
      blind: false,
      revealed_at: null,
      feedback_history: [],
      runs: [
        {
          id: "advanced",
          mode: "advanced",
          status: "completed",
          elapsed: 1,
          error: null,
          request: { search_queries: ["Search quality"], mode: "advanced" },
          response: { search_id: "s", session_id: null, usage: null, warnings: null },
          results: [agreementResult(1, 1), agreementResult(2, 2), agreementResult(3, 3)],
        },
      ],
    };
    let agreement = {
      reviewers: [],
      double_graded: 0,
      single_graded: 3,
      exact_agreement: null,
      adjacent_agreement: null,
      kappa: null,
      pairs: [],
      disputed: [],
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/agreement")) return route.fulfill({ json: agreement });
      if (path.endsWith("/activity")) return route.fulfill({ json: [] });
      if (path.endsWith("/sessions")) return route.fulfill({ json: [] });
      if (path.endsWith("/credits")) return route.fulfill({ json: { available: false } });
      return route.fulfill({ json: evaluation });
    });

    await page.goto(`${base}/?id=${evaluation.id}`);
    await page.getByRole("article").first().waitFor();
    await page.getByText("Review details", { exact: true }).click();

    // One reviewer proves nothing about consistency, and the panel must say so.
    await page.getByText("Reviewer agreement", { exact: true }).click();
    await page.getByText(/No result has been graded by two reviewers yet/).waitFor();
    assert.match(
      await page.getByText(/No result has been graded by two reviewers yet/).innerText(),
      /3 results have one grade/,
    );

    agreement = {
      reviewers: ["ann@parallel.ai", "bob@parallel.ai"],
      double_graded: 4,
      single_graded: 1,
      exact_agreement: 0.5,
      adjacent_agreement: 0.75,
      kappa: 0.42,
      pairs: [
        {
          reviewers: ["ann@parallel.ai", "bob@parallel.ai"],
          kappa: 0.42,
          overlap: 4,
          exact: 0.5,
          adjacent: 0.75,
        },
      ],
      disputed: [
        {
          result_id: 3,
          spread: 3,
          grades: [
            ["ann@parallel.ai", 0],
            ["bob@parallel.ai", 3],
          ],
        },
      ],
    };
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await page.getByText("Grades to review (1)", { exact: true }).waitFor();

    const panel = page.locator("details", { hasText: "Reviewer agreement" }).last();
    const text = await panel.innerText();
    assert.match(text, /50%/, "exact agreement");
    assert.match(text, /75%/, "agreement within one grade");
    assert.match(text, /0\.42/, "kappa value");
    assert.match(text, /Moderate/, "kappa band");
    assert.match(
      text,
      /Result 3: .*gave 0 \(Irrelevant\).*gave 3 \(Fully relevant\)/s,
      "the disputed grades are named",
    );

    // A single pair is already summarised above; the per-pair list is for three or more.
    assert.equal(await page.getByRole("list", { name: "Reviewer pairs" }).count(), 0);
    assert.equal(await page.getByRole("list", { name: "Disputed results" }).count(), 1);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "the panel does not force horizontal overflow on mobile",
    );
    assert.deepEqual(errors, [], "no browser exceptions");
  },
  { viewport: { width: 1440, height: 1000 } },
);

// ------------------------------------------------------------------ activity log

await scenario(
  "the activity log batches, reports a refused save and retries it",
  async (page) => {
    const batches = [],
      events = [];
    // Refuse every save until the test has seen the failure surface, then let retries through.
    let refusing = true;
    const result = (rank) => ({
      id: rank,
      rank,
      url: `https://example.com/${rank}`,
      title: `Result ${rank}`,
      excerpts: ["excerpt"],
      publish_date: null,
      judgment: null,
      relevance: null,
      issues: [],
      rubric_version: "relevance-v1",
      notes: "",
      version: 0,
      updated_at: null,
    });
    const session = {
      id: "activity-test",
      query: "Test",
      criteria: "",
      created_at: new Date().toISOString(),
      rubric: "r",
      blind: false,
      revealed_at: null,
      feedback_history: [],
      runs: [
        {
          id: "fast",
          mode: "fast",
          status: "completed",
          elapsed: 1,
          error: null,
          request: { search_queries: ["Test"], mode: "fast" },
          response: { search_id: "s", session_id: null, usage: null, warnings: null },
          results: [result(1), result(2), result(3)],
        },
      ],
    };

    await page.route("**/api/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/activity")) {
        if (route.request().method() === "POST") {
          batches.push(route.request().postDataJSON().events);
          if (refusing) return route.fulfill({ status: 503, json: { error: "Test failure" } });
          for (const event of batches.at(-1))
            if (!events.some((seen) => seen.id === event.id))
              events.push({
                ...event,
                actor: "reviewer@parallel.ai",
                created_at: new Date().toISOString(),
              });
          return route.fulfill({ json: { saved: true } });
        }
        return route.fulfill({ json: events });
      }
      if (path.endsWith("/sessions")) return route.fulfill({ json: [] });
      return route.fulfill({ json: session });
    });

    await page.goto(`${base}/?id=${session.id}`);
    await page.getByRole("article").first().waitFor();

    // The log lives inside the collapsed "Review details" section.
    await page.getByText("Review details", { exact: true }).click();
    await page.getByText("Activity", { exact: true }).waitFor();

    // The component records an "opened" event on mount and flushes after a quiet period;
    // a refused save must surface to the reviewer rather than fail silently.
    await page.getByText(/Some interactions could not be saved/).waitFor({ state: "attached" });
    assert.ok(batches.length >= 1, "the queue is flushed without being asked");
    const refused = batches.at(-1);
    assert.ok(
      refused.some((event) => event.action === "opened"),
      "opening an evaluation is recorded",
    );
    assert.equal(events.length, 0, "a refused save stores nothing");

    // Opening the Activity panel retries the queue before reading it back.
    refusing = false;
    const attempts = batches.length;
    await page.getByText("Activity", { exact: true }).click();
    await page.getByText("reviewer@parallel.ai", { exact: false }).first().waitFor();
    assert.ok(batches.length > attempts, "opening the panel retries the queued events");
    assert.deepEqual(batches.at(-1), refused, "the retry reuses the same event identifiers");
    assert.equal(events.length, refused.length, "the retry does not duplicate stored events");

    // Several interactions close together travel in a single request.
    const sent = batches.length;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("article").first().getByRole("button", { name: "Show more" }).click();
    await page.getByRole("article").nth(1).getByRole("button", { name: "Show more" }).click();
    await page.waitForTimeout(1500);
    assert.equal(
      batches.length,
      sent + 1,
      `nearby clicks are batched into one request, saw ${batches.length - sent}`,
    );
    assert.ok(
      batches.at(-1).length >= 3,
      `expected at least 3 batched clicks, saw ${batches.at(-1).length}`,
    );
    assert.ok(batches.at(-1).every((event) => event.action === "clicked"));
    assert.equal(
      new Set(batches.at(-1).map((event) => event.id)).size,
      batches.at(-1).length,
      "each event has its own id",
    );
  },
  { viewport: null },
);

// ================================================================ responsive layout

await scenario(
  "the workspace fits its viewports without stray scrolling",
  async (page) => {
    // A configuration panel carries one disclosure per settings group, so a bare `summary`
    // locator matches all five. Name the group that holds the field under test.
    const settingsGroup = (side, title) =>
      page
        .getByRole("group", { name: `Configuration ${side === 0 ? "A" : "B"}`, exact: true })
        .locator("summary")
        .filter({ hasText: title });
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("http://127.0.0.1:3000/");
      await page.getByLabel("Query", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("Query", { exact: true }).inputValue(),
        "Parallel Search API modes and source filters",
      );
      assert.equal(
        await page.getByRole("button", { name: "Run comparison", exact: true }).isEnabled(),
        true,
      );
      assert.equal(await page.locator(".review-results").isVisible(), true);
      assert.equal(await page.getByLabel("Objective").isVisible(), false);
      assert.equal(
        await page.getByRole("checkbox", { name: "Blind review", exact: true }).isVisible(),
        false,
      );
      const sidebar = await page.locator(".search-sidebar").boundingBox();
      const output = await page.locator(".review-results").boundingBox();
      assert.ok(sidebar.x + sidebar.width <= output.x, "Outputs remain right of the sidebar");
      assert.ok(sidebar.width > 320, "the sidebar is slightly wider");
      assert.equal(await page.locator(".configuration-empty").count(), 1);
      assert.match(await page.locator(".configuration-empty").innerText(), /Run a comparison/);
      const action = await page.getByRole("button", { name: "Run comparison", exact: true }).boundingBox();
      const criteria = await page.getByLabel("Evaluation criteria").boundingBox();
      assert.ok(action.y > criteria.y && action.y - criteria.y - criteria.height < 110, "run action follows the inputs");
      assert.equal(await page.getByRole("group", { name: "Configuration A", exact: true }).locator("summary").count(), 0, "mode comparison shows only mode controls");
      assert.ok(
        sidebar.height < height - 180,
        "Setup does not stretch into an empty full-height sidebar",
      );
      assert.ok(
        await page.getByRole("button", { name: "Run comparison", exact: true }).isVisible(),
      );
      const sizes = await page.evaluate(() => {
        const pane = document.querySelector(".search-settings-scroll");
        return [
          document.documentElement.scrollHeight <= innerHeight,
          pane.scrollHeight <= pane.clientHeight,
        ];
      });
      assert.deepEqual(sizes, [true, true], `${width}x${height}: page and default setup fit`);
    }
    let presetSearches = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/search") presetSearches++;
    });
    const beforeExperiment = await page.getByLabel("Query", { exact: true }).inputValue();
    const beforeCriteria = await page.getByLabel("Evaluation criteria").inputValue();
    const axes = page.getByRole("combobox", { name: "Comparison axis", exact: true });
    const axisLabels = {
      mode: ["Search mode", "Search mode"],
      include_domains: ["Allowed sources", "Allowed sources"],
      exclude_domains: ["Blocked sources", "Blocked sources"],
      after_date: ["Publication date", "Published on or after"],
      location: ["Country", "Target country"],
      max_results: ["Maximum results", "Maximum results"],
      max_chars_per_result: ["Excerpt length", "Excerpt characters per result"],
      max_age_seconds: ["Cache age", "Maximum cache age (seconds)"],
    };
    const chooseAxis = async (key) => {
      await axes.click();
      const label = axisLabels[key][0];
      await page.getByRole("option", { name: label, exact: true }).click();
      assert.equal(await axes.innerText(), label);
    };
    // Every axis moves exactly one documented request field and leaves the query alone.
    for (const key of [
      "mode",
      "include_domains",
      "exclude_domains",
      "after_date",
      "location",
      "max_results",
      "max_chars_per_result",
      "max_age_seconds",
    ]) {
      await chooseAxis(key);
      const summary = await page.getByLabel("Configuration differences").innerText();
      assert.ok(summary.includes(`${axisLabels[key][1]} — A:`), `${key}: ${summary}`);
      assert.equal(summary.split(" → ").length, 2, `${key} changes exactly one field`);
      assert.equal(await page.getByLabel("Query", { exact: true }).inputValue(), beforeExperiment);
      assert.equal(await page.getByLabel("Evaluation criteria").inputValue(), beforeCriteria);
    }
    // The selected axis stays selected; shared settings appear once and update both requests.
    await chooseAxis("max_age_seconds");
    await chooseAxis("mode");
    assert.equal(await page.getByLabel("Allowed sources", { exact: true }).count(), 1);
    await page
      .locator(".search-sidebar summary")
      .filter({ hasText: "Shared settings and options" })
      .click();
    const shared = page.getByRole("group", { name: "Shared settings", exact: true });
    await shared.locator("summary").filter({ hasText: "Results and excerpts" }).click();
    await shared.getByLabel("Maximum results", { exact: true }).fill("12");
    assert.equal(
      (await page.getByLabel("Configuration differences").innerText()).split(" → ").length,
      2,
    );
    await page.getByRole("button", { name: "View API code", exact: true }).click();
    const requests = JSON.parse(
      await page.getByRole("region", { name: "Search request JSON" }).innerText(),
    );
    assert.deepEqual(
      requests.map((request) => request.advanced_settings.max_results),
      [12, 12],
    );
    assert.deepEqual(
      requests.map((request) => request.mode),
      ["advanced", "fast"],
    );
    await page.getByRole("button", { name: "Close API code" }).click();
    await chooseAxis("include_domains");
    await settingsGroup(1, "Sources").click();
    await page.locator("#B-include-domains").fill("custom.example");
    assert.ok(
      (await page.getByLabel("Configuration differences").innerText()).includes("custom.example"),
    );
    assert.equal(presetSearches, 0, "Editing configurations never runs a search");
    let demoSearches = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/search") demoSearches++;
    });
    await page.getByRole("combobox", { name: "Demo queries", exact: true }).click();
    await option(page, "Vendor pricing").click();
    assert.equal(
      await page.getByLabel("Query", { exact: true }).inputValue(),
      "Intercom customer support pricing plans",
    );
    assert.ok((await page.getByLabel("Evaluation criteria").inputValue()).includes("Intercom"));
    assert.equal(
      await page.getByRole("combobox", { name: "Shared settings", exact: true }).innerText(),
      "Advanced",
    );
    assert.equal(demoSearches, 0, "Demo selection does not spend search credits");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page.goto("http://127.0.0.1:3000/");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    let saved, releaseSave;
    await page.route("**/api/search", async (route) => {
      const input = route.request().postDataJSON();
      saved = {
        id: "layout-test",
        query: "Search documentation",
        criteria: "Relevant documentation",
        search_request: input.search_request,
        created_at: new Date().toISOString(),
        runs: input.modes.map((mode, side) => ({
          id: `run-${side}`,
          mode,
          status: "completed",
          elapsed: 0.7,
          request: input.requests[side],
          results: Array.from({ length: 10 }, (_, rank) => ({
            id: side * 10 + rank + 1,
            rank: rank + 1,
            title: `${mode} documentation result ${rank + 1}`,
            url: `https://example.com/${mode}/${rank}`,
            excerpts: [
              "# Documentation\nDocumentation with source examples and practical usage instructions. ".repeat(
                12,
              ),
            ],
            relevance: null,
            issues: [],
            rubric_version: "relevance-v1",
            notes: "",
            version: 0,
            updated_at: null,
            publish_date: null,
          })),
        })),
      };
      await route.fulfill({ json: saved });
    });
    await page.route("**/api/evaluation?*", (route) => route.fulfill({ json: saved }));
    await page.route("**/api/feedback", async (route) => {
      const input = route.request().postDataJSON();
      await new Promise((resolve) => {
        releaseSave = resolve;
      });
      const result = saved.runs
        .flatMap((run) => run.results)
        .find((result) => result.id === input.result_id);
      Object.assign(result, {
        relevance: input.relevance,
        issues: input.issues,
        notes: input.notes,
        rubric_version: "relevance-v1",
        version: result.version + 1,
        updated_at: new Date().toISOString(),
      });
      await route.fulfill({ json: result });
    });
    await page.getByLabel("Query", { exact: true }).fill("Search documentation");
    await page
      .locator(".search-sidebar summary")
      .filter({ hasText: "Shared settings and options" })
      .click();
    await page.getByRole("button", { name: "Copy A to B", exact: true }).click();
    assert.equal(
      await page.getByRole("combobox", { name: "Configuration B", exact: true }).innerText(),
      "Advanced",
    );
    await chooseAxis("max_results");
    await settingsGroup(1, "Results and excerpts").click();
    await page
      .getByRole("group", { name: "Configuration B", exact: true })
      .getByLabel("Maximum results", { exact: true })
      .fill("7");
    await settingsGroup(0, "Results and excerpts").click();
    assert.equal(
      await page
        .getByRole("group", { name: "Configuration A", exact: true })
        .getByLabel("Maximum results", { exact: true })
        .inputValue(),
      "5",
    );
    await page.getByRole("button", { name: "Run comparison", exact: true }).click();
    await page.getByText("Search saved. Review the results below.").waitFor();
    assert.equal(
      await page.getByRole("combobox", { name: "Configuration A", exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await page.getByRole("combobox", { name: "Configuration B", exact: true }).isVisible(),
      false,
    );
    assert.equal(saved.runs[0].request.advanced_settings?.max_results, 5);
    assert.equal(saved.runs[1].request.advanced_settings.max_results, 7);
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ]) {
      await page.setViewportSize({ width, height });
      const left = await page
        .getByRole("region", { name: "A · Advanced results", exact: true })
        .boundingBox();
      const right = await page
        .getByRole("region", { name: "B · Advanced results", exact: true })
        .boundingBox();
      assert.ok(
        left.x + left.width <= right.x && Math.abs(left.y - right.y) < 2,
        "Result columns are side by side",
      );
      assert.ok(left.width >= 300 && right.width >= 300, "Columns remain readable");
      assert.deepEqual(
        await page.evaluate(() => {
          const results = document.querySelector(".results-scroll");
          results.scrollTop = 200;
          return [
            document.documentElement.scrollHeight <= innerHeight,
            results.scrollTop > 0,
            window.scrollY === 0,
          ];
        }),
        [true, true, true],
        "Scrolling stays in results",
      );
    }
    assert.equal((await page.locator(".mode-summary").first().innerText()).includes("%"), false);
    await page.getByLabel("Evaluation criteria").fill("Draft criteria for next comparison");
    assert.ok(
      (await page.getByRole("region", { name: "Review context" }).innerText()).includes(
        "Relevant documentation",
      ),
      "Saved criteria remain unchanged",
    );
    const first = page.getByRole("article").first();
    assert.equal(
      (await first.getByLabel("Excerpt for result 1").innerText()).startsWith("#"),
      false,
      "Markdown heading marker is not displayed",
    );
    const feedbackBox = await first.getByRole("group", { name: "Result feedback" }).boundingBox();
    const excerptBox = await first.getByLabel("Excerpt for result 1").boundingBox();
    assert.ok(excerptBox.y < feedbackBox.y, "Excerpts precede the rating controls");
    await first.getByRole("button", { name: "Show more", exact: true }).click();
    assert.equal(
      await first
        .getByRole("button", { name: "Show less", exact: true })
        .getAttribute("aria-expanded"),
      "true",
    );
    const fullyRelevant = () =>
      first.getByRole("button", { name: "3 · Fully relevant", exact: true });
    await fullyRelevant().click();
    await first.getByRole("status").filter({ hasText: "Saving…" }).waitFor();
    assert.equal(await fullyRelevant().isDisabled(), true);
    assert.equal(
      await first.getByText("Saved", { exact: true }).count(),
      0,
      "Saved waits for the response",
    );
    releaseSave();
    await first.getByText("Saved", { exact: true }).waitFor();
    assert.equal(await fullyRelevant().getAttribute("aria-pressed"), "true");
    await page.reload();
    await first.getByText("Saved", { exact: true }).waitFor();
    assert.equal(await first.getAttribute("data-grade"), "3", "Grade survives reopening");
    await first.getByRole("button", { name: "Clear rating", exact: true }).click();
    await first.getByRole("status").filter({ hasText: "Saving…" }).waitFor();
    releaseSave();
    await first.getByText("Saved", { exact: true }).waitFor();
    assert.equal(await first.getAttribute("data-grade"), "unrated");
  },
  { viewport: null },
);

await finish();
