// @vitest-environment happy-dom
import { useLayoutEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import FileOpen from './file-open.js';
import { fetchFileBlob, issueFile } from '../lib/file-download-api.js';

vi.mock('../lib/file-download-api.js', async original => ({ ...await original<typeof import('../lib/file-download-api.js')>(), issueFile: vi.fn(), fetchFileBlob: vi.fn() }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const snapshots: { path: string; text: string; images: string[] }[] = [];
function Observe() {
  const { pathname } = useLocation();
  useLayoutEffect(() => { snapshots.push({ path: pathname, text: document.body.textContent ?? '', images: [...document.querySelectorAll('img')].map(img => img.getAttribute('alt') ?? '') }); }, [pathname]);
  return null;
}
function Switch() { const navigate = useNavigate(); return <button onClick={() => navigate('/files/second')}>次のファイル</button>; }

it('別のファイルに移った最初の描画から前のファイルを隠す', async () => {
  snapshots.length = 0;
  vi.mocked(issueFile).mockReset().mockResolvedValueOnce({ id: 'first', url: '/first', expiresAt: '2099-10-20T01:00:00Z', filename: '前の写真.png', mimeType: 'image/png', size: 100, kind: 'image' }).mockReturnValueOnce(new Promise(() => {}));
  vi.mocked(fetchFileBlob).mockResolvedValue(new Blob(['first'], { type: 'image/png' }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:first');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  render(<MemoryRouter initialEntries={['/files/first']}><Switch /><Routes><Route path="/files/:id" element={<><FileOpen /><Observe /></>} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'ファイルを開く' }));
  expect(await screen.findByAltText('前の写真.png')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '次のファイル' }));
  const firstRender = snapshots.find(snapshot => snapshot.path === '/files/second');
  expect(firstRender).toBeDefined();
  expect(firstRender!.text).not.toContain('前の写真.png');
  expect(firstRender!.images).not.toContain('前の写真.png');
  expect(revoke).toHaveBeenCalledWith('blob:first');
});
