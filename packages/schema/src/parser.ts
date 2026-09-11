/** .rayfold text → IR. Spec: spec/01-schema.md. */
import {
  builtinTypes,
  type AnnotValue,
  type Annotation,
  type ArgDef,
  type EnumValueDef,
  type FieldDef,
  type JsonValue,
  type OpDef,
  type OpKind,
  type RayfoldSchemaIR,
  type TypeDef,
  type TypeRef,
} from "./ir.ts";
import { RayfoldSyntaxError, TokenStream, tokenize, type Token } from "./lexer.ts";
import { parseExpr, type BareRoot } from "./expr.ts";
import { parseLiteral, parseShape } from "./shape.ts";

const DEF_KEYWORDS = new Set([
  "entity",
  "object",
  "input",
  "enum",
  "union",
  "scalar",
  "error",
  "event",
  "view",
  "query",
  "command",
  "stream",
]);

/** Annotations whose arguments are policy expressions. */
const EXPR_ANNOTATIONS = new Set(["allow", "deny"]);
/** Annotations whose single positional/named argument is a type reference. */
const TYPE_ANNOTATIONS = new Set(["input"]);

export function parseSchemaText(src: string): RayfoldSchemaIR {
  return new Parser(new TokenStream(tokenize(src))).parseDocument();
}

class Parser {
  private readonly ir: RayfoldSchemaIR = { rayfold: "0.1", types: builtinTypes(), ops: {}, views: {} };
  private inlineErrorCounter = 0;

  constructor(private readonly ts: TokenStream) {}

  parseDocument(): RayfoldSchemaIR {
    while (!this.ts.at("eof")) this.parseDefinition();
    return this.ir;
  }

  private parseDefinition(): void {
    const doc = this.ts.accept("blockstring")?.value;
    const kw = this.ts.peek();
    if (kw.kind !== "name" || !DEF_KEYWORDS.has(kw.value)) {
      throw this.ts.error(`Expected a definition keyword (entity, query, ...) but found ${JSON.stringify(kw.value)}`);
    }
    this.ts.next();
    switch (kw.value) {
      case "entity":
      case "object":
      case "input":
      case "error":
      case "event":
        this.parseFieldedType(kw.value, doc, kw);
        break;
      case "enum":
        this.parseEnum(doc, kw);
        break;
      case "union":
        this.parseUnion(doc, kw);
        break;
      case "scalar":
        this.parseScalar(doc, kw);
        break;
      case "view":
        this.parseView(kw);
        break;
      case "query":
      case "command":
      case "stream":
        this.parseOp(kw.value, doc, kw);
        break;
      default:
        throw this.ts.error("unreachable");
    }
  }

  private defineType(def: TypeDef, at: Token): void {
    const existing = this.ir.types[def.name];
    if (existing) {
      const why = existing.builtin ? "is a built-in type" : "is already defined";
      throw new RayfoldSyntaxError(`Type ${def.name} ${why}`, at.line, at.col);
    }
    this.ir.types[def.name] = def;
  }

  private parseFieldedType(kind: "entity" | "object" | "input" | "error" | "event", doc: string | undefined, at: Token): void {
    const name = this.ts.expectName();
    const implementsList: string[] = [];
    if (kind === "entity" && this.ts.accept("name", "implements")) {
      implementsList.push(this.ts.expectName());
      while (this.ts.atName() && !this.ts.atPunct("{") && !this.ts.atPunct("@")) implementsList.push(this.ts.expectName());
    }
    const bare: BareRoot = "this";
    const annotations = this.parseAnnotations(bare);
    const fields = this.parseFieldBlock(kind === "input" ? "args" : "this", kind === "input");
    const base = { name, annotations, ...(doc !== undefined ? { description: doc } : {}) };
    let def: TypeDef;
    switch (kind) {
      case "entity":
        def = { kind, ...base, fields, implements: implementsList };
        break;
      case "object": {
        def = { kind, ...base, fields };
        if (annotations.some((a) => a.name === "interface")) def.interface = true;
        break;
      }
      case "input":
        def = { kind, ...base, fields };
        break;
      case "error":
        def = { kind, ...base, fields };
        break;
      case "event":
        def = { kind, ...base, fields };
        break;
    }
    this.defineType(def, at);
  }

