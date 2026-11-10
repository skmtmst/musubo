// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { emptyLayout, type FormInputBlock } from '@line-crm/shared'
import Form from './form'
import { LiffApiError } from '../lib/api-error.js'

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }))
vi.mock('../lib/api.js', () => ({ api: { getForm: vi.fn(), getMyLatestFormAnswer: vi.fn(), submitForm: vi.fn(), uploadFormFile: vi.fn(), liffConfig: vi.fn().mockResolvedValue({ success: true, data: {} }) } }))
const { api } = await import('../lib/api.js')
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function open(filePatch: Partial<FormInputBlock> = {}) {
  const layout = emptyLayout()
  layout.options.confirmDialog = { enabled: false }
  const fields: Partial<FormInputBlock>[] = [
    { type: 'text', name: 'name', label: 'お名前', placeholder: '例：見本 141' },
    { type: 'text', name: 'email', label: 'メール', limit: { format: 'email' }, placeholder: '例：sample@example.com' },
    { type: 'text', name: 'tel', label: '電話', limit: { format: 'tel' }, placeholder: '例：090-0000-5678' },
    { type: 'textarea', name: 'note', label: '自由に書く', placeholder: '例：ご希望を記入' },
    { type: 'date', name: 'date', label: '日付', placeholder: '例：2026/10/09' },
    { type: 'text', name: 'time', label: '時刻', limit: { format: 'time' }, placeholder: '例：13:00' },
    { type: 'address', name: 'address', label: '住所', placeholder: '例：1-2-3' },
    { type: 'file', name: 'file', label: '添付画像', ...filePatch },
    { type: 'rating', name: 'rating', label: '評価' },
  ]
  layout.sections[0].blocks = fields.map((f, i) => ({ kind: 'input', id: `b${i}`, ...f } as FormInputBlock))
  vi.mocked(api.getForm).mockResolvedValue({ id: 'f1', name: '入力の見本', description: '', layout, isActive: true })
  vi.mocked(api.submitForm).mockResolvedValue({ status: 200, body: { success: true, data: {} } })
  render(<MemoryRouter initialEntries={['/forms/f1']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>)
  await screen.findByLabelText('お名前')
}

describe('編集した参考の文字と実際の入力', () => {
  it('入力ごとの参考の文字を出すが、参考の文字を回答として送らない', async () => {
    await open()
    for (const hint of ['例：見本 141', '例：sample@example.com', '例：090-0000-5678', '例：ご希望を記入', '例：2026/10/09', '例：13:00', '例：1-2-3']) {
      expect((screen.getByPlaceholderText(hint) as HTMLInputElement).value).toBe('')
    }
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    await screen.findByText(/^ご回答ありがとうございました/)
    const data = vi.mocked(api.submitForm).mock.calls[0][1].data
    expect(JSON.stringify(data)).not.toContain('例：')
  })

  it('日付と時刻は実際の入力の種類で、選んだ値を保存する', async () => {
    await open()
    const date = screen.getByLabelText('日付') as HTMLInputElement
    const time = screen.getByLabelText('時刻') as HTMLInputElement
    expect(date.type).toBe('date')
    expect(time.type).toBe('time')
    fireEvent.change(date, { target: { value: '2026-10-09' } })
    fireEvent.change(time, { target: { value: '13:30' } })
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    await screen.findByText(/^ご回答ありがとうございました/)
    expect(vi.mocked(api.submitForm).mock.calls[0][1].data).toMatchObject({ date: '2026-10-09', time: '13:30' })
  })

  it('添付ボタンでファイルを選ぶと既存のアップロードへ送り、返った画像を表示する', async () => {
    await open()
    vi.mocked(api.uploadFormFile).mockResolvedValue({ success: true, data: { key: 'photo.png', url: 'https://example.test/photo.png', mimeType: 'image/png', size: 10 } })
    const file = new File(['test-image'], 'photo.png', { type: 'image/png' })
    const input = screen.getByLabelText('添付画像', { selector: 'input' }) as HTMLInputElement
    const choose = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: '写真を選ぶ' }))
    expect(choose).toHaveBeenCalled()
    expect(input.accept).not.toContain('application/pdf')
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(api.uploadFormFile).toHaveBeenCalledWith('f1', file, undefined, 'b7', 'single'))
    expect((await screen.findByAltText('送った画像') as HTMLImageElement).src).toBe('https://example.test/photo.png')
  })
})


