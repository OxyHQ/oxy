"""The obsolete own-app credential launcher must not reach AWS or load secrets."""
import subprocess
import sys
from pathlib import Path
import unittest


class RetiredLauncher(unittest.TestCase):
    def test_prepare_and_execute_refused_without_aws_or_credentials(self):
        launcher = Path(__file__).with_name('run-service-token-issuer-canary-1519.py')
        for args in [[], ['noted'], ['noted', '--execute', '--plan', '/does-not-exist']]:
            with self.subTest(args=args):
                result = subprocess.run([sys.executable, str(launcher), *args], env={}, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertIn('historical Noted credential canary launcher is retired', result.stderr)


if __name__ == '__main__':
    unittest.main()
