import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/deploy-cloudflare-staging.yml'),
  'utf8',
);

describe('Deploy Cloudflare Staging workflow', () => {
  it('queues every request and checks both live revisions before either publish', () => {
    expect(workflow).toMatch(/concurrency:\n\s+group: cloudflare-staging\n\s+queue: max\n\s+cancel-in-progress: false/);
    for (const [check, publish] of [
      ['Reject staging rollback after acquiring the shared lock', 'Bind the staging Cloudflare account'],
      ['Recheck forward revisions before Worker publish', 'Deploy Worker to staging'],
      ['Recheck forward revisions before Admin publish', 'Deploy Admin Panel to staging'],
    ]) {
      const start = workflow.indexOf(`- name: ${check}`);
      const end = workflow.indexOf(`- name: ${publish}`);
      expect(start).toBeGreaterThan(workflow.indexOf('pnpm deploy:lock acquire staging'));
      expect(end).toBeGreaterThan(start);
      expect(workflow.slice(start, end)).toContain('node scripts/deploy/verify-staging-forward.mjs');
    }
  });
  it('stops if the legacy deployment or migration path can still run', () => {
    expect(workflow).toContain("github.repository == 'skmtmst/musubo'");
    const first = workflow.indexOf('Require retired legacy staging paths before this run');
    expect(first).toBeGreaterThan(workflow.indexOf('actions/checkout@'));
    expect(first).toBeLessThan(workflow.indexOf('Check deployment security settings'));
    for (const [check, publish] of [
      ['Recheck retired legacy paths before Worker publish', 'Deploy Worker to staging'],
      ['Recheck retired legacy paths before Admin publish', 'Deploy Admin Panel to staging'],
    ]) {
      const start = workflow.indexOf(`- name: ${check}`);
      const end = workflow.indexOf(`- name: ${publish}`);
      expect(start).toBeGreaterThan(first);
      expect(end).toBeGreaterThan(start);
      expect(workflow.slice(start, end)).toContain('node scripts/deploy/verify-legacy-staging-retired.mjs');
    }
  });
  it.each([false, true])('passes source metadata to the actual Worker deploy command (replay=%s)', (replay) => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'staging-metadata-'));
    try {
      const sha = (replay ? 'b' : 'a').repeat(40);
      const values: Record<string, string> = {
        'steps.worker_source.outputs.root': sandbox,
        'steps.build_metadata.outputs.worker_sha': sha,
        'steps.build_metadata.outputs.worker_version': '0.24.0',
        'steps.build_metadata.outputs.released_at': '2026-10-09T00:00:00Z',
      };
      const step = workflow.split('- name: Deploy Worker to staging')[1].split('- name: Verify the deployed Worker')[0];
      const script = step.split('run: |\n')[1].replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_all, key: string) => {
        if (!values[key]) throw new Error(`Unexpected expression: ${key}`);
        return values[key];
      });
      writeFileSync(resolve(sandbox, 'npx'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$RUNNER_TEMP/args.txt"\necho "Current Version ID: 11111111-1111-1111-1111-111111111111"\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${sandbox}:${process.env.PATH}`, RUNNER_TEMP: sandbox,
          GITHUB_OUTPUT: resolve(sandbox, 'outputs'), WORKER_CONFIG_REPLAY: String(replay), WORKER_SOURCE_SHA: sha },
      });
      expect(result.status, result.stderr).toBe(0);
      const args = readFileSync(resolve(sandbox, 'args.txt'), 'utf8');
      expect(args).toContain(`BUILD_GIT_COMMIT:${sha}`);
      expect(args).toContain('BUILD_VERSION:0.24.0');
      expect(args).toContain('BUILD_RELEASED_AT:2026-10-09T00:00:00Z');
      expect(workflow).toContain('APP_COMMIT_SHA: ${{ steps.build_metadata.outputs.admin_sha }}');
      expect(workflow).toContain('node scripts/deploy/verify-public-build.mjs');
      expect(workflow.indexOf('Verify public source revisions')).toBeLessThan(workflow.indexOf('Release the staging lock'));
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
  it('supports a gated development push and still defaults manual runs to dry-run', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/^\s+push:/m);
    expect(workflow).toMatch(/branches:\s*\n\s*- codex\/development/);
    expect(workflow).toContain("vars.NEN_STAGING_DELIVERY_MODE == 'dry-run'");
    expect(workflow).toContain("vars.NEN_STAGING_DELIVERY_MODE == 'apply'");
    expect(workflow).toContain('default: dry-run');
    expect(workflow).toContain('default: all');
  });

  it('can only run from codex/development against staging', () => {
    expect(workflow).toContain("github.ref == 'refs/heads/codex/development'");
    expect(workflow).toContain('environment: staging');
    expect(workflow).toContain('apps/worker/wrangler.staging.toml');
    expect(workflow).toContain('STAGING_PAGES_PROJECT: nen-line-stg-admin-git');
    expect(workflow).toContain('--branch codex/development');
    expect(workflow).not.toContain('apps/worker/wrangler.toml');
  });

  it('acquires an exact deploy lock for apply and releases it however the run ends', () => {
    expect(workflow).toContain('id: staging_lock');
    expect(workflow).toContain("if: env.DELIVERY_MODE == 'apply'");
    expect(workflow).toContain('pnpm deploy:lock acquire staging');
    expect(workflow).toContain(
      'pnpm deploy:lock verify staging --sha "$GITHUB_SHA" --remote origin',
    );
    // 途中の段が落ちても解放する。success() に戻すと、取得後の失敗でロックが残る。
    expect(workflow).toContain("if: always() && steps.staging_lock.outcome == 'success'");
    expect(workflow).not.toContain("if: success() && steps.staging_lock.outcome == 'success'");
    // 取得していない run は他担当のロックを解放しない。
    expect(workflow).not.toMatch(/if: always\(\)\n\s+run: pnpm deploy:lock release staging/);
    expect(workflow).toContain('pnpm deploy:lock release staging --remote origin');
    expect(workflow.indexOf('pnpm deploy:lock acquire staging')).toBeLessThan(
      workflow.indexOf('Require latest development after acquiring the staging lock'),
    );
    expect(workflow.indexOf('Require latest development after acquiring the staging lock')).toBeLessThan(
      workflow.indexOf('Bind the staging Cloudflare account'),
    );
    expect(workflow.indexOf('pnpm deploy:lock release staging')).toBeGreaterThan(
      workflow.indexOf('npx wrangler pages deploy apps/web/out'),
    );
  });

  it.each([
    { name: 'matching development', remoteSha: 'a'.repeat(40), gitExit: 0, succeeds: true },
    { name: 'development advanced', remoteSha: 'b'.repeat(40), gitExit: 0, succeeds: false },
    { name: 'empty remote result', remoteSha: '', gitExit: 0, succeeds: false },
    { name: 'remote lookup failed', remoteSha: 'a'.repeat(40), gitExit: 128, succeeds: false },
  ])('checks the live branch after locking: $name', ({ remoteSha, gitExit, succeeds }) => {
    const sandbox = mkdtempSync(resolve(tmpdir(), 'staging-latest-'));
    try {
      const step = workflow.split('- name: Require latest development after acquiring the staging lock')[1]
        .split('- name: Reject staging rollback after acquiring the shared lock')[0];
      const script = step.split('run: |\n')[1];
      writeFileSync(resolve(sandbox, 'git'), [
        '#!/bin/sh',
        '[ "$*" = "ls-remote --exit-code origin refs/heads/codex/development" ] || exit 99',
        '[ -z "$STAGING_TEST_REMOTE_SHA" ] || printf "%s\\trefs/heads/codex/development\\n" "$STAGING_TEST_REMOTE_SHA"',
        'exit "$STAGING_TEST_GIT_EXIT"',
        '',
      ].join('\n'), { mode: 0o755 });
      const result = spawnSync('bash', ['-e', '-c', script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${sandbox}:${process.env.PATH}`,
          GITHUB_SHA: 'a'.repeat(40), STAGING_TEST_REMOTE_SHA: remoteSha, STAGING_TEST_GIT_EXIT: String(gitExit) },
      });
      expect(result.status === 0, result.stderr).toBe(succeeds);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('binds the ephemeral config to the staging Environment account', () => {
    expect(workflow).toContain('Bind the staging Cloudflare account');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(workflow).toContain('apps/worker/wrangler.staging.toml');
    expect(workflow).not.toContain('echo "$CLOUDFLARE_ACCOUNT_ID"');
  });

  it('passes the staging Turnstile site key to the admin build', () => {
    expect(workflow).toContain(
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY: ${{ vars.NEXT_PUBLIC_TURNSTILE_SITE_KEY }}',
    );
  });

  it('uses separate Worker and Pages credentials with safe fallbacks', () => {
    expect(workflow).toContain(
      'secrets.CLOUDFLARE_WORKERS_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN || secrets.CF_API_TOKEN',
    );
    expect(workflow).toContain(
      'secrets.CLOUDFLARE_ACCOUNT_ID || secrets.CF_ACCOUNT_ID',
    );
    expect(workflow).toContain(
      'secrets.CLOUDFLARE_PAGES_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN || secrets.CF_API_TOKEN',
    );
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ env.WORKER_API_TOKEN }}');
    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ env.PAGES_API_TOKEN }}');
  });

  it('can deploy Worker and Admin independently', () => {
    expect(workflow).toContain("env.DELIVERY_TARGET != 'admin'");
    expect(workflow).toContain("env.DELIVERY_TARGET != 'worker'");
    expect(workflow).toContain("inputs.target || 'all'");
    expect(workflow).toContain(
      'pnpm --filter @line-harness/update-engine build',
    );
  });

  it('keeps cron disabled and migrations in their separate workflow', () => {
    expect(workflow).toContain("grep -q '^\\[triggers\\]'");
    expect(workflow).not.toContain('d1 migrations apply');
    expect(workflow).not.toContain('apply-d1-migrations');
  });

  it('counts staging D1 migrations and blocks apply while any are pending', () => {
    expect(workflow).toContain('name: Count pending staging D1 migrations');
    expect(workflow).toContain('--command "SELECT name FROM _migrations" --json');
    expect(workflow).toContain('pending_count=$((pending_count + 1))');
    expect(workflow).toContain('検証D1の未適用マイグレーション: ${pending_count} 件');
    expect(workflow).toContain('if [ "$DELIVERY_MODE" = "apply" ] && [ "$pending_count" -ne 0 ]');
    expect(workflow).toContain('Migrate D1を先に実行してください。');
    expect(workflow).not.toContain('CREATE TABLE IF NOT EXISTS _migrations');
  });

  it('can replay only the current staging config on the already deployed Worker source', () => {
    expect(workflow).toContain('worker_config_replay:');
    expect(workflow).toContain('worker_source_sha:');
    expect(workflow).toContain('expected_worker_version_id:');
    expect(workflow).toContain('test "$DELIVERY_TARGET" = "worker"');
    expect(workflow).toContain('test "$active_version" = "$EXPECTED_WORKER_VERSION_ID"');
    expect(workflow).toContain('git merge-base --is-ancestor "$WORKER_SOURCE_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain('git worktree add --detach "$worker_root" "$WORKER_SOURCE_SHA"');
    expect(workflow).toContain(
      'cp apps/worker/wrangler.staging.toml "$worker_root/apps/worker/wrangler.staging.toml"',
    );
    expect(workflow).toContain('[ "$WORKER_CONFIG_REPLAY" != "true" ]');
  });

  it('rebuilds only the verified live Admin source when unrelated D1 migrations are pending', () => {
    expect(workflow).toContain('pages_config_replay:');
    expect(workflow).toContain('pages_source_sha:');
    expect(workflow).toContain('expected_pages_deployment_id:');
    expect(workflow).toContain('test "$DELIVERY_TARGET" = "admin"');
    expect(workflow).toContain('test "$active_id" = "$EXPECTED_PAGES_DEPLOYMENT_ID"');
    expect(workflow).toContain('test "$active_sha" = "$PAGES_SOURCE_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$PAGES_SOURCE_SHA" "$GITHUB_SHA"');
    expect(workflow).toContain('git worktree add --detach "$admin_root" "$PAGES_SOURCE_SHA"');
    expect(workflow).toContain('[ "$PAGES_CONFIG_REPLAY" != "true" ]');
    expect(workflow).toContain('test "$deployed_sha" = "$source_sha"');
    expect(workflow).toContain('test "$deployed_id" != "$EXPECTED_PAGES_DEPLOYMENT_ID"');
    expect(workflow).not.toContain('pnpm d1 migrations apply');
  });

  it('verifies the active Version ID and Google write setting after Worker deploy', () => {
    expect(workflow).toContain('id: worker_deploy');
    expect(workflow).toContain('Current Version ID:');
    expect(workflow).toContain('/versions/$version_id');
    expect(workflow).toContain('test "$active_version" = "$version_id"');
    expect(workflow).toContain('GOOGLE_BUSINESS_WRITE_ENABLED');
    expect(workflow).toContain(
      'test "$actual" = "$EXPECTED_GOOGLE_BUSINESS_WRITE_ENABLED"',
    );
  });
  it('stamps the source HEAD before build and checks public metadata after deploy', () => {
    expect(workflow).toContain('stamp-staging-version.ts "$worker_root"');
    expect(workflow.indexOf('stamp-staging-version.ts')).toBeLessThan(workflow.indexOf('pnpm --filter worker build'));
    expect(workflow).toContain('$STAGING_API_URL/admin/version');
    expect(workflow).toContain('.git_commit == $commit and .version == $version');
    expect(workflow).toContain('test "$matched" = true');
  });

});
