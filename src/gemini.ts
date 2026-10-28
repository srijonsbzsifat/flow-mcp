import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HOME_DIR } from "./chrome.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const KEY_FILE = join(HOME_DIR, "gemini-key");
const MODEL = process.env.FLOW_MCP_GEMINI_TTS ?? "gemini-2.5-flash-preview-tts";

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

// A key is one unbroken run of characters - older AI Studio keys start "AIza", newer ones "AQ" (2026-10). Anything
// shorter or still holding template text is not a key.
export const geminiKey = (): string | undefined => {
  const key = (process.env.GEMINI_API_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8") : "")).trim();
  if (!key || key.length < 20 || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) return undefined;
  return key;
};

// Saves the user's key from the panel straight to a file only they can read. It never passes through Claude - that is
// why there is no MCP tool for it. The key is checked with Google BEFORE anything is written, so a mistyped or
// placeholder key can never replace one that works. The check lists models with the key in a header (never in the URL)
// and spends no text-to-speech quota.
export async function saveGeminiKey(raw: string): Promise<{ saved: true; ending: string }> {
  const key = raw.trim();
  // Only the shape is checked here (Google moved new keys from "AIza..." to "AQ..." in October 2026, and a prefix
  // check refused them); whether the key WORKS is decided by Google itself just below.
  if (!/^[A-Za-z0-9._~+/=-]{20,512}$/.test(key) || /^(YOUR|PASTE|<|\$)/i.test(key) || /_KEY|KEY_HERE|EXAMPLE/i.test(key)) {
    throw new Error("That doesn't look like a Google AI Studio key. Copy the whole key from aistudio.google.com/apikey, with no spaces.");
  }
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key } }).catch(() => null);
  if (!res) throw new Error("Couldn't reach Google to check the key. Check your internet connection and try again.");
  if (!res.ok) throw new Error("Google didn't accept that key. Copy it again from aistudio.google.com/apikey. Your previous key, if any, is unchanged.");
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return { saved: true, ending: key.slice(-4) };
}

interface TtsPart {
  inlineData?: { mimeType?: string; data?: string };
}

// Speaks a line with Gemini's TTS. Free tier, no Flow credits, no length cap, and the same voices Flow uses.
export async function speakWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number }> {
  const key = geminiKey();
  if (!key) {
    const placeholder = existsSync(KEY_FILE) && readFileSync(KEY_FILE, "utf8").trim().length > 0;
    throw new Error(
      (placeholder
        ? `The key file still holds placeholder text, not a key.\n\n`
        : `No Gemini key yet.\n\n`) +
        `1. Open aistudio.google.com/apikey and click "Create API key".\n` +
        `2. Copy the whole key (older keys start with AIza, newer ones with AQ).\n` +
        `3. Paste it into Flow Studio: Voice tab -> Google AI Studio key -> Save key. It is checked with Google and saved\n` +
        `   only on this computer - never paste it into a chat.`,
    );
  }
  const prompt = style ? `Say ${style}: ${text}` : text;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  const body = (await res.json()) as { error?: { message?: string }; candidates?: { content?: { parts?: TtsPart[] } }[] };
  if (!res.ok) throw new Error(`Gemini TTS refused this take (${res.status}): ${body.error?.message ?? "no detail"}`);
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error("Gemini returned no audio for this line.");

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
  return { output: target, duration };
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
export async function speakLongWithGemini(text: string, voice: string, target: string, style?: string): Promise<{ output: string; duration: number; takes: number }> {
  const max = Number(process.env.FLOW_MCP_TTS_CHUNK ?? 1800);
  const pieces = chunkText(text, max);
  if (pieces.length === 1) return { ...(await speakWithGemini(pieces[0]!, voice, target, style)), takes: 1 };
  const stem = target.replace(/\.\w+$/, "");
  const parts: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const part = `${stem}.take${String(i + 1).padStart(2, "0")}.m4a`;
    for (let attempt = 0; ; attempt++) {
      try { await speakWithGemini(pieces[i]!, voice, part, style); break; }
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
  return { output: target, duration: Number(stdout.trim()), takes: parts.length };
}
