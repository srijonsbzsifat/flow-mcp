import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const KEY_FILE = join(HOME_DIR, "gemini-key");
// Newest first (all tested 2026-10-28 with the same request and the same 30 voice names). Each model has its own free quota,
// so when every key is used up on one, the next model is tried. FLOW_MCP_GEMINI_TTS pins a single model.
// Every model accepts 8,192 input tokens and returns up to 16,384 output tokens per request (read from the models API).
const MODELS = process.env.FLOW_MCP_GEMINI_TTS
  ? [process.env.FLOW_MCP_GEMINI_TTS]
  : ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];

// Gemini's prebuilt voices. Flow draws on the same set, so a narration made here matches one made in Flow.
export const GEMINI_VOICES = [
  { name: "Zephyr", description: "bright" }, { name: "Puck", description: "upbeat" },
  { name: "Charon", description: "informative" }, { name: "Kore", description: "firm" },
  { name: "Fenrir", description: "excitable" }, { name: "Leda", description: "youthful" },
  { name: "Orus", description: "firm" }, { name: "Aoede", description: "breezy" },
  { name: "Callirrhoe", description: "easy-going" }, { name: "Autonoe", description: "bright" },
  { name: "Enceladus", description: "breathy" }, { name: "Iapetus", description: "clear" },
  { name: "Umbriel", description: "easy-going" }, { name: "Algieba", description: "smooth" },
  { name: "Despina", description: "smooth" }, { name: "Erinome", description: "clear" },
  { name: "Algenib", description: "gravelly" }, { name: "Rasalgethi", description: "informative" },
  { name: "Laomedeia", description: "upbeat" }, { name: "Achernar", description: "soft" },
  { name: "Alnilam", description: "firm" }, { name: "Schedar", description: "even" },
  { name: "Gacrux", description: "mature" }, { name: "Pulcherrima", description: "forward" },
  { name: "Achird", description: "friendly" }, { name: "Zubenelgenubi", description: "casual" },
  { name: "Vindemiatrix", description: "gentle" }, { name: "Sadachbia", description: "lively" },
  { name: "Sadaltager", description: "knowledgeable" }, { name: "Sulafat", description: "warm" },
];

// Keys: GEMINI_API_KEY (if set), the legacy single-key file, and ~/.flow-mcp/gemini-keys (one key per line, added from the Studio panel).
// With several keys (e.g. several Google accounts) a rate-limited or used-up key is skipped for as long as Google says and the
// next one takes over, automatically. A key is one unbroken run of characters - older AI Studio keys start "AIza", newer
// ones "AQ" (2026-10). Anything shorter or still holding template text is not a key.
const KEYS_FILE = join(HOME_DIR, "gemini-keys");
const STATE_FILE = join(HOME_DIR, "gemini-key-state.json");
const BASE = process.env.FLOW_MCP_GEMINI_BASE ?? "https://generativelanguage.googleapis.com/v1beta";
const looksLikeKey = (k: string) => k.length >= 20 && !/^(YOUR|PASTE|<|\$)/i.test(k) && !/_KEY|KEY_HERE|EXAMPLE/i.test(k);

export function geminiKeys(): string[] {
  const out: string[] = [];
  const add = (raw?: string) => { const k = raw?.trim(); if (k && looksLikeKey(k) && !out.includes(k)) out.push(k); };
  add(process.env.GEMINI_API_KEY);
  for (const f of [KEY_FILE, KEYS_FILE]) if (existsSync(f)) for (const line of readFileSync(f, "utf8").split(/\r?\n/)) add(line);
  return out;
}
export const geminiKey = (): string | undefined => geminiKeys()[0];

type Limit = { until: number; reason: string };
const readState = (): Record<string, Limit> => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
function markLimited(key: string, model: string, ms: number, reason: string): void {
  const state = readState();
  state[`${model}|${key.slice(-4)}`] = { until: Date.now() + ms, reason };
  try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state), { mode: 0o600 }); } catch { /* cosmetic: the key is still skipped for this take */ }
}
const limitOf = (key: string, model: string = MODELS[0]!): Limit | undefined => { const l = readState()[`${model}|${key.slice(-4)}`]; return l && l.until > Date.now() ? l : undefined; };
const human = (ms: number) => { const m = Math.max(1, Math.round(ms / 60_000)); return ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : `${m}m`; };

// What the panel shows: the last four characters of each key (never the key) and whether it can be used right now.
export function keyStatus(): { ending: string; state: "ready" | "limited"; resets_in?: string; reason?: string }[] {
  return geminiKeys().map((k) => {
    const l = limitOf(k);
    return l ? { ending: k.slice(-4), state: "limited" as const, resets_in: human(l.until - Date.now()), reason: l.reason } : { ending: k.slice(-4), state: "ready" as const };
  });
}

