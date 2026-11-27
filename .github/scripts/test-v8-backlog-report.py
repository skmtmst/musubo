import copy
import importlib.util
import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml

spec = importlib.util.spec_from_file_location('v8_report', '.github/scripts/v8-backlog-report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class BacklogTest(unittest.TestCase):
    def test_nightly_runs_identical_guard(self):
        required = yaml.safe_load(Path('.github/workflows/required-pr-gate.yml').read_text())['jobs']['v8-screen-guard']
        nightly = yaml.safe_load(Path('.github/workflows/v8-nightly-guard.yml').read_text())['jobs']['v8-screen-guard']
        required = copy.deepcopy(required)
        required.pop('needs')
        required.pop('if')
        required.pop('strategy')
        required['name'] = 'V8 screen guard'
        for step in required['steps']:
            if step.get('uses', '').startswith('actions/upload-artifact@'):
                step['with']['name'] = step['with']['name'].replace('-${{ matrix.shard }}', '')
        nightly.pop('strategy')
        nightly['name'] = 'V8 screen guard'
        for step in nightly['steps']:
            if 'if' in step:
                step['if'] = re.sub(r" && matrix\.shard == '[^']+'(?=\s*(?:}})?$)", '', step['if'])
            if step.get('uses', '').startswith('actions/upload-artifact@'):
                step['with']['name'] = step['with']['name'].replace('-${{ matrix.shard }}', '')
        original = json.loads(Path('.github/scripts/v8-guard-before-split.json').read_text())
        required['steps'] = required['steps'][:10] + original + required['steps'][-2:]
        self.assertEqual(required, nightly)

    def test_failed_steps_only_and_no_logs(self):
        run = {'id': 2}
        jobs = [{'name': 'V8 screen guard', 'conclusion': 'failure', 'steps': [
            {'name': 'broken', 'conclusion': 'failure'}, {'name': 'ok', 'conclusion': 'success'}]}]
        with patch.object(report, 'pages', return_value=jobs):
            self.assertEqual(report.failed_steps(run), ['broken'])
            jobs[0]['conclusion'] = 'success'
            self.assertEqual(report.failed_steps(run), [])

    def test_merged_final_head_only(self):
        pr = {'number': 5, 'title': 'title', 'merged_at': '2026-11-26', 'base': {'ref': 'codex/development'}, 'head': {'sha': 'abc'}}
        run = {'id': 2, 'event': 'pull_request', 'name': 'Required PR gate', 'pull_requests': [{'number': 5, 'head': {'sha': 'abc'}}]}
        with patch.object(report, 'failed_steps', return_value=['broken']), patch.object(report, 'save_entry') as save:
            report.pr_record(pr, run)
            save.assert_called_once()
            pr['merged_at'] = None
            report.pr_record(pr, run)
            self.assertEqual(save.call_count, 1)
            pr['merged_at'] = '2026-11-26'
            run['pull_requests'][0]['head']['sha'] = 'old'
            report.pr_record(pr, run)
            self.assertEqual(save.call_count, 1)

    def test_duplicate_comment_is_not_added(self):
        issue = {'number': 12, 'title': report.TITLE}
        with patch.object(report, 'pages', side_effect=[[issue], [{'body': '<!-- v8-backlog:pr-5 -->'}]]), patch.object(report, 'api') as api:
            report.save_entry('pr-5', 'PR #5 title', ['broken'], {'id': 1})
            api.assert_not_called()

    def test_failed_record_creates_issue_and_comment(self):
        with patch.object(report, 'pages', side_effect=[[], []]), patch.object(report, 'api', side_effect=[{'number': 8}, {}]) as api:
            report.save_entry('pr-5', 'PR #5 title', ['broken'], {'id': 4, 'created_at': '2026-11-26T00:00:00Z'})
            self.assertEqual(api.call_count, 2)
            body = api.call_args.args[2]['body']
            self.assertIn('<!-- v8-backlog:pr-5 -->', body)
            self.assertIn('broken', body)
            self.assertIn('/actions/runs/4', body)

    def test_night_uses_japan_date(self):
        run = {'id': 4, 'status': 'completed', 'name': 'V8 nightly guard', 'event': 'schedule', 'head_branch': 'codex/development', 'created_at': '2026-11-26T17:00:00Z'}
        with patch.object(report, 'failed_steps', return_value=['broken']), patch.object(report, 'save_entry') as save:
            report.process_run(run)
            self.assertEqual(save.call_args.args[0], 'night-2026-11-27')

    def test_success_does_not_create_issue(self):
        with patch.object(report, 'api') as api, patch.object(report, 'pages') as pages:
            report.save_entry('night-2026-11-27', 'night', [], {'id': 1})
            api.assert_not_called()
            pages.assert_not_called()


if __name__ == '__main__':
    unittest.main()
