// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
const mock = vi.hoisted(() => ({ list: vi.fn(), groups: vi.fn(), create: vi.fn(), buttons: new Map<string, () => unknown>(), checks: new Map<string, (on: boolean) => void>(), name: null as null | ((e: { target: { value: string } }) => void) }))
vi.mock('@/lib/api', () => ({ api: { tags: { list: mock.list, create: mock.create }, tagGroups: { list: mock.groups } } }))
vi.mock('./use-tap-action-sources', () => ({ useTapActionAccount: () => null }))
vi.mock('./button', async original => {
  const { default: Actual } = await original<typeof import('./button')>()
  return { default: (props: ComponentProps<typeof Actual>) => {
    if (props.onClick) mock.buttons.set([props.children].flat().filter(value => typeof value === 'string' || typeof value === 'number').join(''), props.onClick as () => unknown)
    return <Actual {...props} />
  } }
})
vi.mock('./checkbox', async original => {
  const { default: Actual } = await original<typeof import('./checkbox')>()
  return { default: (props: ComponentProps<typeof Actual>) => {
    if (props['aria-label'] && props.onCheckedChange) mock.checks.set(props['aria-label'], props.onCheckedChange)
    return <Actual {...props} />
  } }
})
vi.mock('./text-field', async original => {
  const { TextField: Actual, ...rest } = await original<typeof import('./text-field')>()
  return { ...rest, TextField: (props: ComponentProps<typeof Actual>) => {
    if (props['aria-label'] === '新しいタグの名前') mock.name = props.onChange as typeof mock.name
    return <Actual {...props} />
  } }
})
import TagPickerField from './tag-picker-field'
const tags = [{ id: 'a', name: '案内A' }, { id: 'b', name: '案内B' }]
const reason = '閲覧のみのためタグを変えられません。'
const createReason = 'タグを作れるのはオーナー・管理者です。'
const props = () => ({ value: ['a'], options: tags, accountId: 'account', onChange: vi.fn() })
const button = (name: string) => screen.getByRole('button', { name, exact: true }) as HTMLButtonElement
async function open() {
  fireEvent.click(button('タグを付ける：変更する'))
  await screen.findByRole('checkbox', { name: '案内B', exact: true })
}
function beginCreate() {
  fireEvent.click(button('その場でタグを作る'))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいタグの名前' }), { target: { value: '新しいタグ' } })
}
function pending() {
  let resolve!: (value: unknown) => void; let reject!: (error: Error) => void
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  mock.list.mockResolvedValue({ success: true, data: tags })
  mock.groups.mockResolvedValue({ success: true, data: [] })
  mock.create.mockResolvedValue({ success: true, data: { id: 'new', name: '新しいタグ' } })
  mock.buttons.clear(); mock.checks.clear(); mock.name = null
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('理由付き欄は隠さず灰色・Tab可・説明IDを保ち、焦点で理由1つ、開くGET0', () => {
  const p = props(); const ref = { current: null as HTMLButtonElement | null }
  render(<><p id="help">説明</p><TagPickerField {...p} buttonRef={ref} describedBy="help" lockedReason={reason} canChangeNow={() => false} /></>)
  const opener = button('タグを付ける：変更する')
  expect(opener.disabled).toBe(false); expect(opener.tabIndex).toBe(0); expect(opener.getAttribute('aria-disabled')).toBe('true'); expect(ref.current).toBe(opener)
  expect(opener.getAttribute('aria-describedby')?.split(' ')).toContain('help')
  fireEvent.focus(opener); expect(screen.getAllByRole('tooltip')).toHaveLength(1); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.click(opener); fireEvent.keyDown(opener, { key: 'Enter' }); fireEvent.keyDown(opener, { key: ' ' })
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mock.list).not.toHaveBeenCalled(); expect(p.onChange).not.toHaveBeenCalled()
})

