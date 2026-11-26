// @vitest-environment happy-dom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from './save-form-errors'
import { TextField } from './text-field'
import Select from './select'
import TimeField from './time-field-v8'
import { useSaveErrorReveal } from './save-form-errors'
import OtpInput from './otp-input'
import SegmentedControl from './segmented'
import ImageUploader from './image-uploader'
import RadioCard, { RadioCardGroup } from './radio-card'
vi.hoisted(() => { process.env.NEXT_PUBLIC_API_URL ??= 'http://127.0.0.1:8787' })

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Form({ error = new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { name: 'この名前は使われています', kind: '種類を選んでください', at: '時刻を選んでください' }) }: { error?: unknown }) {
  const fields = useSaveFormErrors()
  const [name, setName] = useState('テスト')
  const [kind, setKind] = useState('a')
  const [at, setAt] = useState('10:00')
  const [notice, setNotice] = useState('')
  return <SaveErrorScope errors={fields}>
    <label>名前<SaveErrorField names={['name']}><TextField value={name} onChange={(e) => setName(e.target.value)} aria-describedby="name-note" /></SaveErrorField></label>
    <span id="name-note">一覧の名前</span>
    <SaveErrorField names={['kind']}><Select aria-label="種類" value={kind} onChange={setKind} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} /></SaveErrorField>
    <SaveErrorField names={['at']}><TimeField aria-label="時刻" value={at} onChange={setAt} /></SaveErrorField>
    <button onClick={() => { if (!fields.capture(error)) setNotice('保存できませんでした') }}>保存する</button>
    <span data-notice>{notice}</span>
  </SaveErrorScope>
}

function BusyForm() {
  const fields = useSaveFormErrors()
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try { await Promise.reject(new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { name: '名前を直してください' })) }
    catch (error) { fields.capture(error) }
    finally { setBusy(false) }
  }
  return <SaveErrorScope errors={fields}>
    <SaveErrorField names={['name']}><TextField aria-label="保存中の名前" disabled={busy} /></SaveErrorField>
    <button onClick={() => void save()}>描画前に失敗</button>
  </SaveErrorScope>
}

it('APIの失敗が描画の確定より先に返っても、入力を有効に戻してから該当欄へ移る', async () => {
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { run(0); return 0 })
  render(<BusyForm />)
  const input = screen.getByRole('textbox', { name: '保存中の名前' })
  fireEvent.click(screen.getByRole('button', { name: '描画前に失敗' }))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByText('名前を直してください')).toBeTruthy()
  expect(input).toHaveProperty('disabled', false)
  expect(document.activeElement).toBe(input)
})

describe('保存の失敗を欄に返す共通部品', () => {
  it('欄下の理由・赤い印・読み上げのつなぎを付け、最初の欄へ移る。直した欄だけ消す', async () => {
    render(<Form />)
    const input = screen.getByRole('textbox', { name: '名前' })
    expect(input.parentElement?.tagName).toBe('LABEL')
    fireEvent.click(screen.getByText('保存する'))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toContain('name-note')
    const reasonId = screen.getByText('この名前は使われています').id
    expect(input.getAttribute('aria-describedby')).toContain(reasonId)
    expect(screen.getByRole('button', { name: '種類' }).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('combobox', { name: '時刻' }).getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('[data-notice]')?.textContent).toBe('')
    fireEvent.change(input, { target: { value: '別の名前' } })
    expect(screen.queryByText('この名前は使われています')).toBeNull()
    expect(screen.getByText('種類を選んでください')).toBeTruthy()
  })
  it.each([new ApiError(403), new Error('offline'), new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, { unknown: '不明な欄' })])('欄へ結び付かない失敗を隠さず知らせる（%s）', (error) => {
    render(<Form error={error} />)
    fireEvent.click(screen.getByText('保存する'))
    expect(document.querySelector('[data-notice]')?.textContent).toBe('保存できませんでした')
  })
  it('一部だけ結び付いた場合も残りの失敗を握りつぶさない', () => {
    render(<Form error={new ApiError(400, '入力を確認してください', undefined, undefined, undefined, undefined, { name: '名前を直してください', unknown: '別の設定を直してください' })} />)
    fireEvent.click(screen.getByText('保存する'))
    expect(screen.getByText('名前を直してください')).toBeTruthy()
    expect(document.querySelector('[data-notice]')?.textContent).toBe('保存できませんでした')
  })
})

function HiddenFields() {
  const [open, setOpen] = useState(false)
  useSaveErrorReveal(['mileage.self'], () => setOpen(true))
  return open ? <SaveErrorField names={['mileage.self']}><TextField aria-label="本人マイル" /></SaveErrorField> : <span>マイル設定は閉じています</span>
}
function HiddenForm() {
  const fields = useSaveFormErrors()
  return <SaveErrorScope errors={fields}><HiddenFields />
    <SaveErrorField names={['kind']}><RadioCardGroup legend="選択"><RadioCard name="choice" value="one" checked={false} title="ひとつ" onChange={() => {}} /></RadioCardGroup></SaveErrorField>
    <button onClick={() => fields.capture({ status: 422, fields: { 'mileage.self': '整数を入力してください', kind: '選択してください' } })}>試す</button>
  </SaveErrorScope>
}
it('畳んだ欄を開いて最初の欄へ移り、選択群も赤い印と理由をつなぐ', async () => {
  render(<HiddenForm />)
  fireEvent.click(screen.getByText('試す'))
  await waitFor(() => {
    expect(screen.getByText('整数を入力してください')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '本人マイル' }))
  })
  const radio = screen.getByRole('radio')
  expect(radio.getAttribute('aria-invalid')).toBe('true')
  expect(radio.getAttribute('aria-describedby')).toContain(screen.getByText('選択してください').id)
  fireEvent.click(radio)
  expect(screen.queryByText('選択してください')).toBeNull()
})

