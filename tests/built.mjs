// Every browser check that needs `npm run build`: the copy and export menus, the search
// sidebar, and sign-in.
//
// The first two serve the bundle straight from `.next` through Playwright's router, so no
// server has to be running and no API call leaves the browser. Sign-in needs a real server
// because a development server grants local access without a session; with
// no AUTH_TEST_URL set it starts its own on port 3011 and stops it afterwards.
//
// Google sign-in is only ever initiated, never completed, every email code is answered from
// a fixture, and no search is issued, so nothing is sent and no credits are spent.
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { load } from "./load.mjs";
import { scenario, serveBuild, finish, option } from "./browser.mjs";

// ============================================== the copy and export menus

const origin = "http://127.0.0.1:3002";
const copy = load("lib/share-evaluations.ts");

const result = {
  id: 1,
  rank: 1,
  title: "A [source]",
  url: "https://example.com/a",
  publish_date: null,
  excerpts: ["Full excerpt", "Second paragraph"],
  judgment: null,
  notes: "Saved note",
  version: 0,
  updated_at: null,
};
const evaluation = {
  id: "copy-test",
  query: "Example query",
  criteria: "Official sources",
  created_at: "2026-09-11T12:00:00Z",
  runs: [
    {
      id: "a",
      mode: "advanced",
      status: "completed",
      elapsed: 1,
      error: null,
      results: [result],
      request: { search_queries: ["Example query"], mode: "advanced" },
    },
  ],
};

const serve = (page) =>
  serveBuild(page, origin, (_route, path) => (path.includes("/auth/") ? null : evaluation));

await scenario(
  "every copy menu puts exactly the serialized text on the clipboard",
  async (page) => {
    await serve(page);
    await page.goto(`${origin}/?id=copy-test`);
    await page.getByRole("article").waitFor();

    const expected = {
      "Copy result": (format) => copy.copyResult(result, format, evaluation, evaluation.runs[0]),
      "Copy configuration": (format) =>
        copy.copyConfiguration(evaluation, evaluation.runs[0], format),
      "Copy evaluation": (format) => copy.copyEvaluation(evaluation, format),
    };
    for (const [label, serialize] of Object.entries(expected)) {
      for (const [format, item] of [
        ["text", "Plain text"],
        ["markdown", "Markdown"],
        ["json", "JSON"],
      ]) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await page
          .locator('[data-slot="dropdown-menu-content"][data-open]')
          .getByRole("menuitem", { name: item, exact: true })
          .click();
        await page.waitForFunction(
          (text) => navigator.clipboard.readText().then((actual) => actual === text),
          serialize(format),
        );
      }
    }

    await page.getByRole("button", { name: "Copy result", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), result.url);
  },
  { permissions: ["clipboard-read", "clipboard-write"] },
);

await scenario(
  "copying an evaluation honours the visible rating filter",
  async (page) => {
    await serve(page);
    await page.goto(`${origin}/?id=copy-test`);
    await page.getByRole("article").waitFor();

    await page.getByRole("combobox", { name: "Show", exact: true }).click();
    await option(page, "3").click();
    await page.getByRole("button", { name: "Copy evaluation", exact: true }).click();
    await page
      .locator('[data-slot="dropdown-menu-content"][data-open]')
      .getByRole("menuitem", { name: "JSON · Filtered results", exact: true })
      .click();
    await page.waitForFunction(() =>
      navigator.clipboard.readText().then((text) => JSON.parse(text).result_filter === "3"),
    );
    assert.equal(
      JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).runs[0].results.length,
      0,
      "no result carries a grade of 3, so the filtered copy is empty",
    );

    await page.getByRole("button", { name: "Copy evaluation", exact: true }).click();
    await page
      .locator('[data-slot="dropdown-menu-content"][data-open]')
      .getByRole("menuitem", { name: "JSON", exact: true })
      .click();
    await page.waitForFunction(() =>
      navigator.clipboard.readText().then((text) => JSON.parse(text).result_filter === "all"),
    );
    assert.equal(
      JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).runs[0].results.length,
      1,
    );
  },
  { permissions: ["clipboard-read", "clipboard-write"] },
);

