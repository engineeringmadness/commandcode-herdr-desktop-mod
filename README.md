# commandcode-herdr-desktop-mod

Reports a Command Code (`cmd`) session's state to the **Herdr desktop app**
(`herdr-app` + `herdr-core` / `hc`) so the sidebar, notifications, `hc get` and
`hc wait` know whether the agent is idle, working, or waiting on you.
Sub-agents (`explore`, `code review`, and any other `agent` tool run) are
published as child records under the session's record.

This is a Command Code **mod**. Herdr needs no plugin: it already treats any
terminal whose program emits **OSC 7501** (the Program Status Protocol) as an
agent. The mod writes those reports to Command Code's own TTY on lifecycle
events.

> This does not work with the older standalone `herdr` 0.9.x multiplexer, which
> uses a socket API and a different plugin format instead of OSC 7501.

## Install

As a local mod package, install it at user scope:

```bash
command-code mods add -g ./commandcode-herdr-desktop-mod
```

> `-g` matters: without it, `mods add` uses project scope and fails with
> `No project root found for project-scoped mod settings` when the source
> directory is not a project root.

Or copy the file into your user mods folder:

```bash
sh scripts/install-mod.sh        # ~/.commandcode/mods/herdr-status.ts
pwsh -File scripts/install-mod.ps1   # Windows
```

> `command-code` works on every platform. The POSIX alias is `cmd`; on Windows
> `cmd` is the operating system's shell, so use `cmdc` or `command-code` there.

Or try it for one session without installing:

```bash
command-code --mod ./mods/herdr-status.ts
```

Restart Command Code (or run `/reload`), then check:

```bash
command-code mods list   # herdr-status
/herdr-status            # inside a session
```

Remove with `sh scripts/install-mod.sh --uninstall`, `pwsh -File
scripts/install-mod.ps1 -Uninstall`, or `command-code mods remove herdr-status`.

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
| sub-agent start | `working` | child record `subagents/<key>`, `title=<type>` |
| sub-agent progress | `working` | `msg=<current tool>` |
| sub-agent stop | `done` / `error` | `msg=<tokens>`; a failed run is `error` |
| session end / reload | `clear` | removes the session record and its children |

The sidebar app name is `command-code`. Reports are deduplicated, `msg` is a
single base64-encoded line, and the mod is a no-op outside a herdr-core terminal
(`HC_TERMINAL_ID` unset), when stdout is not a TTY, or when `CMD_HERDR_OSC=0`.

The mod does not send the protocol's `ESC ] 7501 ; ?` support probe: herdr-core
accepts reports without it, and reading stdin for the reply would contend with
the TUI's input handling.

## Sub-agents

The `agent` tool's nested runs (`explore`, `code review`, and any custom agent)
are separate 7501 records below the session's root record:

```
ESC ] 7501 ; state=working:app=command-code:id=subagents/<key>:title=<base64 type>:msg=<base64> ESC \
```

The key is a stable 12-hex hash of the tool call id, so progress and stop
reports replace the same record. `title` is the sub-agent type; `msg` is its
task description, then its current tool, then its token count. A failed
sub-agent reports `error`; one moved to the background keeps `working` until it
settles. Clearing the session root removes every child record too.

Herdr-core stores these under `records` in `hc get` / `hc ls --json`, nested by
the `subagents/...` id.

The shipped agents pane in Herdr app 0.1.16 builds sub-agent rows from herdr-core
child terminals, not from 7501 records. To draw them in the pane, install the
companion below.

## Herdr app companion

The companion clones Herdr's shipped agents mod, patches the clone to render
`subagents/...` records under the terminal that reported them, clones the main
layout, and switches to that layout:

```bash
sh scripts/install-herdr-app.sh            # macOS / Linux
pwsh -File scripts/install-herdr-app.ps1   # Windows
```

It creates `mods/agents-records` and `layouts/main-records.json` in
`~/.config/herdr-app` (or `$HERDR_APP_HOME`). Your original `mods/agents` and
`main` layout stay untouched; switch back with `ctrl-shift-l` or
`herdr-app do layout.switch --name main`. Remove it with `--uninstall` /
`-Uninstall`.

Clicking a sub-agent row opens a small details popup with its state, current
tool, and token count, plus a **Focus Command Code** button. Sub-agents run
in-process, so there is no separate terminal to open; the popup focuses the
terminal hosting them.

The patch targets the agents mod shipped with Herdr app 0.1.16. If Herdr changes
that file, the installer stops with the name of the section it could not patch
instead of writing a half-patched view.

## Verify

Start `command-code` in a Herdr desktop terminal, then from a shell:

```bash
hc get <terminal>     # "status": {"app": "command-code", "state": "working"}
hc wait <terminal>    # waits until the current turn finishes
```

The sidebar agent list should show `command-code` with the matching state.
While a sub-agent runs, `hc get` also shows its child record:

```json
"records": {
  "subagents/1a2b3c4d5e6f": {
    "state": "working",
    "app": "command-code",
    "title": "explore",
    "msg": "find the handler"
  }
}
```

## How it works

The mod emits one OSC 7501 sequence per state change:

```
ESC ] 7501 ; state=working:app=command-code:msg=<base64> ESC \
```

A sub-agent report adds `id=subagents/<key>` and `title=<base64 type>`, so it
replaces only that child record.

Herdr parses it from the pty, so it works locally, over SSH, and inside
containers without any environment variables beyond `HC_TERMINAL_ID`.

No resume command is reported: the desktop core keeps terminals alive itself,
and OSC 7501 has no resume field.

## Test

```bash
npm test
```

Requires Node 22.6+ (the test imports the TypeScript mod directly; Node 23.6+
needs no flag). There is no standalone typecheck: `@commandcode/harness` ships
inside the CLI and is not published to npm, so the harness types are only
available at load time.

## Layout

| File | Role |
|---|---|
| `mods/herdr-status.ts` | The Command Code mod |
| `scripts/install-mod.sh` | Loose-file install/remove (POSIX) |
| `scripts/install-mod.ps1` | Loose-file install/remove (Windows) |
| `scripts/install-herdr-app.sh` | Herdr app companion install/remove (POSIX) |
| `scripts/install-herdr-app.ps1` | Herdr app companion install/remove (Windows) |
| `scripts/patch-agents-mod.mjs` | Adds record rows to the cloned Herdr agents mod |
| `scripts/patch-herdr-layout.mjs` | Points the cloned layout at `agents-records` |
| `tests/mod.test.mjs` | Protocol encoding and lifecycle wiring tests |
| `package.json` | `cmd mods add` package manifest |
