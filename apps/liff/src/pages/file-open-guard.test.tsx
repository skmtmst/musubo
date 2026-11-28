// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FileOpen from './file-open.js';
import { issueFile, fetchFileBlob } from '../lib/file-download-api.js';

vi.mock('../lib/file-download-api.js', async (original) => ({ ...await original<typeof import('../lib/file-download-api.js')>(), issueFile: vi.fn(), fetchFileBlob: vi.fn() }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
const file = { id: 'f1', url: '/images/chat-attachments/f1', expiresAt: '2099-10-20T01:00:00Z', filename: '写真.png', mimeType: 'image/png', size: 100, kind: 'image' as const };
beforeEach(() => { vi.mocked(issueFile).mockResolvedValue(file); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} })); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const mount = () => render(<MemoryRouter initialEntries={['/files/f1']}><Routes><Route path="/files/:id" element={<FileOpen />} /></Routes></MemoryRouter>);
it('不正なファイル情報は開ける状態にせず、読み直せる', async () => {
  vi.mocked(issueFile).mockResolvedValueOnce({ ...file, size: -1 }).mockResolvedValueOnce(file);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度試す' }));
  expect(await screen.findByText('写真.png')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ファイルを開く' })).toBeTruthy();
});
it('ファイルを開くボタンを続けて押しても取得は一度だけ', async () => {
  let finish!: (blob: Blob) => void;
  vi.mocked(fetchFileBlob).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  mount();
  const button = await screen.findByRole('button', { name: 'ファイルを開く' });
  act(() => { button.click(); button.click(); });
  expect(fetchFileBlob).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Blob(['x'])));
  expect(await screen.findByAltText('写真.png')).toBeTruthy();
});
