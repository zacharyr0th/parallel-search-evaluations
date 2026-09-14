// Shared Chromium harness for the browser suites.
//
// One browser serves every case in a suite; each case gets its own context, so routing,
// storage and viewport changes never leak into the next one. Search and feedback responses
// are always fixtures, so a browser check spends no Parallel credits.
import { createRequire } from "node:module";
import fs from "node:fs";
import { test } from "node:test";

const { chromium } = createRequire(import.meta.url)("playwright");

export const base = process.env.UI_TEST_URL || "http://127.0.0.1:3000";

let browser;
const launched = async () => (browser ??= await chromium.launch());

/** Close the shared browser. Call this last; node:test reports and sets the exit code. */
export const finish = () => browser?.close();

/**
 * Run one browser case against a fresh context.
 *
 * @param {string} name
 * @param {(page, tools: {context, errors: string[]}) => Promise<void>} body
 *   `errors` collects uncaught page errors; assert on it when the case cares.
 * @param {object} [contextOptions] passed to `browser.newContext`.
 */
export function scenario(name, body, contextOptions = {}) {
  return test(name, async () => {
    const context = await (await launched()).newContext({
      viewport: { width: 1440, height: 900 },
      ...contextOptions,
    });
    const errors = [];
    try {
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await body(page, { context, errors });
    } finally {
      await context.close();
    }
  });
}

/**
 * Serve the built application to `page` from `.next`, with `/api` answered by `api`.
 * Needs `npm run build`; nothing reaches the network and no server has to be running.
 */
export async function serveBuild(page, origin, api) {
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) return route.fulfill({ json: (await api(route, path)) ?? null });
    const file = path.startsWith("/_next/static/")
      ? `.next/${path.slice("/_next/".length)}`
      : path === "/"
        ? ".next/server/app/index.html"
        : path === "/activity"
          ? ".next/server/app/activity.html"
        : path === "/parallel-logo.svg" || path === "/_next/image"
          ? "public/parallel-logo.svg"
          : null;
    if (!file || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const type = file.endsWith(".html")
      ? "text/html"
      : file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : "application/octet-stream";
    return route.fulfill({ body: fs.readFileSync(file), contentType: type });
  });
}

/**
 * The option named `name` inside the select popup that is currently open.
 *
 * A Base UI select keeps its popup at full size for a frame after it loses `data-open`, so a
 * bare getByRole('option') can bind to the previous menu's copy of the same label and then
 * wait forever for that copy to become visible. Only the open popup carries `data-open`.
 */
export const option = (page, name) =>
  page
    .locator('[data-slot="select-content"][data-open]')
    .getByRole("option", { name, exact: true });
