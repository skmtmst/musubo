
import React, { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EntityPickerDialog, EntityMultiPickerDialog, EntityPickerField, type EntityPickerItem } from './entity-picker'
// @vitest-environment happy-dom

afterEach(cleanup)

it('単一候補の確定を止める理由を示し、選ぶだけでは反映しない', () => {
  const confirm = vi.fn()
  render(<EntityPickerDialog title="テンプレートを選ぶ" items={[{ id: 'a', name: '返信' }]} onCancel={() => {}} onConfirm={confirm} />)
  expect(screen.getByRole('button', { name: '選ぶ' }).title).toContain('候補を選んで')
  fireEvent.click(screen.getByRole('radio', { name: '返信' }))
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
  expect(confirm).toHaveBeenCalledWith('a')
})

const folders = [{ id: 'f1', name: 'アンケート', color: '#3b82f6' }, { id: 'f2', name: '予約の前', color: '#22c55e' }]
const items: EntityPickerItem[] = [
  { id: 'a', name: '来店アンケート', folderId: 'f1', meta: '10/02 更新' },
  { id: 'b', name: '初回カウンセリング', folderId: 'f2', meta: '09/28 更新' },
  { id: 'c', name: '施術後アンケート', folderId: 'f1', meta: '08/30 更新' },
  { id: 'd', name: '分類なし', folderId: null },
]

it('取得中の窓は既存値を未選択と表示しない', () => {
  const view = render(<EntityPickerDialog title="担当者を選ぶ" items={[]} initialId="saved" state={<p>取得中</p>} onCancel={() => {}} onConfirm={() => {}} />)
  expect(screen.getByText('選択済みの候補を確認できません')).toBeTruthy()
  expect(screen.queryByText('まだ選んでいません')).toBeNull()
  view.rerender(<EntityPickerDialog title="担当者を選ぶ" items={[]} initialId="saved" state={<p>取得失敗</p>} onCancel={() => {}} onConfirm={() => {}} />)
  expect(screen.getByText('選択済みの候補を確認できません')).toBeTruthy()
})

function Single({ initial = '', readOnly = false, onChange = vi.fn() }: { initial?: string; readOnly?: boolean; onChange?: (id: string) => void }) {
  const [value, setValue] = useState(initial)
  return <EntityPickerField label="回答フォーム" noun="回答フォーム" items={items} folders={folders} value={value} readOnly={readOnly}
    createHref="/form-submissions/edit" createLabel="回答フォームを作る" preview={(item) => <p>{item ? `見本：${item.name}` : '見本なし'}</p>}
    onChange={(id) => { onChange(id); setValue(id) }} />
}

