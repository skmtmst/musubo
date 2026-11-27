// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryMenuItem } from '@/lib/restaurant-delivery-api'
import SoldOutBoard from './bulk'

afterEach(cleanup)

const item: DeliveryMenuItem = {
  id: 'menu-1',
  name: '唐揚げ弁当',
  category: '弁当',
  price: 980,
  soldOut: false,
  services: [{ service: 'demaecan', soldOut: false }],
} as DeliveryMenuItem

function baseProps(overrides: Partial<React.ComponentProps<typeof SoldOutBoard>> = {}): React.ComponentProps<typeof SoldOutBoard> {
  return {
    items: [item],
    total: 1,
    soldOutCount: 0,
    query: '',
    onQueryChange: vi.fn(),
    soldOutOnly: false,
    onSoldOutOnlyChange: vi.fn(),
    page: 1,
    perPage: 20,
    loading: false,
    error: null,
    selected: ['menu-1'],
    busy: false,
    busyItemId: null,
    canManage: true,
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onToggleOne: vi.fn(),
    onSubmit: vi.fn(),
    onRetry: vi.fn(),
    onPage: vi.fn(),
    onPerPage: vi.fn(),
    ...overrides,
  }
}

describe('SoldOutBoard の送信中・ページ範囲ガード', () => {
  it('一括送信中は BulkBar の選択解除を押しても選択を消さない', () => {
    const onToggleAll = vi.fn()
    render(<SoldOutBoard {...baseProps({ busy: true, onToggleAll })} />)

    const clearButton = screen.getByRole('button', { name: '選ぶのをやめる' })
    fireEvent.click(clearButton)

    expect(onToggleAll).not.toHaveBeenCalled()
  })

  it('ページ番号が 0 以下でも先頭ページへ丸めて商品と件数表示を壊さない', () => {
    render(<SoldOutBoard {...baseProps({ page: 0 })} />)

    expect(screen.getByText('唐揚げ弁当')).toBeTruthy()
    expect(screen.getByText('全1品中 1〜1品を表示')).toBeTruthy()
  })
})
