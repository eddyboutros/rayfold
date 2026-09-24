import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadSchema } from "@rayfold/schema";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { openApiFor } from "./openapi.ts";
import { listen } from "./http.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const bookstoreDoc = (): Obj => openApiFor(createBookstore().server.ir);

const CUSTOM = `
entity Item { id: ID n: Int }
entity Secret @allow(read: viewer != null) { id: ID }
enum Format { A B }
query items(limit: Int, flag: Boolean = false, format: Format?, q: String @range(min: 2, max: 8), top: Int @range(min: 1, max: 50)): [Item] @http(method: GET, path: "/items")
query item(n: Int, id: ID?): Item? @http(method: GET, path: "/items/{n}/{id}")
query secret(id: ID): Secret? @http(method: GET, path: "/secrets/{id}")
command free(n: Int): Item @idempotent(false) @http(method: POST, path: "/free", body: "*")
command keyed(n: Int): Item @http(method: POST, path: "/keyed", body: "*")
entity Note { id: ID v: Int @version }
command makeNote(n: Int): Note @http(method: POST, path: "/notes", body: "*")
query secrets(page: Int = 1): [Secret] @http(method: GET, path: "/secrets")
entity Priced { id: ID cost: Int? @allow(read: viewer != null) }
query priced(id: ID): Priced? @http(method: GET, path: "/priced/{id}")
query prices(cap: Decimal? @range(min: 0, max: 100), qn: String? @range(min: 1, max: 10)): [Item] @http(method: GET, path: "/prices")
`;
const customDoc = (): Obj => openApiFor(loadSchema(CUSTOM).ir);

const WIRE = `
entity Hit { id: ID first: String? }
input Near { maxKm: Int @http(name: "max-km") }
input Where { zipCode: String? @http(name: "zip-code") near: Near @http(name: "near-by") }
query find(firstName: String? @http(name: "first-name"), maxCount: Int @http(name: "max-count") @range(min: 1, max: 9)): [Hit] @http(method: GET, path: "/find")
query hit(hitId: ID @http(name: "hit-id")): Hit? @http(method: GET, path: "/hits/{hitId}")
query search(firstName: String? @http(name: "first-name"), where: Where): [Hit] @http(method: QUERY, path: "/search", body: "*")
command tag(hitId: ID @http(name: "hit-id"), where: Where): Hit @http(method: PUT, path: "/hits/{hitId}", body: where)
`;

/** Every operation as "method path", in document order. */
function operations(doc: Obj): Array<[string, Obj]> {
  return Object.entries(doc.paths as Obj).flatMap(([path, ops]) => Object.entries(ops as Obj).map(([method, op]): [string, Obj] => [`${method} ${path}`, op]));
}
const header = (op: Obj, name: string): Obj | undefined => (op.parameters as Obj[]).find((p) => p.in === "header" && p.name === name);
const PROBLEM_REF = { $ref: "#/components/schemas/Problem" };
const problemResponse = (description: string) => ({ description, content: { "application/problem+json": { schema: PROBLEM_REF } } });
const SHAPE_PARAM = { name: "shape", in: "query", required: false, description: "Rayfold shape text or sha256: shape id; default view when absent", schema: { type: "string" } };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});

