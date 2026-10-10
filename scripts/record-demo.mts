import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

// Records the README recall GIF against a running local server (never the live demo).
// Usage: npm run start -- -p 3300 (after `npm run seed`), then `npm run demo:gif`.
const BASE = process.env.DEMO_URL ?? "http://localhost:3300";
const OUT = "docs/recall-demo.gif";
const TMP = ".demo-video";
const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
mkdirSync("docs", { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: TMP, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
const recordingStarted = Date.now(); // video time zero is (about) page creation

// Warm the server off camera so the clip starts on a rendered page.
await page.goto(`${BASE}/login`);
await page.getByRole("button", { name: /Manager/ }).click();
await page.waitForURL(/\/recall/);
await page.goto(`${BASE}/recall`);
await page.getByLabel("Batch code").waitFor();
const trimSeconds = (Date.now() - recordingStarted) / 1000 + 0.2;
await pause(page, 900);

// 1. Search for the batch.
const box = page.getByLabel("Batch code");
await box.click();
await box.pressSequentially("B-4471", { delay: 90 });
await pause(page, 300);
await page.getByRole("button", { name: "Find batch" }).click();
await page.getByRole("heading", { level: 1, name: /B-4471/ }).waitFor();
await pause(page, 1600);

// 2. Rewind to the first delivery, then replay the batch's history.
const slider = page.getByRole("slider", { name: "Replay date" });
await slider.focus();
await page.keyboard.press("Home");
await pause(page, 1200);
await page.getByRole("button", { name: "Play" }).click();
await page.getByRole("button", { name: "Quarantine batch everywhere" }).waitFor({ timeout: 20_000 });
await pause(page, 1200);

// 3. Quarantine with the typed confirmation and show the pull list.
await page.getByRole("button", { name: "Quarantine batch everywhere" }).click();
const dialog = page.getByRole("dialog");
await pause(page, 900);
await dialog.getByLabel("Type B-4471 to confirm").pressSequentially("B-4471", { delay: 110 });
await pause(page, 400);
await dialog.getByRole("button", { name: "Quarantine batch" }).click();
await dialog.getByRole("columnheader", { name: "Units to pull" }).waitFor();
await pause(page, 2600);
await dialog.getByRole("button", { name: "Done" }).click();
await page.getByText("RECALLED", { exact: true }).waitFor();
await pause(page, 2200);

await context.close();
await browser.close();

const video = readdirSync(TMP).find((f) => f.endsWith(".webm"));
if (!video) throw new Error("No video recorded");
renameSync(`${TMP}/${video}`, `${TMP}/demo.webm`);

// Trim the off-camera warm-up, then build a palette-optimised GIF.
const start = process.env.DEMO_TRIM ?? trimSeconds.toFixed(2);
const filters = "fps=12,scale=960:-1:flags=lanczos";
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", start, "-i", `${TMP}/demo.webm`, "-vf", `${filters},palettegen=stats_mode=diff`, `${TMP}/palette.png`]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", start, "-i", `${TMP}/demo.webm`, "-i", `${TMP}/palette.png`, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, OUT]);
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
