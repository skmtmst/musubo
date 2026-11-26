import json
import re
import unittest
from pathlib import Path

import yaml


class GuardShardsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load(Path('.github/workflows/required-pr-gate.yml').read_text())
        cls.job = cls.workflow['jobs']['v8-screen-guard']
        cls.original = json.loads(Path('.github/scripts/v8-guard-original-steps.json').read_text())

    def test_original_checks_run_once_with_unchanged_commands_and_conditions(self):
        names = self.job['strategy']['matrix']['shard']
        self.assertEqual(set(names), {'inventory', 'defects', 'comparison', 'general'})
        self.assertFalse(self.job['strategy']['fail-fast'])
        steps = self.job['steps']
        for original in self.original:
            found = [step for step in steps if step.get('name') == original['name']]
            self.assertEqual(len(found), 1, original['name'])
            actual = dict(found[0])
            condition = actual.pop('if')
            match = re.search(r" && matrix\.shard == '([^']+)'(?=\s*(?:}})?$)", condition)
            self.assertIsNotNone(match, original['name'])
            self.assertIn(match.group(1), names)
            restored = condition[:match.start()] + condition[match.end():]
            expected = dict(original)
            self.assertEqual(restored, expected.pop('if'), original['name'])
            self.assertEqual(actual, expected, original['name'])
        speed = [next(s for s in steps if s.get('name') == original['name']) for original in self.original if '!cancelled()' in original.get('if', '')]
        self.assertTrue(speed)
        for step in speed:
            self.assertIn("matrix.shard == 'general'", step['if'])

    def test_gate_waits_for_the_matrix_and_checks_its_result(self):
        gate = self.workflow['jobs']['required-pr-gate']
        self.assertIn('v8-screen-guard', gate['needs'])
        self.assertEqual(gate['steps'][0]['env']['V8_SCREEN_GUARD_RESULT'], '${{ needs.v8-screen-guard.result }}')
        self.assertIn('"$V8_SCREEN_GUARD_RESULT"', gate['steps'][0]['run'])


if __name__ == '__main__':
    unittest.main()
