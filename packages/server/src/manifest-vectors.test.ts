import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@rayfold/schema";
import { createFetchHandler } from "./fetch.ts";
import { createRayfoldServer } from "./server.ts";

/**
 * The published `manifest/` contract under `conformance/vectors`, run against a real server.
 *
 * The manifest is a document rather than a pure function, so the vector pins its contract - which members exist, what
 * kind of thing each is, and the rules relating them - and the values stay free, since they depend on the schema and
 * the configuration. `VectorsTest.kt` checks the JVM against the same file.
 */
const ROOT = new URL("../../../conformance/vectors/manifest/document.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const contract = JSON.parse(readFileSync(ROOT, "utf8")) as {
  members: Array<{ name: string; type: string; required: boolean; keys?: string[] }>;
};

const SCHEMA = `
  entity Book { id: ID title: String costPrice: Decimal? @allow(read: viewer.role == "admin") }
  query book(id: ID): Book?
`;

async function served(): Promise<{ body: Record<string, unknown>; header: string | null }> {
  const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { book: () => null } } });
  const handler = createFetchHandler(server, { viewer: () => null });
  const res = await handler(new Request("http://api.example/rayfold/manifest"));
  return { body: (await res.json()) as Record<string, unknown>, header: res.headers.get("rayfold-schema") };
}

describe("conformance vectors: manifest", () => {
  it("serves exactly the members the contract names", async () => {
    const { body } = await served();
    expect(Object.keys(body).sort()).toEqual(contract.members.map((m) => m.name).sort());
  });

  it("schemaHash is bare lower-case hex, not a prefixed shape id", async () => {
    const { body } = await served();
    // a shape id is "sha256:..." and this is not. Both get called "the hash", which is how an implementer gets it
    // wrong once and then cannot see it.
    expect(body["schemaHash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("schemaHash is the value the Rayfold-Schema header carries", async () => {
    const { body, header } = await served();
    expect(header).toBe(body["schemaHash"]);
  });

  it("schemaHash is not recomputable from the schema member, because that one is redacted", async () => {
    const { body } = await served();
    const ofServed = sha256Hex(canonicalJson(body["schema"]));
    expect(ofServed).not.toBe(body["schemaHash"]);
    // and the reason is the redaction, not a different hashing rule: a policy is present but its expression is gone
    expect(JSON.stringify(body["schema"])).toContain("costPrice");
    expect(JSON.stringify(body["schema"])).not.toContain("admin");
  });

  it("limits names the bounds a client sizes a batch against", async () => {
    const { body } = await served();
    const named = contract.members.find((m) => m.name === "limits")!.keys!;
    for (const k of named) expect(Object.keys(body["limits"] as object), `limits.${k}`).toContain(k);
  });

  it("publishes nothing it was not asked to: an unrelated option stays out of a document served to anyone", async () => {
    // `timing` is a server's own debug setting, not a bound a batch is judged against. It used to appear here only
    // because the manifest published every option there was.
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Query: { book: () => null } }, timing: true });
    expect(Object.keys(server.manifest().limits)).not.toContain("timing");
  });
});
