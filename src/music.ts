// Google Flow Music (flowmusic.app, Lyria): a chat with a "Producer". Driven in the same Chrome as Flow (CDP), signed in by
// the user once on the flowmusic.app tab. Selectors mapped live 2026-10-28: textbox "Chat message", button "Send message",
// song links /song/<id> inside <main>, song page "..." (More options) -> Download -> M4A | MP3 | WAV (free, unlimited).
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import { getBrowser } from "./chrome.js";
import { projectDir } from "./core.js";

const HOME = "https://www.flowmusic.app/";
const FORMATS = { m4a: "M4A", mp3: "MP3", wav: "WAV" } as const;
type Fmt = keyof typeof FORMATS;
const MAX_WAIT_MS = 5 * 60_000;

const format = z.enum(["m4a", "mp3", "wav"]).default("mp3").describe("Download format: mp3 (small, fine for a bed under narration), m4a, or wav (largest).");
export const musicShapes = {
  create: {
    project: z.string().min(1).describe("Folder (under the flow-mcp output root) for the downloaded track."),
    prompt: z
      .string()
      .min(10)
      .max(1500)
      .describe(
        "What to make, in plain words, as you would tell a producer: mood, instruments, tempo, length, and whether it is instrumental. For a bed under narration say 'instrumental, no vocals, no drums, low dynamics, no big builds'. A track often comes out longer than asked; trim it afterwards.",
      ),
    session: z.enum(["new", "current"]).default("new").describe("'new' starts a fresh Producer session (default); 'current' continues the one open on the flowmusic.app tab."),
    download: z.boolean().default(true).describe("Download the new track when it is ready."),
    format,
  },
  edit: {
    project: z.string().min(1).describe("Folder for the downloaded track."),
    message: z.string().min(3).max(1500).describe("The change to ask the Producer for in the open session, e.g. 'softer, remove the pads, end at 55 seconds'. A new song version is made."),
    session_url: z.string().url().optional().describe("A flowmusic.app/session/<id> link to continue; default is the session open on the flowmusic.app tab."),
    download: z.boolean().default(true),
    format,
  },
  download: {
    project: z.string().min(1).describe("Folder for the downloaded track."),
    song: z.string().optional().describe("Song id or flowmusic.app/song/<id> link; default is the newest song in the open session."),
    format,
  },
};
type Create = { project: string; prompt: string; session: "new" | "current"; download: boolean; format: Fmt };
type Edit = { project: string; message: string; session_url?: string; download: boolean; format: Fmt };
type Download = { project: string; song?: string; format: Fmt };

async function musicPage(): Promise<Page> {
  const b = await getBrowser();
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  const page = ctx.pages().find((p) => /flowmusic\.app/.test(p.url())) ?? (await ctx.newPage());
  if (!/flowmusic\.app/.test(page.url())) await page.goto(HOME, { waitUntil: "domcontentloaded" });
  return page;
}

async function requireSignedIn(p: Page): Promise<void> {
  await p.getByRole("textbox", { name: "Chat message" }).waitFor({ timeout: 20_000 }).catch(() => {});
  if (await p.getByRole("button", { name: "Log in" }).count()) {
    throw new Error("Flow Music is not signed in. Sign in on the flowmusic.app tab in the Flow Chrome window (by hand), then retry.");
  }
}

const songs = (p: Page) =>
  p.locator('main a[href^="/song/"]').evaluateAll((as) =>
    [...new Map(as.map((a) => [(a as HTMLAnchorElement).getAttribute("href")!, (a.textContent ?? "").trim()])).entries()].map(([href, title]) => ({ href, title })),
  );

// Sends one message and waits for the Producer to finish. New song links that appear are the result; if the Producer
// only answers in words (a question, a refusal) the reply text is returned and nothing is created.
async function ask(p: Page, message: string): Promise<{ created: { href: string; title: string }[]; reply?: string }> {
  let known = await songs(p);
  for (let i = 0; i < 5; i++) {              // a reopened session lists its songs late: wait until the list stops growing
    await p.waitForTimeout(1500);
    const now = await songs(p);
    if (now.length === known.length && i > 0) break;
    known = now;
  }
  const before = new Set(known.map((s) => s.href));
  const box = p.getByRole("textbox", { name: "Chat message" });
  await box.click();
  await box.fill(message);
  await p.getByRole("button", { name: "Send message" }).click();
  const t0 = Date.now();
  let quiet = 0;
  let created: { href: string; title: string }[] = [];
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await p.waitForTimeout(2500);
    created = (await songs(p)).filter((s) => !before.has(s.href));
    const text = await p.locator("main").innerText().catch(() => "");
    const busy = /Generating|\b\d{1,3}%/.test(text);
    const stopping = (await p.getByRole("button", { name: "Stop generating" }).count()) > 0;
    if (created.length && !busy) {
      if (++quiet >= 2) return { created };
    } else if (!created.length && !busy && !stopping && Date.now() - t0 > 12_000) {
      if (++quiet >= 3) return { created, reply: text.split("\n").slice(-12).join("\n").slice(-900) };
    } else quiet = 0;
  }
  throw new Error(`Flow Music did not finish within ${MAX_WAIT_MS / 60000} minutes. Look at the flowmusic.app tab; the song may still appear in the session.`);
}

