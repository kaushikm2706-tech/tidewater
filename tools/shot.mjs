// Usage: node tools/shot.mjs <url> <out.png> [waitSelector] [--logs]
import { chromium } from 'playwright-core';
const [url, out, sel] = process.argv.slice(2);
const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
if (sel && !sel.startsWith('--')) await page.waitForSelector(sel, { timeout: 20000 }).catch((e) => logs.push('[wait-fail] ' + e.message));
await page.waitForTimeout(1500);
await page.screenshot({ path: out });
if (process.argv.includes('--text')) console.log((await page.evaluate(() => document.body.innerText)).slice(0, 3000));
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
