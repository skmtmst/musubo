/*
 * 大きいデータの速度の見張りを vitest の上で1回走らせる入口（報告だけ）。
 * 通常の試験（vitest.config.ts の *.test.ts）には入らない。vitest.scale.config.ts からだけ読む。
 * 目安を超えても落とさない。落ちるのは台本そのものが壊れた時（行が入らない・口が 500 を返す）だけ。
 */
import { expect, test } from 'vitest';
import { readOptions, runScaleBenchmark } from './scale-benchmark.js';

test('大きいデータの速度を測って表にする', async () => {
  const options = readOptions(process.env);
  const report = await runScaleBenchmark(options);
  process.stdout.write(`\n${report.markdown}\n`);
  expect(report.counts.friends).toBeGreaterThan(0);
  for (const result of report.results.filter(result => ['dashboard-90', 'dashboard-custom'].includes(result.key))) {
    expect(result.medianMs).toBeLessThanOrEqual(3000);
  }
  expect(report.results.filter(result => result.status >= 400).map(result => result.key)).toEqual([]);
}, 60 * 60_000);
