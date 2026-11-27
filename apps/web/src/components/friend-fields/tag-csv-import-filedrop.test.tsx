// @vitest-environment happy-dom
/*
 * タグCSV取り込みのファイル選択（★管理画面 NQMnx への置き換え）。
 * 落とす場所で選ぶ → 行に名前・件数・大きさ・外すが出る → 外すと消える。
 * 大きさの上限と誤り文は変えない。
 */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TagCsvImportDialog from './tag-csv-import-dialog'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: { tags: { importPreview: vi.fn(), importCsv: vi.fn() } },
}))

afterEach(() => { cleanup(); vi.clearAllMocks() })

function openDialog() {
  render(<TagCsvImportDialog open onClose={() => {}} onCompleted={() => {}} />)
}

function chooseFile(name: string, content: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null
  if (!input) throw new Error('file input が見つかりません')
  fireEvent.change(input, { target: { files: [new File([content], name, { type: 'text/csv' })] } })
}

describe('タグCSV取り込みのファイル選択（★管理画面 NQMnx）', () => {
  it('落とす場所と「CSVを選ぶ」ボタンが出る', () => {
    openDialog()
    expect(screen.getByText('ここにCSVを置く')).not.toBeNull()
    expect(screen.getByText('UTF-8・最大500件・1MB以下')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'CSVを選択する' })).not.toBeNull()
  })

  it('選んだCSVは行に名前・件数・大きさと外すが出る', async () => {
    openDialog()
    chooseFile('タグまとめ.csv', 'タグ名,フォルダ\nVIP,会員\n常連,会員\n')
    expect(await screen.findByText('タグまとめ.csv')).not.toBeNull()
    expect(screen.getByText('2件・1KB')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '「タグまとめ.csv」を外す' }))
    expect(screen.queryByText('タグまとめ.csv')).toBeNull()
  })

  it('大きすぎるCSVは誤りの行に出て、文は重ねて出さない', async () => {
    openDialog()
    chooseFile('大きすぎる.csv', `${'あ'.repeat(1024 * 1024 + 1)}`)
    expect(await screen.findByText('CSVは1MB以下にしてください')).not.toBeNull()
    expect(screen.getAllByText('CSVは1MB以下にしてください')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '「大きすぎる.csv」を外す' })).not.toBeNull()
  })
})

it('CSVの確認前に、既存タグを上書きしないこととエラー行の直し方を知らせる', async () => {
  vi.mocked(api.tags.importPreview).mockResolvedValueOnce({ success: true, data: {
    summary: { total: 2, ready: 1, skipped: 0, invalid: 1 },
    rows: [
      { rowNumber: 1, name: 'VIP', folderName: '会員', status: 'ready' },
      { rowNumber: 2, name: '', folderName: '', status: 'invalid', error: 'タグ名を入力してください' },
    ],
  } } as Awaited<ReturnType<typeof api.tags.importPreview>>)
  openDialog()
  chooseFile('タグ.csv', 'タグ名,フォルダ\nVIP,会員\n,\n')
  await screen.findByText('タグ.csv')
  fireEvent.click(screen.getByRole('button', { name: '取り込む内容を確認' }))
  expect(await screen.findByText('要確認：エラーの1行は登録されません')).toBeTruthy()
  expect(screen.getByText(/同じ名前のタグは上書きしません/)).toBeTruthy()
  expect(screen.getByText(/エラーの行はCSVを直してから/)).toBeTruthy()
})

it('登録できる行がない時は理由を示し、登録を送らない', async () => {
  vi.mocked(api.tags.importPreview).mockResolvedValueOnce({ success: true, data: {
    summary: { total: 1, ready: 0, created: 0, skipped: 1, invalid: 0, failed: 0 },
    rows: [{ line: 2, name: 'VIP', folderName: '', status: 'skipped', code: 'already_exists', message: '同じ名前のタグがあります' }],
  } } as Awaited<ReturnType<typeof api.tags.importPreview>>)
  openDialog()
  expect(screen.getByText('CSVファイルを選ぶと確認できます。')).toBeTruthy()
  chooseFile('既存.csv', 'タグ名,フォルダ\nVIP,\n')
  await screen.findByText('既存.csv')
  fireEvent.click(screen.getByRole('button', { name: '取り込む内容を確認' }))
  const save = await screen.findByRole('button', { name: '0件を登録する' })
  expect(save.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('登録できる行がありません。CSVを直して選び直してください。')).toBeTruthy()
    expect(screen.getByText('要確認：登録できる行だけを登録します')).toBeTruthy()
  fireEvent.click(save)
  expect(api.tags.importCsv).not.toHaveBeenCalled()
})

