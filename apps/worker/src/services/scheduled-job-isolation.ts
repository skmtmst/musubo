import { logger, scheduledJobCode } from '@line-crm/shared/server';
export type ScheduledJob = {
  name: string;
  run: () => Promise<void>;
};

export type ScheduledJobFailure = {
  name: string;
  reason: unknown;
};

export const SCHEDULED_CRONS = {
  restaurantMinute: '* * * * *',
  delivery: '*/5 * * * *',
  frequentHeavy: '1-56/5 * * * *',
  sixHourlyHeavy: '0 */6 * * *',
} as const;

export const STAGING_LINE_TOKEN_REFRESH_CRON = '2-57/5 * * * *';
export const STAGING_BANNER_GENERATION_CRON = '*/2 * * * *';

export type ScheduledLane = keyof typeof SCHEDULED_CRONS | 'ignored';

export function scheduledLane(cron: string): ScheduledLane {
  const matched = Object.entries(SCHEDULED_CRONS).find(([, expression]) => expression === cron);
  return (matched?.[0] as keyof typeof SCHEDULED_CRONS | undefined) ?? 'ignored';
}


/** 呼出元の固定名だけを記録する。例外の本文・任意のjob名は出さない。 */
function logScheduledFailure({ name, reason }: ScheduledJobFailure): void {
  const job = scheduledJobCode(name);
  const category = reason instanceof TypeError ? 'type_error'
    : reason instanceof SyntaxError ? 'syntax_error'
      : reason instanceof Error && reason.name === 'AbortError' ? 'aborted' : 'error';
  logger.error('scheduled.job_failed', { scheduledJob: job, failureKind: category });
}

/** 同じcron内の処理を独立して走らせ、1件の失敗で残りを止めない。 */
export async function runIsolatedScheduledJobs(
  jobs: ScheduledJob[],
  onFailure: (failure: ScheduledJobFailure) => void = logScheduledFailure,
): Promise<{ succeeded: number; failed: number }> {
  const results = await Promise.allSettled(jobs.map((job) => job.run()));
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed += 1;
      onFailure({ name: jobs[index]!.name, reason: result.reason });
    }
  });
  return { succeeded: results.length - failed, failed };
}
