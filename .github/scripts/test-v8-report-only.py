import os
import subprocess
import unittest
from pathlib import Path

import yaml


class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workflow = yaml.safe_load(Path('.github/workflows/required-pr-gate.yml').read_text())
        cls.step = workflow['jobs']['required-pr-gate']['steps'][0]
        cls.script = cls.step['run']
        cls.names = [name for name in cls.step['env'] if name.endswith('_RESULT')]

    def check_gate(self, v8, report_only, expected, **overrides):
        env = {**os.environ, **{name: 'success' for name in self.names},
               'V8_SCREEN_GUARD_RESULT': v8, 'V8_GUARD_REPORT_ONLY': report_only, **overrides}
        result = subprocess.run(['bash', '-e', '-c', self.script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)
        return result.stdout

    def test_v8_failure_reported_but_optional(self):
        self.assertIn('::warning::', self.check_gate('failure', 'true', True))

    def test_strict_mode_rejects_v8_failure(self):
        self.check_gate('failure', 'false', False)
        self.check_gate('success', 'false', True)

    def test_other_failure_and_interruption_remain_blocking(self):
        self.check_gate('success', 'true', False, WORKER_UNIT_RESULT='failure')
        self.check_gate('cancelled', 'true', False)
        self.check_gate('skipped', 'true', True)


if __name__ == '__main__':
    unittest.main()