describe('タグCSV取り込みの確認から登録まで', () => {
  const dialog = () => screen.getByRole('dialog')
  async function toPreview(rows: Array<{ line: number; name: string; folderName: string; status: 'ready' | 'skipped' | 'invalid'; message?: string }>) {
    vi.mocked(api.tags.importPreview).mockResolvedValueOnce({ success: true, data: {
      summary: { total: rows.length, ready: rows.filter((row) => row.status === 'ready').length, created: 0, skipped: rows.filter((row) => row.status === 'skipped').length, invalid: rows.filter((row) => row.status === 'invalid').length, failed: 0 },
      rows,
    } } as Awaited<ReturnType<typeof api.tags.importPreview>>)
    openDialog()
    expect(dialog().getAttribute('data-design-node')).toBe('H374MR')
    chooseFile('タグ.csv', 'タグ名,フォルダ\nVIP,会員\n常連,会員\n')
    await screen.findByText('タグ.csv')
    fireEvent.click(screen.getByRole('button', { name: '取り込む内容を確認' }))
    await screen.findByRole('button', { name: /件を登録する$/ })
  }

  it('確認は読んだ行を事前確認の口へ送り、新しく作る・飛ばす・エラーの数を出す（sfTEW）', async () => {
    await toPreview([
      { line: 2, name: 'VIP', folderName: '会員', status: 'ready' },
      { line: 3, name: '常連', folderName: '会員', status: 'skipped' },
    ])
    expect(api.tags.importPreview).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'VIP', folderName: '会員' }),
      expect.objectContaining({ name: '常連', folderName: '会員' }),
    ])
    expect(dialog().getAttribute('data-design-node')).toBe('sfTEW')
    for (const label of ['新しく作る', '飛ばす', 'エラー']) expect(dialog().textContent).toContain(label)
    expect(api.tags.importCsv).not.toHaveBeenCalled()
  })

  it('登録が全部通れば完了（op1rh）で「一覧へ戻る」を出す', async () => {
    const onCompleted = vi.fn()
    vi.mocked(api.tags.importPreview).mockResolvedValueOnce({ success: true, data: {
      summary: { total: 1, ready: 1, created: 0, skipped: 0, invalid: 0, failed: 0 }, rows: [{ line: 2, name: 'VIP', folderName: '会員', status: 'ready' }],
    } } as Awaited<ReturnType<typeof api.tags.importPreview>>)
    vi.mocked(api.tags.importCsv).mockResolvedValueOnce({ success: true, data: {
      outcome: 'success', summary: { total: 1, ready: 0, created: 1, skipped: 0, invalid: 0, failed: 0 }, rows: [{ line: 2, name: 'VIP', folderName: '会員', status: 'created' }],
    } } as Awaited<ReturnType<typeof api.tags.importCsv>>)
    render(<TagCsvImportDialog open onClose={() => {}} onCompleted={onCompleted} />)
    chooseFile('タグ.csv', 'タグ名,フォルダ\nVIP,会員\n')
    await screen.findByText('タグ.csv')
    fireEvent.click(screen.getByRole('button', { name: '取り込む内容を確認' }))
    fireEvent.click(await screen.findByRole('button', { name: '1件を登録する' }))
    expect(await screen.findByText('1件を登録しました')).toBeTruthy()
    expect(api.tags.importCsv).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'VIP', folderName: '会員' })])
    expect(dialog().getAttribute('data-design-node')).toBe('op1rh')
    expect(screen.getByRole('button', { name: '一覧へ戻る' })).toBeTruthy()
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  it('一部だけ入らなかったら（QzRsJ）入らなかった行を5行まで理由つきで出し、その行だけCSVで出せる', async () => {
    const failedRows = Array.from({ length: 6 }, (_, index) => ({ line: index + 3, name: `だめ${index}`, folderName: '', status: 'invalid' as const, message: `理由${index}` }))
    vi.mocked(api.tags.importPreview).mockResolvedValueOnce({ success: true, data: {
      summary: { total: 7, ready: 1, created: 0, skipped: 0, invalid: 6, failed: 0 }, rows: [{ line: 2, name: 'VIP', folderName: '', status: 'ready' }, ...failedRows],
    } } as Awaited<ReturnType<typeof api.tags.importPreview>>)
    vi.mocked(api.tags.importCsv).mockResolvedValueOnce({ success: true, data: {
      outcome: 'partial', summary: { total: 7, ready: 0, created: 1, skipped: 0, invalid: 6, failed: 0 }, rows: [{ line: 2, name: 'VIP', folderName: '', status: 'created' }, ...failedRows],
    } } as Awaited<ReturnType<typeof api.tags.importCsv>>)
    openDialog()
    chooseFile('タグ.csv', 'タグ名,フォルダ\nVIP,\n')
    await screen.findByText('タグ.csv')
    fireEvent.click(screen.getByRole('button', { name: '取り込む内容を確認' }))
    fireEvent.click(await screen.findByRole('button', { name: '1件を登録する' }))
    expect(await screen.findByRole('heading', { name: '要確認：1件を登録し、6件は入りませんでした', exact: true })).toBeTruthy()
    expect(dialog().getAttribute('data-design-node')).toBe('QzRsJ')
    const table = screen.getByRole('table')
    expect(table.querySelector('thead')?.textContent).toBe('行タグ名入らなかった理由')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(5)
    expect(table.textContent).toContain('理由0')
    expect(table.textContent).not.toContain('VIP')
    expect(screen.getByRole('button', { name: '入らなかった6行をCSVで出す' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '一覧へ戻る' })).toBeTruthy()
  })
})
