// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  editor: vi.fn(),
  ctas: vi.fn(),
  saveCtas: vi.fn(),
  saveEditor: vi.fn(),
  fetchApi: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchApi: apiMocks.fetchApi,
    webinarApi: {
      editor: apiMocks.editor,
      ctas: apiMocks.ctas,
      saveCtas: apiMocks.saveCtas,
      saveEditor: apiMocks.saveEditor,
    },
  }
})
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import CtaPane from './cta'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import { ApiError, type Webinar, type WebinarEditor } from '@/lib/api'

const CTA_CARD = {
  atSeconds: 600,
  kind: 'form' as const,
  title: '個別相談はこちら',
  body: null,
  buttonLabel: '相談を申し込む',
  autoOpen: false,
  formId: 'form-1',
  url: null,
}

function makeEditor(registrationFormId: string | null, version = 5): WebinarEditor {
  return {
    version,
    registrationFormId,
    publicPage: { form: registrationFormId ? { id: registrationFormId, name: `フォーム:${registrationFormId}` } : null },
  } as WebinarEditor
}

beforeEach(() => {
  vi.resetAllMocks()
  apiMocks.ctas.mockResolvedValue({ data: [CTA_CARD] })
  apiMocks.fetchApi.mockResolvedValue({
    success: true,
    data: [
      { id: 'form-1', name: 'フォーム1', isActive: true },
      { id: 'form-2', name: 'フォーム2', isActive: true },
    ],
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ウェビナー CTA 編集の webinarId 切替時の古い応答ガード', () => {
  it('「違いを比べる」の通信中に別ウェビナーへ切り替えると、前のウェビナーの比較ダイアログを出さない', async () => {
    let resolveEditor!: (value: unknown) => void
    apiMocks.saveCtas.mockRejectedValueOnce(new ApiError(409, 'conflict', 'VERSION_CONFLICT'))
    apiMocks.editor.mockReturnValueOnce(new Promise((resolve) => { resolveEditor = resolve }))

    let saveHandler: (() => Promise<boolean>) | null = null
    const onEditorChange = vi.fn()
    const renderPane = (webinarId: string, editor: WebinarEditor) => (
      <CtaPane
        ctx={webinarEditContext({ id: webinarId, accountId: 'account-1', durationSeconds: 3600 } as Webinar, editor, { onEditorChange })}
        chrome={{ ...webinarWizardChrome, footerActions: <button type="button" onClick={() => void saveHandler?.()}>下書きを保存</button> }}
        onDirtyChange={() => {}}
        registerSave={(handler) => { saveHandler = handler }}
      />
    )

    const { rerender } = render(renderPane('webinar-a', makeEditor('form-1')))
    await screen.findByText('案内ボタンのカード 1 枚')

    await act(async () => {
      await saveHandler?.()
    })

    const compareButton = await screen.findByRole('button', { name: '違いを比べる' })
    fireEvent.click(compareButton)
    await waitFor(() => expect(apiMocks.editor).toHaveBeenCalledWith('webinar-a'))

    rerender(renderPane('webinar-b', makeEditor('form-2', 9)))
    await waitFor(() => expect(screen.queryByRole('button', { name: '違いを比べる' })).toBeNull())

    await act(async () => {
      resolveEditor({ data: makeEditor('form-1', 6) })
    })

    expect(screen.queryByText('違いを比べる')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「最新を読み込んで続ける」の通信中に別ウェビナーへ切り替えると、前のウェビナーで onEditorChange を呼ばない', async () => {
    let resolveLatest!: (value: unknown) => void
    apiMocks.saveCtas.mockRejectedValueOnce(new ApiError(409, 'conflict', 'VERSION_CONFLICT'))
    apiMocks.editor.mockReturnValueOnce(new Promise((resolve) => { resolveLatest = resolve }))

    let saveHandler: (() => Promise<boolean>) | null = null
    const onEditorChange = vi.fn()
    const renderPane = (webinarId: string, editor: WebinarEditor) => (
      <CtaPane
        ctx={webinarEditContext({ id: webinarId, accountId: 'account-1', durationSeconds: 3600 } as Webinar, editor, { onEditorChange })}
        chrome={{ ...webinarWizardChrome, footerActions: <button type="button" onClick={() => void saveHandler?.()}>下書きを保存</button> }}
        onDirtyChange={() => {}}
        registerSave={(handler) => { saveHandler = handler }}
      />
    )

    const { rerender } = render(renderPane('webinar-a', makeEditor('form-1')))
    await screen.findByText('案内ボタンのカード 1 枚')

    await act(async () => {
      await saveHandler?.()
    })

    fireEvent.click(await screen.findByRole('button', { name: '最新を読み込んで続ける' }))
    const dialogConfirm = (await screen.findAllByRole('button', { name: '最新を読み込んで続ける' })).at(-1)!
    fireEvent.click(dialogConfirm)
    await waitFor(() => expect(apiMocks.editor).toHaveBeenCalledWith('webinar-a'))

    rerender(renderPane('webinar-b', makeEditor('form-2', 9)))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await act(async () => {
      resolveLatest({ data: makeEditor('form-1', 7) })
    })

    expect(onEditorChange).not.toHaveBeenCalled()
  })
})