describe('作ってあるものを選ぶ欄と窓（dJZ7Q）', () => {
  it('候補の状態を指定しない欄は従来の欠落文言を保つ', () => {
    const view = render(<EntityPickerField label="回答フォーム" noun="回答フォーム" items={[{ id: 'other', name: '別のフォーム' }]} value="gone" onChange={() => {}} />)
    expect(screen.getByText('見つかりません')).toBeTruthy()
    expect(screen.getByText('消されたか、使えなくなりました。選び直してください。')).toBeTruthy()
    view.rerender(<EntityPickerField label="担当者" noun="担当者" items={[{ id: 'other', name: '別の担当者' }]} value="gone" onChange={() => {}} />)
    expect(screen.getByText('見つかりません')).toBeTruthy()
  })
  it('候補の取得状態に応じて、0件と未取得を区別する', () => {
    const props = { label: '担当者', noun: '担当者', items: [], value: 'gone', onChange: vi.fn() }
    const view = render(<EntityPickerField {...props} candidatesStatus="loading" />)
    expect(screen.getByText('読み込み中…')).toBeTruthy()
    view.rerender(<EntityPickerField {...props} items={[{ id: 'gone', name: '古い名前' }]} candidatesStatus="loading" />)
    expect(screen.getByText('読み込み中…')).toBeTruthy()
    expect(screen.queryByText('古い名前')).toBeNull()
    view.rerender(<EntityPickerField {...props} candidatesStatus="error" />)
    expect(screen.getByText('担当者を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('担当者は今は選べません')).toBeNull()
    view.rerender(<EntityPickerField {...props} candidatesStatus="ready" />)
    expect(screen.getByText('担当者は今は選べません')).toBeTruthy()
    expect(screen.getByText('選び直してください。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '担当者：変える' }).getAttribute('aria-invalid')).toBe('true')
  })
  it('項目名を欄に残しても窓の候補名と確定するIDは変えない', async () => {
    const onChange = vi.fn()
    render(<EntityPickerField label="担当者" noun="担当者" items={items} value="a" valuePrefix="担当者：" onChange={onChange} />)
    expect(screen.getByText('来店アンケート').parentElement?.textContent).toBe('担当者：来店アンケート')
    fireEvent.click(screen.getByRole('button', { name: '担当者：変える' }))
    const dialog = await screen.findByRole('dialog', { name: '担当者を選ぶ' })
    expect(within(dialog).queryByText('担当者：来店アンケート')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: '初回カウンセリング' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('頭に「：」の無い valuePrefix でも注釈（title）は「頭：名前」にする', () => {
    render(<EntityPickerField label="タグ" noun="タグ" items={[{ id: 'a', name: 'VIP' }]} value="a" valuePrefix="タグ" onChange={() => {}} />)
    expect(screen.getByText('VIP').closest('[title]')?.getAttribute('title')).toBe('タグ：VIP')
  })

  it('欄は空なら［選ぶ］、選ぶと名前とフォルダ＋［変える］。窓の中で押しただけでは変わらない', async () => {
    const onChange = vi.fn()
    render(<Single onChange={onChange} />)
    expect(screen.getByText('回答フォームを選ぶ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '回答フォーム：選ぶ' }))
    const dialog = await screen.findByRole('dialog', { name: '回答フォームを選ぶ' })
    expect(dialog.style.getPropertyValue('--dialog-design-width')).toBe('640px')
    // フォルダの列で絞る
    fireEvent.click(within(within(dialog).getByRole('navigation', { name: 'フォルダ' })).getByRole('button', { name: /アンケート/ }))
    expect(within(dialog).queryByRole('radio', { name: '初回カウンセリング' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: '来店アンケート' }))
    expect(within(dialog).getByText('見本：来店アンケート')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    // 窓の中に「新しく作る」は無く、作る画面へは文字リンク
    expect(within(dialog).queryByRole('button', { name: /新しく作る/ })).toBeNull()
    expect(within(dialog).getByRole('link', { name: /作る画面へ：回答フォームを作る/ }).getAttribute('href')).toBe('/form-submissions/edit')
    fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' }))
    expect(onChange).toHaveBeenCalledWith('a')
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('来店アンケート')).toBeTruthy()
    expect(screen.getByText('フォルダ：アンケート')).toBeTruthy()
    expect(screen.getByRole('button', { name: '回答フォーム：変える' })).toBeTruthy()
  })

  it('キャンセルでは値を変えない。探す欄で名前を絞る', async () => {
    const onChange = vi.fn()
    render(<Single initial="b" onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '回答フォーム：変える' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByRole('radio', { name: '初回カウンセリング' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '施術' } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 320)) })
    expect(within(dialog).getAllByRole('radio').map((row) => row.getAttribute('aria-label'))).toEqual(['施術後アンケート'])
    fireEvent.click(within(dialog).getByRole('radio', { name: '施術後アンケート' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('初回カウンセリング')).toBeTruthy()
  })

  it('閲覧のみでも窓は開いて見られるが［選ぶ］は出さない', async () => {
    render(<Single initial="a" readOnly />)
    fireEvent.click(screen.getByRole('button', { name: '回答フォーム：見る' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: '選ぶ' })).toBeNull()
    expect(within(dialog).queryByRole('link', { name: /作る画面へ/ })).toBeNull()
    expect(within(dialog).getAllByRole('button', { name: '閉じる' })).toHaveLength(2)
  })

  it('消された候補を指していたら、見つからないと出して選び直させる', () => {
    render(<Single initial="gone" />)
    expect(screen.getByText('現在は選べません')).toBeTruthy()
    expect(screen.getByText('選び直してください。')).toBeTruthy()
    expect(screen.queryByText(/消されたか/)).toBeNull()
    expect(screen.getByRole('button', { name: '回答フォーム：変える' }).getAttribute('aria-invalid')).toBe('true')
  })
})

describe('まとめて選ぶ窓', () => {
  it('複数選択の未取得・失敗・確定した欠落を区別し、値を勝手に外さない', () => {
    const onChange = vi.fn()
    const props = { label: '担当者', noun: '担当者', items: [], value: ['gone'], onChange, multiple: true as const }
    const view = render(<EntityPickerField {...props} candidatesStatus="loading" />)
    expect(screen.getByText('読み込み中…')).toBeTruthy()
    view.rerender(<EntityPickerField {...props} items={[{ id: 'gone', name: '古い名前' }]} candidatesStatus="loading" />)
    expect(screen.getByText('古い名前')).toBeTruthy()
    view.rerender(<EntityPickerField {...props} items={[{ id: 'gone', name: '古い名前' }]} candidatesStatus="error" />)
    expect(screen.getByText('古い名前')).toBeTruthy()
    view.rerender(<EntityPickerField {...props} candidatesStatus="error" />)
    expect(screen.getByText('担当者を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText('担当者は今は選べません')).toBeNull()
    view.rerender(<EntityPickerField {...props} candidatesStatus="ready" />)
    expect(screen.getByText('担当者は今は選べません')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '担当者は今は選べませんを外す' }))
    expect(onChange).toHaveBeenCalledWith([])
  })
  it('フォルダの横のチェックでフォルダごと選び、一部だけなら「－」。選んだものだけ見て、確定で返す', async () => {
    const onConfirm = vi.fn()
    render(<EntityMultiPickerDialog title="配るアカウントを選ぶ" unit="アカウント" items={items} folders={folders} initialIds={['b']} onConfirm={onConfirm} onCancel={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: '配るアカウントを選ぶ' })
    const folderCheck = within(dialog).getByRole('checkbox', { name: 'アンケートをまとめて選ぶ' }) as HTMLInputElement
    fireEvent.click(folderCheck)
    expect((within(dialog).getByRole('checkbox', { name: '来店アンケート' }) as HTMLInputElement).checked).toBe(true)
    expect((within(dialog).getByRole('checkbox', { name: '施術後アンケート' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '施術後アンケート' }))
    expect((within(dialog).getByRole('checkbox', { name: 'アンケートをまとめて選ぶ' }) as HTMLInputElement).indeterminate).toBe(true)
    expect(within(dialog).getByText('2 件')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '選んだものだけ見る' }))
    expect(within(dialog).getAllByRole('checkbox').filter((box) => !box.getAttribute('aria-label')?.includes('まとめて')).map((box) => box.getAttribute('aria-label'))).toEqual(['来店アンケート', '初回カウンセリング'])
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ（2件）' }))
    expect(onConfirm).toHaveBeenCalledWith(['b', 'a'])
  })

  it('欄から開いた窓をキャンセルしても値は変わらず、確定すると件数と名前が出る', async () => {
    function Host() {
      const [value, setValue] = useState<string[]>([])
      return <EntityPickerField multiple label="タグ" noun="タグ" items={items} folders={folders} value={value} onChange={setValue} />
    }
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'タグ：選ぶ' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '分類なし' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('タグを選ぶ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'タグ：選ぶ' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '分類なし' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '来店アンケート' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ（2件）' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText('来店アンケート')).toBeTruthy()
    expect(screen.getByText('分類なし')).toBeTruthy()
  })
})

describe('配るアカウントの欄の補足', () => {
  it('フォルダごとの数で「渋谷エリア 2・テスト 1」の形にし、フォルダを読めないときは名前を並べる', async () => {
    const { summarizeByFolder } = await import('./hq-account-picker')
    const f = [{ id: 's', name: '渋谷エリア' }, { id: 't', name: 'テスト' }]
    expect(summarizeByFolder([{ id: '1', name: '本店', folderId: 's' }, { id: '2', name: '渋谷店', folderId: 's' }, { id: '3', name: 'TEST', folderId: 't' }], f)).toBe('渋谷エリア 2・テスト 1')
    expect(summarizeByFolder([{ id: '1', name: '本店' }, { id: '2', name: '渋谷店' }], f)).toBe('本店・渋谷店')
  })
})

it('カテゴリは件数付きの単一選択で、矢印キーで絞っても候補を確定せず、読込中は数を作らない', async () => {
  const confirm = vi.fn()
  const props = {
    title: 'テンプレートから選ぶ',
    items: [{ id: 'text', name: '返信の文', category: 'text' }, { id: 'coupon', name: '来店特典', category: 'coupon' }],
    categories: [{ id: 'text', label: 'テキスト' }, { id: 'coupon', label: 'クーポン' }],
    onCancel: () => {}, onConfirm: confirm,
  }
  const view = render(<EntityPickerDialog {...props} />)
  const trigger = screen.getByRole('button', { name: '候補の絞り込み' })
  expect(trigger.textContent).toContain('すべて 2')
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  await screen.findByRole('listbox')
  expect(screen.getAllByRole('option').map(item => item.textContent)).toEqual(['すべて 2', 'テキスト 1', 'クーポン 1'])
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  await waitFor(() => expect(screen.getAllByRole('radio').map(item => item.getAttribute('aria-label'))).toEqual(['返信の文']))
  expect(trigger.textContent).toContain('テキスト 1')
  expect(confirm).not.toHaveBeenCalled()
  view.rerender(<EntityPickerDialog {...props} state={<p>読み込み中</p>} />)
  expect((trigger as HTMLButtonElement).disabled).toBe(true)
  expect(trigger.textContent).toBe('テキスト')
  expect(confirm).not.toHaveBeenCalled()
})
