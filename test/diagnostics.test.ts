import { describe, expect, it } from "vitest";
import { parseLoadOutput, parseDiagnostics } from "../src/diagnostics.js";

const failed = `[1 of 3] Compiling Lib              ( src/Lib.hs, interpreted )

src/Lib.hs:7:11: error: [GHC-83865]
    • Couldn't match expected type ‘Int’ with actual type ‘[Char]’
    • In the expression: "oops"
      In an equation for ‘answer’: answer = "oops"
  |
7 | answer = "oops"
  |           ^^^^^^

src/Lib.hs:3:1: warning: [-Wunused-imports]
    The import of ‘Data.List’ is redundant
      except perhaps to import instances from ‘Data.List’
    To import instances alone, use: import Data.List()
  |
3 | import Data.List
  | ^^^^^^^^^^^^^^^^
Failed, one module loaded.`;

const spanned = `src/Foo.hs:(12,5)-(14,20): error: [GHC-39999]
    • No instance for ‘Show (a -> b)’ arising from a use of ‘print’
   |
12 |     print id
   |     ^^^^^^^^
Failed, no modules loaded.`;

describe("parseLoadOutput", () => {
  it("parses a failed reload with error + warning", () => {
    const s = parseLoadOutput(failed);
    expect(s.status).toBe("failed");
    expect(s.modulesLoaded).toBe(1);
    expect(s.compiled).toEqual([{ module: "Lib", file: "src/Lib.hs" }]);
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);

    const [err, warn] = s.diagnostics;
    expect(err).toMatchObject({ file: "src/Lib.hs", line: 7, column: 11, severity: "error", code: "GHC-83865" });
    expect(err!.message).toContain("Couldn't match expected type ‘Int’");
    expect(err!.message).not.toContain("|"); // snippet gutter stripped
    expect(err!.message.startsWith("•")).toBe(true); // de-indented
    expect(err!.raw).toContain('7 | answer = "oops"');

    expect(warn).toMatchObject({ file: "src/Lib.hs", line: 3, column: 1, severity: "warning", code: "-Wunused-imports" });
    expect(warn!.message).toContain("redundant");
  });

  it("parses multi-line spans and 'no modules loaded'", () => {
    const s = parseLoadOutput(spanned);
    expect(s.status).toBe("failed");
    expect(s.modulesLoaded).toBe(0);
    expect(s.diagnostics[0]).toMatchObject({ line: 12, column: 5, endLine: 14, endColumn: 20, code: "GHC-39999" });
  });

  it("parses column ranges", () => {
    const s = parseLoadOutput(`Foo.hs:4:8-12: warning: [-Wname-shadowing]\n    This binding for ‘x’ shadows\nOk, 3 modules loaded.`);
    expect(s.status).toBe("ok");
    expect(s.modulesLoaded).toBe(3);
    expect(s.diagnostics[0]).toMatchObject({ line: 4, column: 8, endLine: 4, endColumn: 12 });
  });

  it("handles a clean reload", () => {
    const s = parseLoadOutput("Ok, 12 modules loaded.");
    expect(s).toMatchObject({ status: "ok", modulesLoaded: 12, errors: 0, warnings: 0 });
    expect(parseLoadOutput("Ok, one module loaded.").modulesLoaded).toBe(1);
    expect(parseLoadOutput("Ok, two modules loaded.").modulesLoaded).toBe(2);
    expect(parseLoadOutput("Failed, no modules loaded.")).toMatchObject({ status: "failed", modulesLoaded: 0 });
  });

  it("parses a successful GHC 9.10 reload summary", () => {
    const s = parseLoadOutput("Ok, 91 modules reloaded.");
    expect(s).toMatchObject({ status: "ok", modulesLoaded: 91, errors: 0, warnings: 0, diagnostics: [], otherOutput: "" });
  });

  it("parses a failed GHC 9.10 reload with a diagnostic and CRLF line endings", () => {
    const s = parseLoadOutput("src/Lib.hs:7:11: error: [GHC-88464]\r\n    Variable not in scope: missing :: Int\r\nFailed, 26 modules reloaded.\r\n");
    expect(s).toMatchObject({ status: "failed", modulesLoaded: 26, errors: 1, warnings: 0, otherOutput: "" });
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0]).toMatchObject({
      file: "src/Lib.hs",
      line: 7,
      column: 11,
      severity: "error",
      code: "GHC-88464",
      message: "Variable not in scope: missing :: Int",
      raw: "src/Lib.hs:7:11: error: [GHC-88464]\n    Variable not in scope: missing :: Int",
    });
  });

  it.each([
    ["Ok, one module reloaded.", "ok", 1],
    ["Ok, 1 module reloaded.", "ok", 1],
    ["Ok, two modules reloaded.", "ok", 2],
    ["Failed, no modules reloaded.", "failed", 0],
    ["Failed, no modules to be reloaded.", "failed", 0],
  ] as const)("parses reload counts in %s", (output, status, modulesLoaded) => {
    expect(parseLoadOutput(output)).toMatchObject({ status, modulesLoaded, otherOutput: "" });
  });

  it("parses Compiling lines with trailing notes", () => {
    const s = parseLoadOutput("[1 of 3] Compiling Lib              ( src/Lib.hs, interpreted ) [Source file changed]\nOk, three modules loaded.");
    expect(s.compiled).toEqual([{ module: "Lib", file: "src/Lib.hs" }]);
  });

  it("reports unknown status when there is no summary", () => {
    const s = parseLoadOutput("some random output");
    expect(s.status).toBe("unknown");
    expect(s.otherOutput).toBe("some random output");
  });

  it("parses interactive errors (from expressions) and old-style headers without codes", () => {
    const d = parseDiagnostics(`<interactive>:1:1: error:\n    Variable not in scope: foo :: Int\n`);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ file: "<interactive>", line: 1, column: 1, severity: "error" });
    expect(d[0]!.code).toBeUndefined();
    expect(d[0]!.message).toBe("Variable not in scope: foo :: Int");
  });

  it("keeps message text that appears on the header line", () => {
    const d = parseDiagnostics(`Foo.hs:1:1: error: [GHC-12345] Something short\n    and more detail`);
    expect(d[0]!.message).toBe("Something short\nand more detail");
  });

  it("does not treat a Windows drive letter as a severity separator", () => {
    const d = parseDiagnostics(`C:\\proj\\src\\Foo.hs:2:3: error:\n    bad`);
    expect(d[0]).toMatchObject({ file: "C:\\proj\\src\\Foo.hs", line: 2, column: 3 });
  });

  it("keeps unlocated GHC errors without inventing a source position", () => {
    const output = "<no location info>: error: [GHC-87110]\r\n    Could not load module `Test.Hspec'.\r\n    It is a member of the hidden package `hspec-2.11.17'.\r\n";
    const s = parseLoadOutput(output);
    expect(s).toMatchObject({ status: "unknown", errors: 1, warnings: 0, otherOutput: "" });
    expect(s.diagnostics).toEqual([{
      severity: "error",
      code: "GHC-87110",
      message: "Could not load module `Test.Hspec'.\nIt is a member of the hidden package `hspec-2.11.17'.",
      raw: output.replace(/\r\n/g, "\n").trimEnd(),
    }]);
  });

  it("parses adjacent located and unlocated diagnostics independently", () => {
    const output = "<no location info>: warning: Warning without a code\n    More detail\nFoo.hs:2:3: error: [GHC-12345] Located error\n<no location info>: error: [GHC-61948]\n    Could not find module `Pml.Language.SpellingSpec'.\nFailed, no modules to be reloaded.";
    const s = parseLoadOutput(output);
    expect(s).toMatchObject({ status: "failed", modulesLoaded: 0, errors: 2, warnings: 1, otherOutput: "" });
    expect(s.diagnostics).toHaveLength(3);
    expect(s.diagnostics[0]).toMatchObject({ severity: "warning", message: "Warning without a code\nMore detail" });
    expect(s.diagnostics[1]).toMatchObject({ file: "Foo.hs", line: 2, column: 3, message: "Located error" });
    expect(s.diagnostics[2]).toMatchObject({ severity: "error", code: "GHC-61948", message: "Could not find module `Pml.Language.SpellingSpec'." });
    for (const d of [s.diagnostics[0], s.diagnostics[2]]) {
      for (const key of ["file", "line", "column", "endLine", "endColumn"]) expect(d).not.toHaveProperty(key);
    }
  });
});
