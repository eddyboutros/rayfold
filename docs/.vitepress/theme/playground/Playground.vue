<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import type { Frame, RequestEnvelope } from "@rayfold/server/core";
import { EXAMPLES, type Example, type ViewerName } from "./examples.ts";
import { BOOKSHOP_SCHEMA, createEngine, execute, kindOf, prepare, restock, sizes, type Engine, type FrameKind } from "./engine.ts";
import { createEditor, type Editor } from "./editor.ts";
import { fromHash, toHash } from "./share.ts";

const VIEWER_NAMES: ViewerName[] = ["anonymous", "customer", "staff"];
const MAX_FRAMES = 200;
const HINT: Record<FrameKind, string> = {
  data: "the query's result",
  ok: "the command's result",
  patch: "a change every client cache applies",
  item: "one item of a stream",
  error: "an error",
  fin: "finished",
};

interface Shown { n: number; kind: FrameKind; hint: string; text: string }

const schemaHost = ref<HTMLElement | null>(null);
const requestHost = ref<HTMLElement | null>(null);
const current = ref<Example | null>(EXAMPLES[0] ?? null);
const viewer = ref<ViewerName>(EXAMPLES[0]?.viewer ?? "anonymous");
const frames = ref<Shown[]>([]);
const status = ref<"idle" | "running" | "live">("idle");
const schemaProblem = ref<string | null>(null);
const requestProblem = ref<string | null>(null);
const note = ref<string | null>(null);
const bytes = ref<{ json: number; rb: number } | null>(null);
const liveBook = ref<string | null>(null);
const copied = ref(false);
const engine = shallowRef<Engine | null>(null);

let schemaEditor: Editor | null = null;
let requestEditor: Editor | null = null;
let running: AbortController | null = null;
let schemaTimer: ReturnType<typeof setTimeout> | undefined;

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

function describe(frame: Frame, kind: FrameKind): string {
  const op = "id" in frame ? `op ${frame.id}: ` : "";
  if ("error" in frame) return `${op}${frame.error.type ?? frame.error.code}`;
  return op + HINT[kind];
}

function rebuild(text: string): boolean {
  try {
    engine.value = createEngine(text);
    schemaProblem.value = null;
    return true;
  } catch (e) {
    engine.value = null;
    schemaProblem.value = e instanceof Error ? e.message : String(e);
    return false;
  }
}

function stop() {
  running?.abort();
  running = null;
  status.value = "idle";
}

async function run() {
  stop();
  note.value = null;
  requestProblem.value = null;
  const e = engine.value;
  if (!e || !requestEditor) return;

  let request: RequestEnvelope;
  try {
    request = JSON.parse(requestEditor.get()) as RequestEnvelope;
  } catch (err) {
    requestProblem.value = `The request is not valid JSON: ${(err as Error).message}`;
    return;
  }

  const envelope = prepare(e, request);
  const live = Array.isArray(envelope.ops) ? envelope.ops.find((op) => op?.live) : undefined;
  const liveId = live?.args?.["id"];
  liveBook.value = typeof liveId === "string" ? liveId : null;

  const controller = new AbortController();
  running = controller;
  frames.value = [];
  bytes.value = null;
  status.value = "running";
  const seen: Frame[] = [];
  try {
    for await (const frame of execute(e, envelope, viewer.value, controller.signal)) {
      if (controller.signal.aborted) break;
      seen.push(frame);
      const kind = kindOf(frame);
      frames.value = [...frames.value, { n: seen.length, kind, hint: describe(frame, kind), text: pretty(frame) }].slice(-MAX_FRAMES);
      bytes.value = sizes(e, seen);
      if (live) status.value = "live";
    }
  } catch (err) {
    if (!controller.signal.aborted) requestProblem.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (running === controller) {
      running = null;
      status.value = "idle";
    }
  }
}

function choose(example: Example) {
  current.value = example;
  viewer.value = example.viewer;
  if (schemaEditor && (!engine.value || engine.value.mocked)) {
    schemaEditor.set(BOOKSHOP_SCHEMA);
    rebuild(BOOKSHOP_SCHEMA);
  }
  requestEditor?.set(pretty(example.request));
  void run();
}

function setViewer(name: ViewerName) {
  viewer.value = name;
  void run();
}

function onSchemaChange(text: string) {
  clearTimeout(schemaTimer);
  schemaTimer = setTimeout(() => {
    stop();
    if (rebuild(text)) void run();
  }, 350);
}

function onRequestChange() {
  current.value = null;
}

function resetSchema() {
  schemaEditor?.set(BOOKSHOP_SCHEMA);
}

