import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HTTP_STATUS, type ErrorCode } from "./protocol.ts";
import { createFetchHandler } from "./fetch.ts";
import { createRayfoldServer } from "./server.ts";

/**
 * The published `errors/` vectors, run against this runtime.
 *
 * The status table is a pure function of the code and is checked directly. The rest needs a server, because the point
 * of the area is *when* a failure is a problem document and when it is a frame — a distinction that depends on how
 * far the request got, not on which code it carries. `VectorsTest.kt` checks the JVM against the same file.
 */
const PATH = new URL("../../../conformance/vectors/errors/statuses-and-problems.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
  statuses: Array<{ code: string; status: number; why?: string }>;
  problemShape: { members: string[] };
  cases: Array<{
    name: string;
    request: { contentType?: string; oversize?: boolean; overBudget?: boolean; op?: string };
    expect: "problem" | "frame";
    status?: number;
    type?: string;
    code?: string;
    why?: string;
  }>;
};

const SCHEMA = `
  entity Book { id: ID title: String }
  query book(id: ID): Book? @cost(base: 5)
`;

/** `book` costs 5: over budget only when the vector asks for it, so the flag is what puts the batch over. */
function handler(overBudget: boolean) {
  const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { book: () => null } }, ...(overBudget ? { budget: 3 } : {}) });
  return createFetchHandler(server, { viewer: () => ({ id: "u1" }), maxBody: 200 });
}

describe("conformance vectors: errors", () => {
  describe("the status a code derives", () => {
    for (const s of doc.statuses) {
      it(`${s.code} is ${s.status}`, () => {
        expect(HTTP_STATUS[s.code as ErrorCode], s.why ?? s.code).toBe(s.status);
      });
    }
  });

  describe("problem document or error frame", () => {
    for (const c of doc.cases) {
      it(c.name, async () => {
        const body = c.request.oversize
          ? JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "x".repeat(400) } }] })
          : JSON.stringify({ ops: [{ id: 1, op: c.request.op ?? "book", args: { id: "b1" } }] });
        const res = await handler(c.request.overBudget ?? false)(
          new Request("http://api.example/rayfold", {
            method: "POST",
            headers: { "content-type": c.request.contentType ?? "application/rayfold+json" },
            body,
          }),
        );
        const why = c.why ?? c.name;

        if (c.expect === "problem") {
          expect(res.status, why).toBe(c.status);
          expect(res.headers.get("content-type"), why).toContain("application/problem+json");
          const problem = (await res.json()) as Record<string, unknown>;
          for (const m of doc.problemShape.members) expect(Object.keys(problem), `${why}: member ${m}`).toContain(m);
          expect(problem["code"], why).toBe(c.code);
          expect(problem["type"], why).toContain(c.type!);
          // lower case, and the underscores gone: "invalid argument", never "Invalid argument"
          expect(problem["title"], `${why}: the title is the problem type, spaced and lower-case`).toBe(c.type!.replace(/_/g, " "));
          return;
        }

        // a batch that got far enough to be understood reports on the frame channel, whatever the code
        expect(res.status, why).toBe(200);
        const frames = (await res.text())
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const errors = frames.filter((f) => "error" in f).map((f) => (f["error"] as { code: string }).code);
        expect(errors, why).toEqual([c.code]);
      });
    }
  });
});
