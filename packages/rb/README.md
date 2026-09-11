# @rayfold/rb

Rayfold Binary (RB), the compact wire encoding for Rayfold. It carries exactly the JSON model, in fewer bytes:
field names come from a dictionary built from the schema, repeated strings go into a string table, and frames are
length-prefixed so a stream can be decoded as it arrives.

You rarely use it directly: `@rayfold/server` answers `application/rayfold` requests with it, and
`@rayfold/client` speaks it when given the schema (`createFetchTransport({ url, binary: ir })`).

```ts
import { loadSchema } from "@rayfold/schema";
import { RbCodec, RB_CONTENT_TYPE } from "@rayfold/rb";

const { ir } = loadSchema(`
  entity Book {
    id: ID
    title: String
  }
  query book(id: ID): Book?
`);
const codec = new RbCodec(ir);
const bytes = codec.encode({ rayfold: "0.1", ops: [{ id: 1, op: "book", args: { id: "b1" } }] });
console.log(RB_CONTENT_TYPE, bytes.length, codec.decode(bytes));
```

Format: `spec/09-binary-format.md` in the Rayfold repository.

Apache-2.0.
