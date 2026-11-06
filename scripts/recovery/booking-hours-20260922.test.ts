import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { applyOnce, assertContext, digest, makeClient, reads, repairBatch, snapshotFrom, TARGET, validate, verify, type Query } from './booking-hours-20260922.js';

const recoveryTime = '2026-09-22T12:30:00.000+09:00';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE menus (id TEXT PRIMARY KEY, base_price INTEGER);`);
  db.exec(readFileSync(new URL('../../packages/db/migrations/323_booking_store_settings.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../packages/db/migrations/391_booking_business_hours_configured.sql', import.meta.url), 'utf8'));
  db.exec(`ALTER TABLE booking_settings ADD COLUMN reminder_day_before_time TEXT;
    ALTER TABLE booking_settings ADD COLUMN reminder_hours_before INTEGER;
    ALTER TABLE booking_business_hours ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1;`);
  db.prepare('INSERT INTO line_accounts (id) VALUES (?), (?)').run(TARGET.lineAccount, 'other-account');
  db.prepare(`INSERT INTO booking_settings (id, line_account_id, business_hours_configured, version,
    reminder_hours_before, updated_at) VALUES ('setting', ?, 1, 7, 2, '2026-09-22T03:23:12.000+09:00')`).run(TARGET.lineAccount);
  db.exec(`INSERT INTO booking_settings (id, line_account_id) VALUES ('other-setting', 'other-account');
    INSERT INTO booking_business_hours (id, booking_settings_id, weekday, start_time, end_time, created_at)
      VALUES ('accidental', 'setting', 1, '09:00', '18:00', '2026-09-22T03:23:12.010'),
        ('other-interval', 'other-setting', 2, '10:00', '12:00', '2026-09-01T00:00:00.000');`);
  const run = (queries: Query[]) => {
    db.exec('BEGIN');
    try {
      const result = queries.map(q => db.prepare(q.sql).all(...(q.params ?? [])));
      db.exec('COMMIT');
      return result as Parameters<typeof snapshotFrom>[0];
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const snapshot = () => snapshotFrom(run(reads));
  return { db, run, snapshot };
}
const context = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: TARGET.repository,
  GITHUB_REF: 'refs/heads/codex/development',
  GITHUB_WORKFLOW_REF: `${TARGET.repository}/.github/workflows/migrate-d1.yml@refs/heads/codex/development`,
  RECOVERY_ENVIRONMENT: 'staging', CLOUDFLARE_ACCOUNT_ID: TARGET.account,
  CLOUDFLARE_API_TOKEN: 'fake-unit-test-token', RECOVERY_MODE: 'dry-run',
};
const now = new Date(recoveryTime);

describe('20260922 one-account recovery', () => {
  it('restores only the flag/interval; increments rather than rewinds the version', async () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const other = f.db.prepare("SELECT * FROM booking_settings WHERE id = 'other-setting'").get();
      const otherHours = f.db.prepare("SELECT * FROM booking_business_hours WHERE id = 'other-interval'").get();
      const after = await applyOnce(async q => f.run(q), before, digest(before), recoveryTime);
      verify(before, after, recoveryTime);
      expect(after.settings[0]?.version).toBe(8);
      expect(after.hours).toEqual([]);
      expect(f.db.prepare("SELECT * FROM booking_settings WHERE id = 'other-setting'").get()).toEqual(other);
      expect(f.db.prepare("SELECT * FROM booking_business_hours WHERE id = 'other-interval'").get()).toEqual(otherHours);
      await expect(applyOnce(async q => f.run(q), before, digest(before), recoveryTime)).rejects.toThrow('Data changed');
      expect(f.snapshot()).toEqual(after);
    } finally { f.db.close(); }
  });
  it.each([
    "UPDATE booking_settings SET version = version + 1 WHERE id = 'setting'",
    "UPDATE booking_settings SET booking_window_days = 30 WHERE id = 'setting'",
    "UPDATE booking_business_hours SET end_time = '17:00' WHERE id = 'accidental'",
    "INSERT INTO booking_business_hours (id, booking_settings_id, weekday, start_time, end_time) VALUES ('new', 'setting', 2, '09:00', '18:00')",
    "ALTER TABLE booking_settings ADD COLUMN future_setting TEXT",
  ])('fails atomically even if state changes AFTER preflight: %s', sql => {
    const f = fixture();
    try {
      const planned = repairBatch(f.snapshot(), recoveryTime);
      f.db.exec(sql);
      const current = f.snapshot();
      expect(() => f.run(planned)).toThrow();
      expect(f.snapshot()).toEqual(current);
    } finally { f.db.close(); }
  });
  it('rolls back the deletion if the later UPDATE fails', () => {
    const f = fixture();
    try {
      f.db.exec("CREATE TRIGGER deny_update BEFORE UPDATE ON booking_settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
      const raw = f.snapshot();
      const withoutTrigger = { ...raw, schema: raw.schema.filter(r => r.type !== 'trigger') };
      // Build from the known schema, then omit only the first guard to inject a failure at the second write.
      expect(() => f.run(repairBatch(withoutTrigger, recoveryTime).slice(1))).toThrow('synthetic failure');
      expect(f.snapshot()).toEqual(raw);
      expect(() => validate(raw)).toThrow('Unexpected schema');
    } finally { f.db.close(); }
  });
  it('rolls back when the update silently affects zero rows', () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const queries = repairBatch(before, recoveryTime);
      queries[3]!.params![1] = 'missing';
      expect(() => f.run(queries)).toThrow();
      expect(f.snapshot()).toEqual(before);
    } finally { f.db.close(); }
  });
  it.each([
    ['business_hours_configured', 0], ['line_account_id', 'wrong'], ['version', 0],
    ['updated_at', '2026-09-22T10:00:00.000+09:00'], ['reminder_hours_before', 3],
  ])('rejects an unexpected setting: %s', (key, value) => {
    const f = fixture();
    try { const s = f.snapshot(); s.settings[0]![key] = value; expect(() => validate(s)).toThrow(); }
    finally { f.db.close(); }
  });
  it('rejects a digest mismatch before any DB call', async () => {
    const f = fixture();
    try {
      const batch = vi.fn();
      await expect(applyOnce(batch, f.snapshot(), '0'.repeat(64), recoveryTime)).rejects.toThrow('Backup differs');
      expect(batch).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it('does not retry an ambiguous write response', async () => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const batch = vi.fn(async (q: Query[]) => { const rows = f.run(q); if (q.length > 3) throw new Error('response lost'); return rows; });
      await expect(applyOnce(batch, before, digest(before), recoveryTime)).rejects.toThrow('response lost');
      expect(batch).toHaveBeenCalledTimes(2);
      expect(f.snapshot().settings[0]?.version).toBe(8);
    } finally { f.db.close(); }
  });
  it('only contains read queries in preflight', () => {
    expect(reads.every(q => q.sql.trim().startsWith('SELECT'))).toBe(true);
  });
  it.each([
    ['GITHUB_ACTIONS', 'false'], ['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_REPOSITORY', 'other/repo'],
    ['GITHUB_REF', 'refs/heads/main'], ['RECOVERY_ENVIRONMENT', 'production'], ['CLOUDFLARE_ACCOUNT_ID', 'other'],
    ['CLOUDFLARE_API_TOKEN', ''], ['RECOVERY_MODE', 'bad'], ['GITHUB_WORKFLOW_REF', 'other'],
  ])('rejects wrong execution context: %s', (key, value) => {
    expect(() => assertContext({ ...context, [key]: value }, now)).toThrow();
  });
  it('requires approval/digest and expires after the incident window', () => {
    expect(() => assertContext(context, now)).not.toThrow();
    expect(() => assertContext({ ...context, RECOVERY_MODE: 'apply' }, now)).toThrow();
    expect(() => assertContext({ ...context, RECOVERY_MODE: 'apply', RECOVERY_DIGEST: 'a'.repeat(64), RECOVERY_CONFIRMATION: TARGET.confirmation }, now)).not.toThrow();
    expect(() => assertContext(context, new Date('2026-09-29T00:00:00+09:00'))).toThrow('expired');
  });
  it('uses only the fixed D1 endpoint, no redirects or retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] })));
    await makeClient(context, fetcher).batch([reads[0]!]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${TARGET.account}/d1/database/${TARGET.database}/query`);
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
    fetcher.mockResolvedValueOnce(new Response('secret response', { status: 403 }));
    await expect(makeClient(context, fetcher).batch(reads)).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the privileged job separate and uploads backup before apply', () => {
    const source = readFileSync(new URL('../../.github/workflows/migrate-d1.yml', import.meta.url), 'utf8');
    const job = source.split('  restore-booking-hours-20260922:')[1]!.split('\n  migrate:')[0]!;
    expect(job).toContain("inputs.environment == 'staging'");
    expect(job).toContain("github.ref == 'refs/heads/codex/development'");
    expect(job).toContain('environment: staging');
    expect(job).toContain('cancel-in-progress: false');
    expect(job).toContain('if-no-files-found: error');
    expect(job).toContain('RECOVERY_ARTIFACT_ID: ${{ steps.backup.outputs.artifact-id }}');
    expect(job.indexOf('uses: actions/upload-artifact@')).toBeLessThan(job.indexOf('booking-hours-20260922.ts apply'));
    expect(job).not.toMatch(/continue-on-error|wrangler|deploy |time-travel restore|_migrations/);
    expect(source).toContain("if: github.repository == 'skmtmst/line-harness-oss' && inputs.operation == 'migrate'");
  });
});
