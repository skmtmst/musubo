// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FormInputBlock } from '@line-crm/shared';
import SeatBookingBlock from './seat-booking-block.js';

const net = vi.hoisted(() => ({ courses: vi.fn(), availability: vi.fn() }));
vi.mock('../lib/api.js', () => ({ restaurantBookingApi: net }));
const block = { id: 'reservation', booking: { storeId: 'store' } } as FormInputBlock;
beforeEach(() => { net.courses.mockReset().mockResolvedValue({ data: [] }); net.availability.mockReset().mockResolvedValue({ data: { slots: [] } }); });
afterEach(cleanup);
function open() { render(<SeatBookingBlock block={block} value="" onChange={() => {}} />); }

it('コース情報が不正なら空きなしにせず読み直せる', async () => {
  net.courses.mockResolvedValueOnce({ data: null });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('この日は空きがありません。ほかの日を選んでください。')).toBeTruthy();
});

it('空き情報が不正なら空きなしにせず読み直せる', async () => {
  net.availability.mockResolvedValueOnce({ data: { slots: null } });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('この日は空きがありません。ほかの日を選んでください。')).toBeTruthy();
});
