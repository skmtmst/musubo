// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqAutoReplyEditor from './auto-reply-editor'

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
afterEach(cleanup)
const settings = { name: '店の返事', keyword: '予約', matchType: 'exact', responseType: 'text', responseContent: 'ご予約ありがとうございます', actions: [{ actionType: 'tag', config: { tagIds: ['tag-source'] }, onFailure: 'stop' }] }
const references = [{ sourceId: 'template-source', kind: 'template' as const, name: '予約の案内' }, { sourceId: 'tag-source', kind: 'tag' as const, name: '回答済み' }]
function mount(patch: Record<string, unknown> = {}, canEdit = true) {
  const onSetting = vi.fn()
  render(<HqAutoReplyEditor title="自動応答のひな形" help="説明" notice={null} canEdit={canEdit} busy={false}
    name="統括の返事" description="" settings={{ ...settings, ...patch }} references={references}
    onName={vi.fn()} onDescription={vi.fn()} onSetting={onSetting} onCancel={vi.fn()} onSave={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '何を返すかに進む' }))
  return onSetting
}
const summary = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling!.textContent

it('テンプレート参照は本文が空でも確認へ進め、同名参照と保存済み後処理件数を伝える', () => {
  const onSetting = mount({ templateId: 'template-source', responseContent: '' })
  expect(summary('返すもの')).toBe('テンプレート「予約の案内」')
  expect(summary('後の処理')).toBe('1つ')
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
  expect(screen.getByText(/内容は配布先の同じ名前のテンプレートで確認/)).toBeTruthy()
  const next = screen.getByRole('button', { name: '次へ：確認' }) as HTMLButtonElement
  expect(next.disabled).toBe(false)
  expect(next.lastElementChild?.classList.contains('lucide-arrow-right')).toBe(true)
  fireEvent.click(next)
  expect(screen.getAllByText('テンプレート「予約の案内」', { selector: 'dd' })).toHaveLength(2)
  expect(onSetting).not.toHaveBeenCalled()
})

it('保存済み画像は共通画像枠で見せ、JSONを本文欄に流さない', () => {
  const content = JSON.stringify({ originalContentUrl: 'https://example.test/full.png', previewImageUrl: 'https://example.test/preview.png' })
  const onSetting = mount({ responseType: 'image', responseContent: content })
  expect(summary('返すもの')).toBe('画像')
  expect(screen.getByAltText('返信画像のプレビュー').getAttribute('src')).toBe('https://example.test/preview.png')
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
  expect(screen.queryByText(content)).toBeNull()
  expect(onSetting).not.toHaveBeenCalled()
})

it('保存済みFlexは既存レンダラーで描き、テキスト字数や差込みと誤表示しない', () => {
  const content = JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'カードのご案内' }] } })
  mount({ responseType: 'flex', responseContent: content })
  expect(summary('返すもの')).toBe('カード')
  expect(screen.getByText('カードのご案内')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
})

it.each([true, false])('無言の後処理がある定義を「なし」としない（編集可能=%s）', canEdit => {
  mount({ responseType: 'silent', responseContent: '', actions: [...settings.actions, ...settings.actions] }, canEdit)
  expect(summary('返すもの')).toBe('返信しない')
  expect(summary('後の処理')).toBe('2つ')
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
  if (!canEdit) for (const el of screen.queryAllByRole('button', { name: '下書きとして保存' })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
})

it('通常テキストは既存の編集口を保ち、後処理未取得を0件へ置き換えない', () => {
  const onSetting = mount({ actions: 'invalid-legacy-value' })
  expect(summary('後の処理')).toBe('確認できません')
  fireEvent.change(screen.getByRole('textbox', { name: '返信内容' }), { target: { value: '変更した本文' } })
  expect(onSetting).toHaveBeenCalledWith('responseContent', '変更した本文')
})


it('プレビューURLが省略された保存済み画像は原画像で見せ、保存内容を変更しない', () => {
  const onSetting = mount({ responseType: 'image', responseContent: JSON.stringify({ originalContentUrl: 'https://example.test/full.png' }) })
  expect(screen.getByAltText('返信画像のプレビュー').getAttribute('src')).toBe('https://example.test/full.png')
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
  expect(onSetting).not.toHaveBeenCalled()
})

it.each(['画像本文', 'null', '{}'])('壊れた画像保存値%sも本文編集へ変換せず、確認不能を示して保持する', content => {
  const onSetting = mount({ responseType: 'image', responseContent: content })
  expect(screen.getByText('保存済みの返信内容の見本を表示できません。')).toBeTruthy()
  expect(screen.queryByAltText('返信画像のプレビュー')).toBeNull()
  expect(screen.queryByRole('textbox', { name: '返信内容' })).toBeNull()
  expect(onSetting).not.toHaveBeenCalled()
})
