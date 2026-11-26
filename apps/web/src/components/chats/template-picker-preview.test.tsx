// @vitest-environment happy-dom
/*
 * N-026: テンプレート選択のプレビューは送信と同じ解決器の結果を見せる。
 *
 * 実物の TemplatePicker をマウントして確かめる。
 *   - 差し込みは生の記号ではなく札の名前で読む（一覧の抜粋・右の中身・title）
 *   - 一覧の名前の右に「予約の知らせ用」「ここでは入らない差し込みあり」
 *   - 入らない差し込みの注意は render-preview の未解決だけで出す（予約がある相手には出さない）。赤にしない
 *   - 確かめられない時は「問題なし」にせず知らせる。入力欄へ入れる値は元の {{…}} のまま
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type Item = { id: string; accountId: string; name: string; messageType: string; messageContent: string; folderId: null }
type PreviewResult = { success: boolean; data?: { content: string; unresolved: string[] } }

const DEFAULT_ITEMS: Item[] = [
  { id: 'tp-var', accountId: 'acc-1', name: '差し込みあり', messageType: 'text', messageContent: '{{name}}さん、{{field.pet_name}}の件です {{pet_name}}', folderId: null },
  { id: 'tp-plain', accountId: 'acc-1', name: '差し込みなし', messageType: 'text', messageContent: 'そのままの挨拶です', folderId: null },
]

const fixture = vi.hoisted(() => ({
  renderPreviewCalls: [] as unknown[],
  items: [] as Item[],
  commonVars: [] as Array<{ varKey: string; name: string; status?: string; value?: string }>,
  preview: ((): Promise<PreviewResult> => Promise.resolve({ success: true, data: { content: '利用者1さん、ポチの件です {{pet_name}}', unresolved: ['pet_name'] } })) as (chat: string, content: string) => Promise<PreviewResult>,
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1' }),
}))

vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(),
  api: {
    templates: {
      // PERF-12: 選択画面は区画取得(listPage)を使う。
      listPage: async () => ({ success: true, data: { items: fixture.items, total: fixture.items.length, limit: 100 } }),
    },
    folders: { list: async () => ({ success: true, data: [] }) },
    friendFields: { list: async () => ({ success: true, data: [] }) },
    commonVars: { list: async () => ({ success: true, data: fixture.commonVars }) },
    chats: {
      renderPreview: (chat: string, body: { content: string }) => {
        fixture.renderPreviewCalls.push([chat, body])
        return fixture.preview(chat, body.content)
      },
    },
  },
}))

const { default: TemplatePicker } = await import('./template-picker')

afterEach(() => {
  cleanup()
  fixture.renderPreviewCalls = []
  fixture.items = DEFAULT_ITEMS
  fixture.commonVars = []
  fixture.preview = () => Promise.resolve({ success: true, data: { content: '利用者1さん、ポチの件です {{pet_name}}', unresolved: ['pet_name'] } })
})
fixture.items = DEFAULT_ITEMS

const card = (name: string) => screen.getAllByText(name, { selector: 'span' })[0].closest('button')!
const pane = () => screen.getByRole('region', { name: 'テンプレートの中身' })
async function openPane(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${name}の中身を見る` }))
  return pane()
}
const warn = () => [...document.querySelectorAll('[data-design-part="notice"][data-tone="warn"]')]
const rawTitles = () => [...document.querySelectorAll('[title]')].map(node => node.getAttribute('title')!).filter(title => title.includes('{{'))

describe('テンプレート選択のプレビュー解決(N-026)', () => {
  test('一覧は項目名の札、右の中身は解決済み本文で見せ、入らない差し込みは名前で赤にせず注意する', async () => {
    await act(async () => {
      render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-1" />)
    })
    await waitFor(() => expect(fixture.renderPreviewCalls.length).toBeGreaterThan(0))
    const call = fixture.renderPreviewCalls[0] as [string, { content: string }]
    expect(call[0]).toBe('fr-1')
    expect(call[1].content).toContain('{{name}}')
    // 一覧の抜粋は相手の値ではなく項目名の札（選んでいるカードも同じ）。
    await waitFor(() => expect(warn()).toHaveLength(1))
    expect(card('差し込みあり').querySelector('[data-token="{{name}}"]')?.textContent).toBe('名前')
    expect(card('差し込みあり').querySelector('[data-token="{{field.pet_name}}"]')?.textContent).toBe('友だち情報')
    expect(card('差し込みあり').querySelector('[data-token="{{pet_name}}"]')?.textContent).toBe('不明な差し込み')
    expect(card('差し込みあり').textContent).not.toContain('利用者1')
    const shown = await openPane('差し込みあり')
    await waitFor(() => expect(shown.querySelector('[data-token="{{name}}"]')?.textContent).toBe('利用者1'))
    expect(shown.querySelector('[data-token="{{field.pet_name}}"]')?.textContent).toBe('ポチ')
    expect(shown.textContent).toContain('（入りません：不明な差し込み）')
    // 注意は共通の Notice（赤い失敗ではない）で、何が・なぜ・どうすればを名前で言う。
    const notice = await waitFor(() => { expect(warn()).toHaveLength(1); return warn()[0] })
    expect(notice.textContent).toContain('「不明な差し込み」は送るときに置き換えられない形のため入りません。')
    expect(notice.textContent).toContain('このまま入力欄に入れられますが、送る前にその部分を書き換えるか消してください。')
    expect(notice.textContent).not.toContain('{{')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(rawTitles()).toEqual([])
  })

  test('差し込みを含まないテンプレートは render-preview を呼ばず生の本文を見せる', async () => {
    await act(async () => {
      render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-1" />)
    })
    await waitFor(() => expect(screen.getAllByText('差し込みなし').length).toBeGreaterThan(0))
    await act(async () => { card('差し込みなし').click() })
    await waitFor(() => expect(screen.getAllByText('そのままの挨拶です').length).toBeGreaterThan(0))
    const calls = fixture.renderPreviewCalls as Array<[string, { content: string }]>
    expect(calls.every((c) => c[1].content.includes('{{'))).toBe(true)
    // 入れるもの（差し込みなし）には注意を出さない。
    expect(warn()).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('chatIdが無いときは render-preview を呼ばず、札の名前で読む（title にも記号を出さない）', async () => {
    await act(async () => {
      render(<TemplatePicker open onClose={() => {}} onPick={() => {}} />)
    })
    await waitFor(() => expect(screen.getAllByText('差し込みあり').length).toBeGreaterThan(0))
    await waitFor(() => {
      const body = card('差し込みあり').querySelector('[data-lines]')!
      expect(body.getAttribute('title')).toBe('［名前］さん、［友だち情報］の件です ［不明な差し込み］')
      expect(body.querySelector('[data-token="{{name}}"]')?.textContent).toBe('名前')
      expect(body.querySelector('[data-token="{{pet_name}}"]')?.hasAttribute('data-unknown')).toBe(true)
      expect(body.textContent).not.toContain('{{')
    })
    expect(fixture.renderPreviewCalls).toHaveLength(0)
    expect(warn()).toEqual([])
  })

  test('解決済み本文を表示しても入力欄へ渡す値は元の差し込み文字列（入らない差し込みがあっても入れられる）', async () => {
    const onPick = vi.fn()
    render(<TemplatePicker open onClose={() => {}} onPick={onPick} chatId="fr-1" />)
    await waitFor(() => expect(warn()).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '入力欄に入れる' }))
    expect(onPick).toHaveBeenCalledWith('{{name}}さん、{{field.pet_name}}の件です {{pet_name}}')
  })

  test('別の会話へ切り替えたら前の相手の値を表示せず、遅れた応答も採用しない', async () => {
    const deferred: Array<{ id: string; resolve: (value: PreviewResult) => void }> = []
    fixture.preview = (id) => new Promise(resolve => deferred.push({ id, resolve }))
    const view = render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-old" />)
    await waitFor(() => expect(deferred.some(call => call.id === 'fr-old')).toBe(true))
    await openPane('差し込みあり')
    view.rerender(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-new" />)
    await waitFor(() => expect(deferred.some(call => call.id === 'fr-new')).toBe(true))
    await act(async () => deferred.find(call => call.id === 'fr-new')!.resolve({ success: true, data: { content: '新しい方さん、ポチの件です {{pet_name}}', unresolved: ['pet_name'] } }))
    await act(async () => deferred.filter(call => call.id === 'fr-old').forEach(call => call.resolve({ success: true, data: { content: '前の方さん、ポチの件です {{pet_name}}', unresolved: ['pet_name'] } })))
    expect(pane().querySelector('[data-token="{{name}}"]')?.textContent).toBe('新しい方')
    expect(screen.queryByText('前の方')).toBeNull()
  })
})

describe('予約の差し込みとカードの札', () => {
  const reservationItems: Item[] = [
    { id: 'tp-booking', accountId: 'acc-1', name: '予約の確認', messageType: 'text', messageContent: '{{name}}様\n日時：{{var.reservation_datetime}}\n人数：{{var.guest_count}}名', folderId: null },
    { id: 'tp-closure', accountId: 'acc-1', name: '臨時休業', messageType: 'text', messageContent: '休業日：{{var.closure_datetime}}', folderId: null },
    { id: 'tp-plain', accountId: 'acc-1', name: 'あいさつ', messageType: 'text', messageContent: 'こんにちは', folderId: null },
  ]

  test('予約がある相手で口が予約の値を入れたときは、予約の差し込みの注意を出さない', async () => {
    fixture.items = reservationItems
    fixture.preview = () => Promise.resolve({ success: true, data: { content: '山田様\n日時：12月1日 18:00\n人数：2名', unresolved: [] } })
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-1" />)
    const shown = await openPane('予約の確認')
    await waitFor(() => expect(shown.querySelector('[data-token="{{var.reservation_datetime}}"]')?.textContent).toBe('12月1日 18:00'))
    expect(card('予約の確認').querySelector('[data-token="{{var.reservation_datetime}}"]')?.textContent).toBe('予約の日時')
    expect(warn()).toEqual([])
    expect(document.body.textContent).not.toContain('入りません')
    // 予約の差し込みは相手しだいなので「予約の知らせ用」。入らない側の札は付けない。
    expect(within(card('予約の確認')).getByText('予約の知らせ用')).toBeTruthy()
    expect(within(card('予約の確認')).queryByText('ここでは入らない差し込みあり')).toBeNull()
  })

  test('予約情報から値を取れない相手では、取れなかった差し込みだけを名前で注意する（予約が無いとは言い切らない）', async () => {
    fixture.items = reservationItems
    fixture.preview = () => Promise.resolve({ success: true, data: { content: '山田様\n日時：12月1日 18:00\n人数：{{var.guest_count}}名', unresolved: ['var.guest_count'] } })
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-1" />)
    const notice = await waitFor(() => { expect(warn()).toHaveLength(1); return warn()[0] })
    expect(notice.textContent).toContain('「人数」はこの方の予約情報から値を取得できないため入りません。')
    expect(notice.textContent).not.toContain('予約の日時')
    expect(notice.textContent).not.toContain('予約が無')
    const shown = await openPane('予約の確認')
    await waitFor(() => expect(shown.textContent).toContain('人数：（入りません：人数）名'))
    expect(card('予約の確認').textContent).toContain('人数：人数名')
    expect(rawTitles()).toEqual([])
  })

  test('共通情報に無い差し込みは一覧で「ここでは入らない差し込みあり」、登録があれば付けない', async () => {
    fixture.items = reservationItems
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} />)
    await waitFor(() => expect(within(card('臨時休業')).getByText('ここでは入らない差し込みあり')).toBeTruthy())
    // どれが・なぜ入らないかは抜粋の札の説明で読む（生の記号は出さない）。
    const chip = card('臨時休業').querySelector('[data-token="{{var.closure_datetime}}"]')!
    expect(chip.textContent).toBe('休業の日時')
    expect(chip.getAttribute('title')).toBe('共通情報に「休業の日時」の登録が無いため、送るときに値が入りません')
    expect(within(card('あいさつ')).queryByText('ここでは入らない差し込みあり')).toBeNull()
    cleanup()
    fixture.commonVars = [{ varKey: 'closure_datetime', name: '臨時休業の日時', status: 'active', value: '12月1日' }]
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} />)
    await waitFor(() => expect(card('臨時休業').querySelector('[data-token="{{var.closure_datetime}}"]')?.textContent).toBe('臨時休業の日時'))
    expect(within(card('臨時休業')).queryByText('ここでは入らない差し込みあり')).toBeNull()
  })

  test('確かめられなかった時は「問題なし」にせず知らせ、入力欄へは入れられる', async () => {
    fixture.items = reservationItems
    fixture.preview = () => Promise.reject(new Error('offline'))
    const onPick = vi.fn()
    render(<TemplatePicker open onClose={() => {}} onPick={onPick} chatId="fr-1" />)
    await waitFor(() => expect(document.body.textContent).toContain('この方に入る値を確かめられませんでした。'))
    expect(warn()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '入力欄に入れる' }))
    expect(onPick).toHaveBeenCalledWith(reservationItems[0].messageContent)
  })

  test('注意は入れる（選んだ）テンプレートで決め、右の中身はそのテンプレートの結果を見せる', async () => {
    fixture.items = reservationItems
    fixture.preview = (_chat, content) => Promise.resolve(content.includes('closure')
      ? { success: true, data: { content: '休業日：12月3日', unresolved: [] } }
      : { success: true, data: { content: '山田様\n日時：{{var.reservation_datetime}}\n人数：{{var.guest_count}}名', unresolved: ['var.reservation_datetime', 'var.guest_count'] } })
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} chatId="fr-1" />)
    // 最初は先頭（予約の確認）が入れるもの。
    await waitFor(() => expect(warn()).toHaveLength(1))
    expect(warn()[0].textContent).toContain('「予約の日時」「人数」は')
    fireEvent.click(await screen.findByRole('button', { name: '臨時休業の中身を見る' }))
    const pane = screen.getByRole('region', { name: 'テンプレートの中身' })
    await waitFor(() => expect(pane.textContent).toContain('休業日：12月3日'))
    // 入れるものが臨時休業に変わったので、予約の確認の注意は残さない。
    await waitFor(() => expect(warn()).toEqual([]))
    expect(pane.textContent).not.toContain('{{')
  })

  test('まとめて送るときは選んだもの全部を確かめ、入らないものの名前と外し方を言う', async () => {
    fixture.items = reservationItems
    fixture.preview = (_chat, content) => Promise.resolve(content.includes('closure')
      ? { success: true, data: { content: '休業日：{{var.closure_datetime}}', unresolved: ['var.closure_datetime'] } }
      : { success: true, data: { content: '山田様\n日時：12月1日 18:00\n人数：2名', unresolved: [] } })
    render(<TemplatePicker open onClose={() => {}} onPick={() => {}} onPickPack={() => {}} chatId="fr-1" />)
    await waitFor(() => expect(screen.getAllByText('臨時休業').length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('switch', { name: '2通以上を続けて送る' }))
    fireEvent.click(card('予約の確認'))
    fireEvent.click(card('臨時休業'))
    const notice = await waitFor(() => { expect(warn()).toHaveLength(1); return warn()[0] })
    expect(notice.textContent).toContain('「休業の日時」は共通情報に登録が無いため入りません。')
    expect(notice.textContent).toContain('続けて送ると送信が止まるため、「臨時休業」を外すか、1通ずつ入力欄で直してください。')
    // 選びから外すと注意も消える（選んでいない結果は使わない）。
    fireEvent.click(card('臨時休業'))
    await waitFor(() => expect(warn()).toEqual([]))
  })
})
