# Local Claude

A chat app and a terminal agent that run completely on my own PC, without internet.

It looks and works a lot like the Claude app, but there is no Claude in it. Claude's weights are not public, so this runs open models (mostly Qwen) through Ollama and gives them the same kind of tools: a terminal, file access, downloads, background processes, notes. Not affiliated with Anthropic, the name only says what I wanted it to be.

I built it for a GTX 1070 with 8 GB, 16 GB of RAM and a Ryzen 5 5500, so everything is tuned for old hardware. Windows only.

## What is in here

`app/` is the chat app (Electron). You see the model think, tool calls ask before they run, and you can send more messages while it is still working.

`local-claude.cmd` starts Claude Code in the terminal, pointed at Ollama instead of Anthropic. More about that in [LAUNCHER.md](LAUNCHER.md).

Both use the same notes folder, so what one of them wrote down the other one can read.

## Modes

| Mode | Model | Speed on the 1070 |
|---|---|---|
| Quick | Qwen 3.5 4B | about 37 tokens/s |
| Smart | Qwen 3.5 9B | 5 to 12 tokens/s |
| Coder | OmniCoder 9B, abliterated | about 11 tokens/s |
| Coder 30B | Qwen3-Coder 30B, abliterated | 1 to 2 tokens/s |

Quick checks if a task is too big for it and asks if you want to switch to Smart. Smart and the Coder modes make a plan, check their own work before they say done and write notes about it.

Coder 30B does not fit on the card at all. It runs through [colibrì](https://github.com/JustVugg/colibri), which keeps part of the model on the GPU and reads the rest from the SSD while it works. The first answer of a chat takes 7 to 10 minutes because it has to read all the instructions first, after that answers start within seconds. It is the smartest of the four and you need patience for it.

That table is what my PC gets. The app looks at your graphics card and RAM and picks models that fit yours: 27B models on a 24 GB card, the 9B completely on the card with 12 GB, small ones on the CPU if there is no card. You see what it found and what it would download, and you can change every choice before anything happens. Later it is under Settings, Local models, "Check this PC".

The pick is a guess from the hardware. If a model then turns out to sit mostly in RAM or to crawl, the chat tells you once and names a smaller one. It never switches by itself.

I could only test this on my own NVIDIA card. AMD and Intel cards are detected, but if Ollama actually uses them is up to Ollama.

You can still put any other Ollama model on a mode in the settings, with its own context size.

## Setup

Windows 10 or 11.

The easy way is the installer: download this repo and double click `install\install.cmd`. It installs Ollama and Node.js if they are missing (with winget), builds the app into `%LOCALAPPDATA%\LocalClaude` and makes a Start menu shortcut. Then it shows your hardware and one list per mode with the models it knows plus whatever you already have in Ollama, the recommended one preselected. What you pick is downloaded straight into Ollama's model folder. Coder 30B is a checkbox there too, with its own two folders.

You do not have to allow PowerShell scripts in Windows for any of this. The installer, the build and the launcher lift that limit for their own run only and leave the setting alone.

By hand it is Node.js, a recent Ollama (it has to offer the Anthropic style `/v1/messages` endpoint, I use 0.33) and:

```
cd app
npm install
npm start
```

If PowerShell answers "running scripts is disabled" to `npm`, type `npm.cmd` instead or use the normal Command Prompt.

On the first start the app checks the hardware and offers to download the models it picked. If you would rather pull them yourself, these are the ones for an 8 GB card:

```
ollama pull qwen3.5:4b
ollama pull qwen3.5:9b
ollama pull huihui_ai/qwen3.5-abliterated:9b-OmniCoder
```

`npm run make-exe` builds `app\dist\LocalClaude\LocalClaude.exe` if you want a normal program instead.

The terminal launcher also needs Claude Code installed. No login needed, the requests go to Ollama on the same PC.

Coder 30B is optional and more work: Python 3, the colibrì release unpacked somewhere, and a Qwen3-Coder 30B model for it (about 18 GB). The mode only shows up once both are there. The folders are set in Settings, Local models. The defaults are `D:\colibri` and `D:\colibri-models\qwen3-coder-30b-abliterated` because that is where mine are.

## Memory

The model keeps one notes file per project in `notes\` with what is done, what is open and what is broken, and reads it back when you mention the project again.

If you use Claude Code, it can also read that project's Claude memory. Read only, every write under `~/.claude` is blocked.

`notes\` and `data\` (chats, settings) are not in this repo.

## Things to know

These are small models. Clear tasks with a clear end work fine. Long or vague ones go wrong a lot more often than with the real thing.

It asks before every command and every file write, unless you allow a tool permanently.

Web search only works while the PC is online. Everything else runs on the PC itself.

Coder 30B reads the whole chat again after you press Stop in the middle of an answer or switch to another chat. So let it finish.

## Tests

```
cd app
node test/context.test.js
node test/hardware.test.js
```

The bigger test drives the real app against a fake API, so it needs no model. How to run it is in [app/README.md](app/README.md), along with the rest of the details about the app.

## Built with

Ollama, the Qwen models, the abliterated builds by huihui-ai, colibrì, Electron, the Anthropic SDK (only as the client for the local endpoint), marked, highlight.js and KaTeX. The app started as a copy of Aster, my Claude app look-alike for the API.

## License

MIT, see [LICENSE](LICENSE). The libraries and fonts bundled in `app/src/renderer/vendor` keep their own licenses.
