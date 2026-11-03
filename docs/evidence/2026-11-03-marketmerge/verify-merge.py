"""Verify the merge contract against the two original parents, without changing Git."""

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
OURS = "0c096eaadce0a9b439cbcc7be42b01b76fdbdf1c"
MAIN = "309ef744bbb6d03ad771492df0af0e7df13ed5c9"
MANUAL = {
    ".claude-plugin/plugin.json", "package.json", "package-lock.json",
    "CHANGELOG.md", "REPORT.md", "test/bootstrap-askuserquestion-deny.test.ts",
    "test/run-tests-tmpdir.test.ts", "test/attach-scope.test.ts",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def blob(ref, path):
    return git("show", f"{ref}:{path}")


def tree(ref):
    entries = {}
    for row in git("ls-tree", "-rz", ref).split(b"\0"):
        if row:
            info, path = row.split(b"\t", 1)
            mode, _, oid = info.decode().split()
            entries[path.decode()] = (mode, oid)
    return entries


assert git("diff", "--name-only", "--diff-filter=U") == b""
assert git("diff", "--exit-code") == b"", "Unstaged changes exist"
checks = {}
for path in [".claude-plugin/plugin.json", "package.json", "package-lock.json", "REPORT.md"]:
    current = (ROOT / path).read_bytes()
    assert current == blob(MAIN, path), path
    checks[path] = {"identical_to_main": True, "sha256": hashlib.sha256(current).hexdigest()}
assert (ROOT / "REPORT-ROUND.md").read_bytes() == blob(OURS, "REPORT-ROUND.md")
checks["REPORT-ROUND.md"] = {"identical_to_branch_parent": True}

ours_log = blob(OURS, "CHANGELOG.md").decode()
start = ours_log.index("## 0.82.0 (2026-10-31)\n")
end = ours_log.index("\n## ", start + 1)
note = ours_log[start:end].split("\n", 1)[1].strip()
main_log = blob(MAIN, "CHANGELOG.md").decode()
position = main_log.index("\n## ", main_log.index("## ") + 1)
expected = main_log[:position].rstrip() + "\n\n### Unreleased: attach scope\n\n" + note + "\n" + main_log[position:]
assert (ROOT / "CHANGELOG.md").read_text() == expected
assert not any(character in note for character in [chr(0x2013), chr(0x2014)])
checks["CHANGELOG.md"] = {"main_text_preserved": True, "branch_note_preserved_verbatim": True, "under_newest_heading": True}

bootstrap = "test/bootstrap-askuserquestion-deny.test.ts"
addition = '''  // This fake HOME may live under the repository when TMPDIR is local. The
  // real bootstrap's CommonJS snippet must not inherit our ESM package scope.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\\n')
'''
needle = "  const root = scratchDir('hoai-deny-')\n"
assert (ROOT / bootstrap).read_text() == blob(MAIN, bootstrap).decode().replace(needle, needle + addition)
tmp_test = "test/run-tests-tmpdir.test.ts"
assert (ROOT / tmp_test).read_bytes() == blob(MAIN, tmp_test)
scope_test = "test/attach-scope.test.ts"
scope_before = blob(OURS, scope_test).decode()
scope_expected = scope_before.replace(
    "import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\n",
    "import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'\n",
).replace(
    "import { join } from 'node:path'\n",
    "import { join } from 'node:path'\nimport { scratchDir } from './helpers/scratch-dirs'\n",
).replace(
    "return mkdtempSync(join(tmpdir(), 'attach-scope-'))",
    "return scratchDir('attach-scope-')",
)
assert (ROOT / scope_test).read_text() == scope_expected

# Compare all test names and assertion calls with both parents using TypeScript's parser.
extract = r'''
import ts from 'typescript';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const results = JSON.parse(input).map(({source}) => {
  const file = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  const names = [], assertions = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      if (callee === 'test') names.push(node.arguments[0].getText(file));
      if (callee.startsWith('assert.')) assertions.push(node.getText(file).replace(/\s+/g, ' '));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return {names, assertions};
});
process.stdout.write(JSON.stringify(results));
'''
for path in [bootstrap, tmp_test, scope_test]:
    sources = [blob(OURS, path).decode(), (ROOT / path).read_text()]
    if path != scope_test:
        sources.insert(1, blob(MAIN, path).decode())
    parsed = json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", extract], cwd=ROOT,
        input=json.dumps([{"source": source} for source in sources]).encode(),
    ))
    assert all(item == parsed[0] for item in parsed), f"Test coverage changed: {path}"
    checks[path] = {"parent_test_names_and_assertions_preserved": True,
                    "test_declarations": len(parsed[-1]["names"]), "assertion_calls": len(parsed[-1]["assertions"])}

# Every other original file must match a parent or Git's clean three-way merge.
base = git("merge-base", OURS, MAIN).decode().strip()
base_tree, ours_tree, main_tree = [tree(ref) for ref in [base, OURS, MAIN]]
index = {}
for row in git("ls-files", "--stage", "-z").split(b"\0"):
    if row:
        info, path = row.split(b"\t", 1)
        mode, oid, stage = info.decode().split()
        assert stage == "0"
        index[path.decode()] = (mode, oid)
auto_merges = []
original_paths = set(base_tree) | set(ours_tree) | set(main_tree)
scratch = ROOT / ".tmp/marketmerge"
scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=scratch) as folder:
    for path in sorted(original_paths - MANUAL):
        old, left, right = [entries.get(path) for entries in [base_tree, ours_tree, main_tree]]
        if left == old:
            expected_entry = right
        elif right == old or left == right:
            expected_entry = left
        else:
            assert old and left and right, f"Unexpected file conflict: {path}"
            assert old[0] == left[0] == right[0], f"Unexpected mode conflict: {path}"
            paths = [Path(folder) / name for name in ["ours", "base", "main"]]
            for target, ref in zip(paths, [OURS, base, MAIN]):
                target.write_bytes(blob(ref, path))
            merged = subprocess.check_output(["git", "merge-file", "-p", *map(str, paths)], cwd=ROOT)
            oid = subprocess.check_output(["git", "hash-object", "--stdin"], input=merged, cwd=ROOT).decode().strip()
            expected_entry = (left[0], oid)
            auto_merges.append(path)
        assert index.get(path) == expected_entry, f"Unexpected merge result: {path}"
checks["all_other_original_files"] = {"verified_paths": len(original_paths - MANUAL), "clean_three_way_merges": auto_merges}
result = {"branch_parent": OURS, "main_parent": MAIN, "merge_base": base, "checks": checks, "passed": True}
print(json.dumps(result, indent=2))
