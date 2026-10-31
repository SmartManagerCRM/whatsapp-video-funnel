// Renders the SVG icons to the PNG sizes the manifest needs (uses the Chromium that ships with Playwright).
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? "playwright");
import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../apps/pwa/public/icons/", import.meta.url);
const jobs = [["icon.svg", "icon-192.png", 192], ["icon.svg", "icon-512.png", 512], ["icon-maskable.svg", "icon-maskable-512.png", 512]];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of jobs) {
  const svg = readFileSync(new URL(src, dir), "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
  writeFileSync(new URL(out, dir), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();
console.log("icons written");
