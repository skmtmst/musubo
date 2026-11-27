// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEMPLATES } from '@/lib/rich-menu-templates'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  uploadImage: vi.fn(),
  notifyToast: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        create: mocks.create,
        uploadImage: mocks.uploadImage,
      },
    },
  }
})

vi.mock('@/components/shared/toast', () => ({
  notifyToast: mocks.notifyToast,
}))

import { createMenuDraft, saveMenuDraft } from './create-save-actions'

function SaveHarness({ onResult }: { onResult: (ok: boolean) => void }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [pendingImages, setPendingImages] = useState([
    { file: new File(['img'], 'menu.png', { type: 'image/png' }), url: '' },
  ])

  const handleSave = async () => {
    const ok = await saveMenuDraft({
      createDraft: () =>
        createMenuDraft({
          accountId: 'acc-1',
          audience: 'all',
          chatBarText: 'メニュー',
          defaultOpen: true,
          folderId: '',
          host: undefined,
          hostSeedFromShape: async () => null,
          hydrate: () => {},
          name: '通常メニュー',
          pendingImages,
          reloadGroup: async () => {},
          saveErrors: { capture: () => false },
          setError,
          setPendingImages,
          size: 'large',
          tabCount: 0,
          tabNameAt: () => 'メイン',
          targetingCondition: null,
          targetingPriority: 1,
          templateKey: TEMPLATES[0].key,
          validateBasics: () => true,
        }),
      group: null,
      host: undefined,
      persistDraft: async () => {},
      reloadGroup: async () => {},
      saveErrors: { capture: () => false },
      saving,
      setCompareOpen: () => {},
      setConflict: () => {},
      setConflictLatest: () => {},
      setError,
      setNotice,
      setSaving,
      validateBasics: () => true,
    })
    onResult(ok)
  }

  return (
    <div>
      <button type="button" onClick={() => void handleSave()}>下書きを保存</button>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('リッチメニュー下書き作成時の画像アップロード失敗処理', () => {
  it('手元ファイルの画像アップロードが失敗したときは保存成功にせず、登録メディア誤認のないエラーを出す', async () => {
    mocks.create.mockResolvedValue({
      success: true,
      data: { id: 'rmg-1', pages: [{ id: 'page-1' }] },
    })
    mocks.uploadImage.mockResolvedValue({
      success: false,
      error: 'アップロードに失敗しました',
    })
    const onResult = vi.fn()

    render(<SaveHarness onResult={onResult} />)
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('登録メディア')
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.notifyToast).not.toHaveBeenCalled()
  })
})
