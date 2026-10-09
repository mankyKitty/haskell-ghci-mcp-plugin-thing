#!/usr/bin/env node
/**
 * A tiny GHCi impostor for tests that must run without GHC installed.
 *
 * Emulates just enough: a default prompt, `:set prompt` / `:set prompt-cont`
 * (with Haskell-string escapes), `:{ ... :}` continuation prompts, a few
 * canned commands, slow commands (for timeout tests), SIGINT handling, and
 * `:quit`. Startup delay and startup banner are configurable via env.
 */
import { createInterface } from "node:readline";

const out = (s) => process.stdout.write(s);
let prompt = "ghci> ";
let promptCont = "ghci| ";
let block = null; // array of lines while inside :{ :}
let busy = null; // timer for a "slow" command
let loadFailing = process.env.FAKE_GHCI_FAIL_RELOAD === "1";

const startupDelay = Number(process.env.FAKE_GHCI_STARTUP_MS ?? 0);
if (process.env.FAKE_GHCI_CRASH === "1") {
  process.stderr.write("fake-ghci: cannot start, boom\n");
  process.exit(3);
}

function unescapeHs(s) {
  // handles \n, \t, \\, \" - enough for prompt strings
  return s.replace(/\\(n|t|\\|")/g, (_, c) => ({ n: "\n", t: "\t", "\\": "\\", '"': '"' })[c]);
}

function handle(line) {
  if (block) {
    if (line.trim() === ":}") {
      const body = block.join("\n");
      block = null;
      out(`defined ${body.split("\n").length} line(s)\n`);
      return out(prompt);
    }
    block.push(line);
    return out(promptCont);
  }
  const t = line.trim();
  let m;
  if (t === ":{") {
    block = [];
    return out(promptCont);
  }
  if ((m = /^:set prompt "(.*)"$/.exec(t))) {
    prompt = unescapeHs(m[1]);
    return out(prompt);
  }
  if ((m = /^:set prompt-cont "(.*)"$/.exec(t))) {
    promptCont = unescapeHs(m[1]);
    return out(prompt);
  }
  if (t === ":quit" || t === ":q") {
    out("Leaving GHCi.\n");
    process.exit(0);
  }
  if (t === ":reload" || t === ":r") {
    if (loadFailing) {
      out(
        "[1 of 2] Compiling Lib              ( src/Lib.hs, interpreted )\n\n" +
          "src/Lib.hs:7:11: error: [GHC-83865]\n" +
          "    • Couldn't match expected type ‘Int’ with actual type ‘[Char]’\n" +
          "    • In the expression: \"oops\"\n" +
          "      In an equation for ‘answer’: answer = \"oops\"\n" +
          "  |\n" +
          "7 | answer = \"oops\"\n" +
          "  |           ^^^^^^\n" +
          "Failed, one module loaded.\n",
      );
    } else {
      out("[2 of 2] Compiling Main             ( app/Main.hs, interpreted )\nOk, two modules loaded.\n");
    }
    return out(prompt);
  }
  if ((m = /^:t(?:ype)? (.*)$/.exec(t))) {
    out(`${m[1]} :: Int -> Int\n`);
    return out(prompt);
  }
  if ((m = /^:sleep (\d+)$/.exec(t))) {
    // simulate a long-running evaluation; SIGINT aborts it like GHCi would
    busy = setTimeout(() => {
      busy = null;
      out("slept\n");
      out(prompt);
    }, Number(m[1]));
    return;
  }
  if (t === ":fail") {
    loadFailing = true;
    return out(prompt);
  }
  if (t === ":unfail") {
    loadFailing = false;
    return out(prompt);
  }
  if (t === "noeol") {
    out("no trailing newline"); // output without a newline - prompt's leading \n must handle this
    return out(prompt);
  }
  if (t === "stderr") {
    process.stderr.write("to stderr\n");
    return out(prompt);
  }
  if (t === "") return out(prompt);
  out(`${t} evaluated\n`);
  out(prompt);
}

process.on("SIGINT", () => {
  if (busy) {
    clearTimeout(busy);
    busy = null;
    out("Interrupted.\n");
    out(prompt);
  } else if (block) {
    block = null;
    out(prompt);
  } else {
    out(prompt);
  }
});

const queue = [];
let ready = false;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (l) => {
  if (!ready || busy) queue.push(l);
  else handle(l);
});
rl.on("close", () => process.exit(0));

// drain queued lines when a slow command finishes
const origOut = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...a) => {
  const r = origOut(chunk, ...a);
  if (ready && !busy && queue.length && String(chunk).endsWith(prompt)) {
    setImmediate(() => {
      if (!busy && queue.length) handle(queue.shift());
    });
  }
  return r;
};

setTimeout(() => {
  out("GHCi, version 9.9.9: https://www.haskell.org/ghc/  :? for help\n");
  if (process.env.FAKE_GHCI_BANNER) out(process.env.FAKE_GHCI_BANNER + "\n");
  out("Ok, two modules loaded.\n");
  out(prompt);
  ready = true;
  while (queue.length && !busy) handle(queue.shift());
}, startupDelay);
