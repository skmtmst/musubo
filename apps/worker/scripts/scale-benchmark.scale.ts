/*
 * 大きいデータの速度の見張りを vitest の上で1回走らせる入口。
 * 通常の試験（vitest.config.ts の *.test.ts）には入らない。vitest.scale.config.ts からだけ読む。
 * 通常は報告だけ。本番の関門（SCALE_RELEASE_GATE=1）では3秒超・異常応答を失敗にする。
 */
import { expect, test } from 'vitest';
import { readOptions, runScaleBenchmark } from './scale-benchmark.js';

test('大きいデータの速度を測って表にする', async () => {
  const options = readOptions(process.env);
  const report = await runScaleBenchmark(options);
  process.stdout.write(`\n${process.env.SCALE_RELEASE_GATE === '1' ? report.markdown.replace('（報告だけ）', '（本番前の関門）') : report.markdown}\n`);
  expect(report.counts.friends).toBeGreaterThan(0);
  expect(report.results.filter(result => result.status >= 500).map(result => result.key)).toEqual([]);
  if (process.env.SCALE_RELEASE_GATE === '1') {
    expect(report.counts.friends).toBe(50_000);
    expect(report.results.filter(result => result.status !== 200 || result.runsMs.some(ms => ms > 3000))
      .map(result => ({ key: result.key, status: result.status, runsMs: result.runsMs }))).toEqual([]);
  }
}, 60 * 60_000);
