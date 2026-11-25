from contextlib import closing, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "rename_workspace", Path(__file__).with_name("rename-workspace.py")
)
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class RenameWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.old = self.root / "UsageDashboard"
        self.new = self.root / "T3-like-UsageBoard"
        self.old.mkdir()
        (self.old / "fixture.txt").write_text("fixture")
        self.code = self.root / "opencode.db"
        self.ag = self.root / "conversation_summaries.db"
        self.forward = self.old.as_posix() + "/child"
        self.backward = str(self.old).replace("/", "\\") + "\\child"
        self.neighbor = self.old.as_posix() + "-other"
        self.uri = self.old.as_uri()
        if self.old.drive:
            self.uri = self.uri.replace(self.old.drive, self.old.drive.lower().replace(":", "%3A"), 1)
        with closing(sqlite3.connect(self.code)) as conn:
            conn.execute("CREATE TABLE session_v2(directory TEXT PRIMARY KEY) WITHOUT ROWID")
            conn.executemany("INSERT INTO session_v2 VALUES (?)",
                             [(self.forward,), (self.backward,), (self.neighbor,)])
            conn.commit()
        with closing(sqlite3.connect(self.ag)) as conn:
            conn.execute("CREATE TABLE conversation_summaries(workspace_uris TEXT)")
            conn.executemany("INSERT INTO conversation_summaries VALUES (?)", [
                (json.dumps([self.uri, self.backward, self.neighbor]),),
                ("",),
            ])
            conn.execute("CREATE VIRTUAL TABLE conversations_fts USING fts5(workspace, title)")
            conn.executemany("INSERT INTO conversations_fts VALUES (?, ?)",
                             [(self.old.name, self.old.name), (self.old.name + "-other", "Other")])
            conn.commit()

    def invoke(self, *, dry_run=False, junction=lambda *_: None):
        with redirect_stdout(io.StringIO()) as output:
            ops.run(self.old, self.new, self.code, self.ag, dry_run=dry_run, junction=junction)
        return output.getvalue()

    def test_dry_run_with_uncheckpointed_wal_does_not_touch_files(self):
        with closing(sqlite3.connect(self.code)) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("INSERT INTO session_v2 VALUES (?)", (self.forward + "WAL",))
            conn.commit()
            before = {p: p.read_bytes() for p in self.root.iterdir() if p.is_file()}
            output = self.invoke(dry_run=True)
            self.assertEqual(before, {p: p.read_bytes() for p in self.root.iterdir() if p.is_file()})
        for line in ("session_v2.directory: 2", "conversation_summaries.workspace_uris: 1",
                     "conversations_fts.workspace: 1", "nonempty WAL excluded: 1"):
            self.assertIn(line, output)
        self.assertEqual([self.old], [p for p in self.root.iterdir() if p.is_dir()])
        self.assertFalse(self.new.exists())

    def test_update_prefixes_and_fts_index(self):
        links = []
        self.invoke(junction=lambda old, new: links.append((old, new)))
        self.assertEqual([(self.old, self.new)], links)
        self.assertTrue((self.new / "fixture.txt").is_file())
        self.assertFalse(self.old.exists())
        with closing(sqlite3.connect(self.code)) as conn:
            self.assertEqual(
                {self.new.as_posix() + "/child", str(self.new).replace("/", "\\") + "\\child", self.neighbor},
                {row[0] for row in conn.execute("SELECT directory FROM session_v2")},
            )
        with closing(sqlite3.connect(self.ag)) as conn:
            uris = json.loads(conn.execute("SELECT workspace_uris FROM conversation_summaries").fetchone()[0])
            expected_uri = self.new.as_uri()
            if self.new.drive:
                expected_uri = expected_uri.replace(self.new.drive, self.new.drive.replace(":", "%3A"), 1)
            self.assertEqual([expected_uri, str(self.new).replace("/", "\\") + "\\child", self.neighbor], uris)
            for name, expected in ((self.new.name, 1), (self.old.name, 1)):
                self.assertEqual(expected, conn.execute(
                    "SELECT count(*) FROM conversations_fts WHERE workspace MATCH ?", (f'"{name}"',)
                ).fetchone()[0])
            self.assertEqual(self.old.name, conn.execute(
                "SELECT title FROM conversations_fts WHERE workspace = ?", (self.new.name,)
            ).fetchone()[0])

    def assert_restores(self, *, junction=lambda *_: None):
        before = {db: db.read_bytes() for db in (self.code, self.ag)}
        with self.assertRaises((OSError, sqlite3.Error)):
            self.invoke(junction=junction)
        self.assertTrue((self.old / "fixture.txt").is_file())
        self.assertFalse(self.new.exists())
        (backup,) = self.root.glob("UsageDashboard-rename-backup-*")
        for db, value in before.items():
            self.assertEqual(value, db.read_bytes())
            self.assertEqual(value, (backup / db.stem / db.name).read_bytes())

    def test_restores_both_databases_after_commits_when_junction_fails(self):
        def fail(*_):
            raise OSError("fixture junction failure")

        self.assert_restores(junction=fail)

    def test_restores_on_second_antigravity_table_failure(self):
        with closing(sqlite3.connect(self.ag)) as conn:
            conn.execute("DROP TABLE conversations_fts")
            conn.commit()
        self.assert_restores()


if __name__ == "__main__":
    unittest.main()
