import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("catalog fingerprint ignores D1 read bookmarks but detects kitchen, recipe and schema changes", () => {
  const result = spawnSync("python3", ["-c", `
import importlib.util, sqlite3, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('snapshot', 'tools/testing/snapshot-local-catalog.py')
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)
with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / 'test.sqlite'
    with sqlite3.connect(path) as db:
        db.executescript('CREATE TABLE recipes(id TEXT); INSERT INTO recipes VALUES ("recipe"); CREATE TABLE kitchen_state(revision INTEGER); INSERT INTO kitchen_state VALUES (1); CREATE TABLE _cf_METADATA(value INTEGER); INSERT INTO _cf_METADATA VALUES (1);')
    original = snapshot.fingerprint(path)
    with sqlite3.connect(path) as db:
        db.execute('UPDATE _cf_METADATA SET value=2')
    assert snapshot.fingerprint(path) == original
    for sql in ['UPDATE kitchen_state SET revision=2', 'UPDATE recipes SET id="changed"', 'CREATE TABLE new_application_data(id TEXT)']:
        before = snapshot.fingerprint(path)
        with sqlite3.connect(path) as db:
            db.execute(sql)
        assert snapshot.fingerprint(path) != before, sql
`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
