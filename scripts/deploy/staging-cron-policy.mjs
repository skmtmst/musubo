import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const allowedCrons = ['2-57/5 * * * *', '*/2 * * * *'];
const scheduleError = 'The staging Worker may only schedule LINE token renewal and new banner generation';

/** Offline verification scripts accept the canonical staging TOML syntax only. */
export function assertStagingCronSource(source) {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const start = lines.indexOf('[triggers]');
  if (start !== -1) {
    if (lines[start + 1] !== `crons = [${allowedCrons.map((cron) => JSON.stringify(cron)).join(', ')}]`) {
      throw new Error(scheduleError);
    }
    if (lines[start + 2] && !lines[start + 2].startsWith('[')) throw new Error(scheduleError);
    lines.splice(start, 2);
  }
  if (lines.some((line) => /\b(?:triggers|crons)\b/.test(line))) throw new Error(scheduleError);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = process.argv[2];
  assertStagingCronSource(readFileSync(config, 'utf8'));
  const { unstable_readConfig } = await import('wrangler');
  const { triggers } = unstable_readConfig({ config });
  const crons = triggers?.crons ?? [];
  if (crons.length && JSON.stringify(crons) !== JSON.stringify(allowedCrons)) throw new Error(scheduleError);
}
