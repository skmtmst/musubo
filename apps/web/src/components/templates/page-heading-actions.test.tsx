// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import { PageHeading } from './page-frame'
import { CreatePage } from './create-page'
import { RowMenu } from '@/components/shared/row-actions'
import { useState } from 'react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(cleanup)

it('題の右に主操作と文字の副操作を1つ置き、残りの操作をメニューから実行する', async () => {
  const extra = vi.fn()
  const { container } = render(<PageHeading title="テスト" actions={<>
    <Button>CSVで書き出す</Button>
    <Button variant="primary">作る</Button>
    <Button onClick={extra}>複製する</Button>
  </>} />)
  expect(screen.getByRole('button', { name: 'CSVで書き出す' }).getAttribute('data-variant')).toBe('text')
  expect(screen.getByRole('button', { name: '作る' }).getAttribute('data-variant')).toBe('primary')
  expect(screen.queryByRole('button', { name: '複製する' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '複製する' }))
  expect(extra).toHaveBeenCalledOnce()
  await waitFor(() => expect(container.querySelector('[data-page-heading-actions] [aria-expanded="true"]')).toBeNull())
})

it('権限付きの主操作も副操作の右に置き、権限が無ければ実行しない', () => {
  const create = vi.fn()
  const { container } = render(<PageHeading title="一覧" actions={<><PermissionGatedButton allowed={false} variant="primary" onClick={create}>作る</PermissionGatedButton><Button>CSVで書き出す</Button></>} />)
  const controls = [...container.querySelectorAll('[data-page-heading-actions] button')]
  expect(controls.map(button => button.textContent)).toEqual(['CSVで書き出す', '作る'])
  fireEvent.click(controls[1])
  expect(create).not.toHaveBeenCalled()
})

it('属性付きの包みの非表示・操作・読み上げを保つ', () => {
  const click = vi.fn()
  render(<PageHeading title="テスト" actions={<><span hidden><Button variant="primary">秘密の操作</Button></span><div role="group" aria-label="まとめ" onClick={click}><Button>読む</Button></div></>} />)
  expect(screen.queryByRole('button', { name: '秘密の操作' })).toBeNull()
  expect(screen.getByRole('group', { name: 'まとめ' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '読む' }))
  expect(click).toHaveBeenCalledOnce()
})

it('帯の非同期保存は二重実行を防ぎ、失敗を表示して再試行できる', async () => {
  let fail!: (reason: Error) => void
  const save = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
  render(<CreatePage title="作る" dirty={false} footerActions={<><Button>キャンセル</Button><Button onClick={save}>下書きを保存</Button><Button variant="primary">保存する</Button></>}>本文</CreatePage>)
  const item = screen.getByRole('button', { name: '下書きを保存' })
  fireEvent.click(item); fireEvent.click(item)
  expect(save).toHaveBeenCalledOnce()
  await act(async () => { fail(new Error('保存に失敗')) })
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  expect(save).toHaveBeenCalledTimes(2)
  await act(async () => { fail(new Error('保存に失敗')) })
})

it('既存のメニューの開閉制御とラベル、危険な操作の色を保つ', async () => {
  const change = vi.fn()
  function Fixture() {
    const [open, setOpen] = useState(false)
    return <PageHeading title="テスト" actions={<><Button>読む</Button><Button variant="primary">作る</Button><Button variant="danger">削除する</Button><RowMenu label="固有の操作" open={open} onOpenChange={value => { change(value); setOpen(value) }} items={[{ id: 'existing', label: '履歴を見る', onSelect() {} }]} /></>} />
  }
  render(<Fixture />)
  fireEvent.click(screen.getByRole('button', { name: '固有の操作' }))
  expect(change).toHaveBeenCalledWith(true)
  expect(await screen.findByRole('menuitem', { name: '履歴を見る' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: '削除する' }).className).toContain('textDanger')
})

