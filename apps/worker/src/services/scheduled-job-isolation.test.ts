import { describe, expect, test, vi } from 'vitest';

import {
  runIsolatedScheduledJobs,
  scheduledLane,
} from './scheduled-job-isolation.js';

describe('runIsolatedScheduledJobs', () => {
  test('固定ジョブ名と分類で失敗を区別し、例外本文や未知の名前を記録しない', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runIsolatedScheduledJobs([
        { name: 'booking expirer', run: async () => { throw new TypeError('private payload'); } },
        { name: 'analytics projection', run: async () => { throw new Error('private payload'); } },
        { name: 'private account name', run: async () => { throw new Error('private payload'); } },
      ]);
      const events = logged.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events.map(({code,scheduledJob,failureKind}) => ({code,scheduledJob,failureKind}))).toEqual([
        {code:'scheduled.job_failed',scheduledJob:'booking_expirer',failureKind:'type_error'},
        {code:'scheduled.job_failed',scheduledJob:'analytics_projection',failureKind:'error'},
        {code:'scheduled.job_failed',scheduledJob:'unknown',failureKind:'error'},
      ]);
      expect(JSON.stringify(events)).not.toContain('private');
    } finally { logged.mockRestore(); }
  });
  test('通知・5分重処理・6時間重処理を別の実行単位へ振り分ける', () => {
    expect(scheduledLane('*/5 * * * *')).toBe('delivery');
    expect(scheduledLane('1-56/5 * * * *')).toBe('frequentHeavy');
    expect(scheduledLane('0 */6 * * *')).toBe('sixHourlyHeavy');
    expect(scheduledLane('invalid')).toBe('ignored');
  });

  test('重い1処理が失敗しても同じ実行単位の残りを止めない', async () => {
    const completed: string[] = [];
    const onFailure = vi.fn();

    const result = await runIsolatedScheduledJobs([
      { name: 'heavy-failed', run: async () => { throw new Error('temporary'); } },
      { name: 'heavy-next', run: async () => { completed.push('heavy-next'); } },
    ], onFailure);

    expect(result).toEqual({ succeeded: 1, failed: 1 });
    expect(completed).toEqual(['heavy-next']);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ name: 'heavy-failed' }));
  });

  test('重い実行が失敗した後でも別の通知実行単位を処理できる', async () => {
    const reminder = vi.fn(async () => undefined);
    await runIsolatedScheduledJobs([
      { name: 'analytics', run: async () => { throw new Error('slow query'); } },
    ], () => undefined);

    await runIsolatedScheduledJobs([{ name: 'booking-reminder', run: reminder }]);

    expect(reminder).toHaveBeenCalledOnce();
  });
});