await scenario(
  "copying is refused with an unsaved note and reports a denied clipboard",
  async (page) => {
    await serve(page);
    await page.goto(`${origin}/?id=copy-test`);
    await page.getByRole("article").waitFor();

    await page.getByRole("article").getByText("Notes", { exact: true }).click();
    await page.getByLabel("Notes for result 1", { exact: true }).fill("Unsaved");
    assert.ok(
      await page.getByRole("button", { name: "Copy result", exact: true }).isDisabled(),
      "a single result cannot be copied mid-edit",
    );
    await page.getByRole("button", { name: "Copy evaluation", exact: true }).click();
    await page
      .locator('[data-slot="dropdown-menu-content"][data-open]')
      .getByRole("menuitem", { name: "Plain text", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "Save notes" }).waitFor();

    await page.getByLabel("Notes for result 1", { exact: true }).fill("Saved note");
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("Denied");
      };
    });
    await page.getByRole("button", { name: "Copy result", exact: true }).click();
    await page
      .locator('[data-slot="dropdown-menu-content"][data-open]')
      .getByRole("menuitem", { name: "Plain text", exact: true })
      .click();
    await page.getByRole("alert").filter({ hasText: "Copy failed" }).waitFor();
  },
  { permissions: ["clipboard-read", "clipboard-write"] },
);

await scenario(
  "menus and dialogs open in place and return focus when dismissed",
  async (page) => {
    await serve(page);
    await page.goto(`${origin}/?id=copy-test`);
    await page.getByRole("article").waitFor();

    const account = page.getByRole("button", { name: "Account", exact: true });
    await account.click();
    await page.locator('[data-slot="popover-content"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="popover-content"]').waitFor({ state: "hidden" });
    assert.ok(
      await account.evaluate((element) => document.activeElement === element),
      "focus returns to the trigger",
    );

    const exportButton = page.getByRole("button", { name: "Export evaluation", exact: true });
    await exportButton.focus();
    await page.keyboard.press("ArrowDown");
    await page.locator('[data-slot="dropdown-menu-content"]').waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Export evaluation",
    );

    await page.goto(`${origin}/`);
    const preset = page.getByRole("combobox", { name: "Demo queries", exact: true });
    await preset.click();
    const popup = page.locator('[data-slot="select-content"][data-open]');
    await popup.waitFor();
    await page.waitForFunction(() => {
      const trigger = document
        .querySelector('[aria-label="Demo queries"]')
        ?.getBoundingClientRect();
      const menu = document
        .querySelector('[data-slot="select-content"][data-open]')
        ?.getBoundingClientRect();
      return trigger && menu && menu.y >= trigger.bottom;
    });
    const triggerBox = await preset.boundingBox(),
      popupBox = await popup.boundingBox();
    assert.ok(popupBox.y >= triggerBox.y + triggerBox.height, "the select opens below its trigger");
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });

    await page
      .locator(".search-group > summary")
      .filter({ hasText: "Shared settings and options" })
      .click();
    const code = page.getByRole("button", { name: "View API code", exact: true });
    await code.click();
    await page.getByRole("dialog", { name: "API code", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "API code", exact: true }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.textContent === "View API code");

    await page.setViewportSize({ width: 390, height: 844 });
    await preset.click();
    await popup.waitFor();
    const mobile = await popup.boundingBox();
    assert.ok(
      mobile.x >= 0 && mobile.x + mobile.width <= 390,
      "the select stays inside a mobile viewport",
    );
  },
  { permissions: ["clipboard-read", "clipboard-write"] },
);

// ========================================================= the search sidebar

const { request } = JSON.parse(fs.readFileSync("tests/search-cases.json", "utf8"));

