// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import * as deployed from '../../worker/src/client/salon-booking/main.js';
import * as shared from './salon-entry.js';

test('配備入口が共通の予約画面を読む。もう1組の部品を作らせない', () => {
  expect(deployed.mountSalonBooking).toBe(shared.mountSalonBooking);
  expect(deployed.unmountSalonBooking).toBe(shared.unmountSalonBooking);
  const files = readdirSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/src/client/salon-booking/'));
  expect(files).toEqual(['main.tsx']);
});

test('席・スタンプの入口は旧CSSを読まない', () => {
  for (const entry of ['restaurant', 'visit-stamps']) {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), `../../worker/src/client/${entry}/main.tsx`), 'utf8');
    expect(source).not.toContain('salon-booking/styles.css');
    if (entry === 'restaurant') expect(source).toContain('liff/src/embedded.css');
  }
});
