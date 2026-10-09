# ghci-mcp

A long-lived GHCi session for Claude (or any MCP agent), so it can typecheck,
query types, evaluate code and run tests in milliseconds instead of running
`cabal build` for every change.

```
┌──────────────┐   stdio   ┌──────────────┐  unix socket  ┌──────────────────────────┐
│ Claude Code  │ ◄───────► │ ghci-mcp mcp │ ◄───────────► │ ghci-mcp serve -- <cmd>  │
│ (any agent)  │           │ (thin client)│               │   owns: cabal repl / ghci │
└──────────────┘           └──────────────┘               └──────────────────────────┘
                                                             runs in YOUR terminal
```

## Design in one paragraph

GHCi is expensive to start and agents are bad at managing long-running
processes, so the session lives **outside** the agent. You start it in a
terminal with whatever command your project needs (`cabal repl lib:foo`,
`stack repl`, `nix develop -c cabal repl`, `make repl`...), and `ghci-mcp serve`
wraps it: it installs a unique prompt sentinel, serialises commands, and
listens on a Unix socket under `~/.cache/ghci-mcp/`. The MCP server is a stateless
client of that socket. It can be restarted freely, several agents can share one
session, and if there is no session it tells the agent exactly what to ask you
to run. For projects where that's fine, it can also start the daemon in the
background for you (`ghci_start`), using the command from `ghci-mcp.json`.

No pty, no native dependencies: GHCi behaves well over pipes (no readline, no
colour codes, prompt still printed). stderr is merged at the fd level so
diagnostics and program output stay in order. Ctrl-C semantics are preserved by
sending SIGINT to the process group, which is exactly what a terminal does.

## Install (once, outside any project)

ghci-mcp isn't published to npm; build it from a checkout of this repo. It
needs Node ≥ 20 on your PATH and nothing else: it does **not** go into your
Haskell project's dependencies, `.cabal` file, `stack.yaml` or Nix flake.

```sh
cd ~/src/ghci-mcp          # wherever you cloned this repo
npm install && npm run build
npm link                   # optional: puts `ghci-mcp` on your PATH
```

Without `npm link`, use `node ~/src/ghci-mcp/dist/cli.js` wherever these docs
say `ghci-mcp`.

## Use it in an existing Haskell project

Nothing has to be added to the project. Three steps:

**1. Register the MCP server with Claude Code, once, for all projects:**

```sh
claude mcp add --scope user ghci -- node ~/src/ghci-mcp/dist/cli.js mcp
cp -r ~/src/ghci-mcp/skills/ghci ~/.claude/skills/   # the workflow skill (recommended)
```

Or load the checkout as a plugin instead, which brings the server and the
skill together: `claude --plugin-dir ~/src/ghci-mcp`.

**2. Start a session in the project, with the project's own toolchain.** Use
whatever command you'd normally run to get a REPL; ghci-mcp runs it via
`sh -c` and wraps it:

```sh
cd my-haskell-project
ghci-mcp serve -- cabal repl lib:my-project
ghci-mcp serve -- stack repl
ghci-mcp serve -- nix develop -c cabal repl   # the project's Nix shell provides GHC; ghci-mcp stays outside it
```

Run `serve` from a shell that has Node. If you usually work inside the
project's `nix develop` shell and it has no Node, run `serve` from outside it
with `nix develop -c ...` as above.

**3. Open Claude Code in the project directory.** The MCP server finds the
session through the socket at `~/.cache/ghci-mcp/<project>-<hash>/default.sock`. If no
session is running, the tools tell the agent the exact `serve` command to ask
you for.

### Keeping the project untouched

- **No config file needed.** Give the command on the `serve` line. Without a
  `ghci-mcp.json`, `ghci_start` / `ghci-mcp start` guess `stack repl` if there
  is a `stack.yaml`, else `cabal repl`.
- **Runtime state** (socket, logs) goes in
  `~/.cache/ghci-mcp/<project>-<hash>/` (`$XDG_CACHE_HOME` if set), never in
  the project. To keep a `ghci-mcp.json` out of git without editing the
  project's `.gitignore`: `echo ghci-mcp.json >> .git/info/exclude`.

## Configuration (optional)

Only needed for multiple sessions, `init` commands, a test command, or to let
the agent start the session itself with `ghci_start`.

```sh
cd my-haskell-project
ghci-mcp init          # writes ghci-mcp.json with a guessed command
```

`ghci-mcp.json`:

```json
{
  "sessions": {
    "default": {
      "command": "cabal repl lib:my-project",
      "testCommand": ":main",
      "init": [":set -Wall"]
    },
    "test": {
      "command": "cabal repl test:spec",
      "testCommand": ":main"
    }
  }
}
```

Shorthand for a single session: `{ "command": "stack repl" }`.

| key                | meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `command`          | shell command that starts GHCi. Anything goes; it runs via `sh -c`.        |
| `cwd`              | working dir for the command, relative to the project root                  |
| `init`             | GHCi commands run once the prompt appears                                  |
| `testCommand`      | what `ghci_run_tests` sends (default `:main`)                              |
| `startupTimeoutMs` | how long to wait for the first prompt (default 10 min)                     |
| `commandTimeoutMs` | default per-command timeout; commands are interrupted past it (default 5 min) |
| `env`              | extra environment variables for GHCi                                       |

