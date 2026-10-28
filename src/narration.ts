// Narrating a whole script with no user input, and changing one part of it later.
// A script has one scene per paragraph (blank line). Scenes are grouped into takes of at most ~1,800 characters (1.5-2 minutes,
// tested), each take spoken in the same voice and style, saved on its own, and joined. A manifest (takes.json) remembers which
// scenes are in which take, so "slower" or "change scene 7" only re-records that one take and rejoins.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { chunkText, speakWithGemini } from "./gemini.js";
import { projectDir } from "./core.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";
const GAP = 0.25;
const MIN_WORDS = 40;       // shorter takes naturally read at odd paces (short lines, pauses): they are not judged
const TOLERANCE = 0.22;     // a take this far from the median pace is re-recorded once

export const narrationShapes = {
  script: {
    project: z.string().min(1).describe("Folder (under the flow-mcp output root) for the takes, takes.json and the joined narration.m4a."),
    script_path: z.string().optional().describe("Absolute path of the script (text file, one scene per paragraph, blank line between scenes). Preferred: the text never passes through chat."),
    text: z.string().max(60000).optional().describe("The script text itself, if there is no file."),
    voice: z.string().min(1).default("Charon").describe("Voice from flow_voices."),
    style: z.string().max(200).optional().describe("Delivery note kept identical for every take, e.g. 'calm, clear, steady explainer pace'. Add 'slowly' to slow the whole read."),
  },
  redo: {
    project: z.string().min(1).describe("The same project folder used by flow_narrate_script."),
    take: z.number().int().min(1).describe("Take number to re-record (see takes.json: each take lists its scenes)."),
    style: z.string().max(200).optional().describe("New delivery for this take, e.g. 'slower and calmer'. Default: the style used before."),
    voice: z.string().optional().describe("Default: the voice used before (keep it, for consistency)."),
    text: z.string().max(6000).optional().describe("Replacement text for this take (e.g. after editing a scene). Default: the same text."),
  },
};

interface Take { take: number; scenes: number[]; text: string; file: string; seconds: number; start: number; words: number; wps: number; model: string; key: string }
interface Manifest { voice: string; style?: string; max_chars: number; takes: Take[]; output: string }

const probe = async (f: string) => Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim());
const clean = (t: string) => t.replace(/\{[^}]*\}/g, "").replace(/[ \t]+/g, " ").trim();

function groupScenes(text: string, max: number): { scenes: number[]; text: string }[] {
  const scenes = text.split(/\r?\n\s*\r?\n/).map(clean).filter(Boolean);
  const takes: { scenes: number[]; text: string }[] = [];
  let cur: { scenes: number[]; text: string } | undefined;
  scenes.forEach((s, i) => {
    const n = i + 1;
    if (s.length > max) { // one scene longer than a take: split at sentence ends, the pieces share the scene number
      if (cur) takes.push(cur), (cur = undefined);
      for (const piece of chunkText(s, max)) takes.push({ scenes: [n], text: piece });
      return;
    }
    if (cur && (cur.text + "\n\n" + s).length <= max) { cur.scenes.push(n); cur.text += "\n\n" + s; }
    else { if (cur) takes.push(cur); cur = { scenes: [n], text: s }; }
  });
  if (cur) takes.push(cur);
  const last = takes[takes.length - 1], prev = takes[takes.length - 2];
  if (last && prev && last.text.length < max * 0.25 && prev.text.length + last.text.length + 2 <= max * 1.3) { prev.scenes.push(...last.scenes); prev.text += "\n\n" + last.text; takes.pop(); }
  return takes;
}

async function joinTakes(dir: string, m: Manifest): Promise<number> {
  const inputs = m.takes.flatMap((t) => ["-i", t.file]);
  const pads = m.takes.map((_, i) => `[${i}]apad=pad_dur=${GAP}[p${i}]`).join(";");
  const cat = `${m.takes.map((_, i) => `[p${i}]`).join("")}concat=n=${m.takes.length}:v=0:a=1[o]`;
  await run(FFMPEG, ["-y", ...inputs, "-filter_complex", `${pads};${cat}`, "-map", "[o]", "-ar", "48000", "-ac", "2", m.output]);
  let at = 0;
  for (const t of m.takes) { t.start = Math.round(at * 1000) / 1000; at += t.seconds + GAP; }
  writeFileSync(join(dir, "takes.json"), JSON.stringify(m, null, 1));
  return probe(m.output);
}

function referencePace(m: Manifest): number {
  const w = (m.takes.filter((t) => t.words >= MIN_WORDS).length ? m.takes.filter((t) => t.words >= MIN_WORDS) : m.takes).map((t) => t.wps).sort((a, b) => a - b);
  return w[Math.floor(w.length / 2)]!;
}