function resetData() {
  if (schemaEditor && rebuild(schemaEditor.get())) void run();
}

async function restockNow() {
  const e = engine.value;
  const book = liveBook.value;
  if (!e || !book) return;
  const result = await restock(e, book);
  const failed = result.find((f) => "error" in f);
  note.value = failed && "error" in failed ? `Restock failed: ${failed.error.message}` : `Staff added 5 copies of ${book}.`;
}

async function share() {
  if (!schemaEditor || !requestEditor) return;
  const schema = schemaEditor.get();
  const hash = toHash({ request: requestEditor.get(), viewer: viewer.value, ...(sameText(schema, BOOKSHOP_SCHEMA) ? {} : { schema }) });
  history.replaceState(history.state, "", hash);
  try {
    await navigator.clipboard.writeText(location.href);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    note.value = "The link is in the address bar.";
  }
}

onMounted(() => {
  const shared = fromHash(location.hash);
  const schemaText = shared?.schema ?? BOOKSHOP_SCHEMA;
  if (shared) {
    current.value = null;
    viewer.value = shared.viewer;
  }
  schemaEditor = createEditor(schemaHost.value!, { doc: schemaText, language: "rayfold", label: "Schema", onChange: onSchemaChange, onRun: () => void run() });
  requestEditor = createEditor(requestHost.value!, {
    doc: shared?.request ?? pretty(current.value?.request ?? {}),
    language: "json",
    label: "Request",
    onChange: onRequestChange,
    onRun: () => void run(),
  });
  if (rebuild(schemaText)) void run();
});

onBeforeUnmount(() => {
  stop();
  clearTimeout(schemaTimer);
  schemaEditor?.destroy();
  requestEditor?.destroy();
});
</script>

<template>
  <div class="pg">
    <div class="pg-examples" role="toolbar" aria-label="Examples">
      <button v-for="ex in EXAMPLES" :key="ex.id" :class="{ active: current?.id === ex.id }" :aria-pressed="current?.id === ex.id" @click="choose(ex)">
        {{ ex.title }}
      </button>
    </div>
    <p class="pg-summary">{{ current ? current.summary : "Your own request. Pick an example above to start from one of ours." }}</p>

    <div class="pg-grid">
      <section class="pg-pane pg-schema">
        <header class="pg-bar">
          <h2>Schema</h2>
          <span v-if="engine?.mocked" class="pg-badge" title="Not the bookshop schema, so the answers are generated from the schema itself">generated data</span>
          <span class="pg-spacer" />
          <button class="pg-quiet" @click="resetSchema">Bookshop schema</button>
        </header>
        <div ref="schemaHost" class="pg-editor" />
        <p v-if="schemaProblem" class="pg-problem" role="alert">{{ schemaProblem }}</p>
      </section>

      <section class="pg-pane pg-request">
        <header class="pg-bar">
          <h2>Request</h2>
          <span class="pg-spacer" />
          <div class="pg-viewers" role="radiogroup" aria-label="Signed in as">
            <span class="pg-muted">as</span>
            <button v-for="v in VIEWER_NAMES" :key="v" role="radio" :aria-checked="viewer === v" :class="{ active: viewer === v }" @click="setViewer(v)">{{ v }}</button>
          </div>
          <button class="pg-run" :disabled="!engine" @click="run">Run <kbd>Ctrl+Enter</kbd></button>
        </header>
        <div ref="requestHost" class="pg-editor" />
        <p v-if="requestProblem" class="pg-problem" role="alert">{{ requestProblem }}</p>
      </section>

      <section class="pg-pane pg-response">
        <header class="pg-bar">
          <h2>Response</h2>
          <span v-if="status === 'live'" class="pg-live"><span class="pg-dot" />live</span>
          <span class="pg-spacer" />
          <span v-if="bytes" class="pg-bytes" title="The same frames as NDJSON, and in Rayfold's binary format">
            <span>JSON {{ size(bytes.json) }}</span><span>binary {{ size(bytes.rb) }}</span>
          </span>
        </header>
        <div v-if="status === 'live'" class="pg-live-actions">
          <button v-if="liveBook && !engine?.mocked" class="pg-run" @click="restockNow">Restock {{ liveBook }}</button>
          <button class="pg-quiet" @click="stop">Stop</button>
        </div>
        <p v-if="note" class="pg-note">{{ note }}</p>
        <ol class="pg-frames" aria-live="polite">
          <li v-for="f in frames" :key="f.n" :class="['pg-frame', `is-${f.kind}`]">
            <div class="pg-frame-head">
              <span class="pg-kind">{{ f.kind === "fin" ? "done" : f.kind }}</span>
              <span class="pg-muted">{{ f.hint }}</span>
            </div>
            <pre>{{ f.text }}</pre>
          </li>
        </ol>
      </section>
    </div>

    <footer class="pg-foot">
      <button class="pg-quiet" @click="resetData">Reset data</button>
      <button class="pg-quiet" @click="share">{{ copied ? "Link copied" : "Copy link" }}</button>
      <span class="pg-spacer" />
      <span class="pg-muted">This is the Rayfold server itself, running in your browser. Nothing is sent anywhere.</span>
    </footer>
  </div>
