# flow-mcp

Drive **Google Flow** (flow.google.com) from Claude, Codex or any other MCP app, or from a local control
panel, using Flow's own credits (free with any Google account: 50 a day), not the pay-per-use video API.

It is a small program that runs on your own machine. It opens its own Chrome window, signs in
as you, and clicks Flow's real buttons. There is no browser extension, no hosted service and no
account to create.

```
Claude / Codex ──stdio──> flow-mcp ──Chrome DevTools Protocol──> Chrome (its own profile) ──> Flow
```

**MCP** = Model Context Protocol, the standard that lets Claude use outside tools.
New here? [GETTING-STARTED.md](GETTING-STARTED.md) takes you from nothing to your first video, step by step, and
[OVERVIEW.md](OVERVIEW.md) explains what it does in plain English, with no code names.

---

## Install or update with Claude (the easy way)

You do not need to type commands: paste one of these into **Claude Code** (or the **Code** tab of the Claude app) and say yes when it asks.

**New here: install**

> Set up Flow MCP from https://github.com/srijonsbzsifat/flow-mcp for me. First check what I already have (git, Node.js 22 or newer, Google Chrome, FFmpeg) and install only what is missing, asking me before each install. Clone it into my home folder (not Desktop, Documents or Downloads, and not a OneDrive-synced folder), run `npm install` and `npm run build`, add it to Claude for every folder with `claude mcp add --scope user flow -- node <full path>/dist/index.js`, then run `npm run login` and tell me exactly what to do in the Chrome window. At the end tell me to restart Claude and then run "check my Flow session". Never ask me to paste a password or an API key into this chat.

**Already using it: update**

> Update Flow MCP in my flow-mcp folder. First show me `git status` and the last 3 commits; if I have local changes, stop and ask me. Then run `git pull`, `npm install` and `npm run build`. Tell me what is new (read "What's new" in README.md) and which one-time steps I need to do, and remind me to fully quit and reopen Claude. After I restart, run `flow_status` and `flow_voices` to confirm it works and that my saved keys and narrations are still there.

**What only you do (Claude cannot and should not):** type your computer password if an install asks for it, sign in to Google in the Chrome window it opens, sign in to Flow Music once (see below), and paste Google AI Studio keys into **Flow Studio**, never into a chat.

**What an update never touches:** your Chrome sign-in (`~/.flow-mcp/chrome-profile`), your saved Gemini keys (`~/.flow-mcp/gemini-keys`), your output folder and saved narrations. They live outside this folder. The compiled program (`dist/`) is not in git, so **`npm run build` is part of every update**: if new tools are missing afterwards, you skipped the build or did not fully quit and reopen Claude.

### What's new (2026-10-28)

- **Flow Music** (flowmusic.app, Lyria): `flow_music_create`, `flow_music_edit`, `flow_music_download`, and `flow_music_bed` (one soft bed of an exact length, hands-off). One-time: in the Flow Chrome window (the one `npm run login` opens), open a new tab, go to **flowmusic.app** and sign in by hand; the session is kept. Downloads land in your output folder under the song title.
- **Several Gemini keys** in Flow Studio (**Voice** tab, "Add key"; one per Google account). When one is rate limited or used up the next is used automatically, then the next voice model (`gemini-3.8-flash-tts` is the default). Existing single keys keep working.
- **Long narration, hands-off**: `flow_narrate` takes up to 12,000 characters; `flow_narrate_script` narrates a whole script (one scene per paragraph) in the same voice, keeps each take, evens out pace and writes `takes.json`; `flow_narrate_redo` re-records just one take (slower, or new wording).
- Windows 11 has now been run end to end.

---

## What you need

