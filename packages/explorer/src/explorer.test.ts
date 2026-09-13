import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createExplorerHandler, explorerHtml, type ExplorerOptions } from "./index.ts";

let running: Server | undefined;

/** The handler in front of an application, as a server would mount it. */
async function start(opts: ExplorerOptions = {}): Promise<string> {
  const explorer = createExplorerHandler(opts);
  const server = createServer((req, res) => {
    if (explorer(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain" }).end("the rest of the application");
  });
  running = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(
  () =>
    new Promise<void>((r) => {
      if (!running) return r();
      running.closeAllConnections();
      running.close(() => r());
      running = undefined;
    }),
);

describe("the explorer page", () => {
  it("serves itself at its own path and leaves everything else alone", async () => {
    const base = await start();
    const page = await fetch(`${base}/rayfold/explorer`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store"); // never cached: it carries the endpoint it talks to
    const html = await page.text();
    expect(html).toContain('"endpoint":"/rayfold"');

    const elsewhere = await fetch(`${base}/rayfold`);
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe("the rest of the application");
  });

  it("takes the endpoint, the path and the title it is given", async () => {
    const base = await start({ endpoint: "/api", path: "/tools/explorer", title: "Acme API" });
    expect((await fetch(`${base}/rayfold/explorer`)).status).toBe(404);
    const html = await (await fetch(`${base}/tools/explorer`)).text();
    expect(html).toContain('"endpoint":"/api"');
    expect(html).toContain('"title":"Acme API"');
  });

  it("answers HEAD without a body and refuses anything but a read", async () => {
    const base = await start();
    const head = await fetch(`${base}/rayfold/explorer`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await fetch(`${base}/rayfold/explorer`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("loads nothing from anywhere else, so it works behind a strict policy and offline", () => {
    const html = explorerHtml();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc="(?!data:)/); // no script or image is fetched
  });

  it("is the page the JVM serves too, character for character", () => {
    // one page, two runtimes: `node scripts/sync-explorer.mjs` copies it across, and this fails if they drift
    const resource = readFileSync(
      new URL("../../../kotlin/rayfold-core/src/main/resources/dev/rayfold/core/explorer.html", import.meta.url),
      "utf8",
    );
    const config = JSON.stringify({ endpoint: "/rayfold", title: "Rayfold" }).replace(/</g, "\\u003c");
    expect(resource.replace("__RAYFOLD_EXPLORER_CONFIG__", config)).toBe(explorerHtml());
  });

  it("a title cannot break out of the configuration it is written into", () => {
    const html = explorerHtml({ title: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>"); // escaped, so the browser reads it as text
  });
});