</template>

<style scoped>
.pg {
  --pg-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pg-examples {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pg-examples button,
.pg-viewers button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg);
  transition: border-color 0.15s, color 0.15s, background-color 0.15s;
}
.pg-examples button:hover,
.pg-viewers button:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-2);
}
.pg-examples button.active,
.pg-viewers button.active {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.pg-summary {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  min-height: 1.6em;
}
.pg-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  grid-template-rows: minmax(0, 0.9fr) minmax(0, 1.1fr);
  grid-template-areas: "schema request" "schema response";
  gap: 12px;
  height: clamp(560px, calc(100vh - 250px), 900px);
}
.pg-schema { grid-area: schema; }
.pg-request { grid-area: request; }
.pg-response { grid-area: response; }
.pg-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: var(--pg-radius);
  background: var(--vp-c-bg-soft);
  overflow: hidden;
}
.pg-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}
.pg-bar h2 {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-2);
}
.pg-spacer { flex: 1; }
.pg-muted { color: var(--vp-c-text-3); font-size: 13px; }
.pg-editor {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.pg-viewers {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pg-run {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-button-brand-text);
  background: var(--vp-button-brand-bg);
}
.pg-run:hover { background: var(--vp-button-brand-hover-bg); }
.pg-run:disabled { opacity: 0.5; cursor: not-allowed; }
.pg-run kbd {
  font: 11px var(--vp-font-family-mono);
  opacity: 0.75;
}
.pg-quiet {
  font-size: 13px;
  color: var(--vp-c-brand-1);
}
.pg-quiet:hover { text-decoration: underline; }
.pg-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--vp-c-warning-1);
  background: var(--vp-c-warning-soft);
}
.pg-problem {
  margin: 0;
  padding: 8px 12px;
  font: 12px/1.5 var(--vp-font-family-mono);
  white-space: pre-wrap;
  color: var(--vp-c-danger-1);
  background: var(--vp-c-danger-soft);
  border-top: 1px solid var(--vp-c-divider);
  max-height: 40%;
  overflow: auto;
}
.pg-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vp-c-brand-1);
}
.pg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: pg-pulse 1.4s ease-in-out infinite;
}
@keyframes pg-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .pg-dot { animation: none; } }
.pg-bytes {
  display: inline-flex;
  gap: 12px;
  font: 12px var(--vp-font-family-mono);
  color: var(--vp-c-text-2);
  font-variant-numeric: tabular-nums;
}
.pg-live-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 0;
}
.pg-note {
  margin: 8px 12px 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.pg-frames {
  flex: 1;
  min-height: 0;
  overflow: auto;
  list-style: none;
  margin: 0;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pg-frame {
  margin: 0;
  border: 1px solid var(--vp-c-divider);
  border-left: 3px solid var(--pg-kind-color, var(--vp-c-divider));
  border-radius: 8px;
  background: var(--vp-c-bg);
}
.pg-frame-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 6px 10px 0;
}
.pg-kind {
  font: 600 12px var(--vp-font-family-mono);
  color: var(--pg-kind-color, var(--vp-c-text-2));
}
.pg-frame pre {
  margin: 0;
  padding: 4px 10px 8px;
  font: 12px/1.55 var(--vp-font-family-mono);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vp-c-text-1);
}
.is-data, .is-item { --pg-kind-color: var(--vp-c-brand-1); }
.is-ok { --pg-kind-color: var(--pg-ok); }
.is-patch { --pg-kind-color: var(--pg-patch); }
.is-error { --pg-kind-color: var(--vp-c-danger-1); }
.is-fin { --pg-kind-color: var(--vp-c-text-3); }
.pg-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
@media (max-width: 960px) {
  .pg-grid {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
    grid-template-areas: "request" "response" "schema";
    height: auto;
  }
  .pg-editor { height: 280px; flex: none; }
  .pg-response { min-height: 320px; }
}
</style>