// "Please retry in 9h55m12s", "retry in 34.5s" or a retryDelay field: how long Google says to wait.
export function retryAfterMs(text: string): number | undefined {
  const m = text.match(/retry[^0-9]{0,15}((?:\d+(?:\.\d+)?\s*(?:h|m(?!s)|s)\s*)+)/i);
  if (!m) return undefined;
  let ms = 0;
  for (const t of m[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/g)) ms += Number(t[1]) * { h: 3_600_000, m: 60_000, s: 1000 }[t[2] as "h" | "m" | "s"];
  return ms || undefined;
}
let lastGood = 0;

// Saves the user's key from the panel straight to a file only they can read. It never passes through Claude - that is
// why there is no MCP tool for it. The key is checked with Google BEFORE anything is written, so a mistyped or
// placeholder key can never replace one that works. The check lists models with the key in a header (never in the URL)
// and spends no text-to-speech quota.
export async function saveGeminiKey(raw: string): Promise<{ saved: true; ending: string; total: number }> {
  const key = raw.trim();
  // Only the shape is checked here (Google moved new keys from "AIza..." to "AQ..." in October 2026, and a prefix
  // check refused them); whether the key WORKS is decided by Google itself just below.
  if (!/^[A-Za-z0-9._~+/=-]{20,512}$/.test(key) || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) {
    throw new Error("That doesn't look like a Google AI Studio key. Copy the whole key from aistudio.google.com/apikey, with no spaces.");
  }
  const res = await fetch(`${BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": key } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach Google to check the key. Check your internet connection and try again.");
  if (!res.ok) throw new Error("Google didn't accept that key. Copy it again from aistudio.google.com/apikey. Your previous key, if any, is unchanged.");
  if (!geminiKeys().includes(key)) {
    mkdirSync(dirname(KEYS_FILE), { recursive: true });
    const current = existsSync(KEYS_FILE) ? readFileSync(KEYS_FILE, "utf8").trim() : "";
    writeFileSync(KEYS_FILE, (current ? current + "\n" : "") + key + "\n", { mode: 0o600 });
    chmodSync(KEYS_FILE, 0o600);
  }
  return { saved: true, ending: key.slice(-4), total: geminiKeys().length };
}

// Removes the saved key that ends in these 4 characters (from the panel's list); returns how many remain.
export function removeGeminiKey(ending: string): { removed: boolean; total: number } {
  let removed = false;
  for (const f of [KEY_FILE, KEYS_FILE]) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const kept = lines.filter((l) => !(looksLikeKey(l.trim()) && l.trim().endsWith(ending)));
    if (kept.length !== lines.length) { removed = true; writeFileSync(f, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 }); }
  }
  return { removed, total: geminiKeys().length };
}

interface TtsPart {
  inlineData?: { mimeType?: string; data?: string };
}

// Speaks a line with Gemini's TTS. Free tier, no Flow credits, no length cap, and the same voices Flow uses.
export async function speakWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number; key?: string; model?: string }> {
  const keys = geminiKeys();
  if (!keys.length) {
    const placeholder = existsSync(KEY_FILE) && readFileSync(KEY_FILE, "utf8").trim().length > 0;
    throw new Error(
      (placeholder ? `The key file still holds placeholder text, not a key.\n\n` : `No Gemini key yet.\n\n`) +
        `1. Open aistudio.google.com/apikey and click "Create API key".\n` +
        `2. Copy the whole key (older keys start with AIza, newer ones with AQ).\n` +
        `3. Paste it into Flow Studio: Voice tab -> Google AI Studio keys -> Save key. It is checked with Google and saved\n` +
        `   only on this computer - never paste it into a chat. Add keys from other Google accounts there too: when one is\n` +
        `   rate limited or used up, the next is used automatically.`,
    );
  }
  const prompt = style ? `Say ${style}: ${text}` : text;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  });
  let part: TtsPart | undefined;
  let usedKey: string | undefined;
  let usedModel = MODELS[0]!;
  const refused: string[] = [];
  for (let pass = 0; pass < 3 && !part; pass++) {
    // Same model first across all keys (the voice stays the same), then the next model. Skip anything cooling down.
    const order: { model: string; key: string }[] = [];
    for (const model of MODELS) for (let i = 0; i < keys.length; i++) { const key = keys[(lastGood + i) % keys.length]!; if (!limitOf(key, model)) order.push({ model, key }); }
    if (!order.length) {
      const soonest = Math.min(...MODELS.flatMap((m) => keys.map((k) => limitOf(k, m)!.until))) - Date.now();
      if (pass < 2 && soonest <= 70_000) { await new Promise((r) => setTimeout(r, soonest + 1500)); continue; }
      throw new Error(`Every Gemini key is rate limited or used up on every voice model (${keys.length} key${keys.length === 1 ? "" : "s"}, ${MODELS.length} model${MODELS.length === 1 ? "" : "s"}). ` + keyStatus().map((k) => `...${k.ending}: back in ${k.resets_in ?? "now"}`).join("; ") + `. Add another key in Flow Studio (Voice tab), or wait.`);
    }
    for (const { model, key } of order) {
      const res = await fetch(`${BASE}/models/${model}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; candidates?: { content?: { parts?: TtsPart[] } }[] };
      if (res.ok) {
        part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!part?.inlineData?.data) throw new Error("Gemini returned no audio for this line.");
        usedKey = key;
        usedModel = model;
        lastGood = keys.indexOf(key);
        break;
      }
      const detail = json.error?.message ?? "no detail";
      if (res.status === 429) { markLimited(key, model, retryAfterMs(JSON.stringify(json)) ?? 60_000, "rate or daily limit"); refused.push(`...${key.slice(-4)} limited on ${model}`); continue; }
      if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(detail))) { for (const m of MODELS) markLimited(key, m, 6 * 3_600_000, "key rejected by Google"); refused.push(`...${key.slice(-4)} rejected`); continue; }
      if (res.status === 404) { markLimited(key, model, 6 * 3_600_000, "model not available to this key"); refused.push(`${model} not available`); continue; }
      throw new Error(`Gemini TTS refused this take (${res.status}): ${detail}`);
    }
  }
  if (!part?.inlineData?.data) throw new Error(`Gemini TTS could not be used: ${refused.join(", ") || "no key worked"}.`);

  // The audio comes back as raw signed 16-bit PCM, so the sample rate has to come from the mime type.
  const rate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] ?? 24000);
  const raw = target.replace(/\.\w+$/, "") + ".pcm";
  writeFileSync(raw, Buffer.from(part.inlineData.data, "base64"));
  await run(FFMPEG, [
    "-y", "-f", "s16le", "-ar", String(rate), "-ac", "1", "-i", raw,
    "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-ac", "2", target,
  ]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  const duration = Number(stdout.trim());
  writeFileSync(raw, "");
  await run("rm", ["-f", raw]).catch(() => {});
  return { output: target, duration, key: usedKey?.slice(-4), model: usedModel };
}

