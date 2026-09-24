import { describe, expect, it } from "vitest";
import { loadSchema } from "@rayfold/schema";
import { createRayfoldServer, ok } from "@rayfold/server";
import { bounded } from "../../../e2e/wait.ts";
import { RayfoldClient } from "./client.ts";
import { RayfoldCache, type MergePolicy } from "./cache.ts";
import { createLocalTransport, type Transport } from "./transport.ts";

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

describe("@merge(serverWins) through the client: every server value overrules, not only a `set` patch", () => {
  const DOCS = `
entity Doc {
  id: ID
  title: String @merge(serverWins)
  notes: String
}
query doc(id: ID): Doc?
command hold(id: ID, title: String, notes: String): Doc
command rename(id: ID, title: String, notes: String): Doc
`;
  const SHAPE = { shape: "{ id title notes }" };

  function build() {
    const doc = { id: "d1", title: "server", notes: "server note" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = createRayfoldServer({
      schema: DOCS,
      resolvers: {
        Query: { doc: () => ({ ...doc }) },
        Command: {
          // stays in flight until the test lets it go, so its prediction is pending meanwhile
          hold: async () => {
            await gate;
            return ok({ ...doc });
          },
          rename: ({ title, notes }: { title: string; notes: string }) => {
            Object.assign(doc, { title, notes });
            return ok({ ...doc });
          },
        },
      },
    });
    const client = new RayfoldClient({ transport: createLocalTransport(server, () => ({ id: "u1" })), schema: loadSchema(DOCS).ir });
    return { doc, release, client };
  }

  it("a query's data drops a pending prediction of a serverWins field; a field without a policy keeps it", async () => {
    const { doc, release, client } = build();
    await client.query("doc", { id: "d1" }, SHAPE);
    const pending = client.command("hold", { id: "d1", title: "mine", notes: "my note" }, { optimistic: [{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }] });
    expect(client.cache.get("Doc:d1")).toMatchObject({ title: "mine", notes: "my note" });
    Object.assign(doc, { title: "theirs", notes: "their note" }); // another writer, behind this client's back
    await client.query("doc", { id: "d1" }, SHAPE);
    expect(client.cache.get("Doc:d1")).toMatchObject({ title: "theirs", notes: "my note" });
    release();
    await bounded(pending, "the held command answered");
    expect(client.cache.predictions).toEqual([]);
  });

  it("a compact command's result, which carries no `set` patch, overrules another command's pending prediction", async () => {
    const { release, client } = build();
    await client.query("doc", { id: "d1" }, SHAPE);
    const pending = client.command("hold", { id: "d1", title: "mine", notes: "my note" }, { optimistic: [{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }] });
    await client.command("rename", { id: "d1", title: "theirs", notes: "their note" }, SHAPE);
    expect(client.cache.get("Doc:d1")).toMatchObject({ title: "theirs", notes: "my note" });
    release();
    await bounded(pending, "the held command answered");
  });

  it("guard: without a policy the prediction stands against a query's data until its command settles", async () => {
    const { doc, release, client } = build();
    await client.query("doc", { id: "d1" }, SHAPE);
    const pending = client.command("hold", { id: "d1", title: "x", notes: "my note" }, { optimistic: [{ set: "Doc:d1", value: { notes: "my note" } }] });
    Object.assign(doc, { notes: "their note" });
    await client.query("doc", { id: "d1" }, SHAPE);
    expect(client.cache.get("Doc:d1")).toMatchObject({ notes: "my note" });
    release();
    await bounded(pending, "the held command answered");
    expect(client.cache.get("Doc:d1")).toMatchObject({ notes: "their note" });
  });

  it("the caller's prediction is not edited by an overrule, so it can be used again", async () => {
    const { doc, release, client } = build();
    await client.query("doc", { id: "d1" }, SHAPE);
    const prediction = [{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }];
    const pending = client.command("hold", { id: "d1", title: "mine", notes: "my note" }, { optimistic: prediction });
    Object.assign(doc, { title: "theirs" });
    await client.query("doc", { id: "d1" }, SHAPE);
    expect(client.cache.get("Doc:d1")).toMatchObject({ title: "theirs" });
    expect(prediction).toEqual([{ set: "Doc:d1", value: { title: "mine", notes: "my note" } }]);
    release();
    await bounded(pending, "the held command answered");
  });
});
