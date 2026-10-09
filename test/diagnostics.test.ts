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
});