it('本人未知は理由なしnative disabledで、再描画前の失効でも開かない', () => {
  const p = props(); let allowed = true
  const view = render(<TagPickerField {...p} canChangeNow={() => allowed} />)
  allowed = false; fireEvent.click(button('タグを付ける：変更する'))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mock.list).not.toHaveBeenCalled()
  view.rerender(<TagPickerField {...p} disabled canChangeNow={() => true} />)
  expect(button('タグを付ける：変更する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('開いた窓を残し、理由付きのチェック・確定・作るを拒み、検索/フォルダGETは維持', async () => {
  const p = props(); const view = render(<TagPickerField {...p} canChangeNow={() => true} />)
  await open(); const oldCheck = mock.checks.get('案内B')!; const oldConfirm = mock.buttons.get('選択する（1件）')!
  view.rerender(<TagPickerField {...p} canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('dialog', { name: 'タグを選ぶ' })).toBeTruthy()
  const check = screen.getByRole('checkbox', { name: '案内B', exact: true }) as HTMLInputElement
  expect(check.disabled).toBe(false); expect(check.getAttribute('aria-disabled')).toBe('true'); expect(check.tabIndex).toBe(0)
  fireEvent.focus(check); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  act(() => { oldCheck(true); oldConfirm() }); fireEvent.click(check); fireEvent.click(button('選択する（1件）'))
  expect(p.onChange).not.toHaveBeenCalled(); expect(check.checked).toBe(false)
  expect(button('その場でタグを作る').getAttribute('aria-disabled')).toBe('true')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '案内B' } })
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '案内A', exact: true })).toBeNull())
  expect(screen.getByRole('checkbox', { name: '案内B', exact: true })).toBeTruthy()
  expect(mock.list).toHaveBeenCalledOnce(); expect(mock.groups).toHaveBeenCalledOnce(); expect(mock.create).not.toHaveBeenCalled()
})

it('開いた窓の未知は印0の普通disabled、古い許可と拒否の確定/候補は両方向とも復活しない', async () => {
  const p = props(); const view = render(<TagPickerField {...p} canChangeNow={() => true} />)
  await open(); const oldYes = mock.buttons.get('選択する（1件）')!; const oldCheck = mock.checks.get('案内B')!
  view.rerender(<TagPickerField {...p} canChangeNow={() => false} />)
  const oldNo = mock.buttons.get('選択する（1件）')!; const oldNoCheck = mock.checks.get('案内B')!
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(button('選択する（1件）').disabled).toBe(true)
  expect(button('タグを付ける：変更する').disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: '案内B', exact: true }) as HTMLInputElement).disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => { oldYes(); oldCheck(true) }); expect(p.onChange).not.toHaveBeenCalled()
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} />)
  act(() => { oldNo(); oldNoCheck(true) }); expect(p.onChange).not.toHaveBeenCalled()
  expect((screen.getByRole('checkbox', { name: '案内B', exact: true }) as HTMLInputElement).checked).toBe(false)
  fireEvent.click(button('選択する（1件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a'])
})

it('既存タグを選べる担当者でも作る権限は別の理由で拒み、POST0で選択はできる', async () => {
  const p = props()
  render(<TagPickerField {...p} canChangeNow={() => true} createLockedReason={createReason} canCreateNow={() => false} />)
  await open(); const create = button('その場でタグを作る')
  expect(create.disabled).toBe(false); expect(create.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(create); expect(screen.getByRole('tooltip').textContent).toBe(createReason)
  fireEvent.click(create); act(() => { mock.buttons.get('その場でタグを作る')!() })
  expect(screen.queryByRole('textbox', { name: '新しいタグの名前' })).toBeNull(); expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: '案内B', exact: true })); fireEvent.click(button('選択する（2件）'))
  expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
})

it('作成だけ未確定disabledでも、既存選択/確定は通し、作成には理由印を付けない', async () => {
  const p = props()
  render(<TagPickerField {...p} canChangeNow={() => true} createDisabled canCreateNow={() => true} />)
  await open(); expect(button('その場でタグを作る').disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => mock.buttons.get('その場でタグを作る')!()); expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(button('選択する（1件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a'])
})