// Waits for a new, finished file in `dir` (Chrome writes "<name>.crdownload" first) and returns its path.
async function waitForFile(dir: string, before: Set<string>, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = { path: "", size: -1 };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const f of readdirSync(dir)) {
      if (before.has(f) || f.endsWith(".crdownload") || f.startsWith(".")) continue;
      const path = join(dir, f);
      const size = statSync(path).size;
      if (last.path === path && last.size === size && size > 0) return path;
      last = { path, size };
    }
  }
  throw new Error(`The download did not arrive in ${dir}. Check the flowmusic.app tab.`);
}

async function fetchSong(p: Page, song: string, fmt: Fmt, project: string) {
  const id = song.replace(/^.*\/song\//, "").replace(/[?#].*$/, "");
  const dir = projectDir(project);
  mkdirSync(dir, { recursive: true });
  await p.goto(`${HOME}song/${id}`, { waitUntil: "domcontentloaded" }); // always fresh: a menu left open on the page hides its buttons
  // Like Flow's own images and videos: Chrome saves straight into the project folder under its real name (the song title)
  // so Chrome's download list can open it; no hidden temp folder, no renaming. Default behaviour is restored afterwards.
  // Set BEFORE any menu is opened: attaching a CDP session mid-menu steals focus and closes it.
  const before = new Set(readdirSync(dir));
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
  try {
    // The song's own "..." is the unnamed button after Share in <main>. The bottom player bar has a "More options" too, but
    // that menu belongs to whatever track is PLAYING (it once downloaded the wrong song), so it is never used.
    const share = p.locator('main button[aria-label="Share"]');
    await share.waitFor({ timeout: 20_000 });
    await p.waitForTimeout(2000); // the page re-renders once while loading; clicking a detached node fails
    const title = (await p.title().catch(() => "")).replace(/\s*[|\-–]\s*(Google )?Flow Music.*$/i, "").replace(/ by \S+$/, "").trim() || id;
    const box = await share.boundingBox();
    if (!box) throw new Error("The song page has no Share button; Flow Music may have changed its layout.");
    await p.mouse.click(box.x + box.width * 1.75 + 12, box.y + box.height / 2); // the "..." button, 60 px right of Share
    // The submenu opens on hover and closes if the pointer cuts across the main menu: go sideways into it first, then down.
    const dl = p.getByRole("menuitem", { name: "Download", exact: true });
    await dl.hover();
    const item = p.getByRole("menuitem", { name: FORMATS[fmt], exact: true });
    await item.waitFor({ timeout: 10_000 });
    const [d, m] = [await dl.boundingBox(), await item.boundingBox()];
    if (!d || !m) throw new Error("The Download submenu did not open; Flow Music may have changed its layout.");
    await p.mouse.move(m.x + m.width / 2, d.y + d.height / 2, { steps: 12 });
    await p.mouse.move(m.x + m.width / 2, m.y + m.height / 2, { steps: 12 });
    await p.mouse.click(m.x + m.width / 2, m.y + m.height / 2);
    const target = await waitForFile(dir, before, 90_000);
    const length = (await p.locator("body").innerText().catch(() => "")).match(/\d{1,2}:\d{2}/g)?.pop();
    return { file: target, title, song_url: `${HOME}song/${id}`, length_shown: length ?? null };
  } finally {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
  }
}

export async function musicCreate(a: Create) {
  const p = await musicPage();
  if (a.session === "new") await p.goto(`${HOME}session`, { waitUntil: "domcontentloaded" });
  await requireSignedIn(p);
  const r = await ask(p, a.prompt);
  const session_url = p.url();
  if (!r.created.length) return { created: false, session_url, producer_reply: r.reply, note: "The Producer made no song. Answer it with flow_music_edit." };
  const song = r.created[r.created.length - 1]!;
  const out = a.download ? await fetchSong(p, song.href, a.format, a.project) : { song_url: HOME + song.href.slice(1), title: song.title };
  return { created: true, session_url, songs: r.created.map((s) => ({ title: s.title, song_url: HOME + s.href.slice(1) })), ...out, credits: "unknown: the Flow Music credit counter is at the bottom left of the page" };
}

export async function musicEdit(a: Edit) {
  const p = await musicPage();
  if (a.session_url) await p.goto(a.session_url, { waitUntil: "domcontentloaded" });
  if (!/\/session\/[\w-]+/.test(p.url())) throw new Error("No Flow Music session is open. Pass session_url (from flow_music_create), or open the session in the flowmusic.app tab.");
  await requireSignedIn(p);
  const session_url = p.url();
  const r = await ask(p, a.message);
  if (!r.created.length) return { created: false, session_url, producer_reply: r.reply };
  const song = r.created[r.created.length - 1]!;
  const out = a.download ? await fetchSong(p, song.href, a.format, a.project) : { song_url: HOME + song.href.slice(1), title: song.title };
  return { created: true, session_url, songs: r.created.map((s) => ({ title: s.title, song_url: HOME + s.href.slice(1) })), ...out };
}

export async function musicDownload(a: Download) {
  const p = await musicPage();
  await requireSignedIn(p);
  let song = a.song;
  if (!song) {
    const all = await songs(p);
    if (!all.length) throw new Error("No song in the open Flow Music session; pass `song`.");
    song = all[all.length - 1]!.href;
  }
  return fetchSong(p, song, a.format, a.project);
}
