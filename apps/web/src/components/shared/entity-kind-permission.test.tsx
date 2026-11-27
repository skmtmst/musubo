// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
const mock = vi.hoisted(() => ({ list: vi.fn(), groups: vi.fn(), create: vi.fn(), preview: vi.fn(), buttons: new Map<string, () => unknown>() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { tags: { list: mock.list, create: mock.create }, tagGroups: { list: mock.groups }, forms: { get: mock.preview } } }))
vi.mock('./use-tap-action-sources', () => ({ useTapActionAccount: () => null }))
vi.mock('./button', async original => {
  const { default: Actual } = await original<typeof import('./button')>()
  return { default: (props: ComponentProps<typeof Actual>) => {
    if (props.onClick) mock.buttons.set([props.children].flat().filter(value => typeof value === 'string' || typeof value === 'number').join(''), props.onClick as () => unknown)
    return <Actual {...props} />
  } }
})
import { EntityKindField, EntityKindDialog } from './entity-picker-sources'
const options = [{ id: 'a', name: '案内A' }, { id: 'b', name: '案内B' }]
const reason = '閲覧のみのため変えられません。'
const createReason = 'タグを作れるのはオーナー・管理者です。'
const field = () => ({ label: '案内', options, value: 'a', onChange: vi.fn(), accountId: 'account' })
const button = (name: string) => screen.getByRole('button', { name, exact: true }) as HTMLButtonElement
beforeEach(() => {
  mock.list.mockResolvedValue({ success: true, data: options }); mock.groups.mockResolvedValue({ success: true, data: [] }); mock.create.mockResolvedValue({ success: true, data: { id: 'new', name: '新規タグ' } }); mock.preview.mockResolvedValue({ success: false }); mock.buttons.clear()
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it.each(['form','scenario'] as const)('%sの既存欄へ理由とleaseを伝え、開いた窓は残し、確定/外すは0', async kind => {
  const p = field(); const view = render(<EntityKindField {...p} kind={kind} noPreview clearable canChangeNow={() => true} />)
  fireEvent.click(button('案内：変更する')); const oldConfirm = mock.buttons.get('選択する')!
  view.rerender(<EntityKindField {...p} kind={kind} noPreview clearable canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('dialog')).toBeTruthy(); const opener = button('案内：変更する')
  expect(opener.disabled).toBe(false); expect(opener.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(opener); expect(screen.getByRole('tooltip').textContent).toBe(reason)
  act(() => oldConfirm()); fireEvent.click(button('案内を外す')); expect(p.onChange).not.toHaveBeenCalled()
  expect(button('選択する').getAttribute('aria-disabled')).toBe('true')
})

it('非tag欄は未知をnative disabled、許可へ戻れば現在の選択を確定できる', () => {
  const p = field(); const view = render(<EntityKindField {...p} kind="scenario" noPreview canChangeNow={() => false} />)
  expect(button('案内：変更する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  view.rerender(<EntityKindField {...p} kind="scenario" noPreview canChangeNow={() => true} />)
  fireEvent.click(button('案内：変更する')); fireEvent.click(screen.getByRole('radio', { name: '案内B', exact: true })); fireEvent.click(button('選択する'))
  expect(p.onChange).toHaveBeenCalledExactlyOnceWith('b')
})

it('複数の非tag欄にもleaseを伝え、未知へ切替後の保持確定は値を書かない', () => {
  const p = { ...field(), value: ['a'], onChange: vi.fn() }; const view = render(<EntityKindField {...p} kind="scenario" multiple canChangeNow={() => true} />)
  fireEvent.click(button('案内：変更する')); const oldConfirm = mock.buttons.get('選択する（1件）')!
  view.rerender(<EntityKindField {...p} kind="scenario" multiple canChangeNow={() => false} />)
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(button('選択する（1件）').disabled).toBe(true)
  act(() => oldConfirm()); expect(p.onChange).not.toHaveBeenCalled(); expect(document.querySelector('[data-permission-locked]')).toBeNull()
})

it('tagは選ぶ権限と作成専用理由/callbackを別々に中へ伝える', async () => {
  const p = { ...field(), value: ['a'], onChange: vi.fn() }
  render(<EntityKindField {...p} kind="tag" multiple canChangeNow={() => true} createLockedReason={createReason} canCreateNow={() => false} />)
  fireEvent.click(button('案内：変更する')); await screen.findByRole('checkbox', { name: '案内B', exact: true })
  expect(button('その場でタグを作る').getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(button('その場でタグを作る')); expect(screen.getByRole('tooltip').textContent).toBe(createReason)
  act(() => mock.buttons.get('その場でタグを作る')!()); expect(screen.queryByRole('textbox', { name: '新しいタグの名前' })).toBeNull(); expect(mock.create).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: '案内B', exact: true })); fireEvent.click(button('選択する（2件）'))
  expect(p.onChange).toHaveBeenCalledExactlyOnceWith(['a','b'])
})

it('tag作成のcallbackだけがfalseでもAPI0、createDisabledの未知も理由なしで止まる', async () => {
  const p = field(); const view = render(<EntityKindField {...p} kind="tag" canChangeNow={() => true} canCreateNow={() => false} />)
  fireEvent.click(button('案内：変更する')); await screen.findByRole('checkbox', { name: '案内B', exact: true })
  expect(button('その場でタグを作る').disabled).toBe(true); act(() => mock.buttons.get('その場でタグを作る')!())
  expect(screen.queryByRole('textbox', { name: '新しいタグの名前' })).toBeNull(); expect(mock.create).not.toHaveBeenCalled()
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => true} canCreateNow={() => true} createDisabled />)
  expect(button('その場でタグを作る').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => mock.buttons.get('その場でタグを作る')!()); expect(screen.queryByRole('textbox', { name: '新しいタグの名前' })).toBeNull()
})

it('tagの開いた窓はrole変更後も残り、single値と理由/callbackを伝え書込0', async () => {
  const p = field(); const view = render(<EntityKindField {...p} kind="tag" canChangeNow={() => true} />)
  fireEvent.click(button('案内：変更する')); await screen.findByRole('checkbox', { name: '案内B', exact: true }); const oldConfirm = mock.buttons.get('選択する（1件）')!
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => false} lockedReason={reason} />)
  expect(screen.getByRole('dialog')).toBeTruthy(); expect(button('案内：変更する').getAttribute('aria-disabled')).toBe('true')
  expect(button('選択する（1件）').getAttribute('aria-disabled')).toBe('true'); act(() => oldConfirm()); expect(p.onChange).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled()
})