it('その場作成の直前に権限が切れたらAPI0で、保持した名前変更/作成ボタンも止める', async () => {
  const p = props(); let allowed = true
  render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => allowed} />)
  await open(); beginCreate(); const setName = mock.name!
  allowed = false; act(() => { setName({ target: { value: '上書き' } }); mock.buttons.get('作る')!() })
  expect(mock.create).not.toHaveBeenCalled(); expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
})

it('理由付きの作成名/作成ボタンは拒み、選ぶ値を変える操作は通す', async () => {
  const p = props(); const view = render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); const oldCreate = mock.buttons.get('作る')!; const name = mock.name!
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => false} createLockedReason={createReason} />)
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).disabled).toBe(true)
  expect(button('作る').disabled).toBe(false); expect(button('作る').getAttribute('aria-disabled')).toBe('true')
  act(() => { oldCreate(); name({ target: { value: '上書き' } }) }); expect(mock.create).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
  fireEvent.click(screen.getByRole('checkbox', { name: '案内B', exact: true })); expect(button('選択する（2件）').disabled).toBe(false)
})

it('作成中の役割変更後の成功はDB結果を消さず、UI選択/名前/窓を書き換えず、読む操作は残す', async () => {
  const p = props(); const deferred = pending(); mock.create.mockReturnValue(deferred.promise)
  const view = render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); fireEvent.click(button('作る'))
  view.rerender(<TagPickerField {...p} canChangeNow={() => false} lockedReason={reason} canCreateNow={() => false} />)
  await act(async () => deferred.resolve({ success: true, data: { id: 'new', name: '保存済みタグ' } }))
  expect(mock.create).toHaveBeenCalledOnce(); expect(screen.queryByRole('checkbox', { name: '保存済みタグ' })).toBeNull()
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
  expect(button('選択する（1件）').getAttribute('aria-disabled')).toBe('true'); expect(p.onChange).not.toHaveBeenCalled()
  fireEvent.click(button('キャンセル'))
  const discard = await screen.findByRole('dialog', { name: '入力を破棄しますか？' })
  fireEvent.click(within(discard).getByRole('button', { name: '破棄する' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'タグを選ぶ' })).toBeNull())
})

it('作成中の失効後の失敗は理由を保存エラーで上書きせず名前を保つ', async () => {
  const p = props(); const deferred = pending(); mock.create.mockReturnValue(deferred.promise)
  const view = render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); fireEvent.click(button('作る'))
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} createLockedReason={createReason} canCreateNow={() => false} />)
  await act(async () => deferred.reject(new Error('offline')))
  expect(screen.queryByText('タグを作れませんでした。もう一度お試しください。')).toBeNull()
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
  expect(button('作る').getAttribute('aria-disabled')).toBe('true')
})

it('同じ描画で保持した作成を連打しても1回だけ、許可時は候補を足し選ぶまで保存値は変えない', async () => {
  const p = props(); const deferred = pending(); mock.create.mockReturnValue(deferred.promise)
  render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); const create = mock.buttons.get('作る')!
  act(() => { create(); create() }); expect(mock.create).toHaveBeenCalledExactlyOnceWith({ name: '新しいタグ', groupId: null, lineAccountId: 'account' })
  await act(async () => deferred.resolve({ success: true, data: { id: 'new', name: '新しいタグ' } }))
  expect(screen.getByRole('checkbox', { name: '新しいタグ', exact: true })).toBeTruthy(); expect(p.onChange).not.toHaveBeenCalled()
  fireEvent.click(button('選択する（2件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a', 'new'])
})

it('見つからない既存タグを外す操作もfreshに拒む', async () => {
  const p = { ...props(), value: ['a', 'missing'] }; let allowed = true
  render(<TagPickerField {...p} canChangeNow={() => allowed} />)
  await open(); const remove = mock.checks.get('見つからないタグを外す')!
  allowed = false; act(() => remove(false)); expect(button('選択する（2件）')).toBeTruthy()
  expect(p.onChange).not.toHaveBeenCalled()
})

