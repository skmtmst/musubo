// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageTemplateDefinition } from '@/lib/hq-templates-api'
import MessageForm from './message-form'
import { useFormErrors } from '@/lib/use-form-errors'

vi.mock('@/lib/hq-templates-api', () => ({ hqTemplatesApi: { messageReferences: async () => [{ kind: 'form', id: 'f-1', name: 'アンケート', accountName: '本店' }] } }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))
afterEach(cleanup)

const base: MessageTemplateDefinition = {
  schemaVersion: 1,
  template: { id: 'legacy-message', name: '前のひな形', category: 'general', messageType: 'text', messageContent: 'こんにちは', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' },
  media: [],
}
function Harness({ initial, save }: { initial: MessageTemplateDefinition; save: (value: MessageTemplateDefinition) => void }) {
  const [value, setValue] = useState(initial)
  return <><MessageForm name="前のひな形" onNameChange={() => {}} value={value} onChange={setValue} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} /><button onClick={() => save(value)}>保存</button></>
}

describe('統括の旧メッセージ編集（保存結果の再確認にも使う）', () => {
  it('既存のカードは画像・ボタン・参照先を残して本文だけ編集できる', async () => {
    const save = vi.fn()
    const card = { format: 'flex' as const, title: 'ご案内', body: '元の本文', imageMediaId: 'media-old', buttons: [{ id: 'b-1', label: '予約', action: 'url' as const, value: 'https://example.test/book' }] }
    render(<Harness initial={{ ...base, card, template: { ...base.template, messageType: 'flex' } }} save={save} />)
    expect(await screen.findByText(/この形は新しく作れません/)).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'ひな形の形式' })).toBeNull()
    expect(screen.queryByLabelText('メッセージ形式')).toBeNull()
    fireEvent.change(screen.getByLabelText('配信する本文'), { target: { value: '直した本文' } })
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
    expect(save.mock.calls[0][0]).toMatchObject({ card: { ...card, body: '直した本文' }, template: { messageType: 'flex' } })
    expect(JSON.parse(save.mock.calls[0][0].template.messageContent).body.contents.some((row: { text?: string }) => row.text === '直した本文')).toBe(true)
  })

  it('画像の長いファイル名は省略しても全文を title で見られる', async () => {
    const filename = 'とても長いファイル名の秋の新メニューのご案内用の画像_2026年10月版.png'
    const media = { id: 'media-old', kind: 'image' as const, filename, mimeType: 'image/png', sizeBytes: 1, width: 1040, height: 1040, durationMs: null, r2Key: 'k', publicUrl: null, versionId: 'v-1', versionNo: 1, contentHash: 'h' }
    const card = { format: 'flex' as const, title: 'ご案内', body: '本文', imageMediaId: 'media-old', buttons: [] }
    render(<Harness initial={{ ...base, media: [media], card, template: { ...base.template, messageType: 'flex' } }} save={vi.fn()} />)
    const name = await screen.findByText(`${filename}・1040×1040`)
    expect(name.getAttribute('title')).toBe(`${filename}・1040×1040`)
  })

  it('既存の画像は切り替えを出さず、URLを直しても画像のまま保存できる', async () => {
    const save = vi.fn()
    render(<Harness initial={{ ...base, template: { ...base.template, messageType: 'image', messageContent: 'https://img.test/old.png' } }} save={save} />)
    expect(await screen.findByText(/この形は新しく作れません/)).toBeTruthy()
    expect(screen.queryByLabelText('メッセージ形式')).toBeNull()
    fireEvent.change(screen.getByLabelText('配信する本文'), { target: { value: 'https://img.test/new.png' } })
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
    expect(save.mock.calls[0][0].template).toMatchObject({ messageType: 'image', messageContent: 'https://img.test/new.png' })
  })

  it('ボタンの押したらは共通の欄：回答フォームは窓で選び、保存は今の形（action・value）', async () => {
    const save = vi.fn()
    const card = { format: 'flex' as const, title: 'ご案内', body: '本文', buttons: [{ id: 'b-1', label: '答える', action: 'url' as const, value: 'https://example.test/a' }] }
    render(<Harness initial={{ ...base, card, template: { ...base.template, messageType: 'flex' } }} save={save} />)
    fireEvent.click(screen.getByRole('button', { name: 'ボタン1を押したとき' }))
    const kinds = within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.getAttribute('aria-label'))
    expect(kinds).toEqual(['URLを開く', 'テキストを送る', '回答フォーム', 'シナリオを始める'])
    fireEvent.click(within(screen.getByRole('listbox')).getByText('回答フォーム'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'ボタン1の回答フォームを選択する' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'ボタン1の回答フォームを選択する' }))
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: 'アンケート（本店）' })).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('radio', { name: 'アンケート（本店）' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
    expect(save.mock.calls[0][0].card.buttons[0]).toEqual({ id: 'b-1', label: '答える', action: 'form', value: 'f-1' })
  })
})

describe('統括のメッセージのひな形：欄ごとの誤り', () => {
  function FieldsHarness({ initial, save }: { initial: MessageTemplateDefinition; save: (value: MessageTemplateDefinition) => void }) {
    const [value, setValue] = useState(initial)
    const fields = useFormErrors()
    return <><MessageForm name="" onNameChange={() => {}} value={value} onChange={setValue} folders={[]} folderId={null} onFolderChange={() => {}} folderLoadFailed={false} disabled={false} catalogFailed={false} onReloadCatalog={() => {}} fields={fields} /><button onClick={() => { if (fields.submit().length === 0) save(value) }}>保存</button></>
  }
  it('名前・本文・ボタンの中身が空なら保存せず、欄ごとに理由を出して名前へ移る', async () => {
    const save = vi.fn()
    const card = { format: 'flex' as const, title: 'ご案内', body: '', buttons: [{ id: 'b-1', label: '予約', action: 'url' as const, value: '' }] }
    render(<FieldsHarness initial={{ ...base, card, template: { ...base.template, messageType: 'flex' } }} save={save} />)
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
    expect(save).not.toHaveBeenCalled()
    expect(document.getElementById('hq-msg-name-error')?.textContent).toBe('ひな形の名前を入力してください')
    expect(document.getElementById('hq-msg-body-error')?.textContent).toBe('配信する本文を入力してください')
    expect(document.getElementById('hq-msg-button-b-1-error')?.textContent).toBe('URLを入力してください')
    expect(screen.getByLabelText('ひな形の名前').getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('ひな形の名前')))
  })
})