describe("openApiFor", () => {
  it("is OpenAPI 3.2.0 with exactly the bookstore's bound paths and methods; QUERY is the `query` key on /books", () => {
    const doc = bookstoreDoc();
    expect(doc.openapi).toBe("3.2.0");
    expect(doc.info).toEqual({ title: "Rayfold API", version: "0.1" });
    expect(Object.fromEntries(Object.entries(doc.paths as Obj).map(([p, ops]) => [p, Object.keys(ops as Obj)]))).toEqual({
      "/books": ["query"],
      "/books/{id}": ["get", "patch"],
      "/reviews/{id}": ["get", "put", "delete"],
      "/orders/{id}": ["get"],
      "/orders": ["post"],
      "/orders/{id}/pay": ["post"],
    });
    expect(Object.fromEntries(operations(doc).map(([k, op]) => [k, op.operationId]))).toEqual({
      "query /books": "books",
      "get /books/{id}": "book",
      "patch /books/{id}": "updateBook",
      "get /reviews/{id}": "review",
      "put /reviews/{id}": "editReview",
      "delete /reviews/{id}": "deleteReview",
      "get /orders/{id}": "order",
      "post /orders": "placeOrder",
      "post /orders/{id}/pay": "payOrder",
    });
    expect(doc.paths["/books"].query.summary).toBe("List books, newest first.");
  });

  it("title, version and prefix options land in info and in every path key", () => {
    const doc = openApiFor(createBookstore().server.ir, { title: "Bookstore", version: "2.1", prefix: "/api" }) as Obj;
    expect(doc.info).toEqual({ title: "Bookstore", version: "2.1" });
    expect(Object.keys(doc.paths)).toEqual(["/api/books", "/api/books/{id}", "/api/reviews/{id}", "/api/orders/{id}", "/api/orders", "/api/orders/{id}/pay"]);
  });

  it("Idempotency-Key is a required header on POST /orders and optional on an @idempotent(false) POST", () => {
    const doc = bookstoreDoc();
    const expected = { name: "Idempotency-Key", in: "header", required: true, description: "Replays the original response on retry", schema: { type: "string", minLength: 16, maxLength: 128 } };
    expect(doc.paths["/orders"].post.parameters).toEqual([expected]);
    expect(header(doc.paths["/orders/{id}/pay"].post, "Idempotency-Key")).toEqual(expected);
    expect(header(doc.paths["/reviews/{id}"].put, "Idempotency-Key")).toBeUndefined();

    const custom = customDoc();
    expect(header(custom.paths["/free"].post, "Idempotency-Key")).toEqual({ ...expected, required: false });
    expect(header(custom.paths["/keyed"].post, "Idempotency-Key")).toEqual(expected);
  });

  it("If-Match is offered on every command returning a versioned entity, and 412 appears exactly where If-Match does", () => {
    const doc = bookstoreDoc();
    expect(header(doc.paths["/reviews/{id}"].put, "If-Match")).toEqual({
      name: "If-Match",
      in: "header",
      required: false,
      description: "Entity version from a previous response; 412 with the current entity when stale",
      schema: { type: "string" },
    });
    expect(header(doc.paths["/books/{id}"].patch, "If-Match")).toBeUndefined();
    expect(header(doc.paths["/orders"].post, "If-Match")).toBeUndefined();

    const withIfMatch = operations(doc).filter(([, op]) => header(op, "If-Match")).map(([k]) => k);
    const with412 = operations(doc).filter(([, op]) => "412" in op.responses).map(([k]) => k);
    expect(withIfMatch).toEqual(["put /reviews/{id}", "delete /reviews/{id}"]);
    expect(with412).toEqual(withIfMatch);
    expect(doc.paths["/reviews/{id}"].put.responses["412"]).toEqual(problemResponse("VersionConflict: data.current carries the entity as stored"));

    // a POST whose result is versioned offers it too, because the binding honours If-Match on every method
    const custom = customDoc();
    expect(header(custom.paths["/notes"].post, "If-Match")).toMatchObject({ name: "If-Match", in: "header", required: false });
    expect(Object.keys(custom.paths["/notes"].post.responses)).toContain("412");
    expect(header(custom.paths["/keyed"].post, "If-Match")).toBeUndefined(); // guard: Item has no @version
    expect(Object.keys(custom.paths["/keyed"].post.responses)).not.toContain("412");
  });

  it("POST with a location answers 201, POST without one 200, and 304 is listed only on queries", () => {
    const doc = bookstoreDoc();
    const place = doc.paths["/orders"].post.responses;
    expect(Object.keys(place)).toEqual(["201", "400", "401", "403", "422"]);
    expect(place["201"]).toEqual({ description: "Result in the requested shape (default view when no shape is given)", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } });
    expect(Object.keys(doc.paths["/orders/{id}/pay"].post.responses)).toEqual(["200", "400", "401", "403", "422"]);

    expect(operations(doc).filter(([, op]) => "304" in op.responses).map(([k]) => k)).toEqual(["query /books", "get /books/{id}", "get /reviews/{id}", "get /orders/{id}"]);
    expect(doc.paths["/books/{id}"].get.responses["304"]).toEqual({ description: "Not modified (ETag revalidation)" });
    expect(doc.paths["/books/{id}"].get.responses["200"].content["application/json"].schema).toEqual({ anyOf: [{ $ref: "#/components/schemas/Book" }, { type: "null" }] });
  });

  it("401/403 appear wherever a policy can refuse: on the op, on a reachable type, on a list element, or on a selectable field", () => {
    const doc = bookstoreDoc();
    const order = doc.paths["/orders/{id}"].get.responses;
    expect(order["401"]).toEqual(problemResponse("Sign-in required by a policy"));
    expect(order["403"]).toEqual(problemResponse("Denied by a policy"));
    // Book.costPrice carries a field policy, and every bookstore result can reach a Book, so every operation can answer 401/403
    expect(Object.keys(doc.paths["/books/{id}"].get.responses)).toEqual(["200", "304", "400", "401", "403"]);
    expect(operations(doc).filter(([, op]) => "401" in op.responses && "403" in op.responses).map(([k]) => k)).toEqual(operations(doc).map(([k]) => k));

    const custom = customDoc();
    expect(Object.keys(custom.paths["/secrets/{id}"].get.responses)).toEqual(["200", "304", "400", "401", "403"]); // type-level @allow alone
    expect(Object.keys(custom.paths["/secrets"].get.responses)).toEqual(["200", "304", "400", "401", "403"]); // ...also as a list element
    expect(Object.keys(custom.paths["/priced/{id}"].get.responses)).toEqual(["200", "304", "400", "401", "403"]); // a field policy
    expect(Object.keys(custom.paths["/items/{n}/{id}"].get.responses)).toEqual(["200", "304", "400"]); // guard: nothing guarded is reachable
  });

  it("422 on placeOrder is a oneOf of exactly its declared errors, each pinning its title and typed data", () => {
    const doc = bookstoreDoc();
    const domain = (type: string) => ({ allOf: [PROBLEM_REF, { properties: { title: { const: type }, data: { $ref: `#/components/schemas/${type}` } } }] });
    expect(doc.paths["/orders"].post.responses["422"]).toEqual({
      description: "Declared domain errors: OutOfStock, PaymentDeclined",
      content: { "application/problem+json": { schema: { oneOf: [domain("OutOfStock"), domain("PaymentDeclined")] } } },
    });
    expect(doc.paths["/orders/{id}/pay"].post.responses["422"].content["application/problem+json"].schema.oneOf).toEqual([domain("PaymentDeclined"), domain("NotPayable")]);
    expect(doc.components.schemas.OutOfStock).toEqual({ type: "object", properties: { bookId: { type: "string" }, available: { type: "integer" } }, additionalProperties: false, required: ["bookId", "available"] });
    expect(doc.paths["/reviews/{id}"].put.responses["422"]).toBeUndefined();
  });

  it("PATCH bodies accept application/merge-patch+json and application/json; every other body only application/json", () => {
    const doc = bookstoreDoc();
    const ref = (name: string) => ({ schema: { $ref: `#/components/schemas/${name}` } });
    expect(doc.paths["/books/{id}"].patch.requestBody).toEqual({ required: true, content: { "application/merge-patch+json": ref("BookPatch"), "application/json": ref("BookPatch") } });
    expect(doc.paths["/reviews/{id}"].put.requestBody).toEqual({ required: true, content: { "application/json": ref("ReviewEdit") } });
    expect(doc.paths["/orders"].post.requestBody).toEqual({ required: true, content: { "application/json": ref("OrderInput") } });
    expect(Object.keys(doc.paths["/books"].query.requestBody.content)).toEqual(["application/json"]);
    expect(doc.paths["/books"].query.requestBody.required).toBe(false); // every spread argument is optional, so an empty body is valid
    expect(doc.paths["/books"].query.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { filter: { anyOf: [{ $ref: "#/components/schemas/BookFilter" }, { type: "null" }] }, page: { $ref: "#/components/schemas/PageArgs" } },
    });
    const bodiless = operations(doc).filter(([, op]) => !op.requestBody).map(([k]) => k);
    expect(bodiless).toEqual(["get /books/{id}", "get /reviews/{id}", "delete /reviews/{id}", "get /orders/{id}", "post /orders/{id}/pay"]);
  });

  it("names parameters, path templates and request-body properties as the bindings read them (@http(name:)); results keep schema names", () => {
    const doc = openApiFor(loadSchema(WIRE).ir) as Obj;
    expect(Object.keys(doc.paths)).toEqual(["/find", "/hits/{hit-id}", "/search"]);
    expect(doc.paths["/find"].get.parameters).toEqual([
      { name: "first-name", in: "query", required: false, schema: { anyOf: [{ type: "string" }, { type: "null" }] } },
      { name: "max-count", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 9, "x-rayfold-range": { min: 1, max: 9 } } },
      SHAPE_PARAM,
    ]);
    expect(doc.paths["/hits/{hit-id}"].get.parameters[0]).toEqual({ name: "hit-id", in: "path", required: true, schema: { type: "string" } });
    expect(doc.paths["/hits/{hit-id}"].put.parameters[0]).toEqual({ name: "hit-id", in: "path", required: true, schema: { type: "string" } });
    expect(doc.paths["/search"].query.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { "first-name": { anyOf: [{ type: "string" }, { type: "null" }] }, where: { $ref: "#/components/schemas/Where" } },
      required: ["where"],
    });
    expect(doc.paths["/hits/{hit-id}"].put.requestBody.content["application/json"].schema).toEqual({ $ref: "#/components/schemas/Where" });
    expect(doc.components.schemas["Where"]).toEqual({
      type: "object",
      properties: { "zip-code": { anyOf: [{ type: "string" }, { type: "null" }] }, "near-by": { $ref: "#/components/schemas/Near" } },
      additionalProperties: false,
      required: ["near-by"],
    });
    expect(doc.components.schemas["Near"]).toEqual({ type: "object", properties: { "max-km": { type: "integer" } }, additionalProperties: false, required: ["max-km"] });
    expect(Object.keys(doc.components.schemas["Hit"].properties)).toEqual(["$type", "id", "first"]);
  });

  it("guard - without @http(name:) every name in the document is the schema name", () => {
    const plain = WIRE.replace(/ @http\(name: "[^"]+"\)/g, "");
    const doc = openApiFor(loadSchema(plain).ir) as Obj;
    expect(Object.keys(doc.paths)).toEqual(["/find", "/hits/{hitId}", "/search"]);
    expect((doc.paths["/find"].get.parameters as Obj[]).map((p) => p.name)).toEqual(["firstName", "maxCount", "shape"]);
    expect(Object.keys(doc.paths["/search"].query.requestBody.content["application/json"].schema.properties)).toEqual(["firstName", "where"]);
    expect(Object.keys(doc.components.schemas["Where"].properties)).toEqual(["zipCode", "near"]);
  });

  it("GET query parameters are required exactly when non-null without a default; path parameters always; `shape` only on GET", () => {
    const custom = customDoc();
    expect(custom.paths["/items"].get.parameters).toEqual([
      { name: "limit", in: "query", required: true, schema: { type: "integer" } },
      { name: "flag", in: "query", required: false, schema: { type: "boolean" } },
      { name: "format", in: "query", required: false, schema: { anyOf: [{ type: "string", enum: ["A", "B"] }, { type: "null" }] } },
      { name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 8, "x-rayfold-range": { min: 2, max: 8 } } },
      { name: "top", in: "query", required: true, schema: { type: "integer", minimum: 1, maximum: 50, "x-rayfold-range": { min: 1, max: 50 } } },
      SHAPE_PARAM,
    ]);
    // the declared type picks the keyword, not the JSON type: a Decimal is text on the wire but compares by value
    expect(custom.paths["/prices"].get.parameters.slice(0, 2)).toEqual([
      { name: "cap", in: "query", required: false, schema: { anyOf: [{ type: "string", pattern: "^-?\\d+(\\.\\d+)?$" }, { type: "null" }], "x-rayfold-range": { min: 0, max: 100 } } },
      { name: "qn", in: "query", required: false, schema: { anyOf: [{ type: "string" }, { type: "null" }], minLength: 1, maxLength: 10, "x-rayfold-range": { min: 1, max: 10 } } },
    ]);
    expect(custom.paths["/items/{n}/{id}"].get.parameters).toEqual([
      { name: "n", in: "path", required: true, schema: { type: "integer" } },
      { name: "id", in: "path", required: true, schema: { anyOf: [{ type: "string" }, { type: "null" }] } },
      SHAPE_PARAM,
    ]);

    const doc = bookstoreDoc();
    const withShape = operations(doc).filter(([, op]) => (op.parameters as Obj[]).some((p) => p.name === "shape")).map(([k]) => k);
    expect(withShape).toEqual(["get /books/{id}", "get /reviews/{id}", "get /orders/{id}"]);
  });

  it("@range becomes minimum/maximum on Int, minLength/maxLength on String and x-rayfold-range everywhere (the only form for Decimal)", () => {
    const { schemas } = bookstoreDoc().components;
    expect(schemas.BookPatch.properties).toEqual({
      title: { anyOf: [{ type: "string" }, { type: "null" }], "x-rayfold-range": { min: 1, max: 200 }, minLength: 1, maxLength: 200 },
      price: { anyOf: [{ type: "string", pattern: "^-?\\d+(\\.\\d+)?$" }, { type: "null" }], "x-rayfold-range": { min: 0 } },
      stock: { anyOf: [{ type: "integer" }, { type: "null" }], "x-rayfold-range": { min: 0 }, minimum: 0 },
    });
    expect(schemas.ReviewEdit.properties).toEqual({
      rating: { type: "integer", "x-rayfold-range": { min: 1, max: 5 }, minimum: 1, maximum: 5 },
      body: { type: "string", "x-rayfold-range": { min: 1, max: 2000 }, minLength: 1, maxLength: 2000 },
    });
    expect(schemas.ReviewEdit.required).toEqual(["rating", "body"]);
    expect(schemas.OrderLine).toEqual({
      type: "object",
      properties: { bookId: { type: "string" }, qty: { type: "integer", "x-rayfold-range": { min: 1, max: 100 }, minimum: 1, maximum: 100 } },
      additionalProperties: false,
      required: ["bookId"],
    });
  });

  it("no #/$defs/ reference survives and every #/components/schemas/ reference resolves to a component", () => {
    for (const doc of [bookstoreDoc(), customDoc()]) {
      const text = JSON.stringify(doc);
      expect(text).not.toContain("#/$defs/");
      const refs = [...text.matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1] ?? "");
      expect(refs.length).toBeGreaterThan(0);
      const schemas = doc.components.schemas as Obj;
      for (const ref of refs) {
        expect(ref.startsWith("#/components/schemas/")).toBe(true);
        const target = schemas[ref.slice("#/components/schemas/".length)];
        expect(target, ref).toBeDefined();
        expect(Object.keys(target as Obj).length, ref).toBeGreaterThan(0);
      }
    }
    const refs = new Set([...JSON.stringify(bookstoreDoc()).matchAll(/"\$ref":"([^"]*)"/g)].map((m) => m[1]));
    for (const name of ["Problem", "Book", "Order", "BookPatch", "ReviewEdit", "OrderInput", "OrderLine", "OutOfStock", "NotPayable", "Page_Book"]) {
      expect(refs.has(`#/components/schemas/${name}`), name).toBe(true);
    }
  });

  it("GET /rayfold/openapi.json over the real HTTP transport serves exactly openApiFor(ir)", async () => {
    const bs = createBookstore();
    const http = await listen(bs.server, 0);
    servers.push(http);
    const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("rayfold-schema")).toBe(bs.server.hash);
    expect(await res.json()).toEqual(openApiFor(bs.server.ir));
  });
});
