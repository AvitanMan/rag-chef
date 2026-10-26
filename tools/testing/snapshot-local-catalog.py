"""Read-only SQLite backup and logical fingerprint; never opens the user's app."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def connect(path):
    wal = Path(str(path) + "-wal")
    query = "?mode=ro" if wal.exists() and wal.stat().st_size > 32 else "?mode=ro&immutable=1"
    return sqlite3.connect(path.resolve().as_uri() + query, uri=True)


def fingerprint(path):
    with connect(path) as db:
        digest = hashlib.sha256()
        tables = db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        for name, schema in tables:
            digest.update(repr((name, schema)).encode())
            rows = db.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall()
            for row in sorted(repr(row) for row in rows):
                digest.update(row.encode())
        return {"file": path.name, "tables": len(tables), "sha256": digest.hexdigest()}


def main():
    mode, root, destination = sys.argv[1:]
    folder = Path(root).resolve() / ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
    candidates = []
    for path in folder.glob("*.sqlite"):
        with connect(path) as db:
            names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if {"recipes", "kitchen_state"}.issubset(names):
                candidates.append(path)
    if len(candidates) != 1:
        raise ValueError("Expected exactly one local recipe database; populate the catalog or use --catalog fixtures.")
    files = candidates + ([folder / "metadata.sqlite"] if (folder / "metadata.sqlite").exists() else [])
    if mode == "snapshot":
        target = Path(destination).resolve() / "v3/d1/miniflare-D1DatabaseObject"
        if target == folder or target.exists():
            raise ValueError("Snapshot destination must be a new disposable directory.")
        target.mkdir(parents=True)
        for path in files:
            with connect(path) as source, sqlite3.connect(target / path.name) as copied:
                source.backup(copied)
    elif mode != "fingerprint":
        raise ValueError("Unknown snapshot operation.")
    print(json.dumps([fingerprint(path) for path in files]))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
