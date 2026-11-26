#!/usr/bin/env python3
"""Record failed V8 guard steps; never inspect logs or pull-request code."""
import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

TITLE = 'V8 見張りの積み残し（報告だけの期間）'
REPO = os.environ.get('GH_REPO', '')


def api(path, method='GET', body=None, paginate=False):
    command = ['gh', 'api', path, '--method', method]
    if paginate:
        command += ['--paginate', '--slurp']
    result = subprocess.run(command + (['--input', '-'] if body is not None else []),
                            input=json.dumps(body, ensure_ascii=False) if body is not None else None,
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def safe(text):
    text = re.sub(r'[\r\n\x00-\x1f]+', ' ', str(text))
    text = re.sub(r'https?://\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[省略]', text)
    text = re.sub(r'(?i)\b(?:gh[opusr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|bearer\s+\S+)\b', '[省略]', text)
    return text.replace('<!--', '').replace('-->', '')[:300].strip()


def pages(path, key=None):
    data = api(path + ('&' if '?' in path else '?') + 'per_page=100', paginate=True)
    return [item for page in data for item in (page[key] if key else page)]


def failed_steps(run):
    jobs = pages(f'/repos/{REPO}/actions/runs/{run["id"]}/jobs', 'jobs')
    guard = [job for job in jobs if job['name'] == 'V8 screen guard' or job['name'].startswith('V8 screen guard (')]
    failures = [job for job in guard if job['conclusion'] == 'failure']
    if not failures:
        return []
    names = []
    for job in failures:
        names.extend(safe(step['name']) for step in job['steps'] if step.get('conclusion') == 'failure')
        if not any(step.get('conclusion') == 'failure' for step in job['steps']):
            names.append(safe(job['name']) + '（失敗した段を取得できません）')
    return sorted(set(names))


def save_entry(key, label, names, run):
    if not names:
        return
    issues = pages(f'/repos/{REPO}/issues?state=open')
    matches = [i for i in issues if 'pull_request' not in i and i['title'] == TITLE]
    if len(matches) > 1:
        raise RuntimeError('同じ名前の未完了 Issue が複数あります')
    issue = matches[0] if matches else api(f'/repos/{REPO}/issues', 'POST', {'title': TITLE, 'body': 'V8 見張りの失敗を記録します。対応状況は各コメントで管理します。'})
    comments = pages(f'/repos/{REPO}/issues/{issue["number"]}/comments')
    marker = f'<!-- v8-backlog:{key} -->'
    if any(marker in comment['body'] for comment in comments):
        return
    url = f'https://github.com/{REPO}/actions/runs/{int(run["id"])}'
    when = safe(run.get('updated_at') or run.get('created_at') or datetime.now(timezone.utc).isoformat())
    data = {'key': key, 'label': safe(label), 'steps': names, 'url': url, 'time': when}
    metadata = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('--', '\\u002d\\u002d')
    body = f'{marker}\n<!-- v8-data:{metadata} -->\n**{safe(label)}**\n- 段: {"、".join(names)}\n- 実行: {url}\n- 日時: {when}'
    api(f'/repos/{REPO}/issues/{issue["number"]}/comments', 'POST', {'body': body})


def pr_record(pr, run):
    if not pr.get('merged_at') or pr.get('base', {}).get('ref') != 'codex/development':
        return
    if run.get('event') != 'pull_request' or run.get('name') != 'Required PR gate':
        return
    if not any(x['number'] == pr['number'] and x.get('head', {}).get('sha') == pr['head']['sha'] for x in run.get('pull_requests', [])):
        return
    save_entry(f'pr-{pr["number"]}', f'PR #{pr["number"]} {safe(pr["title"])}', failed_steps(run), run)


def process_run(run):
    if run.get('status') != 'completed':
        return
    if run.get('name') == 'V8 nightly guard' and run.get('event') in ('schedule', 'workflow_dispatch') and run.get('head_branch') == 'codex/development':
        day = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00')).astimezone(timezone(timedelta(hours=9))).date().isoformat()
        save_entry(f'night-{day}', f'夜間 {day} (日本時間)', failed_steps(run), run)
    elif run.get('event') == 'pull_request' and run.get('name') == 'Required PR gate':
        for item in run.get('pull_requests', []):
            pr = api(f'/repos/{REPO}/pulls/{int(item["number"])}')
            pr_record(pr, run)


def main():
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    kind = os.environ['GITHUB_EVENT_NAME']
    if kind == 'pull_request_target':
        pr = event['pull_request']
        if not pr.get('merged_at'):
            return
        # workflow_run may finish before or after merge; only inspect runs for the final PR head.
        runs = pages(f'/repos/{REPO}/actions/workflows/required-pr-gate.yml/runs?event=pull_request', 'workflow_runs')
        for run in runs:
            if any(x['number'] == pr['number'] and x.get('head', {}).get('sha') == pr['head']['sha'] for x in run.get('pull_requests', [])):
                if run.get('status') == 'completed':
                    pr_record(pr, run)
                break
    else:
        run_id = event['workflow_run']['id'] if kind == 'workflow_run' else int(event['inputs']['run_id'])
        run = api(f'/repos/{REPO}/actions/runs/{int(run_id)}')
        process_run(run)


if __name__ == '__main__':
    main()
