// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BookingStorePhotos from './booking-store-photos.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { storePhotos: read } }));
beforeEach(() => read.mockReset());
afterEach(cleanup);
it.each([
  ['一覧がない', null],
  ['知らない種類', [{ slot: 'unknown', url: 'https://example.test/photo.png' }]],
])('%s場合は写真を読み直せる', async (_kind, invalid) => {
  read.mockResolvedValueOnce(invalid).mockResolvedValueOnce([{ slot: 'exterior', url: 'https://example.test/photo.png' }]);
  render(<BookingStorePhotos />);
  fireEvent.click(await screen.findByRole('button', { name: '写真を読み直す' }));
  expect(await screen.findByRole('img', { name: 'お店の外観' })).toBeTruthy();
});
