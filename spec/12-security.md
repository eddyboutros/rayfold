# 12. Security considerations

Status: draft, part of Rayfold Core. Every conforming server MUST meet the requirements marked MUST. The reference
runtimes enforce them by default, and `e2e/security.test.ts` sends each attack below to a running server.

No protocol can make an API impossible to attack. What Rayfold can do is make the safe behaviour the default, put it in
the contract instead of in each handler, and test it on every change. This chapter lists the threats Rayfold Core
addresses, the rule that addresses each one, and what stays the application's job.

## 1. Threat model

Rayfold assumes:

- **Clients are untrusted.** Every byte of a request, including shapes, variables, `$ref` paths, idempotency keys,
  deadlines and binary (RB) input, may be hostile.
- **Browsers are a special kind of client.** They attach cookies automatically and let any web page send some
  requests to any site. A server reached from a browser must not let one site act on another's behalf.
- **The schema and resolvers are trusted.** They are written by the service's owners. Their mistakes, such as a
  resolver that ignores `ctx.simulate`, should fail safe where the runtime can detect them.

Out of scope for Rayfold Core:

- Transport encryption: use TLS.
- Authentication itself: the transport's viewer hook turns credentials into a viewer.
- Rate limits across many requests: Rayfold bounds the cost of each batch, and a gateway or the viewer hook limits
  request rates.

## 2. Browser-facing requests

Rules for requests reaching a Rayfold server over HTTP, including REST-style bindings, the MCP endpoint and WebSocket
handshakes:

1. **Body types.** A POST or QUERY to the batch endpoint MUST carry `application/rayfold+json`, `application/json` or
   `application/rayfold`. Any other type gets `415` with an RFC 9457 problem, before the body is parsed. A binding with
   a body MUST accept only `application/json`, and PATCH also `application/merge-patch+json`. The MCP endpoint MUST
   accept only `application/json`.
   Browsers let any page send `text/plain`, form and multipart bodies to any site without asking. JSON media types
   force a CORS preflight, which a foreign page cannot pass.
2. **Origin.** A request that can change data and carries an `Origin` header MUST be refused with `403` unless the
   origin is the server's own or is listed in the server's allowed origins. That covers POST without `Rayfold-Safe`, PUT,
   PATCH, DELETE, MCP calls and WebSocket handshakes. Safe requests are exempt: GET, QUERY, and POST with
   `Rayfold-Safe: true`, which may hold only queries. They cannot change data, a foreign page cannot send QUERY or the
   `Rayfold-Safe` header without a CORS preflight, and it cannot read the answer. Requests without `Origin` come from
   non-browser clients and are unaffected. Behind a proxy that rewrites Host, list the public origin, or writes are
   refused while reads keep working.
3. **Host.** A server reached on a loopback address (127.0.0.0/8 or ::1) MUST answer only loopback host names
   (`localhost`, `127.0.0.1`, `[::1]`) unless it is configured with an explicit host list. Other hosts get `403`.
   This defeats DNS rebinding, where a page renames its own domain to 127.0.0.1 and would otherwise count as same
   origin.
4. **POST bindings need an `Idempotency-Key` header** (spec 04 section 8). A plain HTML form cannot send one.
5. **Headers.** Every response MUST carry `X-Content-Type-Options: nosniff`. Problem responses MUST carry
   `Cache-Control: no-store`. A `304` needs neither, because it has no body.

## 3. Resource limits

1. **Body size.** A server MUST cap request bodies (default 1 MiB) and answer an oversized one with `413 Content
   Too Large` (problem type `payload_too_large`, code `resource_exhausted`), because retrying the same body cannot
   help. After refusing, it SHOULD keep draining the upload up to a bound, so the refusal reaches the client, then
   close the connection. WebSocket frames and assembled messages MUST be capped too (default 1 MiB); an oversized
   one closes the connection with code 1009.
2. **Nesting.** Arguments and variables nested deeper than 64 levels MUST fail the batch with `invalid_argument`
   before anything walks them recursively. Shape text nested deeper than 64 levels MUST be refused while parsing. RB
   values nested deeper than 64 levels MUST be refused while decoding, and an RB length prefix larger than the
   remaining input MUST be refused before allocating.
3. **Cost.** The batch budget (spec 06 section 5) is computed as follows:
   - Each op's arguments are coerced first. An op whose arguments fail validation never runs and costs 0; it reports
     its error when its turn comes.
   - Arguments containing `$ref` cannot be coerced before earlier ops run. For those, any page size that is not a
     whole number from 0 to 200 counts as 200.
   - Every op costs at least 1, and arithmetic MUST NOT wrap.
   - Scalar fields cost nothing by default, but every row a page can return costs 1 (spec 06 section 5), so a shape
     of scalars alone cannot make a large page cheap.
   - The result: bad input can raise the estimate but never lower it.
