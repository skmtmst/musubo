import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { hqRichMenuDefinitionFromSeed,type HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { forgetStaffIdentity,rememberStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import RichMenuCreateV8 from '../../../v8/rich-menus/new/create'

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccount: null, loading: false }) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/hq/rich-menus', useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))

let host: RichMenuCreateHost
beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  document.documentElement.setAttribute('data-theme', 'v8')
  window.history.replaceState(null, '', '/hq/rich-menus')
  host = {
    backHref: '/hq/rich-menus', onCancel: vi.fn(), canOperate: true, folders: [],
    references: { tags: [], templates: [], forms: [{ id: 'f-1', name: '申込フォーム' }] },
    uploadImage: vi.fn(async (file: File) => ({ r2Key: `hq-templates/tenant/${file.name}` })),
    imageUrl: (key) => `http://images.test/${key}`,
    distribute: <div>配るアカウント</div>, selectedCount: 1, friendTotal: 120, busy: false, onSave: vi.fn(),
  }
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('統括から店舗のAPIを呼んではいけません') }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.documentElement.removeAttribute('data-theme') })
const click = (name: string) => fireEvent.click(getPageAction({ name, exact: true }))
const start = async (count = 'なし') => {
  render(<RichMenuCreateV8 host={host} />)
  fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '統括メニュー' } })
  fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: count }))
  click('次へ：ボタンの動き')
  await screen.findByText('画像の上で面を選ぶ')
}
const saved = (): HqRichMenuSeed => vi.mocked(host.onSave).mock.calls.at(-1)![0]
const save = async () => { click('下書きを保存'); await waitFor(() => expect(host.onSave).toHaveBeenCalled()) }
const selectArea = (letter: string) => fireEvent.focus(screen.getByRole('button', { name: new RegExp(`^${letter.charCodeAt(0) - 64}番目のボタン、`) }))
const pickIntent = (name: string) => {
  fireEvent.click(within(screen.getByRole('group', { name: '押したときの動き' })).getByRole('radio', { name, exact: true }))
}

