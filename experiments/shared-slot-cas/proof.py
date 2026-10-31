"""Research model only: CAS at one shared SQLite authority, not an Oxy backend."""
from contextlib import closing
import multiprocessing as mp
from pathlib import Path
import sqlite3
import tempfile
import unittest


def connect(path):
    return sqlite3.connect(path, timeout=5, isolation_level=None)


def cas(path, expected, value):
    with closing(connect(path)) as db:
        result = db.execute(
            'UPDATE slot SET version = version + 1, value = ? WHERE id = 1 AND version = ?',
            (value, expected),
        )
        return result.rowcount == 1


def delayed_writer(path, observed, release, result):
    with closing(connect(path)) as db:
        version = db.execute('SELECT version FROM slot WHERE id = 1').fetchone()[0]
    observed.set()
    if not release.wait(10):
        raise RuntimeError('writer not released')
    result.put(cas(path, version, 'older'))


def lock_then_wait(path, locked, release):
    db = connect(path)
    db.execute('BEGIN IMMEDIATE')
    db.execute("UPDATE slot SET version = version + 1, value = 'uncommitted' WHERE id = 1")
    locked.set()
    release.wait(10)
    db.commit()


class SharedAuthorityModel(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='oxy-cas-model-')
        self.path = str(Path(self.directory.name) / 'authority.sqlite')
        with closing(connect(self.path)) as db:
            db.execute('CREATE TABLE slot (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, value TEXT)')
            db.execute('INSERT INTO slot VALUES (1, 0, NULL)')
        self.ctx = mp.get_context('spawn')

    def tearDown(self):
        self.directory.cleanup()

    def slot(self):
        with closing(connect(self.path)) as db:
            return db.execute('SELECT version, value FROM slot WHERE id = 1').fetchone()

    def test_delayed_other_process_cannot_overwrite_newer_committed_value(self):
        observed, release = self.ctx.Event(), self.ctx.Event()
        result = self.ctx.Queue()
        older = self.ctx.Process(target=delayed_writer, args=(self.path, observed, release, result))
        older.start()
        try:
            self.assertTrue(observed.wait(10))
            self.assertTrue(cas(self.path, 0, 'newer'))
            release.set()
            self.assertFalse(result.get(timeout=10))
            older.join(10)
            self.assertEqual(older.exitcode, 0)
            self.assertEqual(self.slot(), (1, 'newer'))
        finally:
            if older.is_alive():
                older.terminate()
                older.join()

    def test_crashed_writer_rolls_back_and_releases_sqlite_lock(self):
        locked, release = self.ctx.Event(), self.ctx.Event()
        writer = self.ctx.Process(target=lock_then_wait, args=(self.path, locked, release))
        writer.start()
        try:
            self.assertTrue(locked.wait(10))
            writer.terminate()
            writer.join(10)
            self.assertEqual(self.slot(), (0, None))
            self.assertTrue(cas(self.path, 0, 'newer'))
        finally:
            if writer.is_alive():
                writer.terminate()
                writer.join()

    def test_unconditional_legacy_writer_can_still_replace_cas_value(self):
        self.assertTrue(cas(self.path, 0, 'newer'))
        with closing(connect(self.path)) as db:
            db.execute("UPDATE slot SET value = 'legacy' WHERE id = 1")
        self.assertEqual(self.slot(), (1, 'legacy'))

    def test_legacy_write_does_not_invalidate_an_older_cas_observation(self):
        observed_version = self.slot()[0]
        with closing(connect(self.path)) as db:
            db.execute("UPDATE slot SET value = 'legacy' WHERE id = 1")
        self.assertTrue(cas(self.path, observed_version, 'older'))
        self.assertEqual(self.slot(), (1, 'older'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
