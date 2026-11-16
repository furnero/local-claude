# Local Claude in the terminal

Claude Code driven by a local model in Ollama: offline, on the GTX 1070, no Claude
app and no Anthropic login needed. It has the usual tools (PowerShell, Read, Edit,
Write, Glob, Grep), so it can SSH, create/edit/delete files and check connections.
It asks before each command or file write.

It is **not** Claude. The models are Qwen 3.5 9B and 4B. Expect them to handle clear,
bounded tasks; long or vague jobs go wrong much more often than with Claude.

## Two ways to use it

- **Chat app** (like the Claude app, with visible thinking): `app\dist\LocalClaude\LocalClaude.exe`,
  also in the Start menu under My Projects. Details in [app/README.md](app/README.md).
- **Terminal** (Claude Code driven by the local model): the launcher below.

Both share the notes in `notes\` and read Claude's memory read-only.

## Start (terminal)

Open any terminal (Windows Terminal, PowerShell, cmd) in the folder you want to work in:

```
"D:\VSCode Projects\LocalClaude\local-claude.cmd"            quick mode
"D:\VSCode Projects\LocalClaude\local-claude.cmd" --smart    smart mode
```

| Option | What it does |
|---|---|
| `--smart` | 9B model + careful working method + mandatory notes upkeep |
| `--project <name>` | use the notes (and Claude memory) of a named project, e.g. `--project pango` |
| `--local-model <name>` | any other Ollama model |
| `--no-memory` | load neither Claude memory nor own notes |
| `-p "question"` | one-shot answer (any other `claude` flag works too) |

Plain chat without tools: `ollama run local-agent`.

## The two modes

| | quick (default) | smart (`--smart`) |
|---|---|---|
| model | `local-agent-4b` (Qwen 3.5 4B) | `local-agent` (Qwen 3.5 9B) |
| speed on the 1070 | ~37 tokens/s, fully on GPU | ~12 tokens/s, ~30% runs on CPU |
| method | answers directly | reads notes first, plans, one step at a time, verifies each step, checks before "done" |
| notes | updates when something important happens | must update at the end of every task |

Both think before answering (Qwen's reasoning mode is on).

## Memory

**Own notes (read + write).** One file per project in `notes\`, named like Claude
Code's project folders (`D--VSCode-Projects-pango.md` = the `pango` folder), so they
line up with the Claude project of the same folder. Sections: Status, Done, Open,
Needs fixing, Facts and decisions. The launcher creates the file, loads it into the
prompt at start, and the model may edit its notes without asking. When you mention a
project or problem, it searches its notes and Claude's memory and tells you what is
done / open / broken before starting. With `--project <name>` you pick the project
explicitly; a name that matches no Claude project starts a notes file of its own.

**Claude memory (read-only).** The `MEMORY.md` index of the nearest Claude project
memory (else the main `D--VSCode-Projects` one) goes into the prompt with full paths,
and the model reads single notes when a topic comes up. A deny rule blocks every
write under `~/.claude`, shell redirects included, so the local model cannot
change Claude's memory.

## What the launcher does

1. Starts `ollama serve` if it is not running.
2. Builds `local-agent` / `local-agent-4b` from `Modelfile` / `Modelfile-4b` on first
   use (49k context window; Ollama's default is too small for Claude Code).
3. Picks the project, creates the notes file, writes the extra system prompt.
4. Starts `claude --safe-mode` against `http://127.0.0.1:11434`: no plugins, hooks,
   CLAUDE.md files, skills or MCP servers (a small model gets lost in long tool
   lists), permission mode `manual`, telemetry and update checks off.

## Notes

- First answer of a session takes longer (model load, about 10-15 s).
- The "cost" Claude Code prints is its own estimate at Anthropic prices; nothing is
  billed, every request goes to Ollama on 127.0.0.1.
- Permission mode is forced to `manual` unless you pass `--permission-mode` yourself.
  Auto mode would let the local model judge its own commands.
- Other models: pull one with tool support, write a Modelfile with
  `PARAMETER num_ctx 49152`, `ollama create <name> -f <file>`, start with
  `--local-model <name>`.