describe('統括リッチメニューのオーナー指摘の回帰', () => {
  it('LINEのメニューはトーク本文の外で下の帯の直前に1つだけ置く', async () => {
    const { container } = render(<RichMenuCreateV8 host={host} />)
    const preview = screen.getByRole('region', { name: 'LINEでの見え方' })
    const menu = preview.querySelector('[data-line-preview-part="rich-menu"]')!
    expect(menu).not.toBeNull()
    expect(menu.previousElementSibling?.getAttribute('data-line-preview-part')).toBe('talk')
    expect(menu.previousElementSibling?.textContent).toBe('')
    expect(menu.nextElementSibling?.textContent).toBe('メニュー')
    expect(menu.nextElementSibling?.nextElementSibling).not.toBeNull()
    expect(menu.textContent).not.toContain('メニュー')
    expect(preview.querySelectorAll('[data-line-preview-part="rich-menu"]')).toHaveLength(1)
    expect(container.textContent).toContain('6面')
  })
  it('案Aの形をキーで選び、見本と同じA・Bの面を作って保存する', async () => {
    render(<RichMenuCreateV8 host={host} />)
    const one = screen.getByRole('radio', { name: '1面（面 A）' })
    fireEvent.click(one)
    fireEvent.keyDown(one, { key: 'ArrowRight' })
    const two = screen.getByRole('radio', { name: '上下2面（面 A・B）' }) as HTMLInputElement
    expect(two.checked).toBe(true)
    expect(two.closest('[data-choice-card]')?.textContent).toBe('上下2面AB')
    expect(two.closest('[data-choice-card]')?.querySelectorAll('input:checked')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '2面メニュー' } })
    click('次へ：ボタンの動き')
    await screen.findByText('画像の上で面を選ぶ')
    expect(screen.getAllByRole('button', { name: /^[12]番目のボタン、動きは/ })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^3番目のボタン、/ })).toBeNull()
    await save()
    expect(saved().pages[0].areas.map((area) => [area.boundsY, area.boundsHeight])).toEqual([[0, 843], [843, 843]])
    expect(saved().pages[0].areas.map((area) => area.label)).toEqual(['', ''])
  })
  it('作る前は大小を選べ、小さい寸法と面を保存できる', async () => {
    render(<RichMenuCreateV8 host={host} />)
    const compact = screen.getByRole('radio', { name: /小さい 2500×843/ }) as HTMLInputElement
    const large = screen.getByRole('radio', { name: /大きい 2500×1686/ }) as HTMLInputElement
    expect(compact.disabled).toBe(false); expect(large.disabled).toBe(false)
    fireEvent.click(compact)
    expect(compact.checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '横3面（面 A・B・C）' }))
    fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '小さいメニュー' } })
    click('次へ：ボタンの動き')
    await screen.findByText('画像の上で面を選ぶ')
    await save()
    expect(saved().size).toBe('compact')
    expect(saved().pages[0].areas).toHaveLength(3)
    expect(saved().pages[0].areas.every((area) => area.boundsHeight === 843)).toBe(true)
    click('形と画像に戻る')
    expect((screen.getByRole('radio', { name: /小さい 2500×843/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getAllByText(/形は下書きを作ったあとは変えられません/)).toHaveLength(1)
  })
  it('保存済みの小さいメニューは小さい形のまま読み込み、再保存する', async () => {
    host.initial = { id: 'm-1', name: '保存済み', chatBarText: 'ご案内', folderId: null, size: 'compact', displayAudience: 'all', displayOrder: 0, defaultPageId: 'p-1', pages: [{ id: 'p-1', name: 'トップ', imageR2Key: null, areas: [] }] }
    render(<RichMenuCreateV8 host={host} />)
    await waitFor(() => expect((screen.getByRole('radio', { name: /小さい 2500×843/ }) as HTMLInputElement).checked).toBe(true))
    await save()
    expect(saved().size).toBe('compact')
    expect(saved().chatBarText).toBe('ご案内')
  })
  it('画像なしでも①の6面を選び、面Aと面Bに別々の動きを保存する', async () => {
    await start()
    expect(screen.getAllByRole('button', { name: /^[1-6]番目のボタン、動きは/ })).toHaveLength(6)
    selectArea('A'); pickIntent('URLを開く')
    fireEvent.change(screen.getByPlaceholderText('例：https://...'), { target: { value: 'https://example.com/booking' } })
    selectArea('B'); pickIntent('テキストを送る')
    fireEvent.change(screen.getByLabelText('このボタンの送る文'), { target: { value: '予約を確認する' } })
    await save()
    expect(saved().pages[0].imageR2Key).toBeNull()
    expect(saved().pages[0].areas[0]).toMatchObject({ intent: 'url', actionData: { uri: 'https://example.com/booking' } })
    expect(saved().pages[0].areas[1]).toMatchObject({ intent: 'text', actionData: { text: '予約を確認する' } })
  })
  it('切替タブなしは1ページとして作り、保存する', async () => {
    await start(); await save()
    expect(saved().pages).toHaveLength(1)
    expect(saved().defaultPageId).toBe(saved().pages[0].id)
  })
  it('3つのタブはA・B・Cになり、画像は①でタブごとに入れ、動きはタブ別に持つ', async () => {
    render(<RichMenuCreateV8 host={host} />)
    fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '統括メニュー' } })
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: '3つ' }))
    expect(screen.getByRole('heading', { name: '画像（タブごとに1枚）' })).toBeTruthy()
    for (const [index, letter] of ['A', 'B', 'C'].entries()) {
      expect((screen.getByLabelText(`タブ${index + 1}の名前（トーク画面のタブに出ます）`) as HTMLInputElement).value).toBe(`タブ ${letter}`)
      fireEvent.change(screen.getByLabelText(`タブ${index + 1}の画像を追加（ファイル）`), { target: { files: [new File(['png'], `${letter}.png`, { type: 'image/png' })] } })
    }
    click('次へ：ボタンの動き')
    await screen.findByText('画像の上で面を選ぶ')
    expect(host.uploadImage).toHaveBeenCalledTimes(3)
    /* ②の頭は直すタブの切り替えと①へ戻る文字リンクだけ。ページを足す・消すは置かない。 */
    expect(screen.queryByRole('button', { name: 'ページを足す' })).toBeNull()
    expect(screen.queryByLabelText('このページの名前')).toBeNull()
    expect(screen.getByRole('button', { name: 'タブの数・名前・画像は ①形と画像 で変えます' })).toBeTruthy()
    const tabs = () => within(screen.getByRole('group', { name: '直すタブ' }))
    for (const [index, letter] of ['A', 'B', 'C'].entries()) {
      fireEvent.click(tabs().getByRole('button', { name: `タブ${index + 1}「タブ ${letter}」` }))
      selectArea('A'); pickIntent('テキストを送る')
      fireEvent.change(screen.getByLabelText('このボタンの送る文'), { target: { value: `内容${letter}` } })
    }
    await save()
    expect(saved().pages.map((page) => page.name)).toEqual(['タブ A', 'タブ B', 'タブ C'])
    expect(saved().pages.map((page) => page.imageR2Key)).toEqual(['hq-templates/tenant/A.png', 'hq-templates/tenant/B.png', 'hq-templates/tenant/C.png'])
    expect(saved().pages.map((page) => page.areas[0].actionData.text)).toEqual(['内容A', '内容B', '内容C'])
    for (const page of saved().pages) {
      for (const area of page.areas.slice(1)) { area.intent = 'text'; area.actionType = 'message'; area.actionData = { text: 'ご案内' } }
    }
    const definition = hqRichMenuDefinitionFromSeed(saved())
    expect(definition.richMenu.pages.map((page) => page.imageR2Key)).toEqual(saved().pages.map((page) => page.imageR2Key))
    expect(definition.richMenu.pages.map((page) => page.areas[0].actionData.text)).toEqual(['内容A', '内容B', '内容C'])
    fireEvent.click(tabs().getByRole('button', { name: 'タブ1「タブ A」' }))
    expect((screen.getByLabelText('このボタンの送る文') as HTMLInputElement).value).toBe('内容A')
  })
  it('切替タブがなしなら②に直すタブの段を出さない', async () => {
    await start()
    expect(screen.queryByRole('group', { name: '直すタブ' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'タブの数・名前・画像は ①形と画像 で変えます' })).toBeNull()
  })
  it('①でタブの名前を決めると②の切り替えと保存の名前になる', async () => {
    render(<RichMenuCreateV8 host={host} />)
    fireEvent.change(screen.getByLabelText('メニュー名（友だちには見えません）'), { target: { value: '統括メニュー' } })
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: '2つ' }))
    fireEvent.change(screen.getByLabelText('タブ1の名前（トーク画面のタブに出ます）'), { target: { value: '予約' } })
    fireEvent.change(screen.getByLabelText('タブ2の名前（トーク画面のタブに出ます）'), { target: { value: '会員' } })
    click('次へ：ボタンの動き')
    await screen.findByText('画像の上で面を選ぶ')
    expect(within(screen.getByRole('group', { name: '直すタブ' })).getByRole('button', { name: 'タブ2「会員」' })).toBeTruthy()
    await save()
    expect(saved().pages.map((page) => page.name)).toEqual(['予約', '会員'])
  })
  it('①でタブを減らすとき、消えるタブに動きがあれば確かめ、取り消すと残す', async () => {
    await start('3つ')
    fireEvent.click(within(screen.getByRole('group', { name: '直すタブ' })).getByRole('button', { name: 'タブ3「タブ C」' }))
    selectArea('A'); pickIntent('テキストを送る')
    fireEvent.change(screen.getByLabelText('このボタンの送る文'), { target: { value: '消えるタブ' } })
    click('タブの数・名前・画像は ①形と画像 で変えます')
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: '2つ' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('タブ3「タブ C」')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.getByLabelText('タブ3の名前（トーク画面のタブに出ます）')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: '2つ' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'タブを減らす' }))
    await waitFor(() => expect(screen.queryByLabelText('タブ3の名前（トーク画面のタブに出ます）')).toBeNull())
    await save()
    expect(saved().pages.map((page) => page.name)).toEqual(['タブ A', 'タブ B'])
  })
  it('設定のないタブは確かめずに減らし、①で足したタブにも面を出す', async () => {
    await start('2つ')
    click('タブの数・名前・画像は ①形と画像 で変えます')
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: 'なし' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.queryByLabelText('タブ2の名前（トーク画面のタブに出ます）')).toBeNull()
    fireEvent.click(within(screen.getByRole('group', { name: '切替タブの数' })).getByRole('button', { name: '3つ' }))
    click('次へ：ボタンの動き')
    await screen.findByText('画像の上で面を選ぶ')
    fireEvent.click(within(screen.getByRole('group', { name: '直すタブ' })).getByRole('button', { name: /^タブ3「/ }))
    expect(screen.getAllByRole('button', { name: /^[1-6]番目のボタン、動きは/ })).toHaveLength(6)
    await save()
    expect(saved().pages).toHaveLength(3)
  })
  it('統括の右欄は面の有無に関わらず使う参照を出し、店の回数を出さない', async () => {
    host.initial = { id: 'm-1', name: '未設定', chatBarText: 'メニュー', folderId: null, size: 'large', displayAudience: 'all', displayOrder: 0, defaultPageId: 'p-1', pages: [{ id: 'p-1', name: 'トップ', imageR2Key: null, areas: [] }] }
    window.history.replaceState(null, '', '/hq/rich-menus?step=buttons')
    render(<RichMenuCreateV8 host={host} />)
    await screen.findByText('画像の上で面を選ぶ')
    expect(screen.queryByRole('heading', { name: '押された回数（今月）' })).toBeNull()
    expect(screen.getByRole('heading', { name: '各アカウントで使うもの' })).toBeTruthy()
  })
  it('面を選んだ状態でも統括の右欄に店の集計を混ぜない', async () => {
    await start()
    selectArea('A')
    expect(screen.getByRole('heading', { name: '各アカウントで使うもの' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '押された回数（今月）' })).toBeNull()
    await save()
    expect(saved().pages[0].areas).toHaveLength(6)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('2つ目のタブにも選んだ面を出し、店のid指定が残っていても店の下書きを読まない', async () => {
    window.history.replaceState(null, '', '/hq/rich-menus?id=store-draft')
    await start('2つ')
    fireEvent.click(within(screen.getByRole('group', { name: '直すタブ' })).getByRole('button', { name: 'タブ2「タブ B」' }))
    expect(screen.getAllByRole('button', { name: /^[1-6]番目のボタン、動きは/ })).toHaveLength(6)
    await save()
    expect(saved().pages).toHaveLength(2)
    expect(fetch).not.toHaveBeenCalled()
  })
  /* ：保存で落ちた欄は帯ではなく欄で知らせ、別の手順・タブ・面ならそこを開いて移る。 */
  it('名前と文言が空なら次へ進まず、2つの欄を赤くして真下に理由を出し、名前へ移る', async () => {
    render(<RichMenuCreateV8 host={host} />)
    fireEvent.change(screen.getByLabelText('トーク画面の下の文言（14文字まで）'), { target: { value: '' } })
    click('次へ：ボタンの動き')
    const name = document.getElementById('rm-name') as HTMLInputElement
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'))
    expect(screen.getByText('名前を入力してください。')).toBeTruthy()
    expect(screen.getByText('トーク画面の下の文言を入力してください。')).toBeTruthy()
    expect(document.getElementById('rm-chatbar')?.getAttribute('aria-invalid')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(name))
    expect(screen.queryByText('画像の上で面を選ぶ')).toBeNull()
  })
  it('切り替えの行き先が無い面は保存せず、その面を選んで理由を出し、一覧に赤い丸を付ける', async () => {
    await start('2つ')
    selectArea('A'); pickIntent('リッチメニューを切り替える')
    selectArea('B')
    click('下書きを保存')
    await waitFor(() => expect(screen.getByText('「リッチメニューを切り替える」面の行き先ページが決まっていません。切り替え先を選んでください。')).toBeTruthy())
    expect(screen.getByRole('heading', { name: /面 A「/ })).toBeTruthy()
    expect(screen.getByRole('img', { name: /直す欄が1か所/ })).toBeTruthy()
    expect(host.onSave).not.toHaveBeenCalled()
  })

  /* ・：③は配る先（全員／決めない）、④は確かめて配る（足りないもの・配ったときの扱い）。 */
  it('③で「決めない」を選ぶと各アカウントで決める形で保存し、④の「配ったときの扱い」を配る前の確認へ渡す', async () => {
    await start()
    selectArea('A'); pickIntent('テキストを送る')
    fireEvent.change(screen.getByLabelText('このボタンの送る文'), { target: { value: '予約' } })
    click('次へ：配る先')
    expect(await screen.findByText(/面Bの動きが未設定です/)).toBeTruthy()
    for (const letter of ['B', 'C', 'D', 'E', 'F']) {
      selectArea(letter); pickIntent('テキストを送る')
      fireEvent.change(screen.getByLabelText('このボタンの送る文'), { target: { value: `案内${letter}` } })
    }
    click('次へ：配る先')
    expect(await screen.findByRole('heading', { name: '各アカウントで誰に出すか' })).toBeTruthy()
    expect(screen.getByText('タグが付いた人')).toBeTruthy()
    expect(screen.getByText('トークを開いたとき')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /決めない/ }))
    expect(screen.getByText('各アカウントで決める')).toBeTruthy()
    click('次へ：確かめて配る')
    expect(await screen.findByRole('heading', { name: '確かめる' })).toBeTruthy()
    expect(screen.queryByText(/面 B・C・D・E・F の動きが未設定/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: /新しく作る/ }))
    click('1 アカウントへ配る')
    await waitFor(() => expect(host.onSave).toHaveBeenCalled())
    const [seed, distribute, mode] = vi.mocked(host.onSave).mock.calls.at(-1)!
    expect(seed.displayAudience).toBe('store')
    expect(distribute).toBe(true)
    expect(mode).toBe('alias')
  })

})
