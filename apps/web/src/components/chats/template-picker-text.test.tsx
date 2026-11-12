// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({
  oldBody: '{{name}}さん\nご予約ありがとうございます。\n{{var.company_name}}',
  newBody: 'そのままの本文\n2行目も残す。',
  packed: [] as string[],
  previews: [] as string[],
  queries: [] as Array<{ textOnly?: boolean }>,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/lib/api', () => ({ api: {
  templates: { listPage: async (params: { textOnly?: boolean }) => { fixture.queries.push(params); return { success: true, data: {
    items: [
      { id: 'old', name: '古い保存形式', accountId: 'acc-1', messageType: 'text', messageContent: JSON.stringify({ text: fixture.oldBody }), folderId: null },
      { id: 'new', name: '今の保存形式', accountId: 'acc-1', messageType: 'text', messageContent: fixture.newBody, folderId: null },
      ...(!params.textOnly ? [{ id: 'question', name: '選択肢付きの質問', accountId: 'acc-1', messageType: 'text', messageContent: '来店はいつですか？', question: { text: '来店はいつですか？' }, folderId: null }] : []),
    ], total: params.textOnly ? 2 : 3, folderCounts: { '': params.textOnly ? 2 : 3 }, limit: 100,
  } } } },
  folders: { list: async () => ({ success: true, data: [] }) },
  chats: { renderPreview: async (_id: string, body: { content: string }) => {
    fixture.previews.push(body.content)
    return { success: true, data: { content: body.content.replaceAll('{{name}}', '見本 141').replaceAll('{{var.company_name}}', '確認用のお店'), unresolved: [] } }
  } },
} }))
const { default: TemplatePicker } = await import('./template-picker')

function ReplyFixture() {
  const [reply, setReply] = useState('')
  return <><textarea aria-label="返信" readOnly value={reply} /><TemplatePicker open onClose={() => {}} onPick={setReply} onPickPack={texts => { fixture.packed = texts }} chatId="chat-1" /></>
}
afterEach(() => { cleanup(); fixture.packed = []; fixture.previews = []; fixture.queries = [] })

it.each([['古い保存形式', 'oldBody'], ['今の保存形式', 'newBody']] as const)('%sを返信欄へ入れても保存用JSONは入らない', async (name, key) => {
  await act(async () => { render(<ReplyFixture />) })
  await waitFor(() => expect(screen.getByText(name)).toBeTruthy())
  await act(async () => { screen.getByText(name).closest('button')!.click() })
  await act(async () => { screen.getByRole('button', { name: '入力欄に入れる' }).click() })
  expect((screen.getByRole('textbox', { name: '返信' }) as HTMLTextAreaElement).value).toBe(fixture[key])
})

it('古い本文を解決器にも渡し、まとめ挿入では選んだ順と改行を残す', async () => {
  await act(async () => { render(<ReplyFixture />) })
  await waitFor(() => expect(fixture.previews).toContain(fixture.oldBody))
  const row = screen.getByText('古い保存形式').closest('li')!
  expect(row.querySelector('[data-token="{{name}}"]')).toBeTruthy()
  expect(row.textContent).not.toContain('{"text":')
  await act(async () => { screen.getByRole('switch', { name: '2通以上を続けて送る' }).click() })
  await act(async () => { screen.getByText('今の保存形式').closest('button')!.click() })
  await act(async () => { screen.getByText('古い保存形式').closest('button')!.click() })
  await act(async () => { screen.getByRole('button', { name: '2通を続けて送る' }).click() })
  expect(fixture.packed).toEqual([fixture.newBody, fixture.oldBody])
})

