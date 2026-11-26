// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
const held = vi.hoisted(() => ({ buttons: new Map<string, (() => unknown)>(), checks: new Map<string, (checked: boolean) => void>(), remove: new Map<string, () => void>(), busy: new Map<string, boolean | undefined>() }))
vi.mock('./button', async original => {
  const { default: Actual } = await original<typeof import('./button')>()
  return { default: (props: ComponentProps<typeof Actual>) => {
    if (typeof props.children === 'string') held.busy.set(props.children, props.busy)
    if (typeof props.children === 'string' && props.onClick) held.buttons.set(props.children, props.onClick as () => unknown)
    return <Actual {...props} />
  } }
})
vi.mock('./checkbox', async original => {
  const { default: Actual } = await original<typeof import('./checkbox')>()
  return { default: (props: ComponentProps<typeof Actual>) => {
    if (props['aria-label'] && props.onCheckedChange) held.checks.set(props['aria-label'], props.onCheckedChange)
    return <Actual {...props} />
  } }
})
vi.mock('./tag-pill', async original => {
  const { default: Actual, ...rest } = await original<typeof import('./tag-pill')>()
  return { ...rest, default: (props: ComponentProps<typeof Actual>) => {
    if (props.onRemove) held.remove.set(props.name, props.onRemove)
    return <Actual {...props} />
  } }
})
import { EntityPickerField, EntityMultiSelect, EntityMultiPickerDialog, EntityPickerDialog } from './entity-picker'
const items = [{ id: 'a', name: '案内A', folderId: 'folder' }, { id: 'b', name: '案内B', folderId: 'folder' }]
const folders = [{ id: 'folder', name: '公開中' }]
const reason = '閲覧のみのため選び直せません。'
const field = () => ({ label: '案内', noun: 'テンプレート', items, folders, value: 'a', onChange: vi.fn() })
const confirm = () => screen.getByRole('button', { name: '選択する', exact: true }) as HTMLButtonElement
const open = () => fireEvent.click(screen.getByRole('button', { name: '案内：変更する' }))
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
beforeEach(() => { held.buttons.clear(); held.checks.clear(); held.remove.clear(); held.busy.clear() })
afterEach(cleanup)

it('任意lease付きは開いた窓を残し、理由付き確定と作成を拒み、検索とプレビューは維持', () => {
  const p = field(); const preview = vi.fn()
  const view = render(<EntityPickerField {...p} canChangeNow={() => true} createHref="/templates/new" createLabel="テンプレート" onSelect={preview} preview={item => <span>見本：{item?.name}</span>} />)
  open()
  const heldConfirm = held.buttons.get('選択する')!
  view.rerender(<EntityPickerField {...p} canChangeNow={() => true} lockedReason={reason} createHref="/templates/new" createLabel="テンプレート" onSelect={preview} preview={item => <span>見本：{item?.name}</span>} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(confirm().getAttribute('aria-disabled')).toBe('true'); expect(confirm().disabled).toBe(false); expect(confirm().tabIndex).toBe(0)
  fireEvent.focus(confirm()); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.click(confirm()); act(() => { heldConfirm() })
  expect(p.onChange).not.toHaveBeenCalled()
  expect(screen.queryByRole('link', { name: /作る画面へ/ })).toBeNull()
  expect(screen.getByRole('button', { name: /作る画面へ/ }).getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: '案内B' }))
  expect(preview).toHaveBeenLastCalledWith('b'); expect(screen.getByText('見本：案内B')).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '案内B' } })
  expect(screen.getByRole('radio', { name: '案内B' })).toBeTruthy()
})

it('未確定disabledだけでも開いた窓と値を残し、理由0、旧許可と旧拒否の確定は復活しない', () => {
  const p = field(); const view = render(<EntityPickerField {...p} canChangeNow={() => true} />)
  open(); const oldAllowed = held.buttons.get('選択する')!
  view.rerender(<EntityPickerField {...p} disabled canChangeNow={() => true} />)
  const oldDenied = held.buttons.get('選択する')!
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(confirm().disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => { oldAllowed() }); expect(p.onChange).not.toHaveBeenCalled()
  view.rerender(<EntityPickerField {...p} canChangeNow={() => true} />)
  act(() => { oldDenied() }); expect(p.onChange).not.toHaveBeenCalled()
  fireEvent.click(confirm()); expect(p.onChange).toHaveBeenCalledExactlyOnceWith('a')
})

