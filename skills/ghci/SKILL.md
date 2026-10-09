---
name: ghci
description: Work on Haskell code using the project's live GHCi session (ghci_* tools) for typechecking, type queries, evaluation and tests instead of cabal build / stack build. Use whenever editing, debugging or exploring Haskell in a project that has a ghci-mcp session or a ghci-mcp.json.
---

# Haskell via GHCi

You have a long-lived GHCi session for this project, exposed as `ghci_*` tools.
GHCi already has every module loaded and recompiles only what changed, so a
`ghci_reload` takes milliseconds to seconds where `cabal build` takes minutes.
Use it as your primary feedback loop.

## The loop

1. `ghci_status` once at the start (and whenever a tool reports no session).
   If no session is running, tell the user the exact `ghci-mcp serve` command
   the error message gives you and wait, or call `ghci_start` if the project
   has a configured command and the user is fine with that. GHCi startup is
   expensive; never start a second session, never stop one you did not start,
   and never fall back to `cabal build`/`stack build` just because a reload
   failed - a failed reload *is* the answer you wanted.
2. Edit the file. Save it.
3. `ghci_reload`. Read the structured diagnostics (file, line, column,
   message). Fix the first error, reload again. Repeat until `OK`.
4. Verify behaviour with `ghci_eval` (small expressions against your new code)
   and `ghci_run_tests` when the session has the test target loaded.

## Before writing code, ask GHCi instead of guessing

Haskell is unforgiving about exact types, and your memory of library APIs is
unreliable. These are cheap and should be used constantly:

- `ghci_type` - the inferred type of any expression (`foldr`, `Map.insertWith`,
  `traverse_ print`). Check the type of what you are *about* to call.
- `ghci_info` - the definition, constructors, class methods, instances and
  fixity of a name. Use it to see what instances exist before writing one.
- `ghci_browse` - every export of a module, with types. Use it to discover
  what the project's own modules offer and what a library module is called.
- `ghci_kind` - the kind of a type, with type families reduced.
- `ghci_doc` - Haddock docs when available.

If a name is not in scope in GHCi, the module is not imported in the
interactive scope: `ghci_eval` with `import qualified Data.Map.Strict as Map`
or `:module +*MyProject.Internal` (the `*` gives access to unexported names).

## Evaluating and defining things

- `ghci_eval` runs an expression or statement. IO actions execute; pure
  values are printed via `Show`. Multi-line input (function definitions, data
  declarations, `let` blocks) is wrapped in `:{ :}` for you.
- Definitions made in `ghci_eval` live only in the session and are discarded
  on `ghci_reload`. Treat them as scratch; real code goes in files.
- Need an extension or flag interactively? `ghci_eval` with
  `:set -XOverloadedStrings`, `:set -Wall`, etc.
- A runaway evaluation is interrupted automatically at `timeoutMs`; use
  `ghci_interrupt` if you need to stop something earlier. Interrupting does
  not lose the session.

## Tests

`ghci_run_tests` runs the configured test command (default `:main`) inside
GHCi and parses hspec/tasty summaries. Pass `args` to focus:
hspec `-m "Module.name"` / `--match`, tasty `-p '/pattern/'`. If the session
was started on the library target only, the test modules may not be loaded;
ask the user whether there is a `test` session (`session: "test"`) or
whether to start one, rather than running `cabal test`.

## Interpreting diagnostics

- `status: failed` with errors: fix in source order; later errors are often
  consequences of the first.
- Warnings do not fail a reload but the user may have `-Werror` in their real
  build, so fix warnings in code you touched.
- `UNKNOWN STATUS`: GHCi printed something unexpected; read the raw output.
- `not_ready`: GHCi is still starting; `ghci_status` shows the startup tail.
  Wait and retry rather than starting anything.
- New files are usually picked up by `ghci_reload` when they are part of the
  cabal/stack target. If not, `ghci_load` with `mode: "add"` and the path.

## What not to do

- Don't run `cabal build`, `stack build`, `cabal repl` or `ghci` yourself in a
  shell while a session exists. It is slow, duplicates work, and can fight the
  session over build artefacts.
- Don't call `ghci_stop` unless the user asks or the session is wedged
  (`ghci_status` says exited, or every command times out even after
  `ghci_interrupt`).
- Don't paste large programs into `ghci_eval`; write them to a file and reload.