it('7種類を順に見せ、未対応の種類は理由を付けて止める', async () => {
  await act(async () => { render(<ReplyFixture />) })
  const tabs = within(screen.getByRole('tablist', { name: 'テンプレートの種類' })).getAllByRole('tab')
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  expect(tabs[0].textContent).toBe('メッセージ2')
  expect(tabs.slice(1).map(tab => tab.textContent)).toEqual([ 'カルーセル', 'リッチメッセージ', 'リッチビデオ', '質問', 'クーポン', 'リサーチ'])
  for (const tab of tabs.slice(1)) {
    expect(tab.getAttribute('aria-disabled')).toBe('true')
    expect(tab.getAttribute('title')).toBe('受信箱からはまだ送れません')
    expect((tab as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(tab)
  }
  expect((screen.getByRole('textbox', { name: '返信' }) as HTMLTextAreaElement).value).toBe('')
})

it('中身を見るとその行を選び、窓の下の1つの操作で本文を入れる', async () => {
  await act(async () => { render(<ReplyFixture />) })
  fireEvent.click(await screen.findByRole('button', { name: '今の保存形式の中身を見る' }))
  const preview = screen.getByRole('region', { name: 'テンプレートの中身' })
  expect(within(preview).getByRole('heading', { name: '今の保存形式' })).toBeTruthy()
  expect(preview.textContent).not.toContain('{"text":')
  expect((screen.getByRole('textbox', { name: '返信' }) as HTMLTextAreaElement).value).toBe('')
  expect(screen.getByText('今の保存形式', { selector: 'span' }).closest('button')?.getAttribute('aria-pressed')).toBe('true')
  expect(within(preview).queryByRole('button', { name: '入力欄に入れる' })).toBeNull()
  expect(screen.getAllByRole('button', { name: '入力欄に入れる' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '入力欄に入れる' }))
  expect((screen.getByRole('textbox', { name: '返信' }) as HTMLTextAreaElement).value).toBe(fixture.newBody)
})

it('まとめモードでは見本を開いた順で選び、開き直しても重複しない', async () => {
  await act(async () => { render(<ReplyFixture />) })
  fireEvent.click(screen.getByRole('switch', { name: '2通以上を続けて送る' }))
  const trigger = await screen.findByRole('button', { name: '今の保存形式の中身を見る' })
  fireEvent.click(trigger)
  const preview = screen.getByRole('region', { name: 'テンプレートの中身' })
  expect(preview.parentElement?.contains(screen.getByText('続けて送る順：'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '中身の表示を閉じる' }))
  fireEvent.click(screen.getByRole('button', { name: '今の保存形式の中身を見る' }))
  expect(screen.getByRole('button', { name: '1通を続けて送る' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '古い保存形式の中身を見る' }))
  expect(fixture.packed).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: '2通を続けて送る' }))
  expect(fixture.packed).toEqual([fixture.newBody, fixture.oldBody])
})

it('右の見本を閉じると開いた虫眼鏡へ焦点を戻す', async () => {
  await act(async () => { render(<ReplyFixture />) })
  const trigger = await screen.findByRole('button', { name: '今の保存形式の中身を見る' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '中身の表示を閉じる' }))
  expect(screen.queryByRole('region', { name: 'テンプレートの中身' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '今の保存形式の中身を見る' }))
})

it('閲覧のみでも見本は読み、入力欄へ入れる1つの操作は灰色の理由付きで止める', async () => {
  const onPick = vi.fn()
  render(<TemplatePicker open onClose={() => {}} onPick={onPick} canPick={false} lockedReason="閲覧のみのため変更できません" />)
  fireEvent.click(await screen.findByRole('button', { name: '今の保存形式の中身を見る' }))
  const buttons = screen.getAllByRole('button', { name: '入力欄に入れる' })
  expect(buttons).toHaveLength(1)
  for (const button of buttons) {
    expect(button.getAttribute('aria-disabled')).toBe('true')
    const reasonId = button.getAttribute('aria-describedby')!
    expect(document.getElementById(reasonId)?.textContent).toContain('閲覧のみのため変更できません')
    fireEvent.click(button)
  }
  expect(onPick).not.toHaveBeenCalled()
})

it('質問付きの文字は候補に混ぜず、件数も選べる文字だけを使う', async () => {
  render(<ReplyFixture />)
  await screen.findByText('古い保存形式')
  expect(fixture.queries.every(query => query.textOnly === true)).toBe(true)
  expect(screen.queryByText('選択肢付きの質問')).toBeNull()
  expect(screen.getByRole('tab', { name: 'メッセージ 2' }).getAttribute('aria-selected')).toBe('true')
})

it('メールの呼び出しには種類タブ・虫眼鏡・LINEの見本を出さず、本文は挿入できる', async () => {
  const onPick = vi.fn()
  render(<TemplatePicker open channel="email" onClose={() => {}} onPick={onPick} />)
  await screen.findByText('今の保存形式')
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.queryByRole('button', { name: /の中身を見る/ })).toBeNull()
  expect(screen.queryByRole('region', { name: 'テンプレートの中身' })).toBeNull()
  fireEvent.click(screen.getByText('今の保存形式').closest('button')!)
  fireEvent.click(screen.getByRole('button', { name: '入力欄に入れる' }))
  expect(onPick).toHaveBeenCalledWith(fixture.newBody)
})

it('本人が未確認なら理由を捏造せず、通常の無効操作として挿入を止める', async () => {
  const onPick = vi.fn()
  render(<TemplatePicker open onClose={() => {}} onPick={onPick} canPick={false} />)
  fireEvent.click(await screen.findByRole('button', { name: '今の保存形式の中身を見る' }))
  for (const button of screen.getAllByRole('button', { name: '入力欄に入れる' })) {
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.hasAttribute('data-permission-locked')).toBe(false)
    fireEvent.click(button)
  }
  expect(onPick).not.toHaveBeenCalled()
})
