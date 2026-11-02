# commandcode-herdr-desktop-mod

Reports a Command Code (`cmd`) session's state to the **Herdr desktop app**
(`herdr-app` + `herdr-core` / `hc`) so the sidebar, notifications, `hc get` and
`hc wait` know whether the agent is idle, working, or waiting on you.

This is a Command Code **mod**. Herdr needs no plugin: it already treats any
terminal whose program emits **OSC 7501** (the Program Status Protocol) as an
agent. The mod writes those reports to Command Code's own TTY on lifecycle
events.

> This does not work with the older standalone `herdr` 0.9.x multiplexer, which
> uses a socket API and a different plugin format instead of OSC 7501.

## Install

As a local mod package, install it at user scope:

```bash
cmd mods add -g ./commandcode-herdr-desktop-mod
```

> `-g` matters: without it, `mods add` uses project scope and fails with
> `No project root found for project-scoped mod settings` when the source
> directory is not a project root.

Or copy the file into your user mods folder:

```bash
sh scripts/install-mod.sh        # ~/.commandcode/mods/herdr-status.ts
pwsh -File scripts/install-mod.ps1   # Windows
```

> On Windows, the Command Code CLI is `cmdc` (or `command-code`); `cmd` is the
> operating system's shell.

Or try it for one session without installing:

```bash
cmd --mod ./mods/herdr-status.ts
```

Restart Command Code (or run `/reload`), then check:

```bash
cmd mods list        # herdr-status
/herdr-status        # inside a session
```

Remove with `sh scripts/install-mod.sh --uninstall`, `pwsh -File
scripts/install-mod.ps1 -Uninstall`, or `cmd mods remove herdr-status`.

## What it reports

| Command Code event | Herdr state | Notes |
|---|---|---|
| session start | `idle` | green checkmark |
| run start, tool running | `working` | |
| permission prompt | `blocked` | `kind=permission` |
| `ask_user_question` / question prompts | `blocked` | `kind=question` |
| run end | `done` | Herdr turns it into `idle` once you look |
| run error | `error` | with the error message |
| interrupt | `idle` | |
| compaction | `working` | `msg=compacting` |

The sidebar app name is `command-code`. Reports are deduplicated, `msg` is a
single base64-encoded line, and the mod is a no-op outside a herdr-core terminal
(`HC_TERMINAL_ID` unset), when stdout is not a TTY, or when `CMD_HERDR_OSC=0`.

## Verify

Start `cmd` in a Herdr desktop terminal, then from a shell:

```bash
hc get <terminal>     # "status": {"app": "command-code", "state": "working"}
hc wait <terminal>    # waits until the current turn finishes
```

The sidebar agent list should show `command-code` with the matching state.

## How it works

The mod emits one OSC 7501 sequence per state change:

```
ESC ] 7501 ; state=working:app=command-code:msg=<base64> ESC \
```

Herdr parses it from the pty, so it works locally, over SSH, and inside
containers without any environment variables beyond `HC_TERMINAL_ID`.

No resume command is reported: the desktop core keeps terminals alive itself,
and OSC 7501 has no resume field.

## Test

```bash
npm test
```

Requires Node 22.6+ (the test imports the TypeScript mod directly; Node 23.6+
needs no flag).

## Layout

| File | Role |
|---|---|
| `mods/herdr-status.ts` | The Command Code mod |
| `scripts/install-mod.sh` | Loose-file install/remove (POSIX) |
| `scripts/install-mod.ps1` | Loose-file install/remove (Windows) |
| `tests/mod.test.mjs` | Protocol encoding and lifecycle wiring tests |
| `package.json` | `cmd mods add` package manifest |
