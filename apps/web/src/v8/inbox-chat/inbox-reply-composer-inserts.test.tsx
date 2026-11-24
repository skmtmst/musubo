// @vitest-environment happy-dom
/*
 * 返信欄の差し込み：テンプレートを入れた後も札で読み、送る値・下書きは {{…}} のまま。
 * 札を消す・カーソル・コピー・送るキー・変換、送るとこうなります（改行・入りません・全文）、
 * 入らない差し込みの注意（口の結果だけで出す・赤にしない・生の記号を出さない）を確かめる。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef, useState, type ComponentProps } from 'react'
import type { InsertTextFieldHandle } from '@/components/shared/insert-text-field'
import { api } from '@/lib/api'

const fixture = vi.hoisted(() => ({ picker: {} as { onPick?: (content: string) => void } }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'acc-1', name: '本店' }] }) }))
vi.mock('@/components/chats/template-picker', () => ({ default: (props: typeof fixture.picker) => { fixture.picker = props; return null } }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: () => undefined }))
vi.mock('@/components/shared/sender-select', () => ({ default: () => null }))
vi.mock('./schedule-dialog', () => ({ default: () => null }))
const { default: InboxReplyComposer } = await import('./inbox-reply-composer')
type Props = ComponentProps<typeof InboxReplyComposer>

const TEMPLATE = '{{name}}様\n日時：{{var.reservation_datetime}}\n人数：{{var.guest_count}}名\n{{var.closure_datetime}}'
const sent: string[] = []
const composing: boolean[] = []

function Harness({ initial = '', names = { vars: {}, varsComplete: true } }: { initial?: string; names?: Props['tokenNames'] }) {
  const [messageContent, setMessageContent] = useState(initial)
  const textareaRef = useRef<InsertTextFieldHandle>(null)
  const isComposingRef = useRef(false)
  const props = {
    staffRole: 'owner', scheduledSends: [], pendingPack: null, messageContent, messageLength: messageContent.length,
    pendingImage: null, pendingAttachment: null, quotedMessage: null, chatDetail: null, textareaRef, tokenNames: names,
    imageInputRef: { current: null }, isComposingRef, memoPopoverRef: { current: null }, showTemplatePicker: false,
    setShowTemplatePicker: () => {}, setMessageContent, selectedChatId: 'chat-1', selectedAccountId: 'acc-1', sendMode: 'enter',
    handleSendMessage: () => { sent.push(messageContent) },
    handleKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void; nativeEvent: { isComposing: boolean } }) => {
      composing.push(isComposingRef.current)
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !isComposingRef.current) { event.preventDefault(); sent.push(messageContent) }
    },
  } as unknown as Props
  return <><InboxReplyComposer {...props} /><output data-testid="raw">{messageContent}</output></>
}

const editor = () => screen.getByRole('textbox', { name: 'メッセージを入力' }) as HTMLElement & { value: string }
const raw = () => screen.getByTestId('raw').textContent
const chipLabels = () => [...editor().querySelectorAll('[data-token]')].map(chip => chip.textContent)
function caretAt(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); sent.length = 0; composing.length = 0 })

it('テンプレートを入れると返信欄でも札の名前で読み、保存・送信の値は {{…}} のまま', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '山田様\n日時：12月1日 18:00\n人数：2名\n{{var.closure_datetime}}', unresolved: ['var.closure_datetime'] } } as never)
  render(<Harness initial="お世話になっております。" />)
  await act(async () => { fixture.picker.onPick!(TEMPLATE) })
  expect(raw()).toBe(`お世話になっております。\n${TEMPLATE}`)
  expect(editor().value).toBe(`お世話になっております。\n${TEMPLATE}`)
  expect(chipLabels()).toEqual(['名前', '予約の日時', '人数', '休業の日時'])
  expect(editor().textContent).not.toContain('{{')
  // 札の説明（title）にも生の記号を出さない。
  expect([...editor().querySelectorAll('[title]')].some(node => node.getAttribute('title')!.includes('{{'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /送信する/ }))
  expect(sent).toEqual([`お世話になっております。\n${TEMPLATE}`])
})

it('札は Backspace 1回で消え、カーソルは札をまたいで保存の文字の位置で数える', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: 'x', unresolved: [] } } as never)
  render(<Harness initial="日時：{{var.reservation_datetime}}です" />)
  act(() => { editor().focus() })
  const chip = editor().querySelector('[data-token]')!
  // 札の中を指しても札の後ろとして数える（札は1つの塊）。
  caretAt(chip.querySelector('span')!.firstChild!, 2)
  const handle = { start: -1 }
  act(() => { handle.start = (document.activeElement as HTMLElement & { value: string }).value.length })
  caretAt(editor(), Array.prototype.indexOf.call(editor().childNodes, chip) + 1)
  await act(async () => { fireEvent.keyDown(editor(), { key: 'Backspace' }) })
  expect(raw()).toBe('日時：です')
  expect(chipLabels()).toEqual([])
  expect(handle.start).toBe('日時：{{var.reservation_datetime}}です'.length)
})

it('選んでコピーすると元の {{…}} で出て、貼り付けた {{…}} は札になる', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: 'x', unresolved: [] } } as never)
  render(<Harness initial="{{name}}様 {{var.guest_count}}名" />)
  act(() => { editor().focus() })
  const range = document.createRange()
  range.selectNodeContents(editor())
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  const copied: Record<string, string> = {}
  fireEvent.copy(editor(), { clipboardData: { setData: (type: string, text: string) => { copied[type] = text } } })
  expect(copied['text/plain']).toBe('{{name}}様 {{var.guest_count}}名')
  caretAt(editor(), editor().childNodes.length)
  await act(async () => { fireEvent.paste(editor(), { clipboardData: { getData: () => '\n{{var.course_name}}' } }) })
  expect(raw()).toBe('{{name}}様 {{var.guest_count}}名\n{{var.course_name}}')
  expect(chipLabels()).toEqual(['名前', '人数', 'コース名'])
})

it('送るキー（Enter）で送る値も {{…}} のままで、変換中の Enter では送らない', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: 'x', unresolved: [] } } as never)
  render(<Harness initial="{{name}}様" />)
  act(() => { editor().focus() })
  await act(async () => { fireEvent.compositionStart(editor()) })
  fireEvent.keyDown(editor(), { key: 'Enter', isComposing: true, keyCode: 229 })
  await act(async () => { fireEvent.compositionEnd(editor()) })
  expect(sent).toEqual([])
  fireEvent.keyDown(editor(), { key: 'Enter' })
  expect(sent).toEqual(['{{name}}様'])
  // 変換の始まり・終わりは呼ぶ側（送るキーの判定）にも伝わる。
  expect(composing.at(-1)).toBe(false)
})

it('送るとこうなりますは改行を保ち、入らない差し込みは名前で「入りません」、全文は窓で改行ごと読む', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '山田様\n日時：12月1日 18:00\n人数：2名\n{{var.closure_datetime}}', unresolved: ['var.closure_datetime'] } } as never)
  render(<Harness initial={TEMPLATE} />)
  await waitFor(() => expect(document.querySelector('[data-send-preview]')).not.toBeNull())
  const preview = document.querySelector('[data-send-preview]')!
  expect(preview.textContent).toBe('山田様\n日時：12月1日 18:00\n人数：2名\n（入りません：休業の日時）')
  expect(preview.querySelector('[data-token="{{var.reservation_datetime}}"]')?.textContent).toBe('12月1日 18:00')
  expect([...document.querySelectorAll('[title]')].some(node => node.getAttribute('title')!.includes('{{'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '全文を見る' }))
  const dialog = await screen.findByRole('dialog', { name: '送るとこうなります' })
  const full = within(dialog).getByText('送る文（改行もこのまま届きます）').parentElement!.querySelector('[data-detail-value]')!
  expect(full.getAttribute('data-multiline')).not.toBeNull()
  expect(full.textContent).toBe('山田様\n日時：12月1日 18:00\n人数：2名\n（入りません：休業の日時）')
})

it('入らない差し込みの注意は口の結果の全部を名前で出し、赤い失敗にしない', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '{{var.reservation_datetime}} {{var.closure_datetime}} {{pet}}', unresolved: ['var.reservation_datetime', 'var.closure_datetime', 'pet'] } } as never)
  render(<Harness initial="{{var.reservation_datetime}} {{var.closure_datetime}} {{pet}}" />)
  const notice = await waitFor(() => {
    const found = [...document.querySelectorAll('[data-design-part="notice"][data-tone="warn"]')].find(node => node.textContent?.includes('入りません'))
    expect(found).toBeTruthy()
    return found!
  })
  expect(notice.textContent).toContain('「予約の日時」はこの方の予約情報から値を取得できないため')
  expect(notice.textContent).toContain('「休業の日時」は共通情報に登録が無いため')
  expect(notice.textContent).toContain('「不明な差し込み」は送るときに置き換えられない形のため')
  expect(notice.textContent).toContain('送る前にその部分を書き換えるか消してください')
  expect(notice.getAttribute('role')).toBe('note')
  expect(notice.textContent).not.toContain('{{')
  expect(screen.queryByRole('alert')).toBeNull()
  // 入らない差し込みがあっても、返信欄には入っていて直せる。
  expect(raw()).toBe('{{var.reservation_datetime}} {{var.closure_datetime}} {{pet}}')
})

it('予約のある相手で口が全部入れたときは、予約の差し込みの注意を出さない', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '12月1日 18:00 に2名', unresolved: [] } } as never)
  render(<Harness initial="{{var.reservation_datetime}} に{{var.guest_count}}名" />)
  await waitFor(() => expect(document.querySelector('[data-send-preview]')?.textContent).toBe('12月1日 18:00 に2名'))
  expect(document.body.textContent).not.toContain('入りません')
  expect(document.querySelector('[data-tone="warn"]')).toBeNull()
})

it('見え方を確かめられなかった時は「問題なし」にせず、知らせだけ出して入力はそのまま', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockRejectedValue(new Error('offline'))
  render(<Harness initial="{{var.guest_count}}名" />)
  await waitFor(() => expect(document.body.textContent).toContain('送ったときの見え方を確かめられませんでした。'))
  expect(document.querySelector('[data-send-preview]')).toBeNull()
  expect(raw()).toBe('{{var.guest_count}}名')
})