  private parseFieldBlock(bare: BareRoot, allowDefaults: boolean): FieldDef[] {
    this.ts.expectPunct("{");
    const fields: FieldDef[] = [];
    const seen = new Set<string>();
    while (!this.ts.atPunct("}")) {
      const doc = this.ts.accept("blockstring")?.value;
      const nameTok = this.ts.expect("name");
      if (seen.has(nameTok.value)) throw this.ts.error(`Duplicate field ${nameTok.value}`, nameTok);
      seen.add(nameTok.value);
      const args = this.ts.atPunct("(") ? this.parseArgs() : [];
      this.ts.expectPunct(":");
      const type = this.parseTypeRef();
      let def: JsonValue | undefined;
      if (this.ts.accept("punct", "=")) {
        if (!allowDefaults) throw this.ts.error("Defaults are only allowed on input fields and arguments", nameTok);
        def = parseLiteral(this.ts);
      }
      const annotations = this.parseAnnotations(bare);
      const ordinal = ordinalOf(annotations, fields.length + 1);
      const f: FieldDef = { name: nameTok.value, type, args, annotations, ordinal };
      if (doc !== undefined) f.description = doc;
      if (def !== undefined) f.default = def;
      fields.push(f);
    }
    this.ts.expectPunct("}");
    return fields;
  }

  private parseArgs(): ArgDef[] {
    this.ts.expectPunct("(");
    const out: ArgDef[] = [];
    const seen = new Set<string>();
    while (!this.ts.atPunct(")")) {
      const doc = this.ts.accept("blockstring")?.value;
      const nameTok = this.ts.expect("name");
      if (seen.has(nameTok.value)) throw this.ts.error(`Duplicate argument ${nameTok.value}`, nameTok);
      seen.add(nameTok.value);
      this.ts.expectPunct(":");
      const type = this.parseTypeRef();
      let def: JsonValue | undefined;
      if (this.ts.accept("punct", "=")) def = parseLiteral(this.ts);
      const annotations = this.parseAnnotations("args");
      const a: ArgDef = { name: nameTok.value, type, annotations };
      if (doc !== undefined) a.description = doc;
      if (def !== undefined) a.default = def;
      out.push(a);
    }
    this.ts.expectPunct(")");
    return out;
  }

  parseTypeRef(): TypeRef {
    if (this.ts.accept("punct", "[")) {
      const of = this.parseTypeRef();
      this.ts.expectPunct("]");
      const nullable = !!this.ts.accept("punct", "?");
      return { kind: "list", of, nullable };
    }
    const name = this.ts.expectName();
    let args: TypeRef[] | undefined;
    if (this.ts.accept("punct", "<")) {
      args = [this.parseTypeRef()];
      while (!this.ts.atPunct(">")) args.push(this.parseTypeRef());
      this.ts.expectPunct(">");
    }
    const nullable = !!this.ts.accept("punct", "?");
    return args ? { kind: "named", name, nullable, args } : { kind: "named", name, nullable };
  }

  private parseAnnotations(bare: BareRoot): Annotation[] {
    const out: Annotation[] = [];
    while (this.ts.atPunct("@")) {
      const at = this.ts.next();
      let name = this.ts.expectName();
      while (this.ts.atPunct(".") && this.ts.peek(1).kind === "name") {
        this.ts.next();
        name += "." + this.ts.expectName();
      }
      const args: Record<string, AnnotValue> = {};
      if (this.ts.accept("punct", "(")) {
        let positional = 0;
        while (!this.ts.atPunct(")")) {
          let key: string;
          if (this.ts.atName() && this.ts.peek(1).kind === "punct" && this.ts.peek(1).value === ":") {
            key = this.ts.expectName();
            this.ts.expectPunct(":");
          } else {
            key = positional === 0 ? "value" : `value${positional}`;
            positional++;
          }
          args[key] = this.parseAnnotValue(name, bare);
        }
        this.ts.expectPunct(")");
      }
      if (out.some((a) => a.name === name)) throw this.ts.error(`Duplicate annotation @${name}`, at);
      out.push({ name, args });
    }
    return out;
  }

  private parseAnnotValue(annot: string, bare: BareRoot): AnnotValue {
    if (EXPR_ANNOTATIONS.has(annot)) return { $expr: parseExpr(this.ts, bare) };
    if (TYPE_ANNOTATIONS.has(annot)) return { $type: this.parseTypeRef() };
    const t = this.ts.peek();
    if (t.kind === "duration") {
      this.ts.next();
      return { $duration: t.num! };
    }
    if (t.kind === "name" && !["true", "false", "null"].includes(t.value)) {
      this.ts.next();
      return { $ident: t.value };
    }
    return parseLiteral(this.ts);
  }

