/**
 * The report page builder, run the way `npm run e2e:html` runs it, over report data whose verdicts the test chose, and
 * the committed report data checked against the rule that produced it.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeVerdict, type Row, type Verdict } from "./harness.ts";
import { bounded } from "./wait.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;

describe("the report page, built from data with known verdicts", () => {
  let dir: string;
  let html: string;
  const results = read("e2e/results.json") as { rows: Row[] };
  // ten ahead, three level, two behind; one value not possible and one yes/no row, so every cell form shows
  const pattern: Verdict[] = [...Array<Verdict>(10).fill("lead"), "tie", "tie", "tie", "behind", "behind"];
  const rows = results.rows.map((r, i) => ({ ...r, verdict: pattern[i]! }));
  rows[0] = { ...rows[0]!, values: { REST: null, GraphQL: 1234567, Rayfold: 89 } };
  const yesNo = rows.findIndex((r) => r.unit?.includes("(1 = yes)"));

  beforeAll(async () => {
    expect(rows).toHaveLength(15);
    dir = mkdtempSync(join(tmpdir(), "rayfold-report-html-"));
    for (const path of ["e2e/methods.json", "e2e/realdata.json", "e2e/workspace.json", "e2e/security.json", "bench/results/latest.json", "packages/server/package.json"]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(ROOT, path), join(dir, path));
    }
    writeFileSync(join(dir, "e2e/results.json"), JSON.stringify({ ...results, rows }));
    const child = spawn(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), join(ROOT, "e2e/report-html.ts"), "out.html"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const code = await bounded(new Promise<number | null>((r) => child.on("exit", r)), "the report builder exiting", 20_000);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    html = readFileSync(join(dir, "out.html"), "utf8");
  }, 30_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the headline and its tile count the verdicts as the data has them", () => {
    expect(html).toContain("Rayfold was ahead on <strong>10 of 15</strong> everyday tasks, level on 3 and behind on 2,");
    expect(html).toContain('<span class="num">10<small>/ 15</small></span><span class="lbl">tasks where Rayfold was ahead</span>');
  });

  it("the score table gives each task its own verdict and its measured values", () => {
    const table = html.slice(html.indexOf('<th scope="col">Task</th>'));
    const cells = [...table.slice(0, table.indexOf("</table>")).matchAll(/<td class="num-cell">([^<]*)<\/td><td class="num-cell">([^<]*)<\/td><td class="num-cell rayfold-cell">([^<]*)<\/td><td><span class="chip ([a-z-]+)">([^<]+)<\/span>/g)].map((m) => m.slice(1));
    const chip = { lead: ["chip-rayfold", "Rayfold ahead"], tie: ["chip-tie", "Level"], behind: ["chip-behind", "Rayfold behind"] };
    expect(cells.map((c) => c.slice(3))).toEqual(pattern.map((v) => chip[v]));
    expect(cells[0]!.slice(0, 3)).toEqual(["not possible", "1,234,567", "89"]);
    const v = rows[yesNo]!.values!;
    expect(cells[yesNo]!.slice(0, 3)).toEqual([v.REST ? "yes" : "no", v.GraphQL ? "yes" : "no", v.Rayfold ? "yes" : "no"]);
  });
});

describe("the committed report data", () => {
  it("every verdict is the one the rule gives its values, so no report cell was typed in", () => {
    const rows = (path: string) => (read(path) as { rows: Row[] }).rows;
    const methods = (read("e2e/methods.json") as { methods: Array<{ facts: Row[] }> }).methods.flatMap((m) => m.facts);
    for (const [where, list] of [["results", rows("e2e/results.json")], ["realdata", rows("e2e/realdata.json")], ["workspace", rows("e2e/workspace.json")], ["methods", methods]] as const) {
      const measured = list.filter((r) => r.values && r.better);
      expect(measured.length, where).toBe(list.length);
      expect(measured.map((r) => r.verdict), where).toEqual(measured.map((r) => computeVerdict(r.values!, r.better!)));
    }
  });
});
