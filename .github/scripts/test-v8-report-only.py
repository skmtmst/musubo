import copy
import os
import subprocess
import unittest
from pathlib import Path

import yaml


def valid_configuration(gate):
    step = gate['steps'][0]
    mode = step['env']['V8_GUARD_REPORT_ONLY']
    has_dependency = 'v8-screen-guard' in gate['needs']
    observes_result = step['env'].get('V8_SCREEN_GUARD_RESULT') == '${{ needs.v8-screen-guard.result }}'
    checks_result = 'case "$V8_SCREEN_GUARD_RESULT" in' in step['run']
    return observes_result and checks_result and ((mode == 'true' and not has_dependency) or (mode == 'false' and has_dependency))


class GateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workflow = yaml.safe_load(Path('.github/workflows/required-pr-gate.yml').read_text())
        cls.gate = workflow['jobs']['required-pr-gate']
        cls.step = cls.gate['steps'][0]
        cls.script = cls.step['run']
        cls.names = [name for name in cls.step['env'] if name.endswith('_RESULT')]

    def check_gate(self, v8, report_only, expected, **overrides):
        env = {**os.environ, **{name: 'success' for name in self.names},
               'V8_SCREEN_GUARD_RESULT': v8, 'V8_GUARD_REPORT_ONLY': report_only, **overrides}
        result = subprocess.run(['bash', '-e', '-c', self.script], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)

    def test_dependencies_and_mode_are_consistent(self):
        self.assertEqual(self.gate['steps'][0]['env']['V8_GUARD_REPORT_ONLY'], 'true')
        self.assertTrue(valid_configuration(self.gate))
        gate = copy.deepcopy(self.gate)
        gate['steps'][0]['env']['V8_GUARD_REPORT_ONLY'] = 'false'
        self.assertFalse(valid_configuration(gate))
        gate['needs'].append('v8-screen-guard')
        self.assertTrue(valid_configuration(gate))
        gate['steps'][0]['env']['V8_GUARD_REPORT_ONLY'] = 'true'
        self.assertFalse(valid_configuration(gate))
        gate['steps'][0]['env']['V8_GUARD_REPORT_ONLY'] = 'false'
        gate['steps'][0]['run'] = gate['steps'][0]['run'].replace('case "$V8_SCREEN_GUARD_RESULT" in', 'case ignored in')
        self.assertFalse(valid_configuration(gate))

    def test_report_only_does_not_need_v8_result(self):
        for result in ('', 'failure', 'cancelled', 'success'):
            self.check_gate(result, 'true', True)

    def test_strict_mode_requires_v8_to_finish_successfully(self):
        for result in ('', 'failure', 'cancelled'):
            self.check_gate(result, 'false', False)
        for result in ('success', 'skipped'):
            self.check_gate(result, 'false', True)

    def test_other_checks_remain_required(self):
        self.check_gate('', 'true', False, WORKER_UNIT_RESULT='failure')
        self.check_gate('', 'true', False, WORKER_BUILD_RESULT='cancelled')
        self.check_gate('', 'invalid', False)


if __name__ == '__main__':
    unittest.main()