it('直接の種類窓にも理由とleaseを伝え、読む候補を残し確定/作成先は拒む', () => {
  const confirm = vi.fn(); const p = { kind: 'scenario' as const, options, onConfirm: confirm, onCancel: vi.fn() }
  const view = render(<EntityKindDialog {...p} canChangeNow={() => true} />); const oldConfirm = mock.buttons.get('選択する')!
  view.rerender(<EntityKindDialog {...p} canChangeNow={() => false} confirmLockedReason={reason} />)
  expect(screen.getByRole('radio', { name: '案内B', exact: true })).toBeTruthy(); expect(button('選択する').getAttribute('aria-disabled')).toBe('true')
  expect(screen.queryByRole('link', { name: /作る画面へ/ })).toBeNull(); act(() => oldConfirm()); expect(confirm).not.toHaveBeenCalled()
})

it('種類窓の未知disabledだけも伝え、失効前に保持した確定は通さない', () => {
  const confirm = vi.fn(); const p = { kind: 'scenario' as const, options, onConfirm: confirm, onCancel: vi.fn() }
  const view = render(<EntityKindDialog {...p} canChangeNow={() => true} />); const oldConfirm = mock.buttons.get('選択する')!
  view.rerender(<EntityKindDialog {...p} canChangeNow={() => true} confirmDisabled />)
  expect(button('選択する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  act(() => oldConfirm()); expect(confirm).not.toHaveBeenCalled()
})

it('formのプレビューGETは理由を渡していても読む', async () => {
  render(<EntityKindDialog kind="form" options={options} initialId="a" accountId="account" confirmLockedReason={reason} canChangeNow={() => false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
  await waitFor(() => expect(mock.preview).toHaveBeenCalledWith('a','account'))
  expect(button('選択する').getAttribute('aria-disabled')).toBe('true')
})


it('tagの理由なしcallback falseを普通disabledとして転送し、旧許可/旧拒否の確定を復活させない', async () => {
  const p = field(); const view = render(<EntityKindField {...p} kind="tag" canChangeNow={() => false} />)
  expect(button('案内：変更する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull()
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => true} />)
  fireEvent.click(button('案内：変更する')); await screen.findByRole('checkbox', { name: '案内B', exact: true }); const oldYes = mock.buttons.get('選択する（1件）')!
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => false} />); const oldNo = mock.buttons.get('選択する（1件）')!
  expect(button('選択する（1件）').disabled).toBe(true); expect(screen.getByRole('dialog')).toBeTruthy(); act(() => oldYes()); expect(p.onChange).not.toHaveBeenCalled()
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => true} />); act(() => oldNo()); expect(p.onChange).not.toHaveBeenCalled()
  fireEvent.click(button('選択する（1件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith('a')
})

it('直接窓のcallbackだけが変わっても最新と描画時を伝え、未知の確定と古い拒否を通さない', () => {
  const confirm = vi.fn(); const p = { kind: 'scenario' as const, options, onConfirm: confirm, onCancel: vi.fn() }
  const view = render(<EntityKindDialog {...p} canChangeNow={() => true} />); const oldYes = mock.buttons.get('選択する')!
  view.rerender(<EntityKindDialog {...p} canChangeNow={() => false} />); const oldNo = mock.buttons.get('選択する')!
  expect(button('選択する').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull(); act(() => oldYes()); expect(confirm).not.toHaveBeenCalled()
  view.rerender(<EntityKindDialog {...p} canChangeNow={() => true} />); act(() => oldNo()); expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '案内B', exact: true })); fireEvent.click(button('選択する')); expect(confirm).toHaveBeenCalledExactlyOnceWith('b')
})

it('tag作成のcallback単独の差替も転送し、選択を通しつつ保持した作成はAPI0', async () => {
  const p = field(); const view = render(<EntityKindField {...p} kind="tag" canChangeNow={() => true} canCreateNow={() => true} />)
  fireEvent.click(button('案内：変更する')); await screen.findByRole('checkbox', { name: '案内B', exact: true }); fireEvent.click(button('その場でタグを作る'))
  fireEvent.change(screen.getByRole('textbox', { name: '新しいタグの名前' }), { target: { value: '新規タグ' } }); const oldCreate = mock.buttons.get('作る')!
  view.rerender(<EntityKindField {...p} kind="tag" canChangeNow={() => true} canCreateNow={() => false} />)
  expect(button('作る').disabled).toBe(true); expect(document.querySelector('[data-permission-locked]')).toBeNull(); act(() => oldCreate()); expect(mock.create).not.toHaveBeenCalled()
  expect((screen.getByRole('textbox', { name: '新しいタグの名前' }) as HTMLInputElement).value).toBe('新規タグ')
  fireEvent.click(button('選択する（1件）')); expect(p.onChange).toHaveBeenCalledExactlyOnceWith('a')
})
