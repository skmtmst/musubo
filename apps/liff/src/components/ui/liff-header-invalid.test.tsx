// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LiffHeader from './liff-header.js';
import { api } from '../../lib/api.js';

const identity = vi.hoisted(() => ({ value: 0 }));
vi.mock('../../lib/liff-auth.js', () => ({ getLiffId: () => `header-invalid-${identity.value}` }));
vi.mock('../../lib/api.js', () => ({ api: { liffConfig: vi.fn() } }));
vi.mock('../../lib/liff-runtime.js', () => ({ default: { closeWindow: vi.fn() } }));
beforeEach(() => { identity.value++; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it.each([
  ['失敗の応答', { success: false, data: { accountName: '誤った店' } }],
  ['不正な店名', { success: true, data: { accountName: { value: '誤った店' } } }],
])('%sを店名として扱わず、読み直して表示する', async (_label, bad) => {
  vi.mocked(api.liffConfig).mockResolvedValueOnce(bad as never).mockResolvedValueOnce({ success: true, data: { accountId: 'a', accountName: '正しいお店', botBasicId: '' } });
  render(<LiffHeader title="予約" />);
  const retry = await screen.findByRole('button', { name: '店名を確認し直す' });
  expect(screen.queryByText('誤った店')).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('正しいお店')).toBeTruthy();
  expect(api.liffConfig).toHaveBeenCalledTimes(2);
});
