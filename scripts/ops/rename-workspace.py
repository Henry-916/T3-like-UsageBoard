"""Post-release Windows maintenance. Close Antigravity and OpenCode/OpenChamber
and run from outside the workspace using a copy of this script.
DryRun never writes, and reads only checkpointed SQLite data (not live WAL).
"""

import argparse
from contextlib import ExitStack, closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
from urllib.parse import quote


OPEN_CODE = {
    "session": "directory",
    "session_v2": "directory",
    "worktree": "directory",
    "project": "worktree",
    "project_directory": "directory",
}
SUFFIXES = ("", "-wal", "-shm", "-journal")


def rewrite_path(value, old, new, *, uris=False):
    if not isinstance(value, str):
        return value
    for sep in ("/", "\\"):
        prefix, target = (str(p).replace("\\", sep).replace("/", sep) for p in (old, new))
        forms = [(prefix, target)]
        if uris and sep == "/":
            forms += [
                ("file:///" + quote(prefix, safe=safe), "file:///" + quote(target, safe=safe))
                for safe in ("/", "/:")
            ]
        for before, after in forms:
            if re.match(re.escape(before) + r"(?=$|[/\\])", value, re.IGNORECASE):
                return after + value[len(before):]
    return value


def rewrite_uris(value, old, new):
    if value is None or not value.strip():
        return value
    items = json.loads(value)
    if not isinstance(items, list):
        raise ValueError("workspace_uris is not a JSON array")
    updated = [new.name if item == old.name else rewrite_path(item, old, new, uris=True)
               for item in items]
    return json.dumps(updated, ensure_ascii=False) if updated != items else value


def process_db(conn, fields, *, write, optional=()):
    for table, (column, rewrite) in fields.items():
        present = conn.execute(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        if not present and table in optional:
            print(f"{table}.{column}: 0 (table absent)")
            continue
        # Collect changed values, not rowids: an OpenCode table can be WITHOUT ROWID.
        changes = {}
        count = 0
        for (value,) in conn.execute(f'SELECT "{column}" FROM "{table}"'):
            if value not in changes:
                updated = rewrite(value)
                if updated == value:
                    continue
                changes[value] = updated
            count += 1
        if write:
            # Update the FTS5 virtual table itself; SQLite maintains its index.
            conn.executemany(
                f'UPDATE "{table}" SET "{column}" = ? WHERE "{column}" COLLATE BINARY = ?',
                ((updated, value) for value, updated in changes.items()),
            )
        print(f"{table}.{column}: {count}")


def db_files(db):
    return [db.with_name(db.name + suffix) for suffix in SUFFIXES]


def make_junction(old, new):
    subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(old), str(new)], check=True)


def run(old, new, opencode, antigravity, *, dry_run, junction=make_junction):
    databases = (opencode, antigravity)
    fields = (
        {table: (column, lambda value: rewrite_path(value, old, new))
         for table, column in OPEN_CODE.items()},
        {
            "conversation_summaries": ("workspace_uris", lambda value: rewrite_uris(value, old, new)),
            "conversations_fts": ("workspace", lambda value: new.name if value == old.name else value),
        },
    )
    if dry_run:
        print(f"Workspace source matches: {int(old.is_dir())}; target exists: {int(new.exists())}")
        for db, columns in zip(databases, fields):
            files = db_files(db)
            wal = files[1]
            print(f"{db.name} files: {sum(file.is_file() for file in files)}; "
                  f"nonempty WAL excluded: {int(wal.is_file() and wal.stat().st_size > 0)}")
            if not db.is_file():
                raise FileNotFoundError(db)
            with closing(sqlite3.connect(db.as_uri() + "?mode=ro&immutable=1", uri=True)) as conn:
                process_db(conn, columns, write=False, optional=OPEN_CODE)
        return

    if not old.is_dir() or old.resolve() != old or new.exists() or new.is_symlink():
        raise RuntimeError("Source must be a real directory and target must not exist.")
    if Path.cwd().resolve().is_relative_to(old):
        raise RuntimeError("Run from outside the workspace.")
    if any(not db.is_file() for db in databases):
        raise RuntimeError("Both databases must exist before migration.")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = old.parent / f"{old.name}-rename-backup-{stamp}"
    backup.mkdir()
    copies = {}
    for db in databases:
        folder = backup / db.stem
        folder.mkdir()
        for file in db_files(db):
            if file.is_file():
                copies[file] = folder / file.name
                shutil.copy2(file, copies[file])
    print(f"Backup: {backup}")

    old.rename(new)
    try:
        with ExitStack() as stack:
            connections = []
            for db, columns in zip(databases, fields):
                conn = stack.enter_context(closing(sqlite3.connect(db.as_uri() + "?mode=rw", uri=True)))
                conn.execute("BEGIN IMMEDIATE")
                connections.append(conn)
                process_db(conn, columns, write=True, optional=OPEN_CODE)
            for conn in connections:
                conn.commit()
        junction(old, new)
    except BaseException as exc:
        failures = []
        for db in databases:
            for file in db_files(db):
                try:
                    if file in copies:
                        shutil.copy2(copies[file], file)
                    else:
                        file.unlink(missing_ok=True)
                except OSError:
                    failures.append(file.name)
        try:
            if old.is_symlink() and old.samefile(new):
                old.unlink()
            elif old.is_dir() and old.samefile(new):
                old.rmdir()  # Remove the junction itself, never recurse.
            new.rename(old)
        except OSError:
            failures.append("workspace")
        if failures:
            raise RuntimeError(f"Rollback incomplete ({', '.join(failures)}); restore from {backup}") from exc
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-DryRun", action="store_true", help="Count matches without writing anything")
    args = parser.parse_args()
    old = Path(r"C:\Users\24701\Desktop\UsageDashboard")
    home = Path.home()
    try:
        run(old, old.with_name("T3-like-UsageBoard"),
            home / ".local/share/opencode/opencode.db",
            home / ".gemini/antigravity/conversation_summaries.db",
            dry_run=args.DryRun)
    except (OSError, sqlite3.Error, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        # Do not echo SQL, database values or subprocess arguments in diagnostics.
        if isinstance(exc, RuntimeError):
            parser.exit(1, f"{exc}\n")
        parser.exit(1, f"Migration failed ({type(exc).__name__}).\n")


if __name__ == "__main__":
    main()