it('再描画前の失効は開く・外す・保持した確定で新鮮なleaseを確認する', () => {
  const p = field(); let allowed = true
  render(<EntityPickerField {...p} clearable canChangeNow={() => allowed} />)
  allowed = false; open(); expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '案内を外す' })); expect(p.onChange).not.toHaveBeenCalled()
  allowed = true; open(); const saved = held.buttons.get('選択する')!
  allowed = false; act(() => { saved() }); expect(p.onChange).not.toHaveBeenCalled()
})

it('multiの理由付きは札の×・候補チェック・全体選択・確定を灰色で拒み、窓を閉じない', () => {
  const change = vi.fn(); const p = { label: '案内', noun: 'テンプレート', items, folders, value: ['a'], onChange: change, createHref: '/templates/new', createLabel: 'テンプレート' }
  const view = render(<EntityPickerField {...p} multiple canChangeNow={() => true} />)
  open(); const remove = held.remove.get('案内A')!
  const oldCheck = held.checks.get('案内B')!
  const oldConfirm = held.buttons.get('選択する（1件）')!
  view.rerender(<EntityPickerField {...p} multiple canChangeNow={() => true} lockedReason={reason} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  const button = screen.getByRole('button', { name: '案内Aを外す' }) as HTMLButtonElement
  expect(button.getAttribute('aria-disabled')).toBe('true'); expect(button.tabIndex).toBe(0)
  expect(screen.getByRole('checkbox', { name: '案内B' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('checkbox', { name: 'すべてをまとめて選ぶ' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: '選択する（1件）' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryByRole('link', { name: /作る画面へ/ })).toBeNull()
  expect(screen.getByRole('button', { name: /作る画面へ/ }).getAttribute('aria-disabled')).toBe('true')
  act(() => { remove(); oldCheck(true); oldConfirm() })
  fireEvent.click(button); expect(change).not.toHaveBeenCalled()
  expect(screen.getByRole('searchbox')).toBeTruthy()
})

it('multi本人未確定は札の×を消さずnative fieldsetで止め、理由0で旧操作も拒む', () => {
  const change = vi.fn(); const p = { label: '案内', noun: 'テンプレート', items, value: ['a'], onChange: change }
  const view = render(<EntityPickerField {...p} multiple canChangeNow={() => true} />)
  const remove = held.remove.get('案内A')!
  view.rerender(<EntityPickerField {...p} multiple canChangeNow={() => false} />)
  expect((screen.getByRole('button', { name: '案内：変更する' }) as HTMLButtonElement).disabled).toBe(true)
  const button = screen.getByRole('button', { name: '案内Aを外す' })
  expect((button.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => remove()); fireEvent.click(button); expect(change).not.toHaveBeenCalled()
})

it('multi候補の保持callbackは描画ごとに違うleaseの両方向を見て、古い拒否を復活させない', () => {
  const change = vi.fn(); const p = { items, folders, selected: ['a'], onChange: change, query: '' }
  const view = render(<EntityMultiSelect {...p} canChangeNow={() => true} />)
  const oldAllowed = held.checks.get('案内B')!
  view.rerender(<EntityMultiSelect {...p} canChangeNow={() => false} />)
  const oldDenied = held.checks.get('案内B')!
  expect((screen.getByRole('checkbox', { name: '案内B' }) as HTMLInputElement).disabled).toBe(true)
  act(() => oldAllowed(true)); expect(change).not.toHaveBeenCalled()
  view.rerender(<EntityMultiSelect {...p} canChangeNow={() => true} />)
  act(() => oldDenied(true)); expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: '案内B' }))
  expect(change).toHaveBeenCalledExactlyOnceWith(['a', 'b'])
})

it('multi作成は実行直前の失効でAPI0、窓と作成名は残す', () => {
  const create = vi.fn(); let allowed = true
  render(<EntityMultiPickerDialog title="案内を選ぶ" items={items} initialIds={['a']} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => allowed} createAction={{ label: '案内を作る', onCreate: create }} />)
  fireEvent.click(screen.getByRole('button', { name: '案内を作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しい名前' }), { target: { value: '新しい案内' } })
  allowed = false; fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  expect(create).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: '新しい名前' }) as HTMLInputElement).value).toBe('新しい案内')
})

