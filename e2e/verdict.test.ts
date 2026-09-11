/** The report's verdict rule, driven through Report.add and Report.addMethod, the way every suite records a result. */
import { describe, expect, it } from "vitest";
import { Report, type Values } from "./harness.ts";

const verdictOf = (values: Values, better: "lower" | "higher") => {
  const report = new Report();
  report.add({ aspect: "a", metric: "m", REST: "", GraphQL: "", Rayfold: "", values, better });
  return report.rows[0]!.verdict;
};

describe("verdicts", () => {
  it("within 1% of the best other stack is a tie, on either side", () => {
    expect(verdictOf({ REST: 75860, GraphQL: 31394, Rayfold: 31390 }, "lower")).toBe("tie"); // 4 B on 31 KB
    expect(verdictOf({ REST: 200, GraphQL: 100, Rayfold: 99 }, "lower")).toBe("tie"); // exactly 1% better
    expect(verdictOf({ REST: 200, GraphQL: 100, Rayfold: 101 }, "lower")).toBe("tie"); // exactly 1% worse
    expect(verdictOf({ REST: 1000, GraphQL: 0, Rayfold: 1005 }, "higher")).toBe("tie");
  });

  it("the band is not blanket: just past 1% Rayfold leads or is behind, and against a best of 0 only equality ties", () => {
    expect(verdictOf({ REST: 200, GraphQL: 100, Rayfold: 98.9 }, "lower")).toBe("lead");
    expect(verdictOf({ REST: 200, GraphQL: 100, Rayfold: 101.1 }, "lower")).toBe("behind");
    expect(verdictOf({ REST: 1000, GraphQL: 0, Rayfold: 1011 }, "higher")).toBe("lead");
    expect(verdictOf({ REST: 0, GraphQL: 0, Rayfold: 1 }, "higher")).toBe("lead");
    expect(verdictOf({ REST: 0, GraphQL: 0, Rayfold: 0 }, "higher")).toBe("tie");
  });

  it("a stack that cannot do it at all never ties with one that can", () => {
    expect(verdictOf({ REST: null, GraphQL: null, Rayfold: 5 }, "lower")).toBe("lead");
    expect(verdictOf({ REST: 5, GraphQL: null, Rayfold: null }, "lower")).toBe("behind");
    expect(verdictOf({ REST: null, GraphQL: null, Rayfold: null }, "lower")).toBe("tie");
  });

  it("a method's facts get the same rule, and its verdict follows them", () => {
    const report = new Report();
    const fact = (metric: string, values: Values) => ({ metric, better: "lower" as const, values, REST: "", GraphQL: "", Rayfold: "" });
    report.addMethod({ method: "GET", title: "t", operation: "o", exchanges: { REST: [], GraphQL: [], Rayfold: [] }, facts: [fact("a", { REST: 100, GraphQL: 100, Rayfold: 99.5 }), fact("b", { REST: 3, GraphQL: 1, Rayfold: 1 })] });
    expect(report.methods[0]!.facts.map((f) => f.verdict)).toEqual(["tie", "tie"]);
    expect(report.methods[0]!.verdict).toBe("tie");
  });
});
