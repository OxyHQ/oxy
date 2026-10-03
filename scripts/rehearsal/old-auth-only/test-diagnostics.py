"""Only fixed categories escape private logs, and migration prerequisites are exact."""
import unittest
from diagnostics import failure_diagnostic, required_extensions


class DiagnosticsTests(unittest.TestCase):
    def test_required_postgis(self):
        self.assertEqual(failure_diagnostic(b'error: extension "postgis" is not available\nsecret=never-public'), {'category': 'required_postgis_unavailable'})

    def test_required_trigram(self):
        self.assertEqual(failure_diagnostic(b'could not open pg_trgm.control: No such file'), {'category': 'required_pg_trgm_unavailable'})

    def test_module_resolution_hides_path_and_secret(self):
        self.assertEqual(failure_diagnostic(b'Cannot find module /private/secret-value'), {'category': 'module_resolution_failed'})

    def test_unknown_error_not_echoed(self):
        self.assertEqual(failure_diagnostic(b'provider secret-value row=user-private'), {'category': 'bootstrap_command_failed'})

    def test_available_exact(self):
        self.assertEqual(required_extensions({'postgis': '3.6.1', 'pg_trgm': '1.6'}), {'postgis': '3.6.1', 'pg_trgm': '1.6'})

    def test_missing_required_before_migration(self):
        for rows in [{}, {'pg_trgm': '1.6'}, {'postgis': '3.6.1'}]:
            with self.subTest(rows=rows), self.assertRaises(AssertionError):
                required_extensions(rows)

    def test_unexpected_version_or_extension(self):
        for rows in [{'postgis': 'secret-value', 'pg_trgm': '1.6'}, {'postgis': '3.6.1', 'pg_trgm': '1.6', 'other': '1.0'}]:
            with self.subTest(rows=rows), self.assertRaises(AssertionError):
                required_extensions(rows)


if __name__ == '__main__':
    unittest.main()
