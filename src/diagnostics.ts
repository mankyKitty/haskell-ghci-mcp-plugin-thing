/**
 * Parser for GHC's textual diagnostics as printed by GHCi on :load / :reload
 * (and on type errors in expressions).
 *
 * Handles the location forms GHC uses:
 *   Foo.hs:12:5: error: ...
 *   Foo.hs:12:5-10: warning: [-Wunused-imports] ...
 *   Foo.hs:(12,5)-(14,20): error: [GHC-83865] ...
 *   <interactive>:3:1: error: ...
 *
 * and the module summary lines:
 *   [1 of 3] Compiling Foo ( src/Foo.hs, interpreted )
 *   Ok, 3 modules loaded.
 *   Ok, one module loaded.
 *   Failed, 2 modules loaded.
 *   Ok, no modules loaded.
 */

export type Severity = "error" | "warning";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: Severity;
  /** GHC error code such as "GHC-83865", or a warning flag such as "-Wunused-imports". */
  code?: string;
  /** The message body, de-indented, without the location header or the code snippet. */
  message: string;
  /** The full raw text of the diagnostic block, as GHC printed it. */
  raw: string;
}

export interface LoadSummary {
  /** "ok" if GHC said Ok, "failed" if it said Failed, "unknown" if no summary line was found. */
  status: "ok" | "failed" | "unknown";
  /** Number of modules loaded according to the summary line (null if unknown). */
  modulesLoaded: number | null;
  /** Modules GHC reported compiling, in order. */
  compiled: { module: string; file: string }[];
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  /** Any output lines that were neither diagnostics nor summary lines. */
  otherOutput: string;
}

const HEADER_RE =
  /^(?<file>(?:[A-Za-z]:)?[^\s:][^:\n]*?):(?:(?<l>\d+):(?<c>\d+)(?:-(?<c2>\d+))?|\((?<l1>\d+),(?<c1>\d+)\)-\((?<l2>\d+),(?<cc2>\d+)\)):\s*(?<sev>[Ee]rror|[Ww]arning)(?::\s*(?<rest>.*))?$/;

const COMPILING_RE = /^\[\s*\d+ of \d+\] Compiling (?<mod>\S+)\s+\(\s*(?<file>[^,]+?)\s*,[^)]*\).*$/;
// GHC spells out small counts: "Ok, two modules loaded."
const SUMMARY_RE = /^(?<status>Ok|Failed), (?<count>no|one|two|three|four|five|six|seven|eight|nine|ten|\d+) modules? loaded\.?$/;
const WORD_NUMBERS: Record<string, number> = { no: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseDiagnostics(output: string): Diagnostic[] {
  return parseLoadOutput(output).diagnostics;
}

export function parseLoadOutput(output: string): LoadSummary {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const diagnostics: Diagnostic[] = [];
  const compiled: { module: string; file: string }[] = [];
  const other: string[] = [];
  let status: LoadSummary["status"] = "unknown";
  let modulesLoaded: number | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const comp = COMPILING_RE.exec(line);
    if (comp?.groups) {
      compiled.push({ module: comp.groups.mod!, file: comp.groups.file! });
      i++;
      continue;
    }

    const summ = SUMMARY_RE.exec(line.trim());
    if (summ?.groups) {
      status = summ.groups.status === "Ok" ? "ok" : "failed";
      const c = summ.groups.count!;
      modulesLoaded = WORD_NUMBERS[c] ?? Number(c);
      i++;
      continue;
    }

    const head = HEADER_RE.exec(line);
    if (head?.groups) {
      const g = head.groups;
      const rawLines = [line];
      const bodyLines: string[] = [];
      // First-line remainder: either "[GHC-xxxxx]" / "[-Wflag]" or the start of the message.
      let code: string | undefined;
      let rest = (g.rest ?? "").trim();
      const codeMatch = /^\[(?<code>[^\]]+)\]\s*(?<after>.*)$/.exec(rest);
      if (codeMatch?.groups) {
        code = codeMatch.groups.code!;
        rest = codeMatch.groups.after!.trim();
      }
      if (rest) bodyLines.push(rest);

      // Body: indented lines until a blank line followed by a non-indented line,
      // or until the next header / summary line.
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trim() === "") {
          // A blank line ends the block only if the following line is not indented.
          const next = lines[i + 1];
          if (next === undefined || !/^\s/.test(next)) {
            break;
          }
          rawLines.push(l);
          bodyLines.push("");
          i++;
          continue;
        }
        // Snippet gutter lines ("12 | code") start flush-left but belong to the block.
        if (!/^\s/.test(l) && !/^\d+\s*\|/.test(l)) break; // non-indented => new thing
        rawLines.push(l);
        bodyLines.push(l);
        i++;
      }

      const message = cleanBody(bodyLines);
      const severity: Severity = g.sev!.toLowerCase() === "error" ? "error" : "warning";
      const d: Diagnostic = {
        file: g.file!,
        line: Number(g.l ?? g.l1),
        column: Number(g.c ?? g.c1),
        severity,
        message,
        raw: rawLines.join("\n"),
      };
      if (code) d.code = code;
      if (g.c2) {
        d.endLine = d.line;
        d.endColumn = Number(g.c2);
      } else if (g.l2) {
        d.endLine = Number(g.l2);
        d.endColumn = Number(g.cc2);
      }
      diagnostics.push(d);
      continue;
    }

    other.push(line);
    i++;
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;
  return {
    status,
    modulesLoaded,
    compiled,
    diagnostics,
    errors,
    warnings,
    otherOutput: other.join("\n").trim(),
  };
}

/**
 * Remove the source-snippet gutter GHC appends (the `   |` / `12 | code` / `   | ^^^` lines)
 * and de-indent the remaining message.
 */
function cleanBody(bodyLines: string[]): string {
  const kept: string[] = [];
  for (const l of bodyLines) {
    // Snippet lines look like "   |", "12 |   foo", "   |   ^^^^". Drop them.
    if (/^\s*\d*\s*\|/.test(l)) continue;
    kept.push(l);
  }
  // trim trailing blanks
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  // De-indent by the minimum indentation of the indented lines. (The only
  // non-indented line can be the remainder of the header line, which is
  // already flush-left.)
  const indents = kept
    .filter((l) => l.trim() !== "" && /^\s/.test(l))
    .map((l) => /^(\s*)/.exec(l)![1]!.length);
  const min = indents.length ? Math.min(...indents) : 0;
  return kept
    .map((l) => (l.trim() === "" ? "" : /^\s/.test(l) ? l.slice(min) : l))
    .join("\n")
    .trim();
}