describe('本人確認の新規受付停止', () => {
  it('古い画像値が残る任意欄も再添付せず、画像や削除操作を出さない', async () => {
    await open({ fileKinds: ['image', 'identity'], required: false, defaultValue: 'https://example.test/images/form-uploads/legacy.png' })
    expect(screen.getByRole('alert').textContent).toContain('本人確認書類は受け付けていません')
    expect(screen.queryByAltText('送った画像')).toBeNull()
    expect(screen.queryByRole('button', { name: '選び直す' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    expect(api.submitForm).not.toHaveBeenCalled()
    expect(api.uploadFormFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/^ご回答ありがとうございました/)).toBeNull()
  })
  it.each([true, false])('旧設定の必須=%sを黙って変えず、撮影やアップロードに誘導しない', async required => {
    await open({ fileKind: 'identity', fileBothSides: true, required })
    expect(screen.getByRole('alert').textContent).toContain('本人確認書類は受け付けていません')
    expect(screen.queryByLabelText('添付画像', { selector: 'input' })).toBeNull()
    expect(screen.queryByRole('button', { name: '写真を撮る' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '送信する' }))
    if (required) {
      expect(api.submitForm).not.toHaveBeenCalled()
      expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('店舗にお問い合わせください'))).toBe(true)
      expect(screen.queryByText(/^ご回答ありがとうございました/)).toBeNull()
    } else {
      await screen.findByText(/^ご回答ありがとうございました/)
      expect(vi.mocked(api.submitForm).mock.calls[0][1].data).not.toHaveProperty('file')
    }
    expect(api.uploadFormFile).not.toHaveBeenCalled()
  })
})

describe('添付の失敗からの再試行', () => {
  const retryMessage = 'ファイルを送れませんでした。時間をおいて、もう一度ファイルを選んでください。'
  it.each([
    ['一時障害', new LiffApiError(503, { error: 'Service unavailable' }), retryMessage],
    ['混雑', new LiffApiError(429, { error: 'Too many requests' }), retryMessage],
    ['通信の失敗', new TypeError('Failed to fetch'), retryMessage],
    ['原因不明の失敗', new Error('document_upload_response_missing'), retryMessage],
    ['容量の制限', new LiffApiError(400, { error: '1ファイル10MBまでです' }), '1ファイル10MBまでです'],
    ['形式の制限', new LiffApiError(400, { error: 'この質問で受け取れる形式を選んでください' }), 'この質問で受け取れる形式を選んでください'],
    ['安全確認の拒否', new LiffApiError(422, { code: 'file_scan_blocked', error: '安全を確認できませんでした。別のファイルを選んでください' }), '安全を確認できませんでした。別のファイルを選んでください'],
  ])('添付の%sでは原因に合う案内を出し、ほかの入力を残す', async (_kind, failure, message) => {
    await open({ fileKinds: ['image', 'pdf'] })
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '入力を残す' } })
    vi.mocked(api.uploadFormFile).mockRejectedValueOnce(failure)
    fireEvent.change(screen.getByLabelText('添付画像', { selector: 'input' }), { target: { files: [new File(['qa'], 'sample.pdf', { type: 'application/pdf' })] } })
    await screen.findByText(message as string)
    expect((screen.getByLabelText('お名前') as HTMLInputElement).value).toBe('入力を残す')
    expect((screen.getByLabelText('添付画像', { selector: 'input' }) as HTMLInputElement).disabled).toBe(false)
    expect(api.uploadFormFile).toHaveBeenCalledOnce()
    expect(api.submitForm).not.toHaveBeenCalled()
  })

  it('追加の失敗でも先の添付と入力を保ち、選び直して成功すると失敗の案内を消す', async () => {
    await open({ fileKinds: ['pdf'], fileMaxCount: 2 })
    fireEvent.change(screen.getByLabelText('お名前'), { target: { value: '入力を残す' } })
    const first = { fileId: 'file-a', filename: 'first.pdf', mimeType: 'application/pdf', state: 'ready' as const, side: 'single' as const }
    const second = { ...first, fileId: 'file-b', filename: 'second.pdf' }
    vi.mocked(api.uploadFormFile).mockResolvedValueOnce({ success: true, data: { file: first } })
      .mockRejectedValueOnce(new LiffApiError(503, { error: 'Service unavailable' }))
      .mockResolvedValueOnce({ success: true, data: { file: second } })
    const choose = (filename: string) => fireEvent.change(screen.getByLabelText('添付画像', { selector: 'input' }), { target: { files: [new File(['qa'], filename, { type: 'application/pdf' })] } })
    choose('first.pdf')
    await screen.findByRole('button', { name: 'first.pdfを外す' })
    choose('second.pdf')
    await screen.findByText(retryMessage)
    expect(screen.getByRole('button', { name: 'first.pdfを外す' })).toBeTruthy()
    expect((screen.getByLabelText('お名前') as HTMLInputElement).value).toBe('入力を残す')
    choose('second.pdf')
    await screen.findByRole('button', { name: 'second.pdfを外す' })
    expect(screen.queryByText(retryMessage)).toBeNull()
    expect(screen.getByRole('button', { name: 'first.pdfを外す' })).toBeTruthy()
    expect((screen.getByLabelText('お名前') as HTMLInputElement).value).toBe('入力を残す')
    expect(api.uploadFormFile).toHaveBeenCalledTimes(3)
    expect(api.submitForm).not.toHaveBeenCalled()
  })
})
