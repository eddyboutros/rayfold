import { describe, expect, it } from "vitest";
import { loadSchema } from "@rayfold/schema";
import { RayfoldClient } from "./client.ts";
import { RayfoldCache, type MergePolicy } from "./cache.ts";
import type { Transport } from "./transport.ts";

const SCHEMA = `
entity Doc {
  id: ID
  title: String @merge(serverWins)
  notes: String
  body: String @merge(crdtText)
}
query doc(id: ID): Doc?
`;

const silent: Transport = { send: () => (async function* () {})() };

describe("per-field conflict policy (spec 08 section 5)", () => {
  const policies: Record<string, MergePolicy> = { title: "serverWins", body: "crdtText" };
  const cache = () => new RayfoldCache(() => 0, (_type, field) => policies[field]);

  it("a field the server speaks for leaves the prediction; a field without a policy keeps it", () => {
    const c = cache();
    c.merge("Doc:d1", { title: "server", notes: "server note" });
    c.addLayer("cmd-1", [{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }]);
    expect(c.get("Doc:d1")).toMatchObject({ title: "mine", notes: "my note" });

    // the server writes both fields while the command is still in flight
    c.merge("Doc:d1", { title: "theirs", notes: "their note" });
    expect(c.get("Doc:d1")).toMatchObject({ title: "theirs", notes: "my note" });

    // and when the command settles, what is left is exactly what the server said
    c.removeLayer("cmd-1");
    expect(c.get("Doc:d1")).toMatchObject({ title: "theirs", notes: "their note" });
  });

  it("refuses to predict a field whose policy it cannot carry out", () => {
    const c = cache();
    expect(() => c.addLayer("cmd-2", [{ set: "Doc:d1", value: { body: "typed locally" } }])).toThrow(/crdtText/);
    // guard: the same prediction on a field it can carry out is accepted
    expect(() => c.addLayer("cmd-3", [{ set: "Doc:d1", value: { title: "typed locally" } }])).not.toThrow();
  });

  it("a client given the schema reads the policy from it", () => {
    const client = new RayfoldClient({ transport: silent, schema: loadSchema(SCHEMA).ir });
    client.cache.merge("Doc:d1", { title: "server", notes: "server note" });
    client.cache.addLayer("cmd-4", [{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }]);
    client.cache.merge("Doc:d1", { title: "theirs", notes: "their note" });
    expect(client.cache.get("Doc:d1")).toMatchObject({ title: "theirs", notes: "my note" });

    // guard: without a schema there is no policy, so the prediction stands
    const plain = new RayfoldClient({ transport: silent });
    plain.cache.merge("Doc:d1", { title: "server" });
    plain.cache.addLayer("cmd-5", [{ set: "Doc:d1", value: { title: "mine" } }]);
    plain.cache.merge("Doc:d1", { title: "theirs" });
    expect(plain.cache.get("Doc:d1")).toMatchObject({ title: "mine" });
  });
});