await scenario(
  "the sidebar builds, runs, restores and resets a comparison",
  async (page, { errors }) => {
    // `serveBuild` answers the document and bundle; the /api routes below stay local to this page.
    await serveBuild(page, "http://127.0.0.1:3002", () => null);
    let saved,
      searches = 0;
    await page.route("**/api/*", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data;
      if (path.endsWith("/search")) {
        const body = route.request().postDataJSON();
        assert.deepEqual(body.search_request, request);
        assert.deepEqual(body.modes, ["fast", "advanced"]);
        assert.equal(body.criteria, "Official sources only");
        assert.equal(body.blind, false);
        searches++;
        saved = {
          id: "sidebar-test",
          query: request.search_queries.join(" · "),
          criteria: body.criteria,
          search_request: body.search_request,
          created_at: new Date().toISOString(),
          runs: body.modes.map((mode, index) => ({
            id: mode,
            mode,
            request: { ...request, mode },
            status: "completed",
            elapsed: 0.5,
            results: [
              {
                id: index + 1,
                rank: 1,
                url: "https://docs.parallel.ai/search/search-quickstart",
                title: "Search quickstart",
                excerpts: ["Official search documentation."],
                publish_date: null,
                judgment: null,
                notes: "",
                version: 0,
                updated_at: null,
              },
            ],
            response: { search_id: "s", session_id: "session_test", warnings: [] },
          })),
        };
        data = saved;
      } else if (path.endsWith("/feedback")) {
        const body = route.request().postDataJSON();
        const result = saved.runs
          .flatMap((run) => run.results)
          .find((result) => result.id === body.result_id);
        assert.equal(body.version, result.version);
        Object.assign(result, {
          relevance: body.relevance,
          issues: body.issues,
          rubric_version: "relevance-v1",
          judgment: result.judgment,
          notes: body.notes,
          version: result.version + 1,
          updated_at: new Date().toISOString(),
        });
        saved.feedback_history ||= [];
        saved.feedback_history.push({
          result_id: result.id,
          relevance: result.relevance,
          issues: result.issues,
          rubric_version: result.rubric_version,
          judgment: result.judgment,
          notes: result.notes,
          version: result.version,
          created_at: result.updated_at,
        });
        data = result;
      } else if (path.endsWith("/sessions"))
        data = saved ? [{ ...saved, modes: "fast,advanced", reviewed: 0, total: 0 }] : [];
      else data = saved;
      await route.fulfill({ json: data });
    });
    await page.goto("http://127.0.0.1:3002/");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    assert.equal(
      await page.getByRole("combobox", { name: "Configuration B", exact: true }).innerText(),
      "Fast",
    );
    assert.equal(await page.getByLabel("Objective").isVisible(), true);
    assert.ok(
      await page.getByRole("checkbox", { name: "Blind review", exact: true }).isVisible(),
    );
    assert.equal(
      await page.getByRole("button", { name: "Add query", exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "Workspace" })
        .getByRole("link", { name: "Compare", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Run comparison", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Remove query 1", exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("combobox", { name: "Configuration A", exact: true }).innerText(),
      "Advanced",
    );
    await page.getByRole("combobox", { name: "Configuration A", exact: true }).click();
    await option(page, "Fast").click();
    await page.getByRole("combobox", { name: "Configuration B", exact: true }).click();
    await option(page, "Advanced").click();
    await page.getByLabel("Query", { exact: true }).fill(request.search_queries[0]);
    let activePanel = "shared";
    const panel = () =>
      page.getByRole("group", {
        name:
          activePanel === "shared"
            ? "Shared settings"
            : `Configuration ${activePanel === 0 ? "A" : "B"}`,
        exact: true,
        includeHidden: true,
      });
    const expand = async (title) => {
      if (title === "API code") {
        if (await page.getByRole("dialog").isVisible()) {
          await page.getByRole("button", { name: "Close API code", exact: true }).click();
          await page.getByRole("dialog").waitFor({ state: "hidden" });
        } else {
          const button = page.getByRole("button", { name: "View API code", exact: true });
          await button.click();
        }
        return;
      }
      await panel().evaluate((el) => {
        for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement)
          if (ancestor.tagName === "DETAILS") ancestor.open = true;
      });
      const outer = panel().locator(":scope > details");
      if (await outer.count())
        await outer.evaluate((e) => {
          e.open = true;
        });
      for (const summary of await panel().locator(".search-group > summary").all()) {
        if (!(await summary.evaluate((e) => e.parentElement.open))) await summary.click();
      }
    };
    await expand("Advanced settings");
    await page.getByRole("button", { name: "Add query", exact: true }).click();
    await page.getByLabel("Query 2", { exact: true }).fill(request.search_queries[1]);
    await page.getByLabel("Objective").fill(request.objective);

    await panel()
      .getByLabel("Allowed sources", { exact: true })
      .fill(request.advanced_settings.source_policy.include_domains.join("\n"));
    await panel().getByLabel("Blocked sources", { exact: true }).fill("reddit.com");
    assert.ok(
      await page
        .getByText("Parallel ignores Blocked sources while Allowed sources has entries.")
        .isVisible(),
    );
    await panel().getByLabel("Published on or after").fill("2026-01-01");
    await panel().getByLabel("Maximum results", { exact: true }).fill("12");
    await panel().getByLabel("Total excerpt characters").fill("16000");
    await panel().getByLabel("Excerpt characters per result").fill("2000");
    await panel().getByRole("combobox", { name: "Target country" }).click();
    await option(page, "United Kingdom (GB)").click();
    await panel().getByLabel("Maximum cache age (seconds)").fill("86400");
    await panel().getByLabel("Fetch timeout (seconds)").fill("10.5");
    await panel().getByRole("checkbox", { name: "Disable cache fallback" }).check();
    await panel().getByLabel("API session ID", { exact: true }).fill("session_test");
    await panel().getByLabel("Client model", { exact: true }).fill("gpt-5.4");
    await page.getByLabel("Evaluation criteria").fill("Official sources only");
    assert.equal(
      await page.getByRole("checkbox", { name: "Blind review", exact: true }).isChecked(),
      false,
    );
    assert.ok(await panel().getByText("Sources", { exact: true }).isVisible());
    await panel().getByLabel("Maximum cache age (seconds)").fill("500");
    await page.getByRole("button", { name: "Run comparison", exact: true }).click();
    assert.equal(
      await panel()
        .getByLabel("Maximum cache age (seconds)")
        .evaluate((input) => input.validity.rangeUnderflow),
      true,
    );
    assert.equal(searches, 0);
    await panel().getByLabel("Maximum cache age (seconds)").fill("86400");
    await page.getByRole("button", { name: "Copy A to B", exact: true }).click();
    await page.getByRole("combobox", { name: "Configuration B", exact: true }).click();
    await option(page, "Advanced").click();
    await expand("API code");
    const preview = JSON.parse(await page.getByLabel("Search request JSON").innerText());
    assert.deepEqual(preview, [
      { ...request, mode: "fast" },
      { ...request, mode: "advanced" },
    ]);
    await page
      .getByRole("group", { name: "Code format" })
      .getByRole("button", { name: "Python", exact: true })
      .click();
    await page.getByRole("button", { name: "Copy code", exact: true }).click();
    await page.getByText("Copied", { exact: true }).waitFor();
    const python = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(python.includes("client.search(**request)"));
    const literal = python.split("requests = json.loads(")[1].split(")\nfor request")[0];
    assert.deepEqual(JSON.parse(JSON.parse(literal)), preview);
    await page
      .getByRole("group", { name: "Code format" })
      .getByRole("button", { name: "JSON", exact: true })
      .click();
    await expand("API code");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
      true,
      "Desktop stays within viewport",
    );
    await page.getByRole("combobox", { name: "Configuration A", exact: true }).click();
    await option(page, "Turbo").click();
    await page.getByRole("button", { name: "Run comparison", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Turbo does not support source paths" })
      .waitFor();
    assert.equal(searches, 0);
    await page.getByRole("combobox", { name: "Configuration A", exact: true }).click();
    await option(page, "Fast").click();
    await page.getByLabel("Query", { exact: true }).press("Control+Enter");
    await page.getByText("Search saved. Review the results below.").waitFor();
    assert.equal(searches, 1);
    const card = page.getByRole("article").first();
    await card.getByText("Add notes", { exact: true }).click();
    await card.getByRole("textbox").fill("Unsaved review note");
    await page
      .getByRole("radiogroup", { name: "Result view" })
      .getByRole("radio", { name: "JSON", exact: true })
      .click();
    assert.deepEqual(JSON.parse(await page.getByLabel("Evaluation JSON").innerText()), saved);
    await page
      .getByRole("radiogroup", { name: "Result view" })
      .getByRole("radio", { name: "Readable", exact: true })
      .click();
    assert.equal(await card.getByRole("textbox").inputValue(), "Unsaved review note");
    await card.getByRole("textbox").fill("");
    const context = page.getByRole("region", { name: "Review context", exact: true });
    assert.ok(
      await context.getByText("Saved criteria: Official sources only", { exact: true }).isVisible(),
    );
    assert.ok(
      await context
        .getByRole("heading", { name: "Saved query: " + saved.query, exact: true })
        .isVisible(),
    );
    await card.focus();
    await card.press("1");
    await card
      .getByRole("button", { name: "1 · Slightly relevant", exact: true })
      .filter({ hasNot: page.locator("[disabled]") })
      .waitFor();
    await page.waitForFunction(() => document.querySelector("article")?.dataset.grade === "1");
    await card.focus();
    await card.press("2");
    await page.waitForFunction(() => document.querySelector("article")?.dataset.grade === "2");
    await card.getByRole("button", { name: "Clear rating", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("article")?.dataset.grade === "unrated",
    );
    await card.getByText("Review history (3)", { exact: true }).click();
    assert.ok(await card.getByText(/Version 3 · Unrated · relevance-v1/).isVisible());
    assert.equal(saved.feedback_history.length, 3);
    await card.getByRole("textbox").press("1");
    assert.equal(saved.feedback_history.length, 3, "Typing a note must not rate the result");
    await card.getByRole("textbox").fill("");
    await page.reload();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    await page.getByText("Review history (3)", { exact: true }).waitFor();
    assert.equal(await page.getByRole("article").first().getAttribute("data-grade"), "unrated");
    await expand("Advanced settings");
    await page.getByLabel("Query 2", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Query 2", { exact: true }).inputValue(),
      request.search_queries[1],
    );
    assert.equal(await panel().getByLabel("Blocked sources", { exact: true }).inputValue(), "reddit.com");
    await expand("API code");
    assert.deepEqual(JSON.parse(await page.getByLabel("Search request JSON").innerText()), preview);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      "Mobile has no horizontal overflow",
    );
    await expand("API code");
    const submit = await page
      .getByRole("button", { name: "Run comparison", exact: true })
      .boundingBox();
    assert.ok(submit.width > 100);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    assert.equal(await page.getByLabel("Query", { exact: true }).inputValue(), "");
    assert.equal(await panel().getByLabel("Blocked sources", { exact: true }).inputValue(), "");
    await expand("API code");
    assert.deepEqual(JSON.parse(await page.getByLabel("Search request JSON").innerText()), [
      { search_queries: [""], mode: "advanced" },
      { search_queries: [""], mode: "fast" },
    ]);
    await page.goto("http://127.0.0.1:3002/");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    await page.getByLabel("Query", { exact: true }).fill("Keep this query");
    await expand("API code");
    assert.deepEqual(JSON.parse(await page.getByLabel("Search request JSON").innerText()), [
      { search_queries: ["Keep this query"], mode: "advanced" },
      { search_queries: ["Keep this query"], mode: "fast" },
    ]);
    await expand("API code");
    assert.equal(await page.getByRole("button", { name: "Use one mode", exact: true }).count(), 0);
    assert.ok(
      await page.getByRole("combobox", { name: "Configuration B", exact: true }).isVisible(),
    );
    assert.equal(await page.getByLabel("Objective").isVisible(), true);
    assert.equal(
      await page.getByRole("button", { name: "Add query", exact: true }).isVisible(),
      true,
    );
    assert.equal(await page.getByLabel("Query", { exact: true }).inputValue(), "Keep this query");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".search-settings-scroll").evaluate((element) => (element.scrollTop = 0));
    await page.goto("http://127.0.0.1:3002/");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    await page.getByLabel("Query", { exact: true }).fill("Independent settings");
    await page.getByRole("combobox", { name: "Comparison axis", exact: true }).click();
    await option(page, "Maximum results").click();
    activePanel = 0;
    await expand("Advanced settings");
    await panel().getByLabel("Maximum results", { exact: true }).fill("7");
    activePanel = 1;
    if (!(await panel().getByLabel("Maximum results", { exact: true }).isVisible()))
      await expand("Advanced settings");
    assert.equal(await panel().getByLabel("Maximum results", { exact: true }).inputValue(), "20");
    await panel().getByLabel("Maximum results", { exact: true }).fill("12");
    await expand("API code");
    const independentRequests = JSON.parse(
      await page.getByLabel("Search request JSON").innerText(),
    );
    assert.deepEqual(
      independentRequests.map((r) => r.advanced_settings.max_results),
      [7, 12],
    );
    assert.deepEqual(
      independentRequests.map((r) => r.search_queries),
      [["Independent settings"], ["Independent settings"]],
    );
    await expand("API code");
    await page.route("**/api/search", async (route) => {
      const body = route.request().postDataJSON();
      assert.deepEqual(body.requests, independentRequests);
      saved = {
        ...saved,
        id: "independent",
        query: "Independent settings",
        search_request: body.search_request,
        runs: body.requests.map((request, index) => ({
          ...saved.runs[index],
          mode: request.mode,
          request,
        })),
      };
      await route.fulfill({ json: saved });
    });
    await page.getByRole("button", { name: "Run comparison", exact: true }).click();
    await page.getByText("Search saved. Review the results below.").waitFor();
    await page.getByText("Review details", { exact: true }).click();
    assert.ok(await page.getByText(/Configurations use different settings/).isVisible());
    await page.reload();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    await page.getByText("Review details", { exact: true }).click();
    await page.getByText(/Configurations use different settings/).waitFor();
    activePanel = 0;
    await expand("Advanced settings");
    assert.ok(await panel().isVisible());
    assert.equal(await panel().getByLabel("Maximum results", { exact: true }).inputValue(), "7");
    activePanel = 1;
    if (!(await panel().getByLabel("Maximum results", { exact: true }).isVisible()))
      await expand("Advanced settings");
    assert.equal(await panel().getByLabel("Maximum results", { exact: true }).inputValue(), "12");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await page
      .locator(".search-sidebar details")
      .first()
      .evaluate((e) => {
        e.open = true;
      });
    assert.ok(await page.getByRole("button", { name: "Copy A to B", exact: true }).isVisible());
    assert.deepEqual(errors, []);
  },
  { viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] },
);

