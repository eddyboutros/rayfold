/** The requests the playground offers, each with a sentence on what it shows. */

export type ViewerName = "anonymous" | "customer" | "staff";

export interface Example {
  id: string;
  title: string;
  summary: string;
  viewer: ViewerName;
  request: { rayfold: "0.1"; ops: Array<Record<string, unknown>> };
}

const envelope = (...ops: Array<Record<string, unknown>>) => ({ rayfold: "0.1" as const, ops });

export const EXAMPLES: Example[] = [
  {
    id: "read",
    title: "Read a book",
    summary: "A query names the fields it wants, related data included. Nothing else comes back.",
    viewer: "anonymous",
    request: envelope({ id: 1, op: "book", args: { id: "b1" }, shape: "{ title stock author { name } }" }),
  },
  {
    id: "default-view",
    title: "No shape",
    summary: "Leave the shape out and the type's default fields come back, so curl and AI agents get something useful.",
    viewer: "anonymous",
    request: envelope({ id: 1, op: "book", args: { id: "b3" } }),
  },
  {
    id: "page",
    title: "A page of books",
    summary: "Lists come as pages with a cursor. The authors of the whole page load in a single call.",
    viewer: "anonymous",
    request: envelope({ id: 1, op: "books", args: { page: { first: 2 } }, shape: "{ items { title author { name } } cursor hasMore total }" }),
  },
  {
    id: "buy",
    title: "Buy a copy",
    summary: "A command returns its result and a patch: the change every client cache applies without asking again.",
    viewer: "customer",
    request: envelope({ id: 1, op: "buy", args: { bookId: "b1", qty: 1 } }),
  },
  {
    id: "sold-out",
    title: "Sold out",
    summary: "The errors a command can throw are declared in the schema, and they arrive typed, with their data.",
    viewer: "customer",
    request: envelope({ id: 1, op: "buy", args: { bookId: "b2" } }),
  },
  {
    id: "pipeline",
    title: "Two steps, one request",
    summary: "An operation can use an earlier one's result. Buy, then read what is left, in a single round trip.",
    viewer: "customer",
    request: envelope(
      { id: 1, op: "buy", args: { bookId: "b3", qty: 2 } },
      { id: 2, op: "book", args: { id: { $ref: "1.id" } }, shape: "{ title stock }" },
    ),
  },
  {
    id: "live",
    title: "Live stock",
    summary: "Add live: true to any query. While it runs, press Restock: the change arrives as a patch.",
    viewer: "customer",
    request: envelope({ id: 1, op: "book", args: { id: "b1" }, shape: "{ title stock }", live: true }),
  },
  {
    id: "policy",
    title: "Staff only",
    summary: "Only staff can read costPrice, and the schema says so. Run it as a customer, then switch to staff.",
    viewer: "customer",
    request: envelope({ id: 1, op: "book", args: { id: "b1" }, shape: "{ title costPrice }" }),
  },
  {
    id: "checked",
    title: "Checked arguments",
    summary: "Arguments are checked against the schema before any of your code runs: qty must be between 1 and 10.",
    viewer: "customer",
    request: envelope({ id: 1, op: "buy", args: { bookId: "b1", qty: 50 } }),
  },
];
