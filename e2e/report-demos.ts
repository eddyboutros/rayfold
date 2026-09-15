/**
 * The reel: one frame in which every advantage plays, for e2e/report.html.
 *
 * Twelve scenes and a closing card cross-fade inside a single fixed stage - `#reel` - on a loop, so a screen
 * recording of that rectangle alone is a finished film. Each scene says in plain words what it is showing, plays the
 * mechanism, and ends with the same three-way comparison the tables further down the page measured.
 *
 * Every comparison line here restates a row of e2e/results.json. Nothing claims a win the suite did not measure.
 *
 * Everything is progressive. With no JavaScript, or with `prefers-reduced-motion`, the first scene simply shows
 * finished - code fully typed, data already updated - and the chapter dots switch scenes without animating.
 *
 * Inside a scene the mechanism is one attribute: while it plays the scene carries `data-step`, an element with class
 * `s1` appears at step 1, `s2` at step 2, `s3` at step 3, and an element with class `u1` is visible *until* step 2.
 * With no `data-step` - the resting state - every `sN` is shown and every `uN` is hidden.
 */
export const demosHtml = `<section id="demos">
<style>
#demos .reel { position: relative; max-width: 1000px; background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; overflow: hidden; margin-top: 20px; }
#demos .reel-bar { height: 3px; background: var(--soft); }
#demos .reel-bar i { display: block; height: 100%; width: 0; background: var(--rayfold); }
#demos .reel-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; padding: 15px 20px 0; }
#demos .reel-head .n { grid-column: 1; font: 500 11px/1 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .1em; color: var(--muted); }
#demos .reel-head h3 { grid-column: 1; margin: 0; font-size: 23px; }
#demos .reel-head .why { grid-column: 1; margin: 0; font-size: 14px; color: var(--muted); max-width: 74ch; min-height: 40px; }
#demos .chapters { grid-column: 2; grid-row: 1 / span 3; display: flex; gap: 4px; align-items: flex-start; flex-wrap: wrap; justify-content: flex-end; max-width: 232px; }
#demos .chapter { width: 22px; height: 22px; padding: 0; font: 500 10px/1 "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); background: none; border: 1px solid var(--rule); border-radius: 50%; cursor: pointer; }
#demos .chapter.on { background: var(--rayfold); border-color: var(--rayfold); color: var(--on-accent); }
#demos .reel-stage { position: relative; min-height: 336px; margin: 12px 20px 0; }
@media (max-width: 880px) { #demos .reel-stage { min-height: 660px; } }
#demos .scene { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1.02fr) minmax(0, 1fr); grid-template-rows: auto auto; gap: 12px 18px; align-content: center; transition: opacity .5s ease, transform .5s ease; }
@media (max-width: 880px) { #demos .scene { grid-template-columns: minmax(0, 1fr); } }
#demos .scene + .scene { opacity: 0; }
#demos .reel[data-js] .scene { opacity: 0; transform: translateY(10px); pointer-events: none; }
#demos .reel[data-js] .scene.on { opacity: 1; transform: none; pointer-events: auto; }
#demos .reel-foot { display: flex; align-items: center; gap: 10px; padding: 14px 20px 16px; }
#demos .caption { margin: 0; font-size: 13.5px; color: var(--muted); }
#demos .controls { display: flex; gap: 6px; justify-content: flex-end; max-width: 1000px; margin-top: 10px; }
#demos .controls button { font: 500 12px/1 "IBM Plex Mono", ui-monospace, monospace; color: var(--rayfold-ink); background: none; border: 1px solid var(--rule); border-radius: 999px; padding: 7px 13px; cursor: pointer; }
#demos .controls button:hover { background: var(--soft); }

#demos pre.code { grid-column: 1; grid-row: 1; margin: 0; font: 11.5px/1.65 "IBM Plex Mono", ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); border-radius: 8px; padding: 12px 13px; align-self: center; min-height: 112px; }
#demos pre.code .caret { border-right: 2px solid var(--rayfold); margin-left: 1px; animation: demo-blink 1s steps(1) infinite; }
@keyframes demo-blink { 50% { opacity: 0; } }
#demos .stage { grid-column: 2; grid-row: 1; display: grid; gap: 9px; align-content: center; }
@media (max-width: 880px) { #demos .stage { grid-column: 1; grid-row: auto; } }
#demos .scene.wide .stage { grid-column: 1 / -1; }
#demos .stage-label { font: 500 11px/1.4 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
#demos .frame { font: 11px/1.5 "IBM Plex Mono", ui-monospace, monospace; background: var(--ground); border: 1px solid var(--rule); border-left: 3px solid var(--rayfold); border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
#demos .frame.bad { border-left-color: var(--warn); }

/* the three-way comparison every scene ends on */
#demos .verdict { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
@media (max-width: 880px) { #demos .verdict { grid-template-columns: minmax(0, 1fr); } }
#demos .v-cell { background: var(--ground); border: 1px solid var(--rule); border-radius: 8px; padding: 9px 11px; display: grid; gap: 3px; align-content: start; font-size: 12.5px; }
#demos .v-cell.win { background: var(--lead-bg); border-color: var(--rayfold); }
#demos .v-who { font: 600 10.5px/1 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; }
#demos .v-rest { color: var(--rest); } #demos .v-gql { color: var(--gql); } #demos .v-rf { color: var(--rayfold-ink); }

/* sN appears at step N, uN hides from step 2 on, and with no step at all everything is finished */
#demos .scene[data-step="0"] .s1, #demos .scene[data-step="0"] .s2, #demos .scene[data-step="0"] .s3,
#demos .scene[data-step="1"] .s2, #demos .scene[data-step="1"] .s3,
#demos .scene[data-step="2"] .s3 { opacity: 0; transform: translateY(6px); }
#demos .s1, #demos .s2, #demos .s3 { transition: opacity .4s ease .16s, transform .4s ease .16s; }
#demos .u1 { opacity: 0; transition: opacity .22s ease; }
#demos .u1.collapse { max-height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; transition: opacity .22s ease, max-height .3s ease, padding .3s ease; }
#demos .scene[data-step="0"] .u1, #demos .scene[data-step="1"] .u1 { opacity: 1; }
#demos .scene[data-step="0"] .u1.collapse, #demos .scene[data-step="1"] .u1.collapse { max-height: 44px; padding-top: 7px; padding-bottom: 7px; }
#demos .swap { display: inline-grid; }
#demos .swap > * { grid-area: 1 / 1; }
#demos .framestack { display: grid; }
#demos .framestack > * { grid-area: 1 / 1; }

/* small parts the scenes are built from */
#demos .board { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
#demos .col { background: var(--ground); border: 1px solid var(--rule); border-radius: 8px; padding: 8px; display: grid; gap: 6px; align-content: start; min-height: 104px; }
#demos .col-h { font: 500 10.5px/1 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; justify-content: space-between; }
#demos .ticket { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 6px 8px; font-size: 12px; }
#demos .ticket.lit { border-color: var(--rayfold); box-shadow: 0 0 0 2px var(--lead-bg); }
#demos .elsewhere { font-size: 12.5px; color: var(--muted); display: flex; align-items: center; gap: 7px; }
#demos .elsewhere::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--gql); flex: none; }
#demos .reqs { display: grid; gap: 5px; font: 11px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
#demos .reqs span { background: var(--ground); border: 1px solid var(--rule); border-radius: 5px; padding: 5px 8px; }
#demos .reqs span.rf { border-color: var(--rayfold); background: var(--lead-bg); }
#demos .trips { display: grid; gap: 9px; }
#demos .trip { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 9px; align-items: center; }
#demos .trip .who { font: 500 11.5px/1 "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); }
#demos .hops { display: flex; gap: 5px; }
#demos .hop { height: 15px; border-radius: 4px; flex: 1; }
#demos .hop.rest { background: var(--rest); } #demos .hop.rf { background: var(--rayfold); }
#demos .fields { display: grid; gap: 4px; font: 12px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
#demos .fields .f { padding: 3px 8px; border-radius: 5px; background: var(--ground); }
#demos .fields .f.keep { background: var(--lead-bg); }
#demos .fields .f.drop { transition: opacity .4s ease, max-height .4s ease, padding .4s ease; max-height: 0; padding-top: 0; padding-bottom: 0; opacity: 0; overflow: hidden; }
#demos .scene[data-step="0"] .fields .f.drop, #demos .scene[data-step="1"] .fields .f.drop { max-height: 28px; padding-top: 3px; padding-bottom: 3px; opacity: 1; }
#demos .screens { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
#demos .screen { background: var(--ground); border: 1px solid var(--rule); border-radius: 8px; padding: 10px; display: grid; gap: 4px; transition: border-color .3s ease .16s; }
#demos .screen .t { font: 500 10.5px/1 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
#demos .screen .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
#demos .scene:not([data-step]) .screen, #demos .scene[data-step="2"] .screen, #demos .scene[data-step="3"] .screen { border-color: var(--rayfold); }
#demos .count { display: flex; align-items: baseline; gap: 9px; }
#demos .count .big { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
#demos .count .unit { font-size: 13px; color: var(--muted); }
#demos .chips { display: flex; flex-wrap: wrap; gap: 3px; }
#demos .chips i { width: 13px; height: 17px; border-radius: 2px; background: var(--rule); display: block; }
#demos .viewer { display: inline-grid; justify-self: start; border: 1px solid var(--rule); border-radius: 999px; overflow: hidden; font: 500 11.5px/1 "IBM Plex Mono", ui-monospace, monospace; }
#demos .viewer > span { grid-area: 1 / 1; padding: 7px 11px; text-align: center; background: var(--rayfold); color: var(--on-accent); }
#demos .ways { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
#demos .way { display: flex; align-items: center; gap: 7px; font-size: 12px; background: var(--ground); border: 1px solid var(--rule); border-radius: 6px; padding: 6px 9px; }
#demos .way b { color: var(--good); font-weight: 700; }
#demos .lines { display: grid; gap: 5px; font: 11.5px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
#demos .lines span { display: flex; gap: 8px; }
#demos .lines b { color: var(--good); font-weight: 700; }
#demos .lines em { color: var(--warn-ink); font-style: normal; font-weight: 700; }

/* the closing card */
#demos .scene.closing { grid-template-columns: minmax(0, 1fr); align-content: center; justify-items: center; text-align: center; gap: 14px; }
#demos .closing .big-claim { font-family: "Barlow Condensed", "Arial Narrow", sans-serif; font-size: clamp(34px, 5vw, 52px); font-weight: 700; line-height: 1; margin: 0; }
#demos .closing .soon { font: 600 12px/1 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--on-accent); background: var(--rayfold); border-radius: 999px; padding: 9px 16px; }
#demos .closing .facts { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; font-size: 12.5px; color: var(--muted); }
#demos .closing .facts span { background: var(--ground); border: 1px solid var(--rule); border-radius: 999px; padding: 7px 13px; }
@media (prefers-reduced-motion: reduce) { #demos .scene, #demos .s1, #demos .s2, #demos .s3, #demos .u1, #demos .fields .f.drop, #demos .screen { transition: none; } }
</style>

  <span class="eyebrow">See it work</span>
  <h2>Twelve things REST and GraphQL make you do, that this protocol does for you</h2>
  <p class="lede">One frame, on a loop. Each scene shows a real request, what comes back, and how the same job goes on
  REST and on GraphQL. Every comparison here is a row from the measured tables further down this page.</p>

  <div class="reel" id="reel">
    <div class="reel-bar"><i></i></div>
    <div class="reel-head">
      <span class="n">1 / 13</span>
      <h3>Your screens update themselves</h3>
      <p class="why">Add live: true to a normal read. When someone else changes the data, the server sends just the part that changed.</p>
      <div class="chapters"></div>
    </div>

    <div class="reel-stage">

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="Your screens update themselves"
        data-why="Add live: true to a normal read. When someone else changes the data, the server sends just the part that changed."
        data-caption="Someone else moved a card. Your app received the one row that changed, not the whole board.">
        <pre class="code">{ "ops": [ { "id": 1, "op": "issues",
             "shape": "{ items { id title state } }",
             "live": true } ] }</pre>
        <div class="stage">
          <span class="stage-label">Your board, open</span>
          <div class="board">
            <div class="col"><span class="col-h">Todo <span class="swap"><b class="u1">2</b><b class="s2">1</b></span></span>
              <div class="ticket">Retry on 429</div>
              <div class="ticket u1 collapse">Cursor resumes after reconnect</div>
            </div>
            <div class="col"><span class="col-h">In review <span class="swap"><b class="u1">1</b><b class="s2">2</b></span></span>
              <div class="ticket">Batch loader for labels</div>
              <div class="ticket lit s2">Cursor resumes after reconnect</div>
            </div>
          </div>
          <span class="elsewhere s1">Someone else moves that card, on another machine</span>
          <div class="frame s2">{"id":1,"patch":[{"set":"Issue:i7","value":{"state":"IN_REVIEW"}}]}</div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>An events endpoint, then fetch the whole board again</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>A subscription, a resolver, and merge code you write</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>One changed row arrives. No client code at all</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="One request per screen"
        data-why="A product page needs a book, the author who wrote it, and its reviews. That is one request, not three."
        data-caption="Measured on the same page with the same data. Every trip saved is time a phone spends waiting.">
        <pre class="code">{ "ops": [ { "id": 1, "op": "book", "args": { "id": "b1" },
             "shape": "{ title author { name }
                         reviews { rating } }" } ] }</pre>
        <div class="stage">
          <span class="stage-label">What goes over the network</span>
          <div class="reqs">
            <span class="u1">GET /books/b1</span>
            <span class="u1">GET /authors/a1</span>
            <span class="u1">GET /reviews?bookId=b1&amp;limit=3</span>
            <span class="rf s2">POST /api &nbsp;- the whole page, once</span>
          </div>
          <div class="count s2"><span class="big">177</span><span class="unit">bytes, against 466 over REST</span></div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>3 requests in 2 waves, 466 bytes</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>1 request, 332 bytes</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>1 request, 177 bytes</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="Two steps, one trip"
        data-why="Place an order, then pay for it. The second step uses an id the first step has not sent back yet."
        data-caption="The server runs them in order and answers both together. Your app never waits in the middle.">
        <pre class="code">{ "ops": [
  { "id": 1, "op": "placeOrder", "args": { ... }, "key": "idem-7f3a" },
  { "id": 2, "op": "payOrder",
    "args": { "id": { "$ref": "1.id" } } } ] }</pre>
        <div class="stage">
          <span class="stage-label">Network waits, for the same work</span>
          <div class="trips">
            <div class="trip"><span class="who">REST</span><div class="hops"><i class="hop rest"></i><i class="hop rest s1"></i></div></div>
            <div class="trip"><span class="who">New</span><div class="hops"><i class="hop rf"></i></div></div>
          </div>
          <div class="frame s2">{"id":1,"ok":{"$type":"Order","id":"o1"}}
{"id":2,"ok":{"$type":"Order","id":"o1","status":"PAID"}}</div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>2 trips: the second needs the first one's id</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>2 trips: a mutation cannot feed another</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>1 trip</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="Only the fields you need"
        data-why="A shape names what comes back. Send no shape and you get a sensible default, so a plain curl call still works."
        data-caption="Twenty books, only the id and the title wanted. About a quarter of REST's bytes cross the network.">
        <pre class="code">{ "ops": [ { "id": 1, "op": "books",
             "shape": "{ items { id title } }" } ] }</pre>
        <div class="stage">
          <span class="stage-label">What comes back, per book</span>
          <div class="fields">
            <span class="f keep">id: "b1"</span>
            <span class="f keep">title: "The Dispossessed"</span>
            <span class="f drop">format: "PAPERBACK"</span>
            <span class="f drop">price: "12.99"</span>
            <span class="f drop">stock: 5</span>
            <span class="f drop">authorId: "a1"</span>
            <span class="f drop">ownerId: "u1"</span>
          </div>
          <span class="elsewhere s2">Five fields the screen never showed did not cross the network</span>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>2,375 bytes: whole records, every time</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>821 bytes</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>635 bytes on the binary wire</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="One database lookup, not twenty"
        data-why="A field that loads related data is handed the whole list at once. There is no other way to write it here."
        data-caption="This is the N+1 problem, the one that quietly costs companies their database. Here the fast version is the only version.">
        <pre class="code">fields: {
  Book: { author: (books) => authorsOf(books) }
}</pre>
        <div class="stage">
          <span class="stage-label">20 books, each with its author's name</span>
          <div class="chips"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="count"><span class="big swap"><b class="u1">20</b><b class="s2">1</b></span><span class="unit">lookups for the authors</span></div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>9 extra requests, made by the client</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>20, unless someone hand-writes a loader</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>1, always</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="One write fixes every open screen"
        data-why="A write answers with patches: short statements of what changed. Every screen already showing that row corrects itself."
        data-caption="No refetch, and no cache-invalidation code to write or maintain.">
        <pre class="code">{ "ops": [ { "id": 1, "op": "restock",
             "args": { "bookId": "b1", "qty": 3 },
             "key": "restock-91c2" } ] }</pre>
        <div class="stage">
          <span class="stage-label">Two screens, both already open</span>
          <div class="screens">
            <div class="screen"><span class="t">Product page</span><span class="v">stock <span class="swap"><b class="u1">5</b><b class="s2">8</b></span></span></div>
            <div class="screen"><span class="t">Stock list</span><span class="v">stock <span class="swap"><b class="u1">5</b><b class="s2">8</b></span></span></div>
          </div>
          <div class="frame s1">{"id":1,"ok":{"$type":"Book","id":"b1","stock":8},
 "patch":[{"set":"Book:b1","value":{"stock":8}}]}</div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>Fetch the list again, or show something stale</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>Fetch again, or write your own cache updates</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>0 extra requests: the change came with the write</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3600"
        data-title="A retry cannot charge twice"
        data-why="Every write carries a key. If the connection drops and your app sends it again, the server returns the first answer instead of doing the work twice."
        data-caption="Measured by actually retrying the call, not by reading the documentation.">
        <pre class="code">POST /api  { "op": "placeOrder", "key": "idem-7f3a" }
POST /api  { "op": "placeOrder", "key": "idem-7f3a" }</pre>
        <div class="stage">
          <span class="stage-label">The same order, sent twice</span>
          <div class="frame s1">{"id":1,"ok":{"$type":"Order","id":"o1"},"meta":{"replay":true}}</div>
          <div class="count s2"><span class="big">1</span><span class="unit">order created, not 2</span></div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>A duplicate, unless every client remembers the header</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>A duplicate: there is no idempotency concept</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>The key is required, so the retry is free</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3800"
        data-title="Bad input never reaches your data"
        data-why="Types and limits are written in the schema, so a wrong value is refused before any of your code runs. And the failures have names."
        data-caption="A client can handle OutOfStock. It cannot handle a 409 whose body shape nobody wrote down.">
        <pre class="code">command placeOrder(qty: Int @range(min: 1)): Order
  throws OutOfStock { bookId: ID, available: Int }</pre>
        <div class="stage">
          <span class="stage-label">Someone sends qty: 0</span>
          <div class="frame bad s1">{"id":1,"error":{"code":"invalid_argument",
  "message":"qty must be at least 1","path":"qty"}}</div>
          <div class="frame s2">{"id":2,"error":{"code":"domain","type":"OutOfStock",
  "data":{"bookId":"b4","available":0}}}</div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>Both bad orders were created. Error shape by convention</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>Type error only. qty 0 got through</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>Both refused, nothing written, errors typed</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3800"
        data-title="Permissions live in the schema"
        data-why="Who may read a field is written on the field, once. The same rule holds however the caller arrives."
        data-caption="A caller who may not read it gets an explicit refusal, not a silent null to misread.">
        <pre class="code">entity Book {
  price: Decimal
  costPrice: Decimal? @allow(read: viewer.role == "admin")
}</pre>
        <div class="stage">
          <span class="stage-label">The same query, two callers</span>
          <div class="viewer"><span class="u1">viewer: admin</span><span class="s2">viewer: customer</span></div>
          <div class="framestack">
            <div class="frame u1">{"data":{"id":"b1","price":"12.99","costPrice":"7.10"}}</div>
            <div class="frame s2">{"data":{"id":"b1","price":"12.99"}}</div>
          </div>
          <div class="ways s3">
            <span class="way"><b>ok</b> batches</span>
            <span class="way"><b>ok</b> REST routes</span>
            <span class="way"><b>ok</b> live updates</span>
            <span class="way"><b>ok</b> AI tools</span>
          </div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>Repeated in every handler that touches the field</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>Repeated in every resolver, and null when denied</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>Written once, enforced on every way in</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3800"
        data-title="An abusive query is refused before it runs"
        data-why="The cost of a call is worked out from the schema before anything executes, and checked against a budget you set."
        data-caption="Your limit is a number in the schema, not a plugin you hope someone configured.">
        <pre class="code">query search(page: PageArgs) @cost(base: 5, perItem: 1)
# a caller asks for 200 x 200 x 200 nested items</pre>
        <div class="stage">
          <span class="stage-label">What the server does with it</span>
          <div class="frame bad s1">{"id":1,"error":{"code":"resource_exhausted",
  "message":"cost 8,120,000 over the budget of 1,000"}}</div>
          <div class="count s2"><span class="big">0</span><span class="unit">database queries were run</span></div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>No query language, so no query to abuse</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>It runs, unless a cost plugin was added</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>Refused before execution, from the schema</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3800"
        data-title="Your API is already an AI tool"
        data-why="Every server is also an MCP server. Assistants get typed tools with no adapter, and can try a write without doing it."
        data-caption="A dry run is part of the protocol: simulate reports what would happen and writes nothing.">
        <pre class="code">POST /mcp   { "method": "tools/list" }
POST /api  { "op": "placeOrder", "simulate": true }</pre>
        <div class="stage">
          <span class="stage-label">What the assistant sees</span>
          <div class="frame s1">tools: book, books, placeOrder, payOrder, restock
each with JSON Schema in and out, and its typed errors</div>
          <div class="frame s2">{"id":1,"ok":{"simulated":true,"wouldCharge":"12.99"}}</div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>Hand-written OpenAPI plus an adapter. No dry run</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>Introspection plus custom glue. No dry run</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>Nothing to write. Dry runs built in</span></div>
        </div>
      </section>

      <section class="scene" data-steps="3" data-delay="1500" data-hold="3800"
        data-title="Remove a field without breaking anyone"
        data-why="The schema records when a field is going away. The server records which clients still ask for it. Your build decides with both."
        data-caption="Evidence before you delete something, instead of a guess and an incident.">
        <pre class="code">costPrice: Decimal? @deprecated(sunset: "2026-12-01",
                               replacement: "margin")</pre>
        <div class="stage">
          <span class="stage-label">the schema check, in your pipeline</span>
          <div class="lines">
            <span class="s1"><em>blocked</em> removed with no notice and no sunset date</span>
            <span class="s2"><em>blocked</em> still asked for by checkout/2.1, 4 days ago</span>
            <span class="s3"><b>allowed</b> sunset passed, no client asked in 30 days</span>
          </div>
        </div>
        <div class="verdict s3">
          <div class="v-cell"><span class="v-who v-rest">REST</span><span>No field-level contract: every removal just ships</span></div>
          <div class="v-cell"><span class="v-who v-gql">GraphQL</span><span>Flags every removal, and knows nothing about sunsets</span></div>
          <div class="v-cell win"><span class="v-who v-rf">New protocol</span><span>Blocked early, allowed once it is provably safe</span></div>
        </div>
      </section>

      <section class="scene closing wide" data-steps="3" data-delay="1200" data-hold="4400"
        data-title="The alternative to REST and GraphQL"
        data-why="One protocol for reads, writes, live updates and AI tools, with the rules in the contract instead of in every handler."
        data-caption="Every number in this film is reproducible: npm run e2e, npm run bench.">
        <div class="stage">
          <p class="big-claim">One protocol.<br>Fewer requests, fewer bugs,<br>fewer things to remember.</p>
          <div class="facts s1">
            <span>Ahead on 15 of 15 measured tasks</span>
            <span>TypeScript and Kotlin, same frames</span>
            <span>Open source, Apache-2.0</span>
          </div>
          <span class="soon s2">Launching soon</span>
        </div>
      </section>

    </div>

    <div class="reel-foot">
      <p class="caption">Someone else moved a card. Your app received the one row that changed, not the whole board.</p>
    </div>
  </div>

  <div class="controls">
    <button class="toggle" type="button">Play</button>
    <button class="restart" type="button">Restart</button>
  </div>

<script>
(function () {
  var reel = document.getElementById("reel");
  if (!reel) return;
  var scenes = Array.prototype.slice.call(reel.querySelectorAll(".scene"));
  if (!scenes.length) return;

  var bar = reel.querySelector(".reel-bar i");
  var numEl = reel.querySelector(".reel-head .n");
  var titleEl = reel.querySelector(".reel-head h3");
  var whyEl = reel.querySelector(".reel-head .why");
  var captionEl = reel.querySelector(".caption");
  var chapterBox = reel.querySelector(".chapters");
  // the buttons sit below the reel, outside the frame a recording keeps
  var controls = document.querySelector("#demos .controls");
  var toggle = controls && controls.querySelector(".toggle");
  var restart = controls && controls.querySelector(".restart");
  var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var timers = [];
  var raf = null;
  var at = 0;
  var playing = false;
  // how far the current scene has played: offset ms had passed when its clock last started, at startedAt, in a scene
  // length ms long (0 while a scene is shown finished)
  var offset = 0;
  var startedAt = 0;
  var length = 0;
  reel.setAttribute("data-js", "");

  // one dot per scene, so the frame stays the same size however many scenes there are
  var chapters = scenes.map(function (scene, i) {
    var dot = document.createElement("button");
    dot.type = "button";
    dot.className = "chapter" + (i === 0 ? " on" : "");
    dot.textContent = String(i + 1);
    dot.title = scene.getAttribute("data-title") || "";
    dot.addEventListener("click", function () { run(i, 0); });
    if (chapterBox) chapterBox.appendChild(dot);
    return dot;
  });

  function clear() {
    timers.forEach(clearTimeout);
    timers = [];
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function sourceOf(pre) {
    if (pre.rayfoldSource === undefined) pre.rayfoldSource = pre.textContent;
    return pre.rayfoldSource;
  }

  function now() { return performance.now(); }

  // the bar stands at the share of the scene played so far and, while the scene moves, fills the rest at its pace
  function progress(moving) {
    if (!bar) return;
    bar.style.transition = "none";
    bar.style.width = length ? Math.round(1000 * offset / length) / 10 + "%" : "0%";
    if (!moving || !length) return;
    void bar.offsetWidth;
    bar.style.transition = "width " + (length - offset) + "ms linear";
    bar.style.width = "100%";
  }

  // the title, the sentence and the caption belong to the scene, so the frame reads as one thing on a recording
  function dress(scene, n) {
    if (numEl) numEl.textContent = (n + 1) + " / " + scenes.length;
    if (titleEl) titleEl.textContent = scene.getAttribute("data-title") || "";
    if (whyEl) whyEl.textContent = scene.getAttribute("data-why") || "";
    if (captionEl) captionEl.textContent = scene.getAttribute("data-caption") || "";
    chapters.forEach(function (c, i) { c.classList.toggle("on", i === n); });
    scenes.forEach(function (s, i) { s.classList.toggle("on", i === n); });
  }

  // types the code in over ms, starting from ms in, so a scene played on after a pause carries on mid-line
  function typeInto(pre, text, ms, from) {
    if (!pre) return;
    var typed = function (t) { return text.slice(0, Math.ceil(Math.min(1, t / ms) * text.length)); };
    pre.textContent = "";
    var body = document.createTextNode(typed(from));
    var caret = document.createElement("i");
    caret.className = "caret";
    pre.appendChild(body);
    pre.appendChild(caret);
    var began = now() - from;
    function step() {
      var t = now() - began;
      body.nodeValue = typed(t);
      if (t < ms) { raf = requestAnimationFrame(step); return; }
      raf = null;
      if (caret.parentNode) caret.parentNode.removeChild(caret);
    }
    raf = requestAnimationFrame(step);
  }

  function finish(scene) {
    scene.removeAttribute("data-step");
    var pre = scene.querySelector("pre.code");
    if (pre) pre.textContent = sourceOf(pre);
  }

  // shows scene n as it stands from ms into its timeline and plays on from there; paused, it shows the scene finished
  function run(n, from) {
    clear();
    at = ((n % scenes.length) + scenes.length) % scenes.length;
    scenes.forEach(function (s, i) { if (i !== at) finish(s); });
    var scene = scenes[at];
    dress(scene, at);
    offset = from;
    startedAt = now();
    length = 0;

    if (!playing || still) { finish(scene); progress(false); return; }

    var pre = scene.querySelector("pre.code");
    var text = pre ? sourceOf(pre) : "";
    var steps = Number(scene.getAttribute("data-steps") || 3);
    var delay = Number(scene.getAttribute("data-delay") || 1000);
    var hold = Number(scene.getAttribute("data-hold") || 1700);
    var typing = text ? Math.max(650, Math.min(1600, text.length * 8)) : 250;
    length = typing + steps * delay + hold;

    var reached = 0;
    for (var k = 1; k <= steps; k++) if (typing + k * delay <= from) reached = k;
    if (reached === steps) scene.removeAttribute("data-step");
    else scene.setAttribute("data-step", String(reached));
    progress(true);

    // the clock drives the scene and the paint follows it: a hidden tab stops animation frames, never the timers
    if (pre && from < typing + 40) {
      typeInto(pre, text, typing, from);
      later(typing + 40, function () { pre.textContent = text; });
    } else if (pre) pre.textContent = text;
    for (var i = reached + 1; i <= steps; i++) {
      (function (k) {
        later(typing + k * delay, function () {
          if (k === steps) scene.removeAttribute("data-step");
          else scene.setAttribute("data-step", String(k));
        });
      })(i);
    }
    later(length, function () { run(at + 1, 0); });
  }

  // something that happens t ms into the current scene, however much of the scene has already played
  function later(t, fn) { timers.push(setTimeout(fn, t - offset)); }

  function play() { playing = true; if (toggle) toggle.textContent = "Pause"; run(at, offset); }

  // freezes the scene where it stands - the typing, the step and the bar - so Play goes on from that very moment
  function pause() {
    if (length) offset = Math.min(length, offset + now() - startedAt);
    playing = false;
    clear();
    if (toggle) toggle.textContent = "Play";
    progress(false);
  }

  var resumeWhenVisible = false;
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (!playing) return;
      resumeWhenVisible = true;
      pause();
    } else if (resumeWhenVisible) {
      resumeWhenVisible = false;
      play();
    }
  });

  // a choice made with the buttons outlasts the reel's first scroll into view, which would otherwise start it again
  if (toggle) toggle.addEventListener("click", function () { started = true; if (playing) pause(); else play(); });
  if (restart) restart.addEventListener("click", function () { started = true; playing = true; if (toggle) toggle.textContent = "Pause"; run(0, 0); });

  dress(scenes[0], 0);
  if (still) { finish(scenes[0]); if (toggle) toggle.textContent = "Play"; return; }

  if (!("IntersectionObserver" in window)) { play(); return; }
  var started = false;
  var watcher = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting || started) return;
      started = true;
      watcher.disconnect();
      play();
    });
  }, { threshold: 0.4 });
  watcher.observe(reel);
})();
</script>
</section>
`;
