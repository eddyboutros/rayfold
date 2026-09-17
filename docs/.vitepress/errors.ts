/**
 * One page per problem type a Rayfold server can answer with. The `type` of every RFC 9457 problem document points at
 * https://eddyboutros.github.io/rayfold/errors/<type>, which GitHub redirects to the page on rayfold.dev; the URI is
 * an identifier clients may compare, so it stays as 0.1.0 published it. errors.test.ts fails if a type either
 * runtime can send has no entry here.
 */

export interface ErrorType {
  type: string;
  /** the protocol code in the problem's `code` member */
  code: string;
  status: number;
  summary: string;
  causes: string[];
  fixes: string[];
  retryable: boolean;
  detail: string;
}

export const PROBLEM_TYPE_BASE = "https://eddyboutros.github.io/rayfold/errors/";

export const ERROR_TYPES: ErrorType[] = [
  {
    type: "invalid_argument",
    code: "invalid_argument",
    status: 400,
    summary: "The request does not match the schema, so nothing ran.",
    causes: [
      "An argument has the wrong type, or is missing when the schema requires it.",
      "A value is outside the `@range` the schema declares, such as `qty: 50` where the maximum is 10.",
      "The batch envelope is not valid JSON, or a shape does not parse.",
    ],
    fixes: [
      "Read `detail`: it names the argument or the position in the request.",
      "Compare the request with the schema, or open the explorer, which shows every argument with its type and range.",
    ],
    retryable: false,
    detail: "ops[0].args.qty: must be at most 10",
  },
  {
    type: "failed_precondition",
    code: "failed_precondition",
    status: 400,
    summary: "The request is valid, but the data is not in the state the operation needs.",
    causes: [
      "`VersionConflict`: a command sent `ifVersion` (or `If-Match`) and the entity has changed since. The error carries the current entity, and HTTP bindings answer `412 Precondition Failed`.",
      "`DependencyFailed`: an operation used `$ref` to read an earlier operation's result, and that operation failed.",
    ],
    fixes: [
      "For a version conflict, show the user the current entity from the error's `data`, then send the change again with the new version.",
      "For a failed dependency, look at the error of the operation it depended on: that one is the real cause.",
    ],
    retryable: false,
    detail: "Review:r1 is at version 4, not 3",
  },
  {
    type: "out_of_range",
    code: "out_of_range",
    status: 400,
    summary: "The operation went past the end of what exists, such as reading beyond the last item.",
    causes: [
      "A request asked for a position, offset or cursor beyond the available data.",
      "The runtime never sends this code itself, so one you receive came from a resolver or an adapter.",
    ],
    fixes: ["Start again from the first page, or stop when a page reports `hasMore: false`."],
    retryable: false,
    detail: "offset 500 is past the end of the list",
  },
  {
    type: "unauthenticated",
    code: "unauthenticated",
    status: 401,
    summary: "The server could not tell who is calling.",
    causes: [
      "The request carries no credentials, or they have expired.",
      "A capability token was edited, is signed with another secret, or has expired.",
      "A command carried an idempotency key but nobody is signed in: a replay record is scoped to the caller it belongs to, so it needs one.",
      "An upload was sent by nobody: an open upload route is a way to fill your storage with nothing to trace it to.",
    ],
    fixes: ["Sign in again or refresh the token, then repeat the request. A command keeps its idempotency key, so repeating it is safe."],
    retryable: false,
    detail: "Capability has expired",
  },
  {
    type: "permission_denied",
    code: "permission_denied",
    status: 403,
    summary: "The server knows who is calling, and they are not allowed to do this.",
    causes: [
      "An `@allow` policy in the schema refuses this caller, for the operation or for a field the shape selects.",
      "A capability token does not name this operation.",
      "A browser sent a command from an origin the server does not allow, or the `Host` header is not accepted.",
    ],
    fixes: [
      "Check the policy on the operation or field in the schema; the explorer lists which policies guard each operation.",
      "Leave out fields the caller may not read, or mark them `@partial` so they come back as `null` instead of failing the operation.",
      "For a web app on another origin, add that origin to the server's `allowedOrigins`.",
    ],
    retryable: false,
    detail: "Book.costPrice: not allowed for this viewer",
  },
  {
    type: "not_found",
    code: "not_found",
    status: 404,
    summary: "What the request names does not exist, or the caller is not allowed to know that it does.",
    causes: ["An id that does not exist, or a path an HTTP binding does not serve."],
    fixes: ["Check the id. Servers often answer `not_found` rather than `permission_denied` so they do not reveal what exists."],
    retryable: false,
    detail: "Order o42 not found",
  },
  {
    type: "already_exists",
    code: "already_exists",
    status: 409,
    summary: "The command would create something that is already there.",
    causes: [
      "An idempotency key was reused for another operation, or for the same one with different arguments. This is the only way the runtime itself raises this code.",
      "A create command for an id, name or other unique value that is taken.",
    ],
    fixes: [
      "Use a fresh key for each distinct command; a key names one command with one set of arguments, so that a replay answers the question that was asked.",
      "Read the existing item instead, or choose another value.",
    ],
    retryable: false,
    detail: "A user named ada already exists",
  },
  {
    type: "aborted",
    code: "aborted",
    status: 409,
    summary: "The operation was stopped by a conflict with another one running at the same time.",
    causes: [
      "Two changes to the same data raced, and this one lost.",
      "The runtime never sends this code itself, so one you receive came from a resolver or an adapter.",
    ],
    fixes: ["Send it again with the same idempotency key. If the first attempt did go through, the server answers with its original result."],
    retryable: true,
    detail: "Concurrent update, try again",
  },
  {
    type: "resource_exhausted",
    code: "resource_exhausted",
    status: 429,
    summary: "The request is over a limit the server enforces.",
    causes: [
      "The batch costs more than the budget. Queries declare their cost with `@cost`, and every frame reports what it cost in `meta.cost`.",
      "Too many operations in one batch, or a shape nested too deep or selecting too many fields.",
      "A rate limit in front of the server.",
    ],
    fixes: ["Ask for less: smaller pages, fewer fields, or split the batch. Retrying the same request unchanged gives the same answer."],
    retryable: false,
    detail: "Batch costs 1240, over the budget of 1000",
  },
  {
    type: "payload_too_large",
    code: "resource_exhausted",
    status: 413,
    summary: "The request body is bigger than the server accepts. Nothing was read past the limit and nothing ran.",
    causes: ["A request body over the server's limit, 1 MiB unless the server changes it."],
    fixes: [
      "Send less in one request, for example by splitting a large batch.",
      "If large bodies are expected, raise the limit on the server: `maxBody` in TypeScript, `maxBodyBytes` on the JVM.",
    ],
    retryable: false,
    detail: "Body exceeds 1048576 bytes",
  },
  {
    type: "unsupported_media_type",
    code: "invalid_argument",
    status: 415,
    summary: "The request body is in a format this endpoint does not read.",
    causes: [
      "A missing or different `Content-Type`. The endpoint reads `application/rayfold+json`, `application/json` and the binary `application/rayfold`; the MCP endpoint reads `application/json`; the uploads route reads `application/octet-stream` and nothing else.",
      "Only these types are accepted so that a web page on another site cannot send a form that the server would act on.",
    ],
    fixes: ["Set `Content-Type: application/rayfold+json` on the request. The client libraries do this for you."],
    retryable: false,
    detail: "Content-Type text/plain is not accepted; send application/rayfold+json",
  },
  {
    type: "canceled",
    code: "canceled",
    status: 499,
    summary: "The caller stopped the request before it finished.",
    causes: ["The client aborted, closed the connection, or navigated away."],
    fixes: ["Nothing to fix on the server. A command that was canceled can be sent again with the same idempotency key."],
    retryable: false,
    detail: "Request canceled by the client",
  },
  {
    type: "unimplemented",
    code: "unimplemented",
    status: 501,
    summary: "This server does not support the operation or feature the request uses.",
    causes: [
      "An operation or extension this server does not provide, or a feature its transport does not offer.",
      "A REST binding reached at a method it is not bound to. That answers `405` with an `Allow` header rather than `501`, carrying this same code.",
    ],
    fixes: ["Check the server's manifest at `/rayfold/manifest` for what it offers."],
    retryable: false,
    detail: "Streams are not served over this transport",
  },
  {
    type: "unavailable",
    code: "unavailable",
    status: 503,
    summary: "The server or something it depends on is down for the moment.",
    causes: ["The service is restarting, overloaded, or cannot reach its database."],
    fixes: ["Try again after a short wait, backing off between attempts. Commands keep their idempotency key, so they never run twice."],
    retryable: true,
    detail: "Database unavailable",
  },
  {
    type: "deadline_exceeded",
    code: "deadline_exceeded",
    status: 504,
    summary: "The request's deadline passed before the server finished.",
    causes: ["The `deadline` sent with the request was shorter than the work took."],
    fixes: ["Give the request more time (at most 600000 ms), or ask for less. The server stops work for a request once its deadline passes."],
    retryable: true,
    detail: "Deadline of 200 ms exceeded",
  },
  {
    type: "domain",
    code: "domain",
    status: 422,
    summary: "An error the schema declares for this operation, such as `OutOfStock`. It arrives with a `type` and its data.",
    causes: [
      "The resolver threw one of the errors listed in the operation's `throws`. The error's `type` is its name in the schema, and `data` holds its fields.",
      "Over a REST binding, the problem's `type` ends with that name, for example `/errors/OutOfStock`. The API you are calling defines it: look it up in that API's schema.",
    ],
    fixes: [
      "Handle it in the client by name: `e.is(\"OutOfStock\")` in TypeScript, or the generated sealed class on the JVM.",
      "A resolver may only throw errors the operation declares. Any other becomes `internal`, so add it to `throws` first.",
    ],
    retryable: false,
    detail: "Only 1 left",
  },
  {
    type: "internal",
    code: "internal",
    status: 500,
    summary: "Something went wrong inside the server. The details stay in its logs.",
    causes: [
      "A resolver threw an ordinary exception.",
      "A resolver threw a declared error that the operation does not list in `throws`; the runtime logs it and answers `internal`.",
    ],
    fixes: ["Look at the server's logs for the request. If the failure is part of normal operation, declare it as an error in the schema instead."],
    retryable: false,
    detail: "Internal error",
  },
  {
    type: "unknown",
    code: "unknown",
    status: 500,
    summary: "An error came from somewhere that did not say what kind it was.",
    causes: [
      "Usually a lower layer, such as a library or another service, failed without a usable code.",
      "The runtime never sends this code itself, so one you receive came from a resolver or an adapter.",
    ],
    fixes: ["Look at the server's logs, and map that failure to a specific code where it is caught."],
    retryable: false,
    detail: "Unknown error",
  },
  {
    type: "data_loss",
    code: "data_loss",
    status: 500,
    summary: "Data was lost or corrupted, and the server could not recover it.",
    causes: [
      "Storage failed or returned data that does not make sense.",
      "The runtime never sends this code itself, so one you receive came from a resolver or an adapter.",
    ],
    fixes: ["This needs an operator: check the storage and restore from a backup if needed."],
    retryable: false,
    detail: "Stored order o7 is unreadable",
  },
];