| | |
|---|---|
| **macOS or Windows 10/11** | Developed on macOS; also run end to end on Windows 11 (Flow, Flow Music, narration, downloads). Please report anything that breaks |
| **Node.js 22 or newer** | `node --version` |
| **Google Chrome** | Any recent version |
| **A Google account** | Free. Flow gives every account 50 credits a day; a paid Google AI plan adds more and unlocks 1080p downloads. Developed on a Pro plan |
| **FFmpeg** *(optional)* | Mac: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg`. Needed only to join clips, mix music or record narration |
| **A Google AI Studio key** *(optional, free)* | Only for the Google narration voices. See below |

A display must stay awake: the Chrome window is really being driven, so the machine cannot be
headless or asleep mid-run.

---

## Install

```bash
git clone https://github.com/srijonsbzsifat/flow-mcp.git
cd flow-mcp
npm install
npm run build
```

> **Mac: do not put this folder in `~/Desktop`, `~/Documents` or `~/Downloads`.** macOS protects those
> folders, and apps that launch the server from there can be refused permission to read its own
> files (`EPERM: operation not permitted`). `~/flow-mcp` or anywhere in your home folder is fine.
>
> **Windows: keep it out of folders OneDrive syncs** (often Desktop and Documents), where files can be held
> online-only. `C:\Users\<you>\flow-mcp` is fine.

Then sign in, once:

```bash
npm run login
```

That opens the dedicated Chrome window. Sign into Google by hand, open (or create) a Flow project,
and leave the window open. The program never types your password; it only uses the session you
created. That Chrome profile lives in `~/.flow-mcp/chrome-profile` and is separate from your
everyday browser.

---

## Connect it to Claude, Codex or Antigravity

**Claude Code**

```bash
claude mcp add --scope user flow -- node /absolute/path/to/flow-mcp/dist/index.js
```

`--scope user` makes it available in every folder; the default (`local`) only works in the folder you ran it from.

**Claude Desktop**: add to `claude_desktop_config.json` (Mac: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`). On Windows, write the path with doubled backslashes, like
`"C:\\Users\\you\\flow-mcp\\dist\\index.js"`:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

**Codex**: add to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.flow]
command = "node"
args = ["/absolute/path/to/flow-mcp/dist/index.js"]
```

Or run `codex mcp add flow -- node /absolute/path/to/flow-mcp/dist/index.js`. No timeout setting is needed:
Codex, like most MCP apps, gives up on a tool call after 60 seconds, so any call that runs longer than about
45 seconds (creating a character, a 1080p download) answers with a task id instead and keeps working, and
`flow_wait` collects the result.

**Antigravity** (Google's coding app): add a `flow` entry to `mcp_config.json`. On a Mac it lives in
`~/.gemini/antigravity/`; you can also open it from the agent panel's **…** menu → **Manage MCP Servers** →
**View raw config**. Keep any servers already listed and add this one beside them:

```json
{ "mcpServers": { "flow": { "command": "node", "args": ["/absolute/path/to/flow-mcp/dist/index.js"] } } }
```

**Other MCP apps** (Cursor, VS Code and others) take the same command and arguments in their own MCP
settings. ChatGPT in the browser or the ChatGPT app can't use it: its connectors only reach servers on
the internet, and this tool has to run on your own computer to drive your Chrome window.

Developed and tested with Claude. Codex and Antigravity speak the same protocol, so they should work the
same way, but neither has been tried yet, so please report how it goes. Running two of them at once is safe:
the first one started drives Flow, and the others pass their requests to it.

Restart the app, then ask it: *"check my Flow session"*. You should get your plan and credit balance
back. Everything after that is plain English; you never type tool names.

### Teach your assistant how to use it (recommended)

This folder's `CLAUDE.md` holds everything learned about driving Flow, but an assistant only reads it when it is
working inside this folder. To get the same habits from any folder, add this to your own global notes
(Claude Code: `~/.claude/CLAUDE.md`; other apps have a similar "custom instructions" file). Replace the path with
where you put the folder:

```text
## Flow MCP (Google Flow video/image tools)

