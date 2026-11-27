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
import { buildCompareRows } from '@/v8/webinar-edit/cta-compare'
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

describe('変更比較で不正なカードを表示する', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    apiMocks.ctas.mockResolvedValueOnce({ data: [{ atSeconds: 720, kind: 'form', title: '入力中', buttonLabel: '申し込む', formId: 'form-1' }] })
    apiMocks.fetchApi.mockResolvedValue({ success: true, data: [{ id: 'form-1', name: 'フォーム1', isActive: true }] })
    apiMocks.saveEditor.mockRejectedValueOnce(new ApiError(409, 'version_conflict'))
    apiMocks.editor.mockResolvedValue({ data: EDITOR })
  })
  afterEach(() => {
    act(() => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
  })
  async function compare(card: unknown) {
    apiMocks.ctas.mockResolvedValueOnce({ data: [card] })
    const host = render()
    await act(async () => undefined)
    await pickEntity('申込に使う回答フォーム', 'フォーム1')
    const click = async (label: string) => act(async () => { [...host.querySelectorAll('button')].find((element) => element.textContent === label)!.click() })
    await click('下書きを保存')
    await click('違いを比べる')
    return screen.getByRole('dialog', { name: '違いを比べる' })
  }
  it('見出しとボタンの文字が不正なら確認できないと表示する', async () => {
    const dialog = await compare({ atSeconds: 60, title: {}, buttonLabel: {} })
    expect(dialog.textContent).toContain('「確認できません」／ボタン「確認できません」／1:00から')
    expect(dialog.textContent).not.toContain('[object Object]')
  })
  it('入力時刻が null なら保存された時刻を表示する', () => {
    const card = { atSeconds: 754, title: '保存済み', buttonLabel: '申込' } as unknown as import('@/lib/api').WebinarCtaCard
    const row = buildCompareRows({ formName: '', cards: [card], times: [null as unknown as string] }, '', [card])[1]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    act(() => root.render(<div>{row.mine}</div>))
    expect(host.textContent).toContain('12:34から')
    expect(host.textContent).not.toContain('nullから')
  })
  it('不正な時刻を確定した時刻として表示しない', async () => {
    const dialog = await compare({ atSeconds: -1, title: '保存済み', buttonLabel: '申込' })
    expect(dialog.textContent).toContain('「保存済み」／ボタン「申込」／時刻を確認できません')
    expect(dialog.textContent).not.toContain('-1:-1')
  })
})