// Splits at sentence ends into takes of at most `max` characters (a single longer sentence is cut at a comma or space).
export function chunkText(text: string, max: number): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if ((cur + " " + piece).trim().length <= max) cur = (cur + " " + piece).trim();
    else { if (cur) out.push(cur); cur = piece.trim(); }
  };
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
      push(rest.slice(0, cut > 0 ? cut + 1 : max));
      rest = rest.slice(cut > 0 ? cut + 1 : max).trim();
    }
    push(rest);
  }
  if (cur) out.push(cur);
  return out;
}

// A long script in one call: takes of ~1,800 characters (about 1.5-2 minutes of speech each, tested 1,608 characters = 100 s,
// 97% word match), spoken one after another in the same voice and style, then joined with a 0.25 s pause. The free tier
// allows 3 requests a minute and about 10 a day, so a 6-minute script needs 3-4 requests; a 429 that asks for a short wait
// is retried, a longer one (the daily quota) is reported as it is.
export async function speakLongWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number; takes: number; models: string[]; keys: string[]; note?: string }> {
  const max = Number(process.env.FLOW_MCP_TTS_CHUNK ?? 1800);
  const pieces = chunkText(text, max);
  if (pieces.length === 1) { const one = await speakWithGemini(pieces[0]!, voice, target, style); return { output: one.output, duration: one.duration, takes: 1, models: [one.model!], keys: [one.key!] }; }
  const stem = target.replace(/\.\w+$/, "");
  const parts: string[] = [];
  const models: string[] = [];
  const usedKeys: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const part = `${stem}.take${String(i + 1).padStart(2, "0")}.m4a`;
    for (let attempt = 0; ; attempt++) {
      try { const one = await speakWithGemini(pieces[i]!, voice, part, style); models.push(one.model!); usedKeys.push(one.key!); break; }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const wait = /\(429\)/.test(msg) ? Number(msg.match(/retry in ([\d.]+)s/i)?.[1] ?? NaN) : NaN;
        if (!(wait <= 70) || attempt >= 3) throw new Error(`Take ${i + 1} of ${pieces.length} failed: ${msg}${i ? ` (takes 1-${i} are saved as ${stem}.take01.m4a ...)` : ""}`);
        await new Promise((r) => setTimeout(r, (wait + 2) * 1000));
      }
    }
    parts.push(part);
  }
  const inputs = parts.flatMap((p) => ["-i", p]);
  const pads = parts.map((_, i) => `[${i}]apad=pad_dur=0.25[p${i}]`).join(";");
  await run(FFMPEG, ["-y", ...inputs, "-filter_complex", `${pads};${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=0:a=1[o]`, "-map", "[o]", "-ar", "48000", "-ac", "2", target]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", target]);
  for (const p of parts) await run("rm", ["-f", p]).catch(() => {});
  const distinct = [...new Set(models)];
  return { output: target, duration: Number(stdout.trim()), takes: parts.length, models: distinct, keys: [...new Set(usedKeys)], note: distinct.length > 1 ? `Takes used different voice models (${distinct.join(", ")}) because of quota limits: the voice may sound slightly different between takes. Re-record those takes later, or add a key, if that matters.` : undefined };
}
