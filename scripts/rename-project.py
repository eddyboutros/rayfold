"""
Renames the project everywhere: code identifiers, package names, wire identifiers (media types, headers, URL paths,
MCP URIs, schema file extension), prose, folders and files. Generated outputs (test results, conformance fixtures,
the report page, package-lock.json) are not edited: regenerate them by running the tests and `npm install`.

    python scripts/rename-project.py OLD NEW [--dry-run]
    python scripts/rename-project.py rayfold NEWNAME

OLD and NEW are the lower-case base words. Case forms are derived: RAY/Ray/ray, and the binary encoding's
abbreviation is the first letter + B (RB for rayfold); override with --old-binary-abbrev / --binary-abbrev.
Back up first: the project is not under version control.
"""
import argparse, os, re, sys

p = argparse.ArgumentParser()
p.add_argument("old"); p.add_argument("new")
p.add_argument("--dry-run", action="store_true")
p.add_argument("--binary-abbrev", default=None, help="new abbreviation for the binary encoding (default: first letters + B)")
p.add_argument("--old-binary-abbrev", default=None)
a = p.parse_args()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
old, new = a.old.lower(), a.new.lower()
Old, New = old.capitalize(), new.capitalize()
OLD, NEW = old.upper(), new.upper()
ob = (a.old_binary_abbrev or (old[0] + "b")).lower()          # "rb"
nb = (a.binary_abbrev or (new[0] + "b")).lower()
OB, NB, Ob, Nb = ob.upper(), nb.upper(), ob.capitalize(), nb.capitalize()

SKIP_DIRS = {"node_modules", ".git", ".gradle", "build", "raw", ".idea", ".kotlin", "dist"}
SKIP_FILES = {"package-lock.json", "results.json", "methods.json", "security.json", "realdata.json", "report.md", "report.html", "rename-project.py",
              "publishing.md"}  # it names other projects called Ray; edit it by hand
SKIP_PATH_PARTS = [os.path.join("conformance", "fixtures")]
TEXT_EXT = {".ts", ".js", ".mjs", ".json", ".md", ".kt", ".kts", ".html", ".css", ".yml", ".yaml", ".txt", ".conf", ".py", ".properties", ".toml", "." + old}

# Order matters: specific phrases first, then compound identifiers, then whole words.
RULES = [
    (re.compile(rf"\b{OLD} \(Reactive, Addressable, Yielding\)"), New),
    (re.compile(rf'"{OLD}" \(Reactive, Addressable, Yielding\)'), f'"{New}"'),
    (re.compile(rf"{OLD} Binary"), f"{New} Binary"),
    (re.compile(rf"\b{OLD}_"), f"{NEW}_"),                        # RAY_CT -> RAYFOLD_CT
    (re.compile(rf"_{OLD}\b"), f"_{NEW}"),
    (re.compile(rf"\b{OLD}\b"), New),                             # prose, stack names, header prefixes (RAY-Safe)
    (re.compile(rf"\b{Old}(?=[A-Z0-9_])"), New),                  # RayServer -> RayfoldServer
    (re.compile(rf"(?<=[a-z0-9]){Old}(?=\b|[A-Z0-9_])"), New),    # startRay -> startRayfold
    (re.compile(rf"\b{Old}\b"), New),
    (re.compile(rf"\b{old}(?=[A-Z0-9_])"), new),                  # rayCall -> rayfoldCall
    (re.compile(rf"\b{old}\b"), new),                             # @ray/, /ray, application/ray+json, ray.dev, .ray, ray://
    (re.compile(rf"\b{OB}_"), f"{NB}_"),                          # RB_CONTENT_TYPE
    (re.compile(rf"\b{OB}\b"), NB),                               # RB
    (re.compile(rf"\b{Ob}(?=[A-Z])"), Nb),                        # RbCodec
    (re.compile(rf"\b{ob}\b"), nb),                               # @ray/rb, packages/rb
]

def text_files():
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        rel_dir = os.path.relpath(d, ROOT)
        if any(rel_dir.startswith(part) for part in SKIP_PATH_PARTS): continue
        for f in files:
            if f in SKIP_FILES or f.endswith(".gz"): continue
            if os.path.splitext(f)[1].lower() in TEXT_EXT or f in {"LICENSE", "NOTICE", ".gitignore"}:
                yield os.path.join(d, f)

changed = 0
per_rule = [0] * len(RULES)
for path in text_files():
    try:
        s = open(path, encoding="utf-8").read()
    except UnicodeDecodeError:
        continue
    t = s
    for i, (rx, rep) in enumerate(RULES):
        t, n = rx.subn(rep, t)
        per_rule[i] += n
    if t != s:
        changed += 1
        if not a.dry_run:
            open(path, "w", encoding="utf-8", newline="").write(t)
print(f"text: {changed} files changed")
for (rx, rep), n in zip(RULES, per_rule):
    if n: print(f"  {n:5d}  {rx.pattern}  ->  {rep}")

# folders and files, deepest first so parents move after their children
moves = []
for d, dirs, files in os.walk(ROOT, topdown=False):
    if any(part in SKIP_DIRS for part in os.path.relpath(d, ROOT).split(os.sep)): continue
    for name in files + dirs:
        base = name
        for rx, rep in RULES:
            base = rx.sub(rep, base)
        if base != name:
            moves.append((os.path.join(d, name), os.path.join(d, base)))
for src, dst in moves:
    print(f"move {os.path.relpath(src, ROOT)} -> {os.path.relpath(dst, ROOT)}")
    if not a.dry_run:
        if os.path.exists(dst): sys.exit(f"refusing to overwrite {dst}")
        os.rename(src, dst)

# what is left, for a human to review
left = []
word = re.compile(rf"\b({old}|{Old}|{OLD}|{ob}|{OB})\b|\b{Old}[A-Z]|[a-z]{Old}\b|\b{old}[a-z]")  # the last branch: compounds such as /raybook
for path in text_files():
    try:
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            if word.search(line): left.append(f"{os.path.relpath(path, ROOT)}:{n}: {line.strip()[:140]}")
    except (UnicodeDecodeError, FileNotFoundError):
        pass
print(f"remaining mentions to review: {len(left)}")
for l in left[:60]: print("  " + l)
