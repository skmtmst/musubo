// @vitest-environment happy-dom
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CopyButton } from './affiliate-parts.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function View() {
  const [url, setUrl] = useState('https://example.test/old');
  const ref = useRef<HTMLInputElement>(null);
  return <><CopyButton url={url} urlRef={ref} /><button onClick={() => setUrl('https://example.test/new')}>リンクを変更</button></>;
}
it('コピー中に続けて押しても操作は一回だけ', async () => {
  let finish!: () => void;
  const copy = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  render(<View />);
  const button = screen.getByRole('button', { name: 'コピーする' });
  act(() => { button.click(); button.click(); });
  expect(copy).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole('button', { name: 'コピーしました' })).toBeTruthy();
});
it('リンク変更後に古いコピーが完了しても、新しいリンクをコピー済みと見せない', async () => {
  let finish!: () => void;
  const copy = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValueOnce(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  render(<View />);
  fireEvent.click(screen.getByRole('button', { name: 'コピーする' }));
  fireEvent.click(screen.getByRole('button', { name: 'リンクを変更' }));
  await act(async () => finish());
  expect(screen.queryByRole('button', { name: 'コピーしました' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'コピーする' }));
  expect(await screen.findByRole('button', { name: 'コピーしました' })).toBeTruthy();
  expect(copy).toHaveBeenLastCalledWith('https://example.test/new');
});
