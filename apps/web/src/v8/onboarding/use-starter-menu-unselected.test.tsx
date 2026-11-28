// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStarterMenu } from './use-starter-menu'

const net = vi.hoisted(() => ({ starterSet: vi.fn() }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: net }))

beforeEach(() => {
  net.starterSet.mockReset()
})

afterEach(cleanup)

describe('useStarterMenu のアカウント未選択時の読み込み状態', () => {
  it('accountId が無いときは読み込み中のまま止まらず、後から選ばれたら取得する', async () => {
    net.starterSet.mockResolvedValue({
      success: true,
      data: {
        preview: [{
          key: 'menu',
          buttons: [{ label: '予約する', feature: 'booking', actionType: 'message', actionData: '予約' }],
        }],
      },
    })

    const view = renderHook(
      ({ accountId }: { accountId: string | null }) => useStarterMenu(accountId, 'restaurant'),
      { initialProps: { accountId: null as string | null } },
    )

    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.buttons).toEqual([])
    expect(view.result.current.error).toBeNull()
    expect(net.starterSet).not.toHaveBeenCalled()

    view.rerender({ accountId: 'acc-1' })
    expect(view.result.current.loading).toBe(true)

    await waitFor(() => expect(view.result.current.loading).toBe(false))
    expect(view.result.current.buttons).toHaveLength(1)
    expect(view.result.current.buttons[0].label).toBe('予約する')

    view.rerender({ accountId: null })
    expect(view.result.current.loading).toBe(false)
    expect(view.result.current.buttons).toEqual([])
  })
})