// Flags what a listener would notice: one take much faster or slower than the rest, or takes made by different voice models.
function checks(m: Manifest): string[] {
  const notes: string[] = [];
  const med = referencePace(m);
  for (const t of m.takes) {
    if (t.words >= MIN_WORDS && Math.abs(t.wps - med) / med > TOLERANCE) notes.push(`Take ${t.take} (scenes ${t.scenes.join(",")}) is read ${t.wps > med ? "faster" : "slower"} than the others (${t.wps.toFixed(2)} vs ${med.toFixed(2)} words/s): redo it with flow_narrate_redo and a pace in the style.`);
  }
  const models = [...new Set(m.takes.map((t) => t.model))];
  if (models.length > 1) notes.push(`Takes came from different voice models (${models.join(", ")}) because of quota limits; the voice may differ slightly between them. Re-record those takes later, or add a key.`);
  return notes;
}

const view = (m: Manifest, seconds: number, dir: string) => ({
  output: m.output,
  seconds: Math.round(seconds * 10) / 10,
  takes: m.takes.map((t) => ({ take: t.take, scenes: t.scenes, start: t.start, seconds: Math.round(t.seconds * 10) / 10, wps: Math.round(t.wps * 100) / 100, model: t.model, key: `...${t.key}` })),
  manifest: join(dir, "takes.json"),
  notes: checks(m),
});

export async function narrateScript(a: { project: string; script_path?: string; text?: string; voice: string; style?: string }) {
  const raw = a.script_path ? readFileSync(a.script_path, "utf8") : a.text;
  if (!raw?.trim()) throw new Error("Give script_path or text.");
  const dir = projectDir(a.project);
  const takesDir = join(dir, "takes");
  mkdirSync(takesDir, { recursive: true });
  const max = Number(process.env.FLOW_MCP_TTS_CHUNK ?? 1800);
  const m: Manifest = { voice: a.voice, style: a.style, max_chars: max, takes: [], output: join(dir, "narration.m4a") };
  const groups = groupScenes(raw, max);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const file = join(takesDir, `take-${String(i + 1).padStart(2, "0")}.m4a`);
    const one = await speakWithGemini(g.text, a.voice, file, a.style);
    const words = g.text.split(/\s+/).filter(Boolean).length;
    m.takes.push({ take: i + 1, scenes: g.scenes, text: g.text, file, seconds: one.duration, start: 0, words, wps: words / one.duration, model: one.model ?? "", key: one.key ?? "" });
  }
  // Consistency without asking: a long take read much faster or slower than the others is re-recorded ONCE with a pace hint,
  // and the better of the two reads is kept. (One extra request per outlier.)
  const fixes: string[] = [];
  const target = referencePace(m);
  for (const t of m.takes) {
    if (t.words < MIN_WORDS || Math.abs(t.wps - target) / target <= TOLERANCE) continue;
    const hint = t.wps > target ? "noticeably slower, relaxed pace with natural pauses" : "a little brisker pace, fewer long pauses";
    const keep = { seconds: t.seconds, wps: t.wps, model: t.model, key: t.key, file: t.file };
    const alt = t.file.replace(/\.m4a$/, ".retry.m4a");
    try {
      const one = await speakWithGemini(t.text, a.voice, alt, `${a.style ? a.style + ", " : ""}${hint}`);
      const wps = t.words / one.duration;
      if (Math.abs(wps - target) < Math.abs(keep.wps - target)) {
        await run(FFMPEG, ["-y", "-i", alt, "-c", "copy", t.file]);
        Object.assign(t, { seconds: one.duration, wps, model: one.model ?? t.model, key: one.key ?? t.key });
        fixes.push(`take ${t.take}: ${keep.wps.toFixed(2)} -> ${wps.toFixed(2)} words/s (${hint})`);
      } else fixes.push(`take ${t.take}: retry did not help (${wps.toFixed(2)}), kept the first read`);
    } catch (err) { fixes.push(`take ${t.take}: retry failed (${err instanceof Error ? err.message.slice(0, 80) : err}), kept the first read`); }
  }
  const out = view(m, await joinTakes(dir, m), dir);
  return fixes.length ? { ...out, auto_pace_fixes: fixes } : out;
}

export async function narrateRedo(a: { project: string; take: number; style?: string; voice?: string; text?: string }) {
  const dir = projectDir(a.project);
  const mf = join(dir, "takes.json");
  if (!existsSync(mf)) throw new Error(`No takes.json in ${dir}: run flow_narrate_script first.`);
  const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  const t = m.takes.find((x) => x.take === a.take);
  if (!t) throw new Error(`No take ${a.take}; this narration has takes 1-${m.takes.length}.`);
  if (a.text) t.text = clean(a.text);
  const style = a.style ?? m.style;
  const one = await speakWithGemini(t.text, a.voice ?? m.voice, t.file, style);   // same file name: the old take is replaced
  t.seconds = one.duration; t.words = t.text.split(/\s+/).filter(Boolean).length; t.wps = t.words / one.duration; t.model = one.model ?? t.model; t.key = one.key ?? t.key;
  if (a.voice) m.voice = a.voice;
  const total = await joinTakes(dir, m);
  return { ...view(m, total, dir), redone: a.take, note: "The audio changed length, so every later word moved: rebuild the video (build.py re-times everything; Cinema-2D: to_studio.py then retime_shots.py)." };
}
