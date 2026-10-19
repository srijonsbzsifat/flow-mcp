import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);

// One Chrome profile (and one debugging port) per Google account. "main" is the original profile and port, so existing
// logins keep working; every other account gets chrome-profile-<name> and the next free port, remembered in accounts.json.
// Every account's Chrome can stay open side by side; switching only changes which one the tools talk to.
const ACCOUNTS_FILE = join(HOME_DIR, "accounts.json");
const CURRENT_FILE = join(HOME_DIR, "account.txt");
const readAccounts = (): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch {
    return {};
  }
};
let current = (process.env.FLOW_MCP_ACCOUNT ?? (existsSync(CURRENT_FILE) ? readFileSync(CURRENT_FILE, "utf8").trim() : "")) || "main";
if (current !== "main" && !(current in readAccounts())) current = "main";

export const currentAccount = (): string => current;
export const profileDir = (account = current): string => join(HOME_DIR, account === "main" ? "chrome-profile" : `chrome-profile-${account}`);
const cdpPort = (account = current): number => (account === "main" ? CDP_PORT : readAccounts()[account]);
const cdpUrl = (): string => `http://127.0.0.1:${cdpPort()}`;

export function listAccounts(): { name: string; active: boolean; signed_in_before: boolean }[] {
  return ["main", ...Object.keys(readAccounts())].map((name) => ({ name, active: name === current, signed_in_before: existsSync(join(profileDir(name), "Default")) }));
}

// Points the tools at another account's Chrome (launched on the next call). A name that does not exist yet is only
// created when `create` is set, so a typo cannot quietly make a new empty profile.
export async function useAccount(name: string, create: boolean): Promise<void> {
  if (!/^[\w-]{1,30}$/.test(name)) throw new Error("Account names are 1-30 letters, digits, - or _.");
  const accounts = readAccounts();
  if (name !== "main" && !(name in accounts)) {
    if (!create) throw new Error(`No account called "${name}". Known: ${listAccounts().map((a) => a.name).join(", ")}. To make a new one, ask again with create: true.`);
    accounts[name] = Math.max(CDP_PORT, ...Object.values(accounts)) + 1;
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts));
  }
  current = name;
  writeFileSync(CURRENT_FILE, name);
  await browser?.close().catch(() => {}); // only disconnects; the previous account's Chrome window stays open
  browser = null;
}

// "Google Account: Name (email)" as Flow's avatar button words it; null when not signed in.
export async function signedInAs(page: Page): Promise<string | null> {
  return page
    .evaluate(() => document.querySelector('a[aria-label^="Google Account"]')?.getAttribute("aria-label") ?? null)
    .catch(() => null);
}

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${cdpUrl()}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Where files the USER downloads by hand in this Chrome land: the normal Downloads folder, exactly like any regular Chrome
// profile (the user's call, 2026-10-19). The tools' own downloads go through a hidden folder and are renamed into the
// project folders; they used to leave Chrome pointed there with random file names, so a manual download "happened" but
// could not be found. Override with FLOW_MCP_USER_DOWNLOADS.
// Where the tools save what they download: <output root>/<project>/, with the files keeping their real names (Flow names
// them "<title>_<timestamp>.<ext>") so Chrome's download list can still open them. The default is ~/flow-mcp-out (macOS
// protects ~/Downloads, ~/Desktop and ~/Documents from background programs); set FLOW_MCP_OUTPUT to put it anywhere,
// e.g. a folder inside Downloads on Windows.
export const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
export const USER_DOWNLOAD_DIR = process.env.FLOW_MCP_USER_DOWNLOADS ?? join(homedir(), "Downloads");

// Chrome reads its own default download folder from the profile's Preferences file and rewrites that file when it
// exits, so it can only be changed while Chrome is NOT running: right before launching it.
function pointChromeDownloadsAt(dir: string): void {
  const file = join(profileDir(), "Default", "Preferences");
  if (!existsSync(file)) return; // a brand-new profile has none yet; the first run's own default applies
  try {
    mkdirSync(dir, { recursive: true });
    const prefs = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    prefs.download = { ...(prefs.download ?? {}), default_directory: dir, prompt_for_download: false, directory_upgrade: true };
    prefs.savefile = { ...(prefs.savefile ?? {}), default_directory: dir };
    writeFileSync(file, JSON.stringify(prefs));
  } catch {
    /* a Preferences file that cannot be read or written must never stop Chrome from starting */
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
async function launchChrome(): Promise<void> {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) {
    throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  }
  mkdirSync(profileDir(), { recursive: true });
  pointChromeDownloadsAt(USER_DOWNLOAD_DIR);
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${profileDir()}`,
      `--remote-debugging-port=${cdpPort()}`,
      "--no-first-run",
      "--no-default-browser-check",
      inEnglish(FLOW_URL),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${cdpPort()} never came up.`);
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(cdpUrl());
  return browser;
}

export async function getFlowPage(): Promise<Page> {
  const b = await getBrowser();
  const context = b.contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()));
  if (existing) {
    await ensureEnglish(existing);
    return existing;
  }
  const page = await context.newPage();
  await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  return page;
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}
