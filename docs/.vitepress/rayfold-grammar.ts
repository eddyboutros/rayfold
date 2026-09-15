/** A TextMate grammar for schema files, so ```rayfold code blocks are highlighted like any other language. */
export const rayfoldGrammar = {
  name: "rayfold",
  scopeName: "source.rayfold",
  patterns: [
    { include: "#comment" },
    { include: "#docstring" },
    { include: "#string" },
    { include: "#annotation" },
    { include: "#keyword" },
    { include: "#number" },
    { include: "#type" },
    { include: "#field" },
  ],
  repository: {
    comment: {
      patterns: [
        { name: "comment.line.double-slash.rayfold", match: "//.*$" },
        { name: "comment.block.rayfold", begin: "/\\*", end: "\\*/" },
      ],
    },
    docstring: { name: "string.quoted.triple.rayfold", begin: '"""', end: '"""' },
    string: {
      name: "string.quoted.double.rayfold",
      begin: '"',
      end: '"',
      patterns: [{ name: "constant.character.escape.rayfold", match: "\\\\." }],
    },
    annotation: { name: "entity.name.function.decorator.rayfold", match: "@[A-Za-z_][\\w.]*" },
    keyword: {
      name: "keyword.control.rayfold",
      match: "\\b(entity|object|input|enum|union|scalar|error|event|query|command|stream|view|throws|emits|implements)\\b",
    },
    number: { name: "constant.numeric.rayfold", match: "(?<![\\w.])-?\\d+(?:\\.\\d+)?(?:ms|s|m|h|d)?\\b" },
    type: { name: "entity.name.type.rayfold", match: "\\b[A-Z][A-Za-z0-9_]*\\b" },
    field: { name: "variable.other.property.rayfold", match: "\\b[a-z_][A-Za-z0-9_]*(?=\\s*[(:=])" },
  },
};
