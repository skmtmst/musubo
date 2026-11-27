import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = Path(os.environ.get('V8_BEHAVIOR_TEST_WORKFLOW', ROOT / '.github/workflows/required-pr-gate.yml'))


def test_files(step):
    return re.findall(r'apps/web/scripts/v8-guard/[\w.-]+\.test\.mjs', step['run'])


class BehaviorGuardPolicy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.safe_load(WORKFLOW.read_text())
        cls.jobs = cls.workflow['jobs']
        cls.original = json.loads((ROOT / '.github/scripts/v8-guard-before-split.json').read_text())
        cls.classification = json.loads((ROOT / '.github/scripts/v8-guard-classification.json').read_text())

    def test_behavior_job_is_a_required_gate_dependency(self):
        self.assertIn('v8-behavior-guard', self.jobs)
        gate = self.jobs['required-pr-gate']
        self.assertIn('v8-behavior-guard', gate['needs'])
        step = gate['steps'][0]
        self.assertEqual(step['env']['V8_BEHAVIOR_GUARD_RESULT'], '${{ needs.v8-behavior-guard.result }}')
        self.assertIn('"$V8_BEHAVIOR_GUARD_RESULT"', step['run'])
        for status, expected in [('success', 0), ('skipped', 0), ('failure', 1), ('cancelled', 1)]:
            env = {**os.environ, **{key: 'success' for key in step['env'] if key.endswith('_RESULT')},
                   'V8_GUARD_REPORT_ONLY': 'true', 'V8_BEHAVIOR_GUARD_RESULT': status}
            result = subprocess.run(['bash', '-e', '-c', step['run']], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)

    def test_all_original_checks_are_assigned_without_weakening(self):
        behavior = self.jobs['v8-behavior-guard']['steps']
        visual = self.jobs['v8-screen-guard']['steps']
        behavior_steps = set(self.classification['behavior_steps'])
        for old in self.original:
            name = old['name']
            if name == 'Broken fixtures must fail the V8 layout guard':
                left = next(x for x in visual if x.get('name') == name)
                right = next(x for x in behavior if x.get('name') == 'Behavior and mixed V8 browser fixtures')
                self.assertEqual(left.get('if'), old.get('if'))
                self.assertEqual(right.get('if'), old.get('if'))
                self.assertEqual(left.get('env'), old.get('env'))
                self.assertEqual(right.get('env'), old.get('env'))
                original_files = test_files(old)
                self.assertEqual(len(original_files), len(set(original_files)))
                records = self.classification['fixtures']
                self.assertEqual(set(original_files), {x['path'] for x in records})
                for category, actual in [('behavior', right), ('visual', left)]:
                    self.assertEqual(test_files(actual), [x for x in original_files if next(y for y in records if y['path'] == x)['category'] == category])
                self.assertEqual(set(test_files(left)) & set(test_files(right)), set())
                continue
            target = behavior if name in behavior_steps else visual
            other = visual if target is behavior else behavior
            found = [x for x in target if x.get('name') == name]
            self.assertEqual(found, [old], name)
            self.assertFalse(any(x.get('name') == name for x in other), name)

    def test_github_only_changes_still_run_v8_policy_tests(self):
        changes = self.jobs['changes']
        policy = next(x for x in changes['steps'] if x.get('name') == 'Verify V8 guard policy for every PR')
        self.assertNotIn('if', policy)
        for filename in ('test-v8-report-only.py', 'test-v8-backlog-report.py', 'test-v8-behavior-guard.py'):
            self.assertIn('python3 .github/scripts/' + filename, policy['run'])
        scope = next(x for x in changes['steps'] if x.get('id') == 'scope')
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            def git(*args):
                return subprocess.run(['git', '-C', tmp, *args], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()
            git('config', 'user.email', 'ci-local@example.invalid')
            git('config', 'user.name', 'CI Local')
            Path(tmp, 'README.md').write_text('before\n')
            git('add', 'README.md'); git('commit', '-qm', 'base'); base = git('rev-parse', 'HEAD')
            Path(tmp, '.github').mkdir(); Path(tmp, '.github', 'policy.yml').write_text('changed\n')
            git('add', '.github'); git('commit', '-qm', 'workflow'); head = git('rev-parse', 'HEAD')
            output = Path(tmp, 'output')
            env = {**os.environ, 'BASE_SHA': base, 'HEAD_SHA': head, 'GITHUB_OUTPUT': str(output)}
            subprocess.run(['bash', '-e', '-c', scope['run']], env=env, cwd=tmp, check=True, capture_output=True)
            self.assertIn('full_suite=false', output.read_text())
            for filename in ('test-v8-report-only.py', 'test-v8-backlog-report.py'):
                subprocess.run(['python3', str(ROOT / '.github/scripts' / filename)], cwd=ROOT, check=True, capture_output=True)


if __name__ == '__main__':
    unittest.main()
