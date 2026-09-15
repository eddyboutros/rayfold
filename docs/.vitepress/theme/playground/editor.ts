import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const KEYWORDS = /^(entity|object|input|enum|union|scalar|error|event|query|command|stream|view|throws|emits|implements)\b/;

/** Just enough of the schema language to colour it: keywords, annotations, types, strings, numbers, comments. */
const rayfold = StreamLanguage.define<{ inDoc: boolean }>({
  name: "rayfold",
  startState: () => ({ inDoc: false }),
  token(stream, state) {
    if (state.inDoc) {
      if (stream.skipTo('"""')) {
        stream.match('"""');
        state.inDoc = false;
      } else stream.skipToEnd();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match('"""')) {
      state.inDoc = true;
      return "string";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^@[A-Za-z_][\w.]*/)) return "meta";
    if (stream.match(KEYWORDS)) return "keyword";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:ms|s|m|h|d)?/)) return "number";
    if (stream.match(/^[A-Z]\w*/)) return "typeName";
    if (stream.match(/^[a-z_]\w*/)) return "propertyName";
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--pg-keyword)" },
  { tag: tags.string, color: "var(--pg-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--pg-number)" },
  { tag: tags.comment, color: "var(--pg-comment)", fontStyle: "italic" },
  { tag: tags.typeName, color: "var(--pg-type)" },
  { tag: tags.meta, color: "var(--pg-meta)" },
  { tag: tags.propertyName, color: "var(--pg-property)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--vp-c-text-1)" },
  ".cm-scroller": { fontFamily: "var(--vp-font-family-mono)", lineHeight: "1.65" },
  ".cm-content": { padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--vp-c-text-3)" },
  ".cm-activeLine": { backgroundColor: "var(--pg-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--vp-c-text-2)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--vp-c-brand-1)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--pg-selection)" },
  ".cm-matchingBracket": { backgroundColor: "var(--pg-selection)", outline: "none" },
});

export interface Editor {
  get(): string;
  set(text: string): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, options: { doc: string; language: "rayfold" | "json"; label: string; onChange(text: string): void; onRun(): void }): Editor {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        options.language === "json" ? json() : rayfold,
        syntaxHighlighting(highlight),
        theme,
        EditorView.contentAttributes.of({ "aria-label": options.label }),
        keymap.of([{ key: "Mod-Enter", run: () => (options.onRun(), true) }, indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) options.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    get: () => view.state.doc.toString(),
    set: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    destroy: () => view.destroy(),
  };
}
