#!/usr/bin/env node
/**
 * Draws the site's bitmap icons from docs/public/favicon.svg: favicon.ico (16 and 32 pixels, for browsers that do not
 * read SVG icons) and apple-touch-icon.png (180 pixels on white, for iOS home screens and bookmarks). Uses the Chromium
 * that Playwright installs, so the icons match what a browser draws from the SVG.
 *
 *   node scripts/icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("@playwright/test");
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "public");
const svg = readFileSync(join(PUBLIC, "favicon.svg"), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: "light" });

/** The SVG drawn `inner` pixels wide in the middle of a `size` pixel square. */
async function draw(size, inner, background) {
  await page.setViewportSize({ width: size, height: size });
  const body = `margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${background ?? "transparent"}`;
  await page.setContent(`<html><body style="${body}">${svg.replace(/width="\d+" height="\d+"/, `width="${inner}" height="${inner}"`)}</body></html>`);
  return page.screenshot({ omitBackground: !background, clip: { x: 0, y: 0, width: size, height: size } });
}

/** An .ico file whose images are PNGs, which every current browser and Windows read. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0);
    entry.writeUInt8(size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

try {
  const images = [{ size: 16, png: await draw(16, 16) }, { size: 32, png: await draw(32, 32) }];
  writeFileSync(join(PUBLIC, "favicon.ico"), ico(images));
  writeFileSync(join(PUBLIC, "apple-touch-icon.png"), await draw(180, 132, "#ffffff"));
  console.log("wrote docs/public/favicon.ico and docs/public/apple-touch-icon.png");
} finally {
  await browser.close();
}