const title = (type: string) => type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The markdown of one error's page. */
export function errorPage(e: ErrorType): string {
  const problem = { type: PROBLEM_TYPE_BASE + e.type, title: e.type.replace(/_/g, " "), status: e.status, detail: e.detail, code: e.code };
  const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");
  return [
    "---",
    `title: ${title(e.type)}`,
    `description: ${JSON.stringify(e.summary)}`,
    "---",
    "",
    `# ${title(e.type)}`,
    "",
    `<p class="error-meta"><code>${e.type}</code><span>HTTP ${e.status}</span><span>${e.retryable ? "Worth retrying" : "Retrying the same request will not help"}</span></p>`,
    "",
    e.summary,
    "",
    "## Why it happens",
    "",
    list(e.causes),
    "",
    "## What to do",
    "",
    list(e.fixes),
    "",
    "## What it looks like",
    "",
    "Inside a batch, the operation's frame carries it:",
    "",
    "```json",
    JSON.stringify({ id: 1, error: { code: e.code, ...(e.type === "domain" ? { type: "OutOfStock", data: { bookId: "b1", available: 1 } } : {}), message: e.detail, ...(e.retryable ? { retryable: true } : {}) }, fin: true }, null, 2),
    "```",
    "",
    "When the whole request is refused over HTTP, the answer is a problem document:",
    "",
    "```json",
    JSON.stringify(problem, null, 2),
    "```",
    "",
    "See also [all error types](./index.md) and the errors chapter of the [specification](../../spec/05-errors.md).",
    "",
  ].join("\n");
}
