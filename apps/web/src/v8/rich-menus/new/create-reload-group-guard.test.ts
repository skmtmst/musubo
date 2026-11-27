import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        get: fixture.get,
      },
    },
  }
})

import { reloadMenuGroup } from './create-reload-group'
import type { Group } from './create-types'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('reloadMenuGroup 不正ID・欠損応答のフェイルクローズ', () => {
  it('空の groupId では API を呼ばずエラーにする', async () => {
    const hydrate = vi.fn()
    await expect(reloadMenuGroup({ hydrate }, '   ')).rejects.toThrow('リッチメニューIDを確認できませんでした')
    expect(fixture.get).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('success: true でも data が欠損または不正形のとき hydrate を呼ばずエラーにする', async () => {
    const hydrate = vi.fn()
    fixture.get.mockResolvedValueOnce({ success: true, data: null })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')
    expect(hydrate).not.toHaveBeenCalled()

    fixture.get.mockResolvedValueOnce({ success: true, data: { name: 'no-id' } })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('正常なグループ応答のときだけ hydrate を呼ぶ', async () => {
    const hydrate = vi.fn()
    const group = { id: 'grp-1', name: '通常メニュー' } as unknown as Group
    fixture.get.mockResolvedValueOnce({ success: true, data: group })
    await reloadMenuGroup({ hydrate }, 'grp-1')
    expect(fixture.get).toHaveBeenCalledWith('grp-1')
    expect(hydrate).toHaveBeenCalledWith(group)
  })
})
