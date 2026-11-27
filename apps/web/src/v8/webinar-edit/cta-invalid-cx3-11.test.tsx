import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
/*
 * ★V8 案内ボタン・フォーム（）の描画。
 * 差し替えるのは通信だけ。カードの一覧・選んだカードの欄・申込フォームが実在する。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

import CtaPane from '@/v8/webinar-edit/cta'
import { webinarEditContext, webinarWizardChrome } from '@/test-utils/webinar-edit'
import type { EditContext, PaneSaveProps } from '@/v8/webinar-edit/types'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
import { ApiError, type Webinar, type WebinarEditor } from '@/lib/api'

const EDITOR = { version: 5, registrationFormId: null, publicPage: { form: null } } as WebinarEditor

const roots: Root[] = []
function render(props: Partial<PaneSaveProps & Pick<EditContext, 'onEditorChange'>> = {}): HTMLElement {
  let saveHandler: (() => Promise<boolean>) | null = null
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  roots.push(root)
  act(() => {
    root.render(
      <CtaPane
        ctx={webinarEditContext({ id: 'webinar-1', accountId: 'account-1', durationSeconds: 3600 } as Webinar, EDITOR, { onEditorChange: props.onEditorChange ?? (() => {}) })}
        chrome={{ ...webinarWizardChrome, footerActions: <button onClick={() => void saveHandler?.()}>下書きを保存</button> }}
        onDirtyChange={props.onDirtyChange ?? (() => {})}
        registerSave={(handler) => { saveHandler = handler; props.registerSave?.(handler) }}
      />,
    )
  })
  return host
}
beforeEach(() => {
  vi.resetAllMocks()
  apiMocks.saveCtas.mockResolvedValue({ data: [] })
  apiMocks.saveEditor.mockResolvedValue({ data: EDITOR })
  apiMocks.fetchApi.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount() }); document.body.innerHTML = ''; vi.clearAllMocks() })
const card = { atSeconds: 720, kind: 'url', title: '見出し', body: null, buttonLabel: '見る', autoOpen: false, formId: null, url: 'https://example.com' }

it('ホスト名の無いURLは保存せず理由を表示する', async () => {
  apiMocks.ctas.mockResolvedValue({ data: [{ ...card, url: 'https://' }] })
  const host = render()
  await act(async () => undefined)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
  expect(apiMocks.saveCtas).not.toHaveBeenCalled()
  expect(host.textContent).toContain('正しい URL を入れてください')
})

it('未知のカード種別は保存せず理由を表示する', async () => {
  apiMocks.ctas.mockResolvedValue({ data: [{ ...card, kind: 'future' }] })
  const host = render()
  await act(async () => undefined)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
  expect(apiMocks.saveCtas).not.toHaveBeenCalled()
  expect(host.textContent).toContain('カードの種類を確認できません')
})