// ==================================================================== sign-in

const external = process.env.AUTH_TEST_URL;
const authBase = external || "http://127.0.0.1:3011";
const server = external
  ? null
  : spawn("npm", ["run", "start", "--", "--port", "3011"], {
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });

const stop = () => {
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
};

try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${authBase}/sign-in`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // -------------------------------------------------------------- the HTTP edge

  await test("every workspace page redirects a signed-out visitor to sign-in", async () => {
    for (const path of ["/", "/runs", "/no-such-page"]) {
      const response = await fetch(authBase + path, { redirect: "manual" });
      assert.equal(response.status, 307, path);
      assert.match(response.headers.get("location"), /\/sign-in/, path);
      assert.equal(
        response.headers.get("www-authenticate"),
        null,
        "no basic-auth prompt is offered",
      );
    }
  });

  await test("a forged session cookie cannot read any evaluation", async () => {
    for (const path of ["/api/evaluations", "/api/evaluation?id=test", "/api/export?id=test"]) {
      const response = await fetch(authBase + path, {
        headers: { cookie: "__Secure-neon-auth.session_token=forged" },
      });
      assert.equal(response.status, 401, path);
    }
  });

  await test("the auth proxy exposes only the endpoints the application needs", async () => {
    const send = (path, body, origin = authBase) =>
      fetch(`${authBase}/api/auth/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await send("sign-out", {}, "https://evil.example")).status,
      403,
      "a foreign origin cannot sign out",
    );
    assert.equal(
      (await send("email-otp/send-verification-otp", { email: "other@gmail.com", type: "sign-in" }))
        .status,
      403,
      "an outside address gets no code",
    );
    assert.equal(
      (await send("sign-up/email", { email: "other@gmail.com" })).status,
      404,
      "account creation is not exposed",
    );
    assert.equal(
      (
        await send("sign-in/social", {
          provider: "google",
          callbackURL: "/",
          padding: "x".repeat(9000),
        })
      ).status,
      413,
      "the body is bounded",
    );

    // A listed endpoint reached by the wrong method is a 405 naming the method it answers,
    // not a 404: the endpoint exists.
    const wrongMethod = await fetch(`${authBase}/api/auth/sign-out`);
    assert.equal(wrongMethod.status, 405, "sign-out does not answer GET");
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal(
      (await send("get-session", {})).status,
      405,
      "the session read does not answer POST",
    );
    const refused = await fetch(`${authBase}/api/auth/sign-up/email`);
    assert.equal(refused.status, 404, "an endpoint that is not exposed stays absent");
    assert.equal(
      (await refused.json()).code,
      "unknown_endpoint",
      "sign-in failures carry a stable code",
    );

    const google = await send("sign-in/social", {
      provider: "google",
      callbackURL: `${authBase}/`,
    });
    const social = await google.json();
    assert.equal(google.status, 200, JSON.stringify(social));
    assert.match(social.url, /^https:\/\//, "Google sign-in is initiated but never completed here");
  });

  // ------------------------------------------------------------ the sign-in page

  await scenario(
    "the sign-in page refuses an address outside the allowlist",
    async (page, { errors }) => {
      await page.goto(`${authBase}/sign-in`);
      await page.getByRole("button", { name: "Continue with Google" }).waitFor();
      await page.getByLabel("Email", { exact: true }).fill("other@gmail.com");
      await page.getByRole("button", { name: "Send sign-in code", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: "@parallel.ai email" });
      await alert.waitFor();
      assert.match(await alert.innerText(), /@parallel\.ai email/);
      await page
        .getByRole("button", { name: "Continue with Google" })
        .locator("img")
        .evaluate((image) => image.decode());
      assert.deepEqual(errors, []);
    },
    { viewport: { width: 1280, height: 800 } },
  );

  await scenario("signing out restores the email form without reloading", async (page) => {
    let signedIn = true;
    await page.route("**/api/auth/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/get-session"))
        return route.fulfill({ json: signedIn ? {
          session: { id: "test-session", userId: "test-user", expiresAt: "2099-01-01T00:00:00Z" },
          user: { id: "test-user", name: "Reviewer", email: "reviewer@parallel.ai", emailVerified: true },
        } : null });
      if (path.endsWith("/sign-out")) {
        signedIn = false;
        return route.fulfill({ json: { success: true } });
      }
      throw new Error(`unexpected auth request: ${path}`);
    });
    await page.goto(`${authBase}/sign-in`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill("reviewer@parallel.ai");
    assert.equal(await page.getByRole("button", { name: "Send sign-in code", exact: true }).isEnabled(), true);
    assert.equal(signedIn, false);
  });

  await scenario("Google and an email code are both offered from the start", async (page) => {
    let codeRequests = 0;
    await page.route("**/api/auth/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/get-session")) return route.fulfill({ json: null });
      if (path.endsWith("/sign-in/social")) {
        assert.equal(
          route.request().postDataJSON().errorCallbackURL,
          `${authBase}/sign-in?google_error=1`,
        );
        return route.fulfill({ status: 400, json: { message: "Google unavailable" } });
      }
      if (path.endsWith("/email-otp/send-verification-otp")) {
        codeRequests++;
        assert.deepEqual(route.request().postDataJSON(), {
          email: "reviewer@parallel.ai",
          type: "sign-in",
        });
        return route.fulfill({ json: { success: true } });
      }
      throw new Error(`unexpected auth request: ${path}`);
    });
    await page.goto(`${authBase}/sign-in`);
    assert.ok(
      new URL(page.url()).pathname.startsWith("/sign-in"),
      `${authBase} granted local access; these checks need a production build`,
    );

    const google = page.getByRole("button", { name: "Continue with Google" });
    await google.waitFor();
    const email = page.getByLabel("Email", { exact: true });
    const sendCode = page.getByRole("button", { name: "Send sign-in code", exact: true });
    assert.equal(await email.isVisible(), true, "the email code form is offered without asking");
    assert.equal(await sendCode.isVisible(), true, "and so is its submit button");

    await google.click();
    await page.getByRole("alert").filter({ hasText: "Google sign-in failed" }).waitFor();
    assert.equal(await email.isVisible(), true, "a Google failure leaves the code form in place");

    await email.fill("other@gmail.com");
    await sendCode.click();
    await page.getByRole("alert").filter({ hasText: "approved account" }).waitFor();
    assert.equal(codeRequests, 0, "no code is requested for an address outside the allowlist");

    await email.fill("reviewer@parallel.ai");
    await sendCode.click();
    await page.getByLabel("Verification code", { exact: true }).waitFor();
    assert.equal(codeRequests, 1, "any parallel.ai address can request a code");
  });
} finally {
  stop();
}

await scenario("owner activity renders events and reports access errors", async (page) => {
  await serveBuild(page, origin, (route, path) => {
    if (path === "/api/telemetry") {
      return [{ id: "event-1", event: "sign_in_succeeded", user_id: "reviewer-id", created_at: "2026-09-14T15:00:00Z" }];
    }
    return null;
  });
  await page.goto(`${origin}/activity`);
  await page.getByRole("cell", { name: "Sign-in succeeded", exact: true }).waitFor();
  assert.equal(await page.getByRole("cell", { name: "reviewer-id", exact: true }).count(), 1);
  await page.route(`${origin}/api/telemetry`, route => route.fulfill({ status: 403, json: { error: "Only the owner can view app activity." } }));
  await page.getByRole("button", { name: "Refresh activity" }).click();
  await page.getByRole("alert").filter({ hasText: "Only the owner" }).waitFor();
});

await finish();
