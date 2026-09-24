# Deployment

Running Rayfold as several servers behind a load balancer: what the servers share, how each tells the balancer when it
can take traffic, and how one stops without dropping anyone. One server needs none of this; the defaults are right for
it.

## What the servers share

Behind a load balancer a request can land on any server, and a retry on a different one from the first attempt. Four
things must therefore be shared, or the guarantees a single server gives stop holding:

| What | Without sharing | Share it with |
|---|---|---|
| The data | a command on one server is invisible to the others | one database, which you already have |
| Idempotency records | a retry that lands on another server runs the command a second time | [`PgIdempotencyStore`](postgres.md#idempotency-records-for-more-than-one-server) on Node, [`JdbcIdempotencyStore`](jdbc.md#idempotency-records-for-more-than-one-server) on the JVM |
| Changes and events | a live query or a stream open on another server never hears the command | [`PgRelay`](postgres.md#live-updates-across-servers) |
| Uploads, if you serve them | a command naming a file that landed on another server finds nothing | [`PgUploadStore`](uploads.md#a-store-that-writes-them-down) on Node, `JdbcUploadStore` on the JVM |

```ts
import pg from "pg";
import { createRayfoldServer, listen, shutdown } from "@rayfold/server";
import { PgIdempotencyStore, PgRelay, pgNotifications } from "@rayfold/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const listener = new pg.Client({ connectionString: process.env.DATABASE_URL }); // LISTEN belongs to one connection
await listener.connect();

const idempotency = new PgIdempotencyStore(pool);
const relay = new PgRelay(pgNotifications(listener), pool);
await idempotency.migrate();
await relay.migrate();

const server = createRayfoldServer({ schema, resolvers, idempotency, relay });
const http = await listen(server, 4000, {
  viewer,
  readiness: { db: () => pool.query("select 1") },
});
await server.ready();
process.on("SIGTERM", () => shutdown(server, http).then(() => process.exit(0)));
```

Both stores create their tables with `migrate()`, or you run `idempotencySchema()` and `relaySchema()` in your own
migrations. `migrate()` is safe to call from every server as it starts: two starting at the same moment race on
Postgres's catalogue, and the one refused runs the statement again and finds the table. A server never hears its own
change back over the relay, so nothing is applied twice.

**Shapes.** A shape the client sends as text works on every server. A shape sent by id must be known to the server
that receives it: ids are hashes of the shape, so shapes registered in code (`server.registerShape`) have the same id
on every instance, and `trustedShapes` fleets are consistent by construction. A shape id one server learned from a
request and another has never seen answers `not_found`, so send text unless the shape is registered.

**Sizing the idempotency bound.** Keys held by commands running right now count against the store's bound (default
100,000) and are never evicted, so the room left for records is the bound minus the commands in flight. A bound below
the number of commands a server runs at once leaves nothing to replay from ([spec 12 §3.6](../../spec/12-security.md)).

## Telling the balancer

Two routes beside the endpoint, for whatever probes your platform runs:

| Route | Answers | Use it as |
|---|---|---|
| `GET /rayfold/health` | `200 {"status":"ok"}` while the process runs | the liveness probe: restart the process when it stops answering |
| `GET /rayfold/ready` | `200 {"ready":true,"reasons":[]}`, or `503` with every reason it should not take traffic | the readiness probe: route traffic only while it answers 200 |

A server is not ready while it is still connecting to the relay (`relay: not listening yet`), when that failed or the
connection dropped later (`relay:` followed by whatever stopped it), once it is shutting down (`shutting down`), and
when a check you configured fails or does not answer within `readinessTimeoutMs` (default 2 seconds): `db: connection
refused`, `db: no answer within 2000 ms`. On the JVM a check that blocks its thread, such as a JDBC `isValid`, is
still answered at the limit. The body says which, so a pod that never becomes ready explains itself.

```yaml
livenessProbe:
  httpGet: { path: /rayfold/health, port: 4000 }
readinessProbe:
  httpGet: { path: /rayfold/ready, port: 4000 }
  periodSeconds: 5
```

## What a server will tell you

`GET {base}/health` is liveness and `GET {base}/ready` is whether to send traffic. Neither says anything about the
server itself, which is the gap `stats` fills:

```ts
const handler = createFetchHandler(server, {
  stats: { authorize: (req) => req.headers.get("authorization") === `Bearer ${process.env.OPS_TOKEN}` },
});
```

```json
{
  "identity": { "name": "bookshop", "instance": "8f3c…", "version": "1.4.0", "startedAt": 1789000000000 },
  "uptimeMs": 86400000, "rayfold": "0.1", "schemaHash": "a71789…", "extensions": ["mcp"],
  "inflight": 2, "draining": false, "ready": true, "reasons": [], "live": 7
}
```

`extensions` lists the endpoints mounted beside this server (`upload`, `mcp`); the manifest lists the protocol
extensions it speaks.

The route does not exist until you configure it, and an unconfigured server answers `404` rather than `403`, so it
does not advertise itself. Give the server an `identity` to make its answers worth comparing:

```ts
createRayfoldServer({ schema, resolvers, identity: { name: "bookshop", version: process.env.GIT_SHA } });
```

`instance` is generated per process when you do not supply one, so a restart is visible as a restart. None of this
is in the manifest — that document's members are fixed by the specification.

**Two servers disagreeing about the schema** is the failure this makes obvious: every response already carries
`Rayfold-Schema`, and `stats` carries the same hash, so a fleet where one instance is still serving last week's
schema shows up without any instrumentation at all.

## Counting what happened

Hand the server a `Counters` sink and it records what an operator asks about:

```ts
import { MemoryCounters } from "@rayfold/server";
const counters = new MemoryCounters();
createRayfoldServer({ schema, resolvers, counters });   // then GET {base}/stats includes them
```

| Counter | Labels | Why it is not available any other way |
|---|---|---|
| `rayfold.requests` | `method` | — |
| `rayfold.refused` | `reason`: host, origin, media, method, route | These are answered **before** a batch is built, so no tracing hook ever sees one |
| `rayfold.ops` | `kind`, `outcome` | Counted without any instrumentation configured |
| `rayfold.errors` | `op`, `code`, `type` | Every declared error is `domain` on the wire and carries its name in `type`, so a code alone puts a schema's whole error vocabulary in one bucket |
| `rayfold.idempotency` | `claim`: owned, done, inflight; `record`: failed | A replayed command is otherwise invisible. `record: failed` counts committed commands the store could not record: their keys stay held until the lease runs out |
| `rayfold.live.opened` / `.reran` / `.closed` | `op` | One live query is a single op for its whole life; `opened` minus `closed` is a leak you can see |

Both runtimes emit the same names. A full sink keeps counting what it already knows and reports `countersDropped`
beside the numbers, rather than going quiet and leaving a graph that keeps drawing and stops being true.

## Stopping

A rolling deploy replaces servers one at a time. Each one has to stop taking traffic before it stops serving, finish
what it was doing, and send the clients that were holding a connection open somewhere else. `shutdown(server, http)`
does that, in this order:

1. **Readiness turns false**, so the balancer stops sending traffic. A request that still arrives is refused with
   `503` and `unavailable`, which the client library retries elsewhere.
2. **Live queries and streams end** with a retryable `unavailable` ("The server is shutting down"). They would never end
   on their own. A WebSocket closes as a server going away (1001) once those frames are out.
3. **Batches already running finish**: a command that has started is left to complete and answer. `drain()` waits for
   them, up to `timeoutMs` (default 10 seconds).
4. **Connections close and the server stops hearing the relay.**

Give the platform a grace period longer than `timeoutMs` (Kubernetes: `terminationGracePeriodSeconds`), and let the
readiness probe fail at least once before the process is killed, so the balancer has stopped routing by then.

`server.drain()` and `server.close()` are the two halves for a transport of your own; `server.draining` is the signal
they abort, and `server.inflight` the batches still running.

## On the JVM

The same shape, with the same routes and the same wire format on the relay, so TypeScript and JVM servers can stand
behind one balancer and share one Postgres:

```kotlin
val idempotency = JdbcIdempotencyStore(dataSource::getConnection)
val relay = PgRelay(PgNotifications(dataSource.connection), dataSource::getConnection)
idempotency.migrate(); relay.migrate() // safe on every instance at start

val server = RayfoldServer(ir, resolvers, idempotency = idempotency, relay = relay)
runBlocking { server.ready() } // suspends until the relay is listening
// RayfoldHttp(server, ...).start(4000, "/rayfold", "0.0.0.0") serves GET /rayfold/health and /rayfold/ready to the
// balancer (start alone listens on loopback); to stop, runBlocking { server.drain(); server.close() }
```

Under Spring Boot the starter wires `IdempotencyStore` and `Relay` beans in, serves both routes, and drains when the
context closes, so a `SIGTERM` to the application stops it the way a rolling deploy needs
([JDBC](jdbc.md), [Java and Spring](java-spring.md)).