it('multi作成中に失効したら、返った保存済み候補を選択へ足さず作成名と旧下書きを保つ', async () => {
  const pending = deferred<{ id: string; name: string }>(); const create = vi.fn(() => pending.promise); const confirm = vi.fn()
  const p = { title: '案内を選ぶ', items, initialIds: ['a'], onConfirm: confirm, onCancel: vi.fn(), createAction: { label: '案内を作る', onCreate: create } }
  const view = render(<EntityMultiPickerDialog {...p} canChangeNow={() => true} />)
  const oldConfirm = held.buttons.get('選択する（1件）')!
  fireEvent.click(screen.getByRole('button', { name: '案内を作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しい名前' }), { target: { value: '新しい案内' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  view.rerender(<EntityMultiPickerDialog {...p} canChangeNow={() => false} confirmLockedReason={reason} />)
  await act(async () => pending.resolve({ id: 'new', name: '作成済みの案内' }))
  expect(create).toHaveBeenCalledExactlyOnceWith('新しい案内')
  expect(screen.getByRole('button', { name: '案内を作る' }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.getByRole('button', { name: '作る', exact: true }).getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryByRole('checkbox', { name: '作成済みの案内' })).toBeNull()
  expect(screen.getByRole('button', { name: '選択する（1件）' }).getAttribute('aria-disabled')).toBe('true')
  expect((screen.getByRole('textbox', { name: '新しい名前' }) as HTMLInputElement).value).toBe('新しい案内')
  act(() => { oldConfirm() })
  expect(confirm).not.toHaveBeenCalled()
  view.rerender(<EntityMultiPickerDialog {...p} canChangeNow={() => true} />)
  expect(create).toHaveBeenCalledTimes(1); expect(screen.queryByRole('checkbox', { name: '作成済みの案内' })).toBeNull()
})

it('multi作成中の失効後に来た失敗を新しい権限表示へ上書きせず、旧名も変えない', async () => {
  const pending = deferred<null>(); const p = { title: '案内を選ぶ', items, initialIds: ['a'], onConfirm: vi.fn(), onCancel: vi.fn(), createAction: { label: '案内を作る', onCreate: () => pending.promise } }
  const view = render(<EntityMultiPickerDialog {...p} canChangeNow={() => true} />)
  fireEvent.click(screen.getByRole('button', { name: '案内を作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しい名前' }), { target: { value: '下書き' } })
  fireEvent.click(screen.getByRole('button', { name: '作る', exact: true }))
  view.rerender(<EntityMultiPickerDialog {...p} canChangeNow={() => false} confirmLockedReason={reason} />)
  fireEvent.change(screen.getByRole('textbox', { name: '新しい名前' }), { target: { value: '不正な変更' } })
  await act(async () => pending.reject(new Error('失敗')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect((screen.getByRole('textbox', { name: '新しい名前' }) as HTMLInputElement).value).toBe('下書き')
})

it('single作成のAPI応答後に失効していたら、開いていた窓を閉じない', async () => {
  const pending = deferred<void>(); const create = vi.fn(() => pending.promise); const p = field()
  const view = render(<EntityPickerField {...p} canChangeNow={() => true} createAction={{ label: q => `「${q}」を作る`, onCreate: create }} />)
  open(); fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  fireEvent.click(await screen.findByRole('button', { name: '「新しい案内」を作る' }))
  expect(create).toHaveBeenCalledExactlyOnceWith('新しい案内')
  view.rerender(<EntityPickerField {...p} canChangeNow={() => false} />)
  await act(async () => pending.resolve())
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(p.onChange).not.toHaveBeenCalled()
})

it('single作成の失敗は許可がある時は共通の失敗欄に残す', async () => {
  const create = vi.fn().mockRejectedValue(new Error('失敗'))
  render(<EntityPickerDialog title="案内を選ぶ" items={items} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => true} createAction={{ label: q => `「${q}」を作る`, onCreate: create }} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  fireEvent.click(await screen.findByRole('button', { name: '「新しい案内」を作る' }))
  expect((await screen.findByRole('alert')).textContent).toBe('作れませんでした。もう一度お試しください。')
})

it('single作成先リンクも再描画前にleaseが失効すれば移動を拒む', () => {
  let allowed = true
  render(<EntityPickerDialog title="案内を選ぶ" items={items} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => allowed} createHref="/templates/new" createLabel="テンプレート" />)
  const link = screen.getByRole('link', { name: /作る画面へ/ })
  allowed = false; expect(fireEvent.click(link)).toBe(false)
})

it('未指定の既存lockedReasonは従来どおり窓を閉じ、新しい形へ勝手に移さない', () => {
  const p = field(); const view = render(<EntityPickerField {...p} />)
  open(); expect(screen.getByRole('dialog')).toBeTruthy()
  view.rerender(<EntityPickerField {...p} lockedReason={reason} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})


it('multiの開いた窓へunknown disabledを伝え、候補と確定を理由なしnativeで止める', () => {
  const change = vi.fn(); const p = { label: '案内', noun: 'テンプレート', items, value: ['a'], onChange: change }
  const view = render(<EntityPickerField {...p} multiple canChangeNow={() => true} />)
  open(); const oldConfirm = held.buttons.get('選択する（1件）')!
  view.rerender(<EntityPickerField {...p} multiple disabled canChangeNow={() => true} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect((screen.getByRole('button', { name: '選択する（1件）' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('checkbox', { name: '案内B' }) as HTMLInputElement).disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => oldConfirm()); expect(change).not.toHaveBeenCalled()
})

it('singleのその場作成は再描画前のlease失効をAPI直前で拒む', async () => {
  let allowed = true; const create = vi.fn(); const confirm = vi.fn()
  render(<EntityPickerDialog title="案内を選ぶ" items={items} initialId="a" onConfirm={confirm} onCancel={vi.fn()} canChangeNow={() => allowed} createAction={{ label: q => `「${q}」を作る`, onCreate: create }} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  const button = await screen.findByRole('button', { name: '「新しい案内」を作る' })
  allowed = false; fireEvent.click(button)
  act(() => { held.buttons.get('選択する')!() })
  expect(confirm).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('single作成の保持した口を続けて押しても、新口指定時は同じAPIを1回だけ始める', async () => {
  const pending = deferred<void>(); const create = vi.fn(() => pending.promise)
  render(<EntityPickerDialog title="案内を選ぶ" items={items} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => true} createAction={{ label: q => `「${q}」を作る`, onCreate: create }} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  await screen.findByRole('button', { name: '「新しい案内」を作る' })
  const saved = held.buttons.get('「新しい案内」を作る')!
  act(() => { saved(); saved() })
  expect(create).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve())
})

it('multi作成欄の開閉も再描画前に失効したら開かない', () => {
  let allowed = true
  render(<EntityMultiPickerDialog title="案内を選ぶ" items={items} initialIds={[]} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => allowed} createAction={{ label: '案内を作る', onCreate: vi.fn() }} />)
  allowed = false; fireEvent.click(screen.getByRole('button', { name: '案内を作る' }))
  expect(screen.queryByRole('textbox', { name: '新しい名前' })).toBeNull()
})


it('singleの未知は確定と作成先を理由なしdisabledにしてhrefを残さない', () => {
  render(<EntityPickerDialog title="案内を選ぶ" items={items} initialId="a" onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => true} confirmDisabled createHref="/templates/new" createLabel="テンプレート" />)
  expect(confirm().disabled).toBe(true)
  expect(screen.queryByRole('link', { name: /作る画面へ/ })).toBeNull()
  expect((screen.getByRole('button', { name: /作る画面へ/ }) as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
})

it.each([false, true])('multi候補の灰色と理由は通常/2段の両方へ渡り、選択を拒む stacked=%s', stacked => {
  const change = vi.fn()
  render(<EntityMultiSelect items={items} folders={folders} selected={['a']} onChange={change} query="" stacked={stacked} lockedReason={reason} canChangeNow={() => true} />)
  for (const name of ['案内B', 'すべてをまとめて選ぶ']) {
    const check = screen.getByRole('checkbox', { name }) as HTMLInputElement
    expect(check.disabled).toBe(false); expect(check.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(check)
  }
  expect(change).not.toHaveBeenCalled()
})


it.each([false, true])('理由とfalse leaseがそろっても欄/外す/候補はnative disabledにせず理由へ届く multiple=%s', multiple => {
  const change = vi.fn(); const common = { label: '案内', noun: 'テンプレート', items, folders, onChange: change, canChangeNow: () => true }
  const view = render(multiple ? <EntityPickerField {...common} multiple value={['a']} /> : <EntityPickerField {...common} value="a" clearable />)
  open()
  view.rerender(multiple ? <EntityPickerField {...common} multiple value={['a']} disabled canChangeNow={() => false} lockedReason={reason} /> : <EntityPickerField {...common} value="a" clearable disabled canChangeNow={() => false} lockedReason={reason} />)
  const opener = screen.getByRole('button', { name: '案内：変更する' }) as HTMLButtonElement
  const remove = screen.getByRole('button', { name: multiple ? '案内Aを外す' : '案内を外す' }) as HTMLButtonElement
  for (const button of [opener, remove]) {
    expect(button.disabled).toBe(false); expect(button.matches(':disabled')).toBe(false)
    expect(button.closest('fieldset')).toBeNull(); expect(button.tabIndex).toBe(0)
    fireEvent.focus(button); expect(screen.getByRole('tooltip').textContent).toBe(reason)
    fireEvent.blur(button); fireEvent.click(button)
  }
  if (multiple) {
    const check = screen.getByRole('checkbox', { name: '案内B' }) as HTMLInputElement
    expect(check.disabled).toBe(false); expect(check.matches(':disabled')).toBe(false); expect(check.tabIndex).toBe(0)
    fireEvent.focus(check); expect(screen.getByRole('tooltip').textContent).toBe(reason)
    fireEvent.click(check)
  }
  expect(change).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy()
})

it('single作成が失効後に失敗しても新しい権限状態を保存エラーで上書きしない', async () => {
  const pending = deferred<void>(); const p = { title: '案内を選ぶ', items, onConfirm: vi.fn(), onCancel: vi.fn(), createAction: { label: (q: string) => `「${q}」を作る`, onCreate: () => pending.promise } }
  const view = render(<EntityPickerDialog {...p} canChangeNow={() => true} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  fireEvent.click(await screen.findByRole('button', { name: '「新しい案内」を作る' }))
  view.rerender(<EntityPickerDialog {...p} canChangeNow={() => false} confirmLockedReason={reason} />)
  await act(async () => pending.reject(new Error('失敗')))
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByRole('dialog')).toBeTruthy()
})

it('multi作成の保持した口を続けて押しても新口指定時は1回だけ開始する', async () => {
  const pending = deferred<{ id: string; name: string }>(); const create = vi.fn(() => pending.promise)
  render(<EntityMultiPickerDialog title="案内を選ぶ" items={items} initialIds={['a']} onConfirm={vi.fn()} onCancel={vi.fn()} canChangeNow={() => true} createAction={{ label: '案内を作る', onCreate: create }} />)
  fireEvent.click(screen.getByRole('button', { name: '案内を作る' }))
  fireEvent.change(screen.getByRole('textbox', { name: '新しい名前' }), { target: { value: '新しい案内' } })
  const saved = held.buttons.get('作る')!; act(() => { saved(); saved() })
  expect(create).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ id: 'new', name: '新しい案内' }))
})

it('新口なしのsingleその場作成はbusy未指定を保ち、幅の予約を新設しない', async () => {
  render(<EntityPickerDialog title="案内を選ぶ" items={items} onConfirm={vi.fn()} onCancel={vi.fn()} createAction={{ label: q => `「${q}」を作る`, onCreate: vi.fn() }} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新しい案内' } })
  await screen.findByRole('button', { name: '「新しい案内」を作る' })
  expect(held.busy.has('「新しい案内」を作る')).toBe(true)
  expect(held.busy.get('「新しい案内」を作る')).toBeUndefined()
})
