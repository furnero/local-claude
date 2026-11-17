# Local Claude (chat app)

A Claude-app-style chat window for local models in Ollama. A fork of Aster (`..\..\Aster`):
same look, animations and tool cards, but everything runs on this PC, with no API key and
no internet needed for chatting.

It is **not** Claude. It runs whatever Ollama model you pick (Qwen 3.5 4B / 9B by default).

## Start

- `dist\LocalClaude\LocalClaude.exe` (after `npm run make-exe`), or the Start menu entry "Local Claude"
- from source: `npm start`

Ollama is started automatically. The first message in a mode prepares its model, which takes a few seconds once.

## What it does

| | |
|---|---|
| **Modes** | **Quick** (small fast model), **Smart** (bigger model + careful working method) and **Coder** (a coding model with the refusals removed, `huihui_ai/qwen3.5-abliterated:9b-OmniCoder` by default, with Smart's method plus a coding section in its instructions). The mode button in the message box switches; each chat remembers its mode. |
| **Coder 30B** | A fourth mode that runs **Qwen3-Coder 30B** through the **colibrì** engine (`D:\colibri`) instead of Ollama. Since 2026-11-16 its default model folder is `D:\colibri-models\qwen3-coder-30b-abliterated`: the abliterated build (refusals removed, `huihui-ai/Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated`), made with `coli.cmd import <file>.gguf --out <folder>` from the Q4_K_M GGUF in `D:\colibri-models\gguf` (18.6 GB; the folder only points at that file, so keep both). The plain model in colibrì's own format is still in `D:\colibri-models\qwen3-coder-30b` (18 GB): switch with Settings → Local models → Coder 30B → Model folder. Both measured the same speed. colibrì keeps the shared part of the model on the graphics card (Vulkan) and reads the specialist blocks from the SSD as needed, so a model this size runs at all. It is slow on this PC (measured 2026-11-16 with only 2 to 3 GB of RAM free): 1 to 2 tokens a second, and it reads the prompt at 8 to 16 tokens a second, so the first answer of a chat took 10 minutes (about 5,000 tokens of instructions and tools). Later rounds and messages in the same chat reuse what it already read (8 to 30 seconds measured). That reuse is all or nothing: after a Stop in the middle of an answer, or once the chat outgrows the context and old parts are trimmed, or when you switch to another chat, the next answer reads everything again. Answers are limited to 3,072 tokens per round in this mode. The app starts colibrì on the first message (this PC only, with a private key from `..\data\colibri.key`) and stops it when another mode needs the memory or the app closes. Its instructions leave out the long Claude memory index (it uses `search_memory` instead) and stay unchanged for the whole chat so that reuse works. Settings → Local models → Coder 30B: folders, blocks kept in RAM, context size, graphics card or CPU only. Needs Python 3. |
| **Server** | A fifth mode for a model on another machine of yours that runs a normal Ollama (`src/main/server.js`). Settings → Local models → Server mode: an SSH target (`user@host` or a name from `~/.ssh/config`), optionally a key file, the local tunnel port (11435 by default, because 11434 is this PC's own Ollama), the model and its context size; or a direct address for a machine on the home network. The app opens the tunnel itself (`ssh -N -L`, batch mode, strict host key checking, so the key must work without a prompt and the host must be known already), reuses one that is already open, and closes its own when the app quits. It creates the `lc-<model>-<N>k` model with the context size on the server. The mode is hidden until a server and a model are entered, and it leaves this PC's models loaded. Measured with Qwen3-Coder 30B on a CPU-only VM (8 cores of a Xeon E5-2640 v4, 24 GB): 13 tokens/s writing, 29 tokens/s reading, 1.8 s for a follow-up, but 200 s after one changed line in the instructions. So this mode gets the short instructions (no Claude memory index) and keeps them unchanged for a whole chat, like Coder 30B; the answer limit stays normal. Each 16k of context cost that server about 1.5 GB of RAM. |
| **Thinking** | The model's reasoning streams into the chat, expanded, before each answer. Settings → General can collapse it after it finishes; the mode menu can switch thinking off. |
| **Quick asks first** | Before a job that is too big for it, Quick mode shows a card: *Switch to Smart* / *Stay in Quick* (or type your own answer). The chat waits for you. |
| **Questions** | The model can ask you something (`ask_user`) with option buttons and wait for the answer. |
| **Send while it works** | Type and press Enter while it is busy: the message is queued and reaches the model with its next tool result (or starts the next turn). Empty box = the button is Stop. |
| **Checks its work** | Before it may finish a turn in which it changed or ran things, it gets an automatic "check your work" pass and must verify with tools. Settings → General: Off / Smart mode / Always. |
| **Plan** | For multi-step jobs it shows a checklist (`update_plan`) and ticks steps off. |
| **Own memory** | One notes file per project in `..\notes\` (Status / Done / Open / Needs fixing / Facts), shared with the `local-claude` terminal launcher. Tools: `save_note`, `remove_note`, `search_memory`. The chat's working folder picks the project. |
| **Claude memory** | Read-only: the index of the matching Claude Code project memory is in its instructions and `search_memory` searches all of it. Writing anywhere under `~/.claude` is blocked. |
| **Computer** | Terminal (PowerShell/cmd/bash), read/list/search/write/edit files, `download_file`. Asks before commands, writes and downloads ("Always allow" per tool). |
| **Servers** | `start_process` runs long-lived programs (Minecraft or dev servers) in the background; `process_output` waits for a log line, `send_input` types into the console, `stop_process` kills it. They show under your name in the sidebar and are stopped when the app closes. Logs: `..\data\process-logs`. |
| **Web** | `web_search` (DuckDuckGo) and `web_fetch`, only while the PC is online, asks first. Everything else works offline. Toggle in the tools menu. |
| **Context window** | Each mode's model gets the context size you pick (Ollama's default is too small). The bar next to the mode name shows how full it is; when a chat outgrows it, the oldest tool output is left out of what the model sees, then the oldest turns. The saved chat is never cut. |
| **Memory** | Settings → Local models → Memory. **RAM limit**: the part of a model that does not fit on the graphics card sits in normal RAM; if a loaded model takes more than the limit (measured from Ollama, not guessed), the app unloads it and says so. **Keep the model in memory**: unload right after each answer / 5 min / 30 min / until the app closes. Each mode card also shows a rough "needs about X GB of RAM". |
| **Context size by hand** | The context list of each mode has "Custom…": type any number of tokens (2,048 up to what the model supports). |
| **Set up for this PC** | The app reads the graphics cards (any vendor, real memory size from the driver's registry entry), RAM, CPU and free disk space, and picks a model and context size per mode: Quick has to fit on the card completely, Smart and Coder may reach up to about 2.5 GB into normal RAM, a PC without a usable card (under 3 GB of its own memory) gets small models on the CPU. The dialog shows what it found, lets you change each choice, downloads what is missing and saves a mode only when its model is really installed. It opens by itself only when Ollama or a mode's model is missing, otherwise from Settings → Local models → "Check this PC". The rules are in `src/main/hardware.js` and were calibrated on one measurement (the 9B at 49k on a GTX 1070: 5.4 GB on the card, 2.2 GB in RAM). Only tested on that NVIDIA card; other sizes with faked hardware. |
| **Slow-model hint** | After an answer the app asks Ollama where the model really sits. If it runs completely on the CPU although there is a card, sits more than 60% in RAM, or writes below 6 tokens/s (Quick) or 2.5 tokens/s (Smart, Coder) twice in a row, the chat says so once, names the next smaller model and offers "Check this PC" and "Don't show again". Nothing is switched automatically. |
| **Coder 30B only when installed** | The mode is left out of the mode menu until the colibrì engine folder and a model folder exist. Old chats in that mode keep their name. |
| **Other models** | Settings → Local models: pick any installed Ollama model per mode, its context size, see whether it supports tools / thinking / images and whether it fits on the graphics card, and download new ones. A model without tool support becomes chat-only. |

## Installer

`..\install\install.cmd` opens a small setup window (`install.ps1`, Windows Forms, PowerShell 5.1).

- **Step 1, programs:** installs Ollama and Node.js when missing (winget; Ollama falls back to its own installer), copies the app into the install folder (or downloads the repo from GitHub when it is not run from a checkout), runs `npm ci` and `make-exe`, makes the shortcuts. Optional: Claude Code for the terminal launcher. Chats, settings and notes of an earlier install are left alone.
- **Step 2, models:** asks `scripts\setup-cli.js plan` for the hardware and the choices, so it uses the same rules as the app. One list per mode: the app's models plus anything installed in Ollama already. `setup-cli.js apply` downloads the missing ones through Ollama (they land in Ollama's model folder) and writes the modes into `data\settings.json`. A mode is only saved when its model is there.
- **Coder 30B (optional):** `setup-cli.js coder30` installs Python when missing, downloads colibrì 2.1.0 and the abliterated Qwen3-Coder 30B GGUF (17 GB, resumable) into the two chosen folders, checks both against pinned SHA-256 sums, runs `coli import` and saves the folders in the settings. A file that does not match its checksum is deleted and nothing of it is run.
- `..\install\build-setup-exe.ps1` wraps the two installer files into `install\out\LocalClaudeSetup.exe` with IExpress (192 KB, unsigned, not in git). That exe downloads the app from GitHub, so it only works for a version that is pushed.
- `install.ps1 -SelfTest` builds the window off-screen, prints what it found and changes nothing.
- **Execution policy:** nobody has to run `Set-ExecutionPolicy`. `install.cmd` starts PowerShell with `-ExecutionPolicy Bypass` and sets `PSExecutionPolicyPreference=Bypass`, so the programs it starts (npm, the build script) are covered too; `install.ps1` does the same for itself and clears the "downloaded from the internet" mark on the installed files, which would otherwise block the app's scripts on a PC set to RemoteSigned. All of it applies to that one run; the PC's setting is never changed. A policy enforced by an administrator (Group Policy) is not worked around: the window says so instead.

State on 2026-11-17: the window, the hardware plan and the model lists are checked with the self-test on one PC. A complete install on a clean PC, the winget installs and the Coder 30B download path have not been run yet.

## Files

- `src/main/chat.js` the turn loop (stream, tools, questions, queue, self-check)
- `src/main/ollama.js` server start, per-mode model with context window (`lc-<model>-<N>k`), model list, download
- `src/main/colibri.js` the second engine for Coder 30B: starts and stops `coli.cmd serve`, private key, cleaned environment, log in `..\data\colibri.log`
- `src/main/server.js` the Server mode: SSH tunnel, the model on the other machine's Ollama
- `src/main/hardware.js` reads the hardware and recommends models for it (`recommend()` is a pure function, tested in `test/hardware.test.js`); `src/renderer/setup.js` is the dialog
- `scripts/setup-cli.js` the installer's helper: `plan`, `apply`, `coder30` (plain Node, no Electron)
- `src/main/context.js` trims what is sent to fit the context window
- `src/main/project.js` project notes + Claude memory + system prompt
- `src/main/tools.js`, `processes.js` the tools
- `..\data\` (next to `notes\`): settings.json, config.json (tool rules, MCP servers), conversations, process logs. Not in the Windows AppData folder, so every way of starting the app sees the same chats.

## Testing

No model needed (fake API, about 1 minute):

```
node test/context.test.js
node test/hardware.test.js
node test/fake-api.js 8797 api.jsonl                       (own terminal)
set ASTER_BASE_URL=http://127.0.0.1:8797 & set ASTER_USERDATA=<tmp> & set LOCALCLAUDE_NOTES=<tmp> & set ASTER_TEST_OFFSCREEN=1 & set FAKE_DL=<tmp>\file.bin
node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
node test/drive-local.js api.jsonl <notes tmp> <tmp>\file.bin [screenshot dir]
```

With the real models: start the app the same way without `ASTER_BASE_URL`, then
`node test/drive-real.js "<prompt>" [--model smart|coder|coder30] [--answer "Stay in Quick"] [--timeout 2400]`.

Port 8787 (Aster's test port) is taken by an SSH tunnel on this PC, hence 8797.

## Behaviour notes

- Style: the system prompt asks for a "lazy but accurate senior developer": smallest change that solves the task, no narration, answers of one to three lines, one cheap check per change.
- Chat titles come from the first message, at once (no model call: on a small GPU that would throw away the model's prompt cache and slow the next answer).
- A third identical tool call in one turn is refused with a hint (small models loop when they lose the thread).
- Pictures read with `read_file` reach the model as a copy of at most 896 px and count as a fixed cost in the context estimate.
- Requests use Chromium's network stack (`net.fetch`): Node's fetch cuts a response that is silent for 5 minutes, which a slow model writing one long tool call can exceed.
