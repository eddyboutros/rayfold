export * from "./ir.ts";
export { tokenize, TokenStream, RayfoldSyntaxError, type Token, type TokenKind } from "./lexer.ts";
export { parseSchemaText } from "./parser.ts";
export { validateIR, assertValid, fieldsOf, KNOWN_ANNOTATIONS, RayfoldSchemaError, type Diagnostic } from "./validate.ts";
export {
  parseShapeText,
  parseShape,
  parseLiteral,
  parseShapeValue,
  shapeToString,
  canonicalShape,
  shapeIdOf,
  isShapeId,
  type ViewResolver,
} from "./shape.ts";
export { ExprError,
  parseExpr,
  parseExprText,
  evalExpr,
  exprToString,
  exprPaths,
  referencesViewer,
  isPushable,
  type ExprEnv,
  type BareRoot,
} from "./expr.ts";
export { canonicalJson, sha256Hex, hashJson, base64url, base64urlBytes, fromBase64url } from "./canonical.ts";
export { loadSchema, schemaHash, type LoadedSchema } from "./load.ts";
export { printSchemaText } from "./print.ts";
export { diffSchemas, isBreaking, type Change, type ChangeLevel, type DiffOptions } from "./diff.ts";
export { generateTypeScript } from "./gen-ts.ts";
export { generateKotlin } from "./gen-kotlin.ts";
export { generateJava } from "./gen-java.ts";
