#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Drives the real host UI in headless Chrome through the message actions flow and exits
// non-zero if any step fails. Needs the stack from README.md to be running.
//
//   NEXTAUTH_SECRET=... node check-ui.mjs        (SCREENSHOT_DIR=./shots to keep screenshots)

import { mkdirSync } from "node:fs";

import { chromium } from "playwright-core";

import { mintSession } from "./mint-session.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOT_DIR;
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const wait = (promise) => promise.then(() => true, () => false);

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: "next-auth.session-token", value: await mintSession(), url: BASE_URL }]);
  const page = await context.newPage();
  const shot = (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

  await page.goto(`${BASE_URL}/apps/actions-demo`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const skip = page.getByRole("button", { name: "Skip until next login" });
  await skip.waitFor({ timeout: 15_000 }).then(() => skip.click()).catch(() => {});
  const launcher = page.getByRole("button", { name: /Open Ask Demo/ });
  check("launcher appears once the app configures the host", await wait(launcher.waitFor({ timeout: 60_000 })));
  await launcher.click();

  const question = `Check ${Date.now()}`;
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.waitFor({ timeout: 90_000 });
  await composer.fill(question);
  await composer.press("Enter");
  check("answer streams from the app", await wait(page.getByText(`Demo answer to: ${question}`).first().waitFor({ timeout: 60_000 })));
  await page.waitForTimeout(2500); // the host saves the answer shortly after it finishes
  await shot("answer");

  // The conversation is reused across runs, so older answers keep their actions too.
  const allFlag = page.getByRole("button", { name: "Flag answer" });
  const allMark = page.getByRole("button", { name: "Mark answer" });
  const flag = allFlag.last();
  const mark = allMark.last();
  check("both actions show on the finished answer", (await allFlag.count()) >= 1 && (await allMark.count()) >= 1);

  await mark.click();
  check("action without a dialog succeeds", await wait(page.getByText("Recorded").first().waitFor({ timeout: 20_000 })));

  await flag.click();
  const dialog = page.getByRole("dialog", { name: "Flag this answer" });
  await dialog.waitFor({ timeout: 10_000 });
  const field = dialog.getByLabel("Corrected answer");
  check("dialog is prefilled with the answer", (await field.inputValue()) === `Demo answer to: ${question}`);
  check("focus moves into the dialog", await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]"))));
  await field.fill("A corrected answer");
  await dialog.getByRole("button", { name: "Submit" }).click();
  check("dialog closes after a successful submit", await wait(dialog.waitFor({ state: "hidden", timeout: 20_000 })));

  await flag.click();
  await dialog.waitFor({ timeout: 10_000 });
  await field.fill("please fail");
  await dialog.getByRole("button", { name: "Submit" }).click();
  const alert = dialog.getByRole("alert");
  check("the app's error text shows inside the dialog", await wait(alert.waitFor({ timeout: 20_000 })) && (await alert.innerText()) === "Demo failure");
  await shot("error");
  await field.fill("x".repeat(60_001));
  check("text over the limit blocks submit", await dialog.getByRole("button", { name: "Submit" }).isDisabled());
  await page.keyboard.press("Escape");
  check("Escape closes the dialog", await wait(dialog.waitFor({ state: "hidden", timeout: 10_000 })));
  check("focus returns to the action", (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Flag answer");

  const demo = page.frameLocator("iframe");
  await demo.locator("#show-mark").uncheck();
  await page.waitForTimeout(800);
  check("the app can hide one action", (await allMark.count()) === 0 && (await allFlag.count()) >= 1);
  await demo.locator("#show-flag").uncheck();
  await page.waitForTimeout(800);
  check("the app can hide every action", (await allMark.count()) === 0 && (await allFlag.count()) === 0);
  await demo.locator("#show-flag").check();
  await demo.locator("#show-mark").check();
  await page.waitForTimeout(800);
  check("the app can show them again", (await allMark.count()) >= 1 && (await allFlag.count()) >= 1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await skip.waitFor({ timeout: 5_000 }).then(() => skip.click()).catch(() => {});
  await page.getByRole("button", { name: /Open Ask Demo/ }).click({ timeout: 60_000 });
  check("a reloaded conversation still shows the actions", await wait(flag.waitFor({ timeout: 90_000 })));
  await mark.click();
  check("an action on a reloaded answer succeeds", await wait(page.getByText("Recorded").first().waitFor({ timeout: 20_000 })));
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