it('拒否へ切り替わっても失敗一覧の再読込GETを止めない', async () => {
  const p = props(); mock.list.mockRejectedValueOnce(new Error('offline'))
  const view = render(<TagPickerField {...p} canChangeNow={() => true} />)
  fireEvent.click(button('タグを付ける：変更する')); await screen.findByText('タグを読み込めませんでした。')
  view.rerender(<TagPickerField {...p} canChangeNow={() => false} lockedReason={reason} />)
  fireEvent.click(button('もう一度読み込む')); await screen.findByRole('checkbox', { name: '案内B', exact: true })
  expect(mock.list).toHaveBeenCalledTimes(2); expect(mock.groups).toHaveBeenCalledTimes(2); expect(mock.create).not.toHaveBeenCalled()
})


it('理由はcallbackがtrueでも優先し、disabledだけの未知も保持操作を拒む', async () => {
  const p = props(); const view = render(<TagPickerField {...p} canChangeNow={() => true} />)
  await open()
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} lockedReason={reason} />)
  act(() => { mock.checks.get('案内B')!(true); mock.buttons.get('選択する（1件）')!(); mock.buttons.get('その場でタグを作る')!() })
  expect((screen.getByRole('checkbox', { name: '案内B', exact: true }) as HTMLInputElement).checked).toBe(false)
  expect(screen.queryByRole('textbox', { name: '新しいタグの名前' })).toBeNull(); expect(p.onChange).not.toHaveBeenCalled()
  view.rerender(<TagPickerField {...p} disabled canChangeNow={() => true} />)
  act(() => { mock.checks.get('案内B')!(true); mock.buttons.get('選択する（1件）')!() })
  expect(button('選択する（1件）').disabled).toBe(true); expect(p.onChange).not.toHaveBeenCalled()
})

it('作成のcallbackがtrueでも作成理由は優先し、未知理由なしは普通のdisabled', async () => {
  const p = props(); const view = render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate()
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} createLockedReason={createReason} />)
  act(() => { mock.buttons.get('作る')!(); mock.name!({ target: { value: '上書き' } }) })
  expect(mock.create).not.toHaveBeenCalled(); expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => false} />)
  expect(button('作る').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
})


it('作成のbusy/refは成功後に解除し、同じ窓で2つ目も作って仮選択へ足せる', async () => {
  const p = props()
  mock.create.mockResolvedValueOnce({ success: true, data: { id: 'first', name: '一つ目のタグ' } }).mockResolvedValueOnce({ success: true, data: { id: 'second', name: '二つ目のタグ' } })
  render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); fireEvent.click(button('作る'))
  await screen.findByRole('checkbox', { name: '一つ目のタグ', exact: true })
  beginCreate(); fireEvent.change(screen.getByRole('textbox', { name: '新しいタグの名前' }), { target: { value: '二つ目のタグ' } }); fireEvent.click(button('作る'))
  await screen.findByRole('checkbox', { name: '二つ目のタグ', exact: true })
  expect(mock.create).toHaveBeenCalledTimes(2); expect(mock.create).toHaveBeenLastCalledWith({ name: '二つ目のタグ', groupId: null, lineAccountId: 'account' })
  expect(p.onChange).not.toHaveBeenCalled(); fireEvent.click(button('選択する（3件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a','first','second'])
})

it('作成中に失効した後のsuccess:falseも保存エラーで理由を上書きしない', async () => {
  const p = props(); const deferred = pending(); mock.create.mockReturnValue(deferred.promise)
  const view = render(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => true} />)
  await open(); beginCreate(); fireEvent.click(button('作る'))
  view.rerender(<TagPickerField {...p} canChangeNow={() => true} canCreateNow={() => false} createLockedReason={createReason} />)
  await act(async () => deferred.resolve({ success: false, error: 'already exists' }))
  expect(screen.queryByText('タグを作れませんでした。名前とフォルダを確認してください。')).toBeNull()
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新しいタグ')
  expect(button('作る').getAttribute('aria-disabled')).toBe('true'); expect(p.onChange).not.toHaveBeenCalled()
})