4. **Depth and fields.** The execution limits (`maxDepth`, `maxFields`) apply as specified in spec 02 section 5.
5. **Deadlines.** `meta.deadline` and an op's `deadline` MUST be whole milliseconds from 0 to 600,000. Anything else
   is `invalid_argument`.
6. **Bounded server memory.** Shapes learned from requests MUST be kept only after the op passed planning, and in a
   bounded store (default 10,000, least recently used first out). Shapes the server registers itself are never
   evicted. Idempotency records MUST expire (default 24 hours), and the store MUST be bounded (default 100,000,
   expired records first, then the oldest). A key held by a command that is running now is never evicted, since
   evicting it would let a second request run the same command.

## 4. Idempotency and replays

1. **Scope.** Records are scoped to the viewer. A command that carries an idempotency key from a caller with no
   viewer MUST be refused with `unauthenticated`, because anonymous callers cannot be told apart and would share one
   replay scope. Applications that serve guests give them a viewer, such as a guest session.
   Commands without a key (`@idempotent(false)`, or idempotent HTTP methods on bindings) and dry runs still run for
   anonymous callers.
2. **Binding.** A record is bound to the operation as well as its coerced arguments. Reusing a key for another
   operation or other arguments is `already_exists`: "Idempotency key K was used for another operation or other
   arguments".
3. **Authorization first.** The operation's write policy MUST be checked before a replay is served.
4. **One execution.** Two requests with the same scope and key that arrive together MUST execute once. The later
   request waits for the first, then replays its result. A command that failed before it changed anything leaves no
   record and releases the key, so a retry runs it. A command that failed after its effect MUST record that failure,
   and one whose op was canceled or ran out of time after its effect MUST record a `canceled` answer saying the
   command committed. Retries are answered with the record rather than running the command a second time.
5. **Form.** A replay answers in the form the retry asks for (compact or full), under the retrying op's id.
6. **Leases.** A server that takes a key holds it for a bounded lease and renews the lease while the command runs, so
   that a key is not held forever by a server that stopped. A request MAY take over a key whose lease has run out.
   This is the one case where a command can run twice: a server that stops between its effect and its record leaves
   nothing to replay. A lease MUST be longer than the commands the server serves (default 30 seconds).

## 5. Authorization and data exposure

1. **Existence.** When a type-level read policy denies an entity at a nullable position, the value is `null`, the
   same as for an entity that does not exist, even with an explicit shape. Non-null positions and list elements
   report the error, and field-level denials are unchanged (spec 06).
2. **Comparisons.** In policy expressions:
   - Numbers and numeric text (Decimal and Long travel as text) compare exactly by value, including beyond 2^53.
   - Two non-numeric texts compare by code point.
   - Ordering values that cannot be ordered, such as text against a boolean, is an evaluation error.
   - A policy whose expression errors fails closed: `@allow` does not allow, `@deny` denies.
3. **`$ref` paths** MUST read only the earlier result's own data. Keys such as `__proto__`, `constructor` or
   `toString` resolve to nothing. Decoders MUST store a `__proto__` key as plain data.
4. **Numbers.** An integer outside the safe range (beyond 2^53) sent as a JSON number, or a Decimal whose text form is
   not plain decimal (such as `1e21`), MUST be refused. Such values travel as text.
5. **Errors.** Unexpected failures MUST reach the client as `internal` with a generic message, never with messages
   or stack traces from the server (spec 05).
6. **Manifest.** `GET /rayfold/manifest` SHOULD serve the schema without policy expressions: annotations named `allow` and
   `deny` keep their names, and their arguments are removed. Clients need names and types, not how access is
   decided. Serving the full IR MUST be an explicit choice, and the manifest MAY be switched off.

## 6. Dry runs

A command accepts `simulate: true` only if it declares `@simulate` (spec 01), which is the author's statement that
its resolver honours `ctx.simulate`. Otherwise the op fails with `failed_precondition`: "X() does not support dry
runs". The runtime cannot stop resolver code from writing, so the declaration is required before an agent is
offered a dry run. The MCP bridge lists a `.simulate` tool only for such commands (spec 10). A dry run never records
an idempotency result and never publishes events or live-query changes.

## 7. Checklist for deployments

- Serve Rayfold over TLS.
- Give every caller who may write a viewer, including guests.
- Keep `allowedOrigins` to the web apps that call the API.
- Turn on trusted shapes in production (spec 02 section 3) when the client set is known.
- Keep the manifest redacted, or switch it off on public servers.
- Put request-rate limits in front of the server; Rayfold limits the cost of each batch, not the number of batches.