The `flow` MCP server lives in /absolute/path/to/flow-mcp (not tied to any one working folder).
Read its CLAUDE.md before driving Flow: it holds the UI map and every lesson learned. Standing rules:
check flow_status for the open project first (everything is per project; switch with flow_open_project only
after the user says which); give every new character a voice (`voice`, or `voice_from` for copies or
outfit variants); generate ALL images from the script before any video; announce batch size, tool and
references before each batch; look at every generated image; never start a video without the user's go
and a credit estimate.
```


---

## Your first film

Nothing below costs a credit until step 4, and the assistant asks before spending.

1. **Check the session.** *"Check my Flow session."* This confirms sign-in, plan and credits.
2. **Make a character.** *"Create a character called Pip, a small lamplighter in a flat cartoon style."*
   Flow draws the portrait. Free.
3. **Draw the key frames.** *"Draw three stills with Pip: a dark rooftop, him lighting a lamp, the
   whole hillside glowing. Match each one to the last."* Free: stills cost nothing, so get the look
   right here before spending.
4. **Shoot it.** *"Turn those into three 10-second shots, each starting where the last one ended,
   720p, no more than 15 credits each."* This spends credits. The price is read from Flow's own
   quote first and the scene is skipped if it is over your cap.
5. **Narrate it.** *"Record this line with a warm documentary voice."* Free, any length.
6. **Cut it.** *"Join the three shots under the narration, don't freeze the last frame."*
   The finished file lands in `~/flow-mcp-out/<project>/`.

---

## The control panel

The same features, without an AI assistant in the loop:

```bash
npm run studio     # then open http://127.0.0.1:8787
```

or double-click **Flow Studio.command** (Mac) or **Flow Studio.cmd** (Windows).

Seven tabs, in the order you would use them:

- **Cast**: reusable characters. Create them, edit them in place, or build one from a picture.
- **Frames**: free stills, with *match previous frame* to keep a set on-model.
- **Shots**: paid clips, with first/last frames, chaining, a live credit estimate, and a card that
  continues a finished clip from its own last frame.
- **Voice**: free narration in Google's voices or your computer's own. Your saved narrations are listed
  here to play or delete, and a list of your Google AI Studio keys (add one per Google account; the next is used automatically when one is limited; each is checked with Google and stored
  only on your computer; never paste a key into a chat).
- **Restyle**: change a clip you already have.
- **Cut**: join any videos into one film, in the order you pick. Upload one, or choose from films you've
  already made. Add a narration (from your saved ones or an upload) and music, and turn the clips' own
  sound down so the narration sits on top.
- **Library**: everything in your Flow project. Download it again for free (a scene comes down as one
  finished film, not loose clips), or move it to Flow's Trash.

A progress monitor and a gallery of your saved work sit alongside. The gallery shows stills or clips
on the tabs that use them. On a wide screen, each side scrolls on its own. Two kinds of delete, clearly
labelled: **Move to the Mac's Trash / Recycle Bin** removes a file from your computer; **Move to
Flow's Trash** removes it from your Flow project only. Both can be undone.

The panel ships with the repo but is not started for you: run `npm run studio` when you want it.
Opening `studio/index.html` as a plain file does nothing; the page needs the server behind it, and
says so in red if you try.

Claude's own process serves the same panel while it runs. Whichever process starts first owns the
Chrome tab and the job queue; the other talks to it over a local API, so Claude and the panel always
agree on what is running. That API listens on 127.0.0.1 only and needs a per-run token
(`~/.flow-mcp/token`).

---

## Tools

| Tool | Purpose |
|---|---|
| `flow_status` | Session state (signed in, **which project is open**, plan, credits left), queue, pacing, prompt playbook |
| `flow_projects` | List the projects on your Flow home page and say which one is open. Everything else acts on the OPEN project only (characters, assets and trash are per project) |
| `flow_open_project` | Switch the Flow tab to another existing project, by title or link. Needs `user_confirmed: true`, meaning the person told the assistant which project; never creates or deletes a project |
| `flow_custom_voice` | Customise a character's voice: a stock voice plus a sample line and a performance note ("frightened child, breathless"). Step 1 generates and plays a preview and leaves it open for you to listen; step 2 (`finish: add` or `discard`) keeps or drops it |
| `flow_accounts` | List the Google accounts set up for Flow (each its own Chrome profile with its own projects and credits), which is active and who is signed in |
| `flow_use_account` | Switch to another account's Chrome (the other stays open), or `create: true` for a new one you sign in to by hand. Needs `user_confirmed: true` |
| `flow_generate` | Queue scenes: prompt, image or video, model, aspect, duration, resolution, variants, first/last frame, reference images, `max_credits` cap |
| `flow_wait` | Wait for jobs, or for the task id of a slow call; returns file paths and results. Answers within about 40 s, so call again until `finished` is true |
| `flow_cancel` | Cancel a job that has not started |
| `flow_retry` | Re-queue failed jobs with the same settings and file names (a failed tile is first retried inside Flow with its own free Retry button: `retries`, default 1) |
| `flow_assets` | List images and videos already in the Flow project (usable as `asset:<title>`) |
| `flow_download` | Download existing project media without regenerating. Free, including the 1080p / 2K upscale. A scene comes down as one stitched film |
| `flow_rename` | Rename generated images or clips in Flow (up to 60 per call, each by its current title; refuses a new name that already exists) |
| `flow_trash` | Move an image, video or scene in the Flow project to Flow's Trash, where it can be restored. Finds the item through the Images tab and the search bar; exact title only (a title shown cut off with … matches by its start); refuses if two items share it; never deletes permanently |
| `flow_agent_images` | Fast image batch: hands up to 50 scenes to Flow's own Agent mode, rendered in parallel (20 images in ~204 s), 0 credits. Each image is matched back to its scene by its stored prompt, so file numbers are right in any finish order. Scenes the agent drops are re-asked of it (up to 2 rounds), then re-run one by one. Pass `characters` (up to 3) to attach them so they stay identical across the whole batch, `references` (up to 20 images; the user attached 3 characters and 17 images by hand already in the project: location plates, earlier stills as start frames; each scene's text says `location: <title>` or `start frame: <title>`) and `style` (a global directive) |
| `flow_edit` | Video-to-video edit of a clip already in the project (relight, weather, remove objects). Flow shows no quote first; about 20 credits for a 4 s clip |
| `flow_continue` | Start a clip from the last frame of an existing one **with a character or your avatar still attached**. The composer allows a start frame or attached characters, never both, so this drives Flow's agent mode, which does both. No quote beforehand |
| `flow_character` | Create a reusable character from a description (Flow draws the portrait) or an image, with a personality and a stock voice (give every character one; for a copy or outfit variation pass `voice_from` with the original's name so it sounds the same); use it as `asset:<name>` |
| `flow_character_edit` | Restyle an existing character in place (free) and save the new portrait; name, personality and voice are kept, so every scene referencing it updates. Pass `look` with the updated description; with only a name it re-saves the current portrait. Also changes the **voice** (`voice`, or `voice_from` another character; a voice-only call skips the redraw) |
| `flow_characters` | List the project's characters, each with the voice it has (read live from Flow; `with_voices: false` for a quick list) |
| `flow_techniques` | 39 film-technique prompt presets (camera moves, product shots, transitions, image commands); pass an id as a scene's `technique` |
| `flow_narrate` | Free narration audio: `gemini` (Google AI Studio text-to-speech, the same voices Flow has, plus a `style` note; up to 12,000 characters, split into takes and joined) or `mac` (a voice installed on this computer, no key needed) |
| `flow_narrate_script` | Narrate a whole script hands-off: one scene per paragraph, scenes grouped into ~1,800-character takes in the SAME voice and delivery, keys and voice models rotated on rate limits, each take loudness-matched, a take read much faster or slower than the rest re-recorded once; writes `narration.m4a` and `takes.json` |
| `flow_narrate_redo` | Re-record ONE take of that narration (slower, calmer, new wording), keep the rest, rejoin |
| `flow_voices` | Narrator voices available, and whether a Google key is set up |
| `flow_assemble` | Join clips into one MP4 (a project's clips, or any you list, in order) with optional music and voiceover, and separate volume for the clips' own sound (local FFmpeg, no credits) |
| `flow_music_create` | Flow Music (flowmusic.app, Lyria): start a Producer session, ask for a track in plain words, wait, download it (mp3, m4a or wav) into the output folder under the song title |
| `flow_music_edit` | Send a follow-up to the Producer in the same session (softer, shorter, remove an element); downloads the new version |
| `flow_music_bed` | One bed of an exact length, hands-off: several versions of the same piece from one session, loudness-matched, crossfaded, faded |
| `flow_music_download` | Download any song by id or link as mp3, m4a or wav |

**Continuity between shots:** `chain_previous` (this clip starts on the last frame of the previous
one), `first_frame` + `last_frame` (animate between two stills you chose), `reference_images` (keep a
character or product consistent). Flow's *composer* takes either frames or references, never both, so
when you need a start frame **and** a character locked together, use `flow_continue`, which goes through
Flow's agent mode and does both.

Output lands in `~/flow-mcp-out/<project>/` (change it with `FLOW_MCP_OUTPUT`). Files keep the names Flow gives them (`<title>_<timestamp>.jpg` / `.mp4`), so they also open from Chrome's own download list; they are not renamed.

### Narration with Google's voices (optional)

`flow_narrate` with `engine: "mac"` uses your computer's own voices and works out of the box: macOS voices on a
Mac, the built-in speech voices on Windows. For Google's voices (the same ones Flow offers), get a free key from
[Google AI Studio](https://aistudio.google.com/apikey) and paste it into **Flow Studio → Voice → Google AI Studio
keys → Add key**. It is checked with Google before it is saved and stored only on your computer. Or set
`GEMINI_API_KEY`. Either way, never paste a key into a chat; it would end up in the conversation history.

**Free keys are rate limited, so add one key per Google account you have.** Studio shows each key by its last 4
characters with "ready" or "limited, back in 9h55m". When Google refuses one (rate or daily limit) that key is set aside
for as long as Google says and the next one is used; when every key is used up on one voice model, the next model is
tried (`gemini-3.8-flash-tts`, `3.8-flash-lite`, `3.1-flash`, `2.5-flash`). All models take 8,192 input tokens and
return up to 16,384 output tokens per request (about 8-10 minutes of speech); the tools use takes of about 1,800
characters (about 100 s) for steady quality, so a 6-minute script is 3-4 requests.

### Music with Flow Music (optional)

Sign in to **flowmusic.app** once, by hand, in the same Chrome window Flow uses (it keeps the session). Then ask for
music in plain words: *"Make a calm piano bed for a 6-minute video."* Flow Music tracks come out 2-5 minutes whatever
length you ask for, which is why `flow_music_bed` makes several in one session and joins them. The number beside the
diamond in Flow Music is progress points, not credits; no generation limit has been found.

---

## Behaviour and settings

- One generation at a time, with a random 25–70 second pause between them. The page carries an
  invisible reCAPTCHA; this drives the real interface at human pace and does nothing to evade it.
- Before each generation the server reads Flow's own credit quote and skips the scene if it exceeds
  `max_credits` (default 25).
- Any Google account language works. The server finds Flow's buttons by their English names, so its
  Chrome window always shows Flow in English (it adds `?hl=en` to the address). Your account's own
  language setting is never changed, and prompts can be written in any language.
- Environment variables: `GEMINI_API_KEY`, `FLOW_MCP_PORT` (8787), `FLOW_MCP_OUTPUT`,
  `FLOW_MCP_HOME`, `FLOW_MCP_USER_DOWNLOADS` (where downloads you make by hand in that Chrome land; default `~/Downloads`), `FLOW_MCP_CDP_PORT` (9333), `FLOW_MCP_CHROME`, `FLOW_MCP_GEMINI_TTS` (pin one voice model), `FLOW_MCP_TTS_CHUNK` (characters per narration take, default 1800), `FLOW_MCP_PAUSE_MIN_S`,
  `FLOW_MCP_PAUSE_MAX_S`.

## If something goes wrong

| Symptom | Cause |
|---|---|
| Mac: the server will not start, `EPERM: operation not permitted` | The folder is in a macOS-protected location. Move it out of `~/Desktop`, `~/Documents` or `~/Downloads` and update the path in your Claude config |
| *"Not signed in"* or *"no project open"* | Run `npm run login`, sign in, open a Flow project, leave the window open |
| A clip generated but no file arrived | The media is still in Flow. `flow_download` pulls it back for nothing. Never re-generate and pay twice |
| Everything times out | The Chrome window was closed, or the machine slept. Reopen it with `npm run login` |

---

## Updating

Use the **update prompt** at the top of this page. By hand, in your flow-mcp folder:

```bash
git status            # stop here if you have local changes
git pull
npm install
npm run build         # required: the compiled program (dist/) is not stored in git
```

Then **fully quit and reopen** Claude (or your assistant), and ask *"check my Flow session"* and *"which narrator voices
do I have?"*. If a new tool is missing, the build or the restart was skipped. Your sign-in, keys and saved work are kept
(they live in `~/.flow-mcp` and your output folder, outside this folder). If Flow Studio is open, close it and reopen it
(`npm run studio`) to see new panels.

---

## Licence and risk

This is a fork of [GTAI-1/flow-mcp](https://github.com/GTAI-1/flow-mcp) with added project switching, search-based
trash, character voices, agent batches that keep characters and reference images attached, and real-name
downloads. The original has no licence file, so keep this to yourself and people you know.

This automates Flow's web interface. It can break whenever Google changes that interface, and
automated use may be against Google's terms of service. Use it on your own account, at your own
risk.