  private parseEnum(doc: string | undefined, at: Token): void {
    const name = this.ts.expectName();
    const annotations = this.parseAnnotations("this");
    this.ts.expectPunct("{");
    const values: EnumValueDef[] = [];
    while (!this.ts.atPunct("}")) {
      const vdoc = this.ts.accept("blockstring")?.value;
      const vt = this.ts.expect("name");
      if (values.some((v) => v.name === vt.value)) throw this.ts.error(`Duplicate enum value ${vt.value}`, vt);
      const vann = this.parseAnnotations("this");
      const v: EnumValueDef = { name: vt.value, annotations: vann, ordinal: ordinalOf(vann, values.length + 1) };
      if (vdoc !== undefined) v.description = vdoc;
      values.push(v);
    }
    this.ts.expectPunct("}");
    const def: TypeDef = { kind: "enum", name, annotations, values };
    if (doc !== undefined) def.description = doc;
    this.defineType(def, at);
  }

  private parseUnion(doc: string | undefined, at: Token): void {
    const name = this.ts.expectName();
    const annotations = this.parseAnnotations("this");
    this.ts.expectPunct("=");
    const members = [this.ts.expectName()];
    while (this.ts.accept("punct", "|")) members.push(this.ts.expectName());
    const def: TypeDef = { kind: "union", name, annotations, members };
    if (doc !== undefined) def.description = doc;
    this.defineType(def, at);
  }

  private parseScalar(doc: string | undefined, at: Token): void {
    const name = this.ts.expectName();
    const annotations = this.parseAnnotations("this");
    const def: TypeDef = { kind: "scalar", name, annotations };
    if (doc !== undefined) def.description = doc;
    this.defineType(def, at);
  }

  private parseView(at: Token): void {
    const type = this.ts.expectName();
    this.ts.expectPunct(".");
    const name = this.ts.expectName();
    this.ts.expectPunct("=");
    const shape = parseShape(this.ts);
    const key = `${type}.${name}`;
    if (this.ir.views[key]) throw new RayfoldSyntaxError(`View ${key} is already defined`, at.line, at.col);
    this.ir.views[key] = { type, name, shape };
  }

  private parseOp(kind: OpKind, doc: string | undefined, at: Token): void {
    const nameTok = this.ts.expect("name");
    if (this.ir.ops[nameTok.value]) throw this.ts.error(`Operation ${nameTok.value} is already defined`, nameTok);
    const args = this.ts.atPunct("(") ? this.parseArgs() : [];
    this.ts.expectPunct(":");
    const returns = this.parseTypeRef();
    const throws: string[] = [];
    const emits: string[] = [];
    let annotations: Annotation[] = [];
    for (;;) {
      if (this.ts.accept("name", "throws")) {
        throws.push(this.parseThrowsItem(nameTok.value));
        while (this.ts.accept("punct", "|")) throws.push(this.parseThrowsItem(nameTok.value));
      } else if (this.ts.accept("name", "emits")) {
        emits.push(this.ts.expectName());
        while (this.ts.atName() && !this.isKeywordAhead()) emits.push(this.ts.expectName());
      } else if (this.ts.atPunct("@")) {
        annotations = annotations.concat(this.parseAnnotations("args"));
      } else break;
    }
    const op: OpDef = { kind, name: nameTok.value, args, returns, throws, emits, annotations };
    if (doc !== undefined) op.description = doc;
    this.ir.ops[nameTok.value] = op;
    void at;
  }

  private isKeywordAhead(): boolean {
    const t = this.ts.peek();
    return t.kind === "name" && (DEF_KEYWORDS.has(t.value) || t.value === "throws" || t.value === "emits");
  }

  /** `Name` or `Name { fields }`; the inline form is hoisted into a named error type. */
  private parseThrowsItem(opName: string): string {
    const nameTok = this.ts.expect("name");
    if (this.ts.atPunct("{")) {
      const fields = this.parseFieldBlock("this", false);
      const existing = this.ir.types[nameTok.value];
      if (existing) {
        if (existing.kind !== "error") throw this.ts.error(`${nameTok.value} is already a ${existing.kind}`, nameTok);
        if (!sameFields(existing.fields, fields)) {
          throw this.ts.error(`Inline error ${nameTok.value} in ${opName} conflicts with an earlier definition`, nameTok);
        }
        return nameTok.value;
      }
      this.inlineErrorCounter++;
      this.ir.types[nameTok.value] = { kind: "error", name: nameTok.value, annotations: [], fields };
    }
    return nameTok.value;
  }
}

function ordinalOf(annotations: Annotation[], fallback: number): number {
  const o = annotations.find((a) => a.name === "ordinal");
  const v = o?.args["value"];
  return typeof v === "number" ? v : fallback;
}

function sameFields(a: FieldDef[], b: FieldDef[]): boolean {
  return JSON.stringify(a.map(stripOrd)) === JSON.stringify(b.map(stripOrd));
}
function stripOrd(f: FieldDef): Omit<FieldDef, "ordinal"> {
  const { ordinal: _o, ...rest } = f;
  return rest;
}