function ArrayForm() {
  const fields = useSaveFormErrors()
  return <SaveErrorScope errors={fields}>
    {[0, 1].map((index) => <label key={index}>本文{index + 1}<SaveErrorField names={[`steps.${index}.messageContent`]}><TextField /></SaveErrorField></label>)}
    <button onClick={() => fields.capture({ status: 422, fields: { 'steps.1.messageContent': '2通目を短くしてください' } })}>配列を試す</button>
  </SaveErrorScope>
}
it('繰り返す欄はAPIの番号で指定した1つだけを赤くしてそこへ移る', async () => {
  render(<ArrayForm />)
  const first = screen.getByRole('textbox', { name: '本文1' })
  const second = screen.getByRole('textbox', { name: '本文2' })
  fireEvent.click(screen.getByText('配列を試す'))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(first.getAttribute('aria-invalid')).not.toBe('true')
  expect(second.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(second)
  expect(screen.getAllByText('2通目を短くしてください')).toHaveLength(1)
})

function DialogForm() {
  const fields = useSaveFormErrors()
  return <SaveErrorScope errors={fields}>
    <SaveErrorField names={['name']}><TextField aria-label="背景の名前" /></SaveErrorField>
    <div role="dialog" aria-label="編集">
      <SaveErrorField names={['name']}><TextField aria-label="編集中の名前" /></SaveErrorField>
      <button onClick={() => fields.capture({ status: 422, fields: { name: '名前を直してください' } })}>窓で保存</button>
    </div>
  </SaveErrorScope>
}
it('同名の欄が背景にもあるときは編集窓だけを赤くして窓の欄へ移る', async () => {
  render(<DialogForm />)
  fireEvent.click(screen.getByText('窓で保存'))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(screen.getByRole('textbox', { name: '背景の名前' }).getAttribute('aria-invalid')).not.toBe('true')
  const input = screen.getByRole('textbox', { name: '編集中の名前' })
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(input)
  expect(screen.getAllByText('名前を直してください')).toHaveLength(1)
})

function RowForm() {
  const fields = useSaveFormErrors()
  const [amount, setAmount] = useState('500')
  return <SaveErrorScope errors={fields}>
    <div data-amount-row style={{ display: 'flex', flexWrap: 'nowrap' }}>
      <SaveErrorField names={['amount']}><TextField aria-label="金額" value={amount} onChange={(e) => setAmount(e.target.value)} /></SaveErrorField>
      <span>円</span>
    </div>
    <button onClick={() => fields.capture({ status: 422, fields: { amount: '金額を直してください' } })}>金額を保存</button>
  </SaveErrorScope>
}
it('横並びの欄でも理由を下に出し、入力を作り直さず、直したら元の配置へ戻す', () => {
  render(<RowForm />)
  const input = screen.getByRole('textbox', { name: '金額' }) as HTMLInputElement
  const row = document.querySelector<HTMLElement>('[data-amount-row]')!
  fireEvent.click(screen.getByText('金額を保存'))
  const reason = screen.getByText('金額を直してください')
  expect(reason.parentElement).toBe(row)
  expect(row.style.flexWrap).toBe('wrap')
  expect(reason.style.flexBasis).toBe('100%')
  expect(screen.getByRole('textbox', { name: '金額' })).toBe(input)
  expect(input.value).toBe('500')
  fireEvent.change(input, { target: { value: '600' } })
  expect(screen.queryByText('金額を直してください')).toBeNull()
  expect(row.style.flexWrap).toBe('nowrap')
  expect(input.value).toBe('600')
})

function CompositeForm() {
  const fields = useSaveFormErrors()
  const [code, setCode] = useState('123456')
  return <SaveErrorScope errors={fields}>
    <SaveErrorField names={['kind']}><SegmentedControl aria-label="方法" value="one" onChange={() => {}} options={[{ value: 'one', label: '一つ' }]} /></SaveErrorField>
    <SaveErrorField names={['imageUrl']}><ImageUploader mode="url" value={null} onChange={() => {}} /></SaveErrorField>
    <SaveErrorField names={['code']}><OtpInput value={code} onChange={setCode} label="確認コード" /></SaveErrorField>
    <button onClick={() => fields.capture({ status: 422, fields: { kind: '方法を選び直してください', imageUrl: '画像を選んでください', code: 'コードを確認してください' } })}>まとめて試す</button>
  </SaveErrorScope>
}
it('選択ボタン・画像欄・認証コードへ渡し、コードを自動で空にしても理由は残す', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  render(<CompositeForm />)
  fireEvent.click(screen.getByText('まとめて試す'))
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  const group = screen.getByRole('group', { name: '方法' })
  expect(group.getAttribute('data-invalid')).toBe('true')
  expect(group.getAttribute('aria-describedby')).toContain(screen.getByText('方法を選び直してください').id)
  const imageReason = screen.getByText('画像を選んでください')
  expect(document.querySelector(`[aria-describedby="${imageReason.id}"][aria-invalid="true"]`)).toBeTruthy()
  expect(screen.getByText('コードを確認してください')).toBeTruthy()
  const slots = screen.getAllByRole('textbox') as HTMLInputElement[]
  expect(slots[0].value).toBe('')
  fireEvent.change(slots[0], { target: { value: '4' } })
  expect(screen.queryByText('コードを確認してください')).toBeNull()
})
