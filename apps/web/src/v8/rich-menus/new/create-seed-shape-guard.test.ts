import { describe, expect, it, vi } from 'vitest'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { seedMenuShape } from './create-seed-shape'

function makeHost() {
  return {
    uploadImage: vi.fn(async () => ({ r2Key: 'k-1' })),
    initial: undefined,
  } as unknown as RichMenuCreateHost
}

const dummySaveErrors = {
  capture: vi.fn(() => false),
} as unknown as ReturnType<typeof useSaveFormErrors>

describe('rich-menus/new/create-seed-shape のタブ数・表示順ガード', () => {
  it('tabCount が範囲外や非整数（-1・NaN・Infinity・3）のときは画像アップロードや例外を起こさず止める', async () => {
    for (const badTabCount of [-1, Number.NaN, Number.POSITIVE_INFINITY, 3, 1.5]) {
      const host = makeHost()
      const setError = vi.fn()
      const result = await seedMenuShape({
        audience: 'all',
        chatBarText: 'メニュー',
        defaultOpen: true,
        folderId: '',
        host,
        hqTagName: '',
        name: '見本メニュー',
        pendingImages: [],
        saveErrors: dummySaveErrors,
        setError,
        size: 'large',
        tabCount: badTabCount,
        tabNameAt: (i) => `タブ${i + 1}`,
        targetingPriority: 10,
        templateKey: 'large-2x3',
        validateBasics: () => true,
      })
      expect(result).toBeNull()
      expect(setError).toHaveBeenCalledWith('タブの数を選び直してください')
      expect(host.uploadImage).not.toHaveBeenCalled()
    }
  })

  it('targetingPriority が非有限のときは止めて理由を出し、正常値では下書きを組み立てる', async () => {
    const setError = vi.fn()
    const badPriority = await seedMenuShape({
      audience: 'all',
      chatBarText: 'メニュー',
      defaultOpen: true,
      folderId: '',
      host: makeHost(),
      hqTagName: '',
      name: '見本メニュー',
      pendingImages: [],
      saveErrors: dummySaveErrors,
      setError,
      size: 'large',
      tabCount: 1,
      tabNameAt: (i) => `タブ${i + 1}`,
      targetingPriority: Number.NaN,
      templateKey: 'large-2x3',
      validateBasics: () => true,
    })
    expect(badPriority).toBeNull()
    expect(setError).toHaveBeenCalledWith('表示順を確認してください')

    const ok = await seedMenuShape({
      audience: 'all',
      chatBarText: 'メニュー',
      defaultOpen: true,
      folderId: '',
      host: makeHost(),
      hqTagName: '',
      name: '見本メニュー',
      pendingImages: [],
      saveErrors: dummySaveErrors,
      setError: vi.fn(),
      size: 'large',
      tabCount: 1,
      tabNameAt: (i) => `タブ${i + 1}`,
      targetingPriority: 10,
      templateKey: 'large-2x3',
      validateBasics: () => true,
    })
    expect(ok?.pages).toHaveLength(2)
    expect(ok?.defaultPageId).toBe('page-1')
    expect(ok?.displayOrder).toBe(10)
  })
})
