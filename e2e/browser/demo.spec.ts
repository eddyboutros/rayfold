/**
 * The web demo in Chromium, Firefox and WebKit (Safari's engine): the real @rayfold/client in each browser engine, live
 * updates over WebSocket between two tabs, and another website trying to act with the visitor's cookie. Browsers
 * differ in when they send cookies and Origin headers, which is what the cross-site test is about. Every user name
 * carries the browser's name, since the three runs share one demo server.
 */
import { expect, test, type Page } from "@playwright/test";

interface State { orders: Array<{ id: string; status: string; customerId: string }>; stock: number | null }
const state = async (page: Page, book: string): Promise<State> => (await (await page.request.get(`/__state?book=${book}`)).json()) as State;

async function signIn(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.fill("#name", name);
  await page.click("#login button");
  await expect(page.locator("#who")).toContainText(name);
}

/** The id the page last logged as opened ("opened g84"). */
async function openedId(page: Page): Promise<string> {
  const text = await page.locator("#log").innerText();
  const ids = [...text.matchAll(/opened (\S+)/g)].map((m) => m[1]!);
  const id = ids.at(-1);
  if (!id) throw new Error(`no book opened: ${text}`);
  return id;
}

/** Searches, then opens the first result that has copies in stock; returns its id. */
async function openBookInStock(page: Page, q: string): Promise<string> {
  await page.fill("#q", q);
  await page.click("#search button");
  const buttons = page.locator("#results li button");
  await expect(buttons.first()).toBeVisible();
  for (let i = 0; i < (await buttons.count()); i++) {
    await buttons.nth(i).click();
    await expect(page.locator("#title")).not.toBeEmpty();
    const id = await openedId(page);
    if (((await state(page, id)).stock ?? 0) > 0) return id;
  }
  throw new Error(`no result for "${q}" has copies in stock`);
}

test("sign in, search the real catalogue, and open a book with its live stock", async ({ page }, info) => {
  await signIn(page, `reader-${info.project.name}`);
  const id = await openBookInStock(page, "frankenstein");
  await expect(page.locator("#author")).not.toBeEmpty();
  await expect(page.locator("#stock")).toHaveText(((await state(page, id)).stock ?? 0).toLocaleString("en-US"));
});

test("a purchase in one tab reaches the other tab over WebSocket, and paying moves the order on", async ({ browser }, info) => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await signIn(a, `buyer-${info.project.name}`);
  const b = await context.newPage();
  await b.goto("/");
  await expect(b.locator("#who")).toContainText(`buyer-${info.project.name}`); // the tabs share the sign-in cookie
  const id = await openBookInStock(a, "frankenstein");
  await b.fill("#q", "frankenstein");
  await b.click("#search button");
  // open the same book in the second tab
  const same = b.locator("#results li button").filter({ hasText: (await a.locator("#title").innerText()).trim() }).first();
  await same.click();
  await expect(b.locator("#title")).toHaveText(await a.locator("#title").innerText());
  const before = (await state(a, id)).stock ?? 0;
  await expect(b.locator("#stock")).toHaveText(before.toLocaleString("en-US"));

  await a.click("#buy");
  await expect(a.locator("#log")).toContainText("placed order");
  const order = /placed order (\S+)/.exec(await a.locator("#log").innerText())?.[1] ?? "";
  await expect(b.locator("#stock")).toHaveText((before - 1).toLocaleString("en-US")); // pushed, not refetched
  await expect(a.locator("#orders li", { hasText: order })).toContainText("PLACED");
  await a.click("#pay");
  await expect(a.locator("#orders li", { hasText: order })).toContainText("PAID");
  await context.close();
});

test("another website cannot place an order with the visitor's cookie, and the visitor still can", async ({ page }, info) => {
  const user = `visitor-${info.project.name}`;
  await signIn(page, user);
  const mine = async () => (await state(page, "g84")).orders.filter((o) => o.customerId === user).length;
  const before = await mine();

  await page.goto("http://localhost:4611/");
  await page.click("#run");
  await expect(page.locator("#run")).toHaveText("Done (results saved)", { timeout: 20_000 });
  expect(await page.locator("#rows tr").count()).toBeGreaterThanOrEqual(6);
  expect(await mine(), "no cross-site attempt placed an order as the visitor").toBe(before);

  // guard: on the demo itself the same cookie places an order, so the check above is not vacuous
  await page.goto("/");
  await expect(page.locator("#who")).toContainText(user);
  await openBookInStock(page, "frankenstein");
  await page.click("#buy");
  await expect(page.locator("#log")).toContainText("placed order");
  expect(await mine()).toBe(before + 1);
});
