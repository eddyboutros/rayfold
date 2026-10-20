/**
 * The documentation site as a visitor meets it, built and served as it is deployed (`vitepress build`, then
 * `vitepress preview`). Every page is opened at a desktop width in the light theme and at a phone width in the dark
 * one: it must load without an error, fit the screen, have one title, and link only to pages that are there. The home
 * page has to say what Rayfold is better at, and how to start, before anyone scrolls; the playground has to work with a
 * keyboard as well as a mouse, in every engine.
 */
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const DIST = fileURLToPath(new URL("../../docs/.vitepress/dist/", import.meta.url));

/** Every page the build wrote, as the address it is served at. */
function routes(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "assets") walk(path);
      } else if (e.name.endsWith(".html") && e.name !== "404.html") {
        const route = `/${relative(DIST, path).replace(/\\/g, "/")}`.replace(/index\.html$/, "").replace(/\.html$/, "");
        out.push(route);
      }
    }
  })(DIST);
  return out.sort();
}

/** The report page is a single standalone document, not a page of the site, so the site's rules are not its rules. */
const STANDALONE = new Set(["/should-you-use-rayfold"]);

interface Seen {
  errors: string[];
  failed: string[];
}

function watch(page: Page): Seen {
  const seen: Seen = { errors: [], failed: [] };
  page.on("console", (m) => {
    if (m.type() === "error") seen.errors.push(m.text());
  });
  page.on("pageerror", (e) => seen.errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && new URL(r.url()).origin === new URL(page.url() || r.url()).origin) seen.failed.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => seen.failed.push(`${r.failure()?.errorText ?? "failed"} ${r.url()}`));
  return seen;
}

const all = routes();

test.describe("every page of the site", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "the crawl runs in one engine; the playground runs in all three");
  // two layouts of the whole site in one test each: the crawl is long, so it gets the time it needs
  test.setTimeout(600_000);

  for (const [name, viewport, colorScheme] of [
    ["at a desktop width, light", { width: 1280, height: 800 }, "light"],
    ["at a phone width, dark", { width: 375, height: 740 }, "dark"],
  ] as const) {
    test(`loads cleanly, fits the screen and has one title, ${name}`, async ({ browser }) => {
      expect(all.length).toBeGreaterThan(80);
      const context = await browser.newContext({ viewport, colorScheme });
      const page = await context.newPage();
      const problems: string[] = [];
      for (const route of all) {
        const seen = watch(page);
        const res = await page.goto(route, { waitUntil: "load" });
        if (res?.status() !== 200) problems.push(`${route}: HTTP ${res?.status()}`);
        await page.waitForLoadState("networkidle");
        const facts = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          h1: document.querySelectorAll("h1").length,
          title: document.title,
          noAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).map((i) => i.getAttribute("src")),
        }));
        if (!STANDALONE.has(route)) {
          if (facts.overflow > 0) problems.push(`${route}: the page scrolls sideways by ${facts.overflow}px`);
          if (facts.h1 !== 1) problems.push(`${route}: ${facts.h1} h1 elements`);
        }
        if (!facts.title.trim()) problems.push(`${route}: no title`);
        for (const src of facts.noAlt) problems.push(`${route}: an image with no alt text (${src})`);
        for (const e of seen.errors) problems.push(`${route}: console: ${e}`);
        for (const f of seen.failed) problems.push(`${route}: request: ${f}`);
        page.removeAllListeners("console");
        page.removeAllListeners("pageerror");
        page.removeAllListeners("response");
        page.removeAllListeners("requestfailed");
      }
      await context.close();
      expect(problems).toEqual([]);
    });
  }

  test("links only to pages that are there", async ({ page, request }) => {
    const links = new Set<string>();
    for (const route of all) {
      if (STANDALONE.has(route)) continue;
      await page.goto(route, { waitUntil: "domcontentloaded" });
      const hrefs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href));
      for (const href of hrefs) {
        const url = new URL(href);
        if (url.origin === new URL(page.url()).origin) links.add(url.pathname);
      }
    }
    const broken: string[] = [];
    for (const path of [...links].sort()) {
      const res = await request.get(path);
      if (res.status() !== 200) broken.push(`${path}: HTTP ${res.status()}`);
    }
    expect(links.size).toBeGreaterThan(60);
    expect(broken).toEqual([]);
  });

  test("a page that does not exist answers 404 with a way back (guard - a page that does answers 200)", async ({ page }) => {
    const seen = watch(page);
    const missing = await page.goto("/guide/no-such-page");
    expect(missing?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Get started" }).first()).toBeVisible();
    // the browser logs the page's own 404; none of its assets may fail, and no script may throw
    expect(seen.failed).toEqual([]);
    expect(seen.errors.filter((e) => !e.startsWith("Failed to load resource: the server responded with a status of 404"))).toEqual([]);
    const there = await page.goto("/guide/quickstart");
    expect(there?.status()).toBe(200);
  });
});