it('非表示の主操作を数えず、非同期成功後は自分のメニューへ焦点を戻す', async () => {
  let finish!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const { container } = render(<PageHeading title="テスト" actions={<><Button variant="primary" hidden>隠れた作成</Button><Button variant="primary">作る</Button><Button>読む</Button><Button onClick={save}>下書きを保存</Button><Button hidden>隠れた補助</Button></>} />)
  expect(screen.getByRole('button', { name: '作る' })).toBeTruthy()
  const trigger = screen.getByRole('button', { name: 'その他の操作' })
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByRole('menuitem', { name: '下書きを保存' }))
  expect(screen.queryByRole('menuitem', { name: '隠れた補助' })).toBeNull()
  await act(async () => { finish() })
  await waitFor(() => expect(container.querySelector('[aria-expanded="true"]')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})

it('作成の保存帯は取消と下書きと保存を保ち、無効条件も守る', async () => {
  const draft = vi.fn(), save = vi.fn(), cancel = vi.fn()
  const { container } = render(<CreatePage title="作る" footerActions={<>
    <Button onClick={cancel}>キャンセル</Button><Button onClick={draft} disabled>下書きを保存</Button><Button variant="primary" onClick={save}>保存する</Button>
  </>}><label>名前<input /></label></CreatePage>)
  expect(container.querySelector('[data-sticky-actions]')?.textContent).toBe('キャンセル下書きを保存保存する')
  const item = screen.getByRole('button', { name: '下書きを保存' })
  expect((item as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(item)
  expect(draft).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(save).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(cancel).toHaveBeenCalledOnce()
})

it('移した入力不足の操作は名前・説明・titleを保ち、解除後にだけ実行する', async () => {
  const save = vi.fn()
  function Fixture() {
    const [name, setName] = useState('')
    return <CreatePage title="作る" footerActions={<>
      <Button>キャンセル</Button>
      <Button disabled={!name} disabledReason={!name ? '名前を入れてください' : undefined} title={!name ? '名前が必要です' : undefined} onClick={save}>下書きを保存</Button>
      <Button variant="primary">保存する</Button>
    </>}><label>名前<input value={name} onChange={event => setName(event.target.value)} /></label></CreatePage>
  }
  render(<Fixture />)
  const item = screen.getByRole('button', { name: '下書きを保存', exact: true }) as HTMLButtonElement
  expect(item.disabled).toBe(true)
  expect(item.title).toBe('名前が必要です')
  expect(item.getAttribute('aria-description')).toBe('名前を入れてください')
  expect(screen.getByRole('status').textContent).toContain('名前を入れてください')
  expect(item.hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(item)
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '会員' } })
  const enabled = screen.getByRole('button', { name: '下書きを保存' }) as HTMLButtonElement
  expect(enabled.disabled).toBe(false)
  expect(enabled.title).toBe('')
  expect(enabled.hasAttribute('aria-description')).toBe(false)
  fireEvent.click(enabled)
  expect(save).toHaveBeenCalledOnce()
})

it('移した権限の操作は焦点と説明を保ち、hrefと内部操作を起動しない', async () => {
  const select = vi.fn()
  render(<CreatePage title="作る" footerActions={<>
    <Button>キャンセル</Button>
    <Button href="/tags/new" lockedReason="管理者に頼んでください" aria-label="別の下書きを保存" onClick={select}>下書きを保存</Button>
    <Button variant="primary">保存する</Button>
  </>}>本文</CreatePage>)
  const item = screen.getByRole('button', { name: '別の下書きを保存' }) as HTMLButtonElement
  expect(item.disabled).toBe(false)
  expect(item.getAttribute('aria-disabled')).toBe('true')
  expect(item.hasAttribute('href')).toBe(false)
  expect(item.querySelector('button,a')).toBeNull()
  const reason = document.getElementById(item.getAttribute('aria-describedby')!)!
  expect(reason.textContent).toBe('管理者に頼んでください')
  expect(reason.hidden).toBe(true)
  act(() => item.focus())
  expect(document.activeElement).toBe(item)
  expect(screen.getByRole('tooltip').textContent).toBe('管理者に頼んでください')
  for (const key of ['Enter', ' ']) expect(fireEvent.keyDown(item, { key })).toBe(false)
  fireEvent.click(item)
  expect(select).not.toHaveBeenCalled()
})

it('その他の操作は通常色で、危険な操作だけ危険色を使う', async () => {
  render(<PageHeading title="一覧" actions={<><Button>読む</Button><Button variant="primary">作る</Button><Button textTone="accent">表示を変える</Button><Button variant="danger">削除する</Button></>} />)
  fireEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
  expect((await screen.findByRole('menuitem', { name: '表示を変える' })).className).toContain('textInk')
  expect(screen.getByRole('menuitem', { name: '削除する' }).className).toContain('textDanger')
})
