import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`);
const ICONS = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"];

/** Width and height from a PNG's header. */
function pngSize(png: Buffer): [number, number] {
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe("the icons browsers ask for", () => {
  it("the docs site and the report page both link every icon, and each one is in docs/public", () => {
    const site = [...read("docs/.vitepress/config.ts").toString("utf8").matchAll(/rel: "(?:icon|apple-touch-icon)"[^}]*href: "([^"]+)"/g)].map((m) => m[1]);
    const report = [...read("e2e/report-html.ts").toString("utf8").matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(site).toEqual(ICONS);
    expect(report).toEqual(ICONS);
    for (const href of ICONS) expect(existsSync(`${ROOT}docs/public${href}`), href).toBe(true);
  });

  it("favicon.ico holds a 16 and a 32 pixel PNG, for browsers that do not read SVG icons", () => {
    const ico = read("docs/public/favicon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const sizes: number[] = [];
    for (let i = 0; i < ico.readUInt16LE(4); i++) {
      const entry = 6 + 16 * i;
      const [width, bytes, offset] = [ico.readUInt8(entry), ico.readUInt32LE(entry + 8), ico.readUInt32LE(entry + 12)];
      expect(pngSize(ico.subarray(offset, offset + bytes))).toEqual([width, width]);
      sizes.push(width);
    }
    expect(sizes).toEqual([16, 32]);
  });

  it("apple-touch-icon.png is the 180 pixel square iOS asks for", () => {
    expect(pngSize(read("docs/public/apple-touch-icon.png"))).toEqual([180, 180]);
  });
});

describe("the card a shared link shows, and the wordmark's font", () => {
  const config = read("docs/.vitepress/config.ts").toString("utf8");

  it("og.png is the 1200 by 630 image the head names, at its size", () => {
    expect(config).toContain('{ property: "og:image", content: `${SITE}/og.png` }');
    expect(config).toContain('{ property: "og:image:width", content: "1200" }');
    expect(config).toContain('{ property: "og:image:height", content: "630" }');
    expect(pngSize(read("docs/public/og.png"))).toEqual([1200, 630]);
  });

  it("the font is served from the site with its licence beside it, and no page asks another host for it", () => {
    const css = read("docs/.vitepress/theme/style.css").toString("utf8");
    expect(css).toContain('src: url("/fonts/archivo-600-latin.woff2") format("woff2")');
    expect(config).toContain('href: "/fonts/archivo-600-latin.woff2", as: "font"');
    expect(read("docs/public/fonts/archivo-600-latin.woff2").subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(read("docs/public/fonts/OFL.txt").toString("utf8")).toContain("SIL Open Font License, Version 1.1");
    expect(`${config}\n${css}`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});