test.describe("the home page's first screen", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "layout, checked once");

  test("on a desktop: the pitch, the measured comparison, how to start, and the first features, before any scrolling", async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto("/");
    const inView = async (selector: string) => {
      const box = await page.locator(selector).first().boundingBox();
      return !!box && box.y >= 0 && box.y + box.height <= 800;
    };
    expect(await inView(".VPHero h1")).toBe(true);
    expect(await inView(".scoreboard")).toBe(true);
    expect(await inView(".home-start")).toBe(true);
    expect(await inView(".VPHero .actions")).toBe(true);
    // the feature cards start on the first screen too
    const features = await page.locator(".VPFeatures").boundingBox();
    expect(features && features.y < 800).toBe(true);
    // the scoreboard shows measured rows, with Rayfold's column marked
    await expect(page.locator(".scoreboard tbody tr")).toHaveCount(6);
    await expect(page.locator(".scoreboard thead th.ours")).toHaveText("Rayfold");
    await expect(page.locator(".scoreboard figcaption")).toContainText(/leads on \d+ of \d+ aspects/);
    await page.close();
  });

  test("on a phone: the pitch and the way in come first, and the comparison follows", async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 375, height: 740 } });
    await page.goto("/");
    const top = async (selector: string) => (await page.locator(selector).first().boundingBox())?.y ?? Infinity;
    expect(await top(".VPHero h1")).toBeLessThan(200);
    expect(await top(".VPHero .actions")).toBeLessThan(740);
    expect(await top(".home-start")).toBeLessThan(await top(".scoreboard"));
    await page.close();
  });

  test("the install command copies, and says so to a screen reader", async ({ browser }) => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator(".home-start .copy").click();
    await expect(page.locator(".home-start .copy")).toHaveText("Copied");
    await expect(page.locator(".home-start [aria-live]")).toHaveText("Install command copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm install @rayfold/server @rayfold/client");
    await context.close();
  });
});

test.describe("the playground", () => {
  test("runs the live example, follows a restock, stops, and announces only the newest frame", async ({ page }) => {
    const seen = watch(page);
    await page.goto("/playground");
    await page.getByRole("button", { name: "Live stock" }).click();
    await expect(page.locator(".pg-live")).toBeVisible();
    const before = await page.locator(".pg-frame").count();
    await page.getByRole("button", { name: /^Restock b1$/ }).click();
    await expect(page.locator(".pg-frame")).toHaveCount(before + 1);
    await expect(page.locator(".pg-frame").last()).toHaveClass(/is-patch/);
    // the list is not a live region; one line is, and it names the newest frame
    await expect(page.locator(".pg-frames")).not.toHaveAttribute("aria-live", /.*/);
    await expect(page.locator(".pg-response .pg-announce")).toHaveText("patch, op 1: a change every client cache applies");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".pg-live")).toHaveCount(0);
    expect(seen.errors).toEqual([]);
  });

  test("the viewer switch is a radio group: arrow keys move the choice and the focus, Tab enters it once", async ({ page }) => {
    await page.goto("/playground");
    const radios = page.getByRole("radiogroup", { name: "Signed in as" }).getByRole("radio");
    await expect(radios).toHaveCount(3);
    const checked = page.getByRole("radio", { checked: true });
    const start = (await checked.textContent())?.trim();
    // only the chosen one is in the tab order
    expect(await radios.evaluateAll((rs) => rs.map((r) => r.getAttribute("tabindex")))).toEqual(
      ["anonymous", "customer", "staff"].map((v) => (v === start ? "0" : "-1")),
    );
    await checked.focus();
    await page.keyboard.press("ArrowRight");
    const next = ["anonymous", "customer", "staff"][(["anonymous", "customer", "staff"].indexOf(start ?? "") + 1) % 3];
    await expect(page.getByRole("radio", { checked: true })).toHaveText(next!);
    await expect(page.getByRole("radio", { checked: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("radio", { checked: true })).toHaveText("staff");
    await page.keyboard.press("Home");
    await expect(page.getByRole("radio", { checked: true })).toHaveText("anonymous");
  });

  test("Run names the shortcut this keyboard uses, and a focused editor shows its focus", async ({ page }) => {
    await page.goto("/playground");
    const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    await expect(page.locator(".pg-run kbd").first()).toHaveText(mac ? "Cmd+Enter" : "Ctrl+Enter");
    await page.locator(".pg-request .cm-content").click();
    const outline = await page.locator(".pg-request .cm-editor").evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(outline).toBe("solid");
  });
});