The project root is the nearest ancestor directory with a `ghci-mcp.json`
(falling back to `cabal.project`/`stack.yaml`, then `hie.yaml` or a `.cabal` file).
If no ancestor matches (e.g. Claude runs at a git root with the Haskell project
in a subdirectory), the single subdirectory within two levels that has a
`ghci-mcp.json`, `cabal.project` or `stack.yaml` is used. The daemon and the MCP
server must agree on the root, since the socket path is derived from it. Set
`GHCI_MCP_ROOT` to override.

## Start a session

In a terminal, in the project:

```sh
ghci-mcp serve                                 # configured command, else guessed (stack/cabal repl)
ghci-mcp serve -- cabal repl lib:my-project    # or give the command explicitly
ghci-mcp serve --session test -- cabal repl test:spec
```

You'll see GHCi's startup output, then a log line every time the agent sends a
command along with GHCi's reply. The terminal still works as a REPL: lines you
type go to the same GHCi through the same queue. Ctrl-C interrupts the current
command; Ctrl-C while idle quits.

Background alternative (what the `ghci_start` tool does):

```sh
ghci-mcp start --wait        # log in ~/.cache/ghci-mcp/<project>-<hash>/default.log
ghci-mcp status
ghci-mcp stop
```

Handy from scripts and editors:

```sh
ghci-mcp send ':t traverse'
ghci-mcp reload              # exit code 1 if the reload failed
```

## The skill

`skills/ghci/SKILL.md` teaches the agent the workflow: reload after every
edit, ask `:type`/`:info`/`:browse` instead of guessing APIs, never fall back
to `cabal build`, never start a second session. Claude Code starts MCP servers
in the project directory, which is how the server finds the project root and
the socket.

## Tools

| tool                | GHCi                 | notes                                                        |
| ------------------- | -------------------- | ------------------------------------------------------------ |
| `ghci_status`       | -                    | ready/busy/exited, startup output tail                       |
| `ghci_start`        | -                    | start the daemon detached (configured or explicit command)   |
| `ghci_stop`         | `:quit`              |                                                              |
| `ghci_interrupt`    | Ctrl-C               | aborts the running evaluation, keeps the session             |
| `ghci_reload`       | `:reload`            | structured diagnostics: file/line/col/severity/code/message  |
| `ghci_load`         | `:add` / `:load`     | add new files/modules                                        |
| `ghci_eval`         | expression or any raw GHCi command | multi-line input is wrapped in `:{ :}`         |
| `ghci_type`         | `:type`              |                                                              |
| `ghci_type_default` | `:type +d`           |                                                              |
| `ghci_info`         | `:info`              |                                                              |
| `ghci_kind`         | `:kind!`             |                                                              |
| `ghci_browse`       | `:browse`            |                                                              |
| `ghci_doc`          | `:doc`               |                                                              |
| `ghci_run_tests`    | `testCommand`        | parses hspec and tasty summaries into pass/fail              |

Every tool takes an optional `session` (default `"default"`); the ones that
run code take `timeoutMs`.

## How the wrapper talks to GHCi

On start it sends

```
:set prompt      "\n<<ghci-mcp:xxxxxxxx>>\n"
:set prompt-cont "<<ghci-mcp-cont:xxxxxxxx>>\n"
```

so every prompt is an unambiguous line. A command's output is everything up to
the next sentinel. The leading `\n` in the prompt terminates output that lacks
a trailing newline. For multi-line input GHCi prints one continuation prompt
per line; if it prints more continuation prompts than lines sent, the input was
incomplete and the wrapper interrupts and reports that instead of hanging.

The socket protocol is newline-delimited JSON (`src/protocol.ts`): `run`,
`status`, `interrupt`, `shutdown`.

## Nix (developing ghci-mcp itself)

Not needed to *use* ghci-mcp in a project; see above.

```sh
nix develop            # node 22, ghc, cabal, HLS
nix build              # ./result/bin/ghci-mcp
nix run . -- status
nix flake check        # runs the test suite against a real ghci
```

The first `nix build` fails with a hash mismatch: copy the `got:` value into
`npmDepsHash` in `flake.nix`. Repeat whenever `package-lock.json` changes.
`.envrc` is set up for direnv.

## Development

```sh
npm install
npm test          # builds, then runs vitest; uses real ghci if on PATH, else test/fake-ghci.mjs
npm run dev -- serve -- ghci   # run from source
```

`test/fake-ghci.mjs` is a small GHCi impostor (prompt handling, `:{ :}`,
slow commands, SIGINT) so the suite runs on machines without GHC.

## Known gaps / next

- Verified against plain `ghci` and GHC 9.4 text diagnostics; `cabal repl` and
  `stack repl` should behave identically (same stdin/stdout, same Ctrl-C group
  semantics) but need a real-project shakedown.
- `-fdiagnostics-as-json` (GHC ≥ 9.8) could replace the text parser.
- Windows is untested (Unix sockets and process groups).
- `ghci_run_tests` only recognises hspec and tasty summaries.
