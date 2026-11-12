// @vitest-environment happy-dom
/*
 * ：質問を作る。保存で足りない欄は、その欄が赤くなり真下に理由が出て、
 * 1つ目の欄へ移る。上の帯だけで終わらせない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const notifySaved = vi.hoisted(() => vi.fn())
vi.mock('@/components/shared/toast', async original => ({ ...await original<typeof import('@/components/shared/toast')>(), notifyToast: notifySaved }))
const navigationPush = vi.hoisted(() => vi.fn())
const templatesApi = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), update: vi.fn(), publish: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const api = (actual as unknown as { api: Record<string, object> }).api
  return {
    ...actual,
    api: {
      ...api,
      templates: { ...api.templates, ...templatesApi },
      folders: { ...api.folders, list: async () => ({ success: true, data: [] }) },
      tags: { ...api.tags, list: async () => ({ success: true, data: [] }) },
      scenarios: { ...api.scenarios, list: async () => ({ success: true, data: [] }) },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigationPush, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '然 - NEN -' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

import QuestionNewV8 from './question-new'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

async function frames(count = 3) {
  for (let i = 0; i < count; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
}

beforeEach(async () => {
  document.documentElement.setAttribute('data-theme', 'v8')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  for (const fn of Object.values(templatesApi)) fn.mockReset()
  await act(async () => { root.render(<QuestionNewV8 />) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

describe('質問を作る：保存で欄に知らせる', () => {
  it('質問と作りかけのフォルダの両方を残して離脱前に確認する', async () => {
    await act(async () => { fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '質問の名前' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'フォルダ', exact: true })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' })) })
    await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '編集中' } }); fireEvent.pointerDown(document.body) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'キャンセル', exact: true })) })
    expect(screen.getByRole('dialog', { name: '保存していない変更があります' }).textContent).toContain('作りかけのフォルダ')
    expect(navigationPush).not.toHaveBeenCalled()
  })

  it('統括では追加処理→返信の既存の順番と、店専用の動きを出さない形を保つ', async () => {
    await act(async () => { root.render(<QuestionNewV8 host={{ description: '配った先で使います', folders: [], folder: '', onFolderChange: vi.fn(), busy: false, onSave: vi.fn(), onCancel: vi.fn() }} />) })
    const extra = screen.getAllByRole('button', { name: '押されたときにあわせて行うことを足す' })[0]
    const reply = screen.getAllByLabelText('押したときの返信')[0]
    expect(extra.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: '選択肢 1 の押されたら：変える' })).toBeNull()
  })

  it('閉じた動きの欄に保存エラーが返ると、その選択肢だけ開いて理由を出す', async () => {
    templatesApi.create.mockRejectedValue({ status: 422, fields: { 'choices.0.userMessage': '発言を短くしてください。' } })
    await act(async () => {
      fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '質問' } })
      fireEvent.change(screen.getByLabelText('質問文（160文字まで）'), { target: { value: '続けますか？' } })
    })
    expect(screen.queryByLabelText('ユーザーメッセージ')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
    await frames()
    // 窓で直す形：エラーのある選択肢 1 の窓だけが開く。
    expect(screen.getByRole('dialog', { name: /選択肢 1「.*」を押されたら/ })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: /選択肢 2「.*」を押されたら/ })).toBeNull()
    const message = screen.getByLabelText('ユーザーメッセージ')
    expect(message.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('発言を短くしてください。')).toBeTruthy()
    expect(document.activeElement).toBe(message)
  })

  it('答え方を矢印で変えても名前を保ち、選択肢の上限と最後の1つの理由を出す', async () => {
    const name = screen.getByLabelText('テンプレート名') as HTMLInputElement
    await act(async () => { fireEvent.change(name, { target: { value: '継続を確認する' } }) })
    const single = screen.getByRole('button', { name: '1つだけ選ぶ' })
    await act(async () => { single.focus(); fireEvent.keyDown(single, { key: 'ArrowRight' }) })
    expect(screen.getByRole('button', { name: 'いくつでも選ぶ' }).getAttribute('aria-pressed')).toBe('true')
    expect(name.value).toBe('継続を確認する')
    const add = screen.getByRole('button', { name: '選択肢を足す（最大 4 つ）' }) as HTMLButtonElement
    await act(async () => { fireEvent.click(add); fireEvent.click(add) })
    expect(add.disabled).toBe(true)
    expect(add.title).toBe('選択肢は4つまでです。')
    for (const number of [4, 3, 2]) await act(async () => { fireEvent.click(screen.getByRole('button', { name: `選択肢 ${number} を削除する` })) })
    const last = screen.getByRole('button', { name: '選択肢 1 を削除する' }) as HTMLButtonElement
    expect(last.disabled).toBe(true)
    expect(last.title).toBe('選択肢は1つ以上必要です。')
    await act(async () => { fireEvent.click(last) })
    expect(screen.getAllByLabelText('ボタンの文字（20文字まで）')).toHaveLength(1)
    expect(name.value).toBe('継続を確認する')
    // 押したときの動きは「押されたら」の欄から窓で開いて決める。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '選択肢 1 の押されたら：変える' })) })
    const message = screen.getByLabelText('ユーザーメッセージ') as HTMLInputElement
    await act(async () => { fireEvent.change(message, { target: { value: '入力を保つ' } }) })
    const hideMessage = screen.getByRole('checkbox', { name: 'ユーザーメッセージを使用しない' })
    await act(async () => { fireEvent.click(hideMessage) })
    expect(message.disabled).toBe(true)
    expect(message.title).toContain('使う場合はチェックを外してください。')
    expect(message.value).toBe('入力を保つ')
    await act(async () => { fireEvent.click(hideMessage) })
    expect(message.disabled).toBe(false)
    expect(message.value).toBe('入力を保つ')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '決める' })) })
    expect(screen.queryByLabelText('ユーザーメッセージ')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '選択肢 1 の押されたら：変える' })) })
    expect((screen.getByLabelText('ユーザーメッセージ') as HTMLInputElement).value).toBe('入力を保つ')
    expect(templatesApi.create).not.toHaveBeenCalled()
  })

  it('空欄の前文と質問文の例は入力済みと区別できる', () => {
    const intro = screen.getByLabelText('前文（空なら送らない）') as HTMLInputElement
    const text = screen.getByLabelText('質問文（160文字まで）') as HTMLInputElement
    expect(intro.value).toBe('')
    expect(intro.placeholder).toBe('例：いつもありがとうございます。')
    expect(text.value).toBe('')
    expect(text.placeholder).toBe('例：来月も定期便を続けますか？')
  })

  it('空のまま保存すると、名前・質問文・選択肢の欄が赤くなり理由が出て、名前の欄へ移る。直すと消える', async () => {
    // 2つ目の選択肢の文字を消しておく（はい・いいえ が最初から入っている）。
    const choiceInputs = Array.from(document.querySelectorAll('input[maxlength="20"]')) as HTMLInputElement[]
    fireEvent.change(choiceInputs[1], { target: { value: '' } })
    const save = screen.getByRole('button', { name: '下書きを保存' })
    await act(async () => { fireEvent.click(save) })
    await frames()
    expect(templatesApi.create).not.toHaveBeenCalled()
    const name = document.querySelector('input[placeholder="例：継続の意思をうかがう"]') as HTMLInputElement
    const text = document.querySelector('input[placeholder="例：来月も定期便を続けますか？"]') as HTMLInputElement
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(text.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById('q-name-error')?.textContent).toBe('テンプレート名を入力してください。')
    expect(document.getElementById('q-text-error')?.textContent).toBe('質問文を入力してください。')
    expect(document.getElementById('q-choice-0-error')).toBeNull()
    expect(document.getElementById('q-choice-1-error')?.textContent).toBe('ボタンの文字を入力してください。')
    expect(choiceInputs[1].getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(name)
    expect(document.querySelector('[data-design-part="validation-summary"]')?.textContent).toContain('3か所直してください：テンプレート名・質問文・選択肢 2 のボタンの文字')
    fireEvent.change(name, { target: { value: '継続のうかがい' } })
    expect(name.getAttribute('aria-invalid')).toBeNull()
    expect(document.getElementById('q-name-error')).toBeNull()
  })
})


it('20文字を超す既存のボタン名は消さずその欄へ案内し、直すとエラーが消えて20文字を保存できる', async () => {
  const long = 'あ'.repeat(25)
  const name = screen.getByLabelText('テンプレート名') as HTMLInputElement
  const text = screen.getByLabelText('質問文（160文字まで）') as HTMLInputElement
  const choice = screen.getAllByLabelText('ボタンの文字（20文字まで）')[1] as HTMLInputElement
  expect(choice.maxLength).toBe(20)
  await act(async () => {
    fireEvent.change(name, { target: { value: '質問の見出し' } })
    fireEvent.change(text, { target: { value: '続けますか？' } })
    // 保存済みデータなど、ブラウザーの入力上限を通らない値も失わない。
    fireEvent.change(choice, { target: { value: long } })
    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
  })
  await frames()
  expect(templatesApi.create).not.toHaveBeenCalled()
  expect(choice.value).toBe(long)
  expect(choice.getAttribute('aria-invalid')).toBe('true')
  expect(document.getElementById('q-choice-1-error')?.textContent).toBe('ボタンの文字は20文字以内で入力してください。')
  expect(document.activeElement).toBe(choice)
  expect(name.value).toBe('質問の見出し')
  expect(text.value).toBe('続けますか？')
  await act(async () => { fireEvent.change(choice, { target: { value: 'あ'.repeat(20) } }) })
  expect(choice.getAttribute('aria-invalid')).toBeNull()
  expect(document.getElementById('q-choice-1-error')).toBeNull()
  templatesApi.create.mockResolvedValue({ success: true, data: { publishedVersion: 1, draftRevision: 1 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '下書きを保存' })) })
  expect(templatesApi.create).toHaveBeenCalledOnce()
  expect(templatesApi.create.mock.calls[0][0].question.choices[1].label).toBe('あ'.repeat(20))
})

it('必須不足は主保存を押せない形と理由にし、欄の検証入口を残す', () => {
  const save = screen.getByRole('button', { name: '保存して公開' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(screen.getByText('テンプレート名を入力してください。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '下書きを保存' }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(save);expect(templatesApi.create).not.toHaveBeenCalled()
})


it('E-20: 質問を保存した後は質問タブに戻り、成功を知らせる', async () => {
  templatesApi.create.mockResolvedValue({success:true,data:{publishedVersion:0,draftRevision:1}})
  await act(async () => {
    fireEvent.change(screen.getByLabelText('テンプレート名'), {target:{value:'質問'}})
    fireEvent.change(screen.getByLabelText('質問文（160文字まで）'), {target:{value:'続けますか？'}})
    fireEvent.click(screen.getByRole('button',{name:'下書きを保存'}))
  })
  await frames()
  expect(templatesApi.create).toHaveBeenCalled()
  expect(navigationPush).toHaveBeenCalledWith('/templates?tab=question')
  expect(notifySaved).toHaveBeenCalledWith('質問を保存しました', {tone:'success'})
})


it('保存して公開は下書きを作った後に同じ版を公開する', async () => {
  templatesApi.create.mockResolvedValue({ success: true, data: { id: 'question-1', publishedVersion: 0, draftRevision: 1 } })
  templatesApi.publish.mockResolvedValue({ success: true, data: { publishedVersion: 1, draftRevision: 0 } })
  navigationPush.mockClear()
  await act(async () => {
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '質問' } })
    fireEvent.change(screen.getByLabelText('質問文（160文字まで）'), { target: { value: '続けますか？' } })
  })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  expect(templatesApi.publish).toHaveBeenCalledWith('question-1', { expectedVersion: 0, expectedDraftRevision: 1 })
  expect(navigationPush).toHaveBeenCalledWith('/templates?tab=question')
})

it('公開に失敗しても作成済みの下書きを使い、二重作成せずに公開をやり直せる', async () => {
  templatesApi.create.mockResolvedValue({ success: true, data: { id: 'question-1', publishedVersion: 0, draftRevision: 1 } })
  templatesApi.update.mockResolvedValue({ success: true, data: { id: 'question-1', publishedVersion: 0, draftRevision: 2 } })
  templatesApi.publish.mockResolvedValueOnce({ success: false, error: '公開できませんでした' }).mockResolvedValueOnce({ success: true, data: { publishedVersion: 1, draftRevision: 0 } })
  navigationPush.mockClear()
  await act(async () => {
    fireEvent.change(screen.getByLabelText('テンプレート名'), { target: { value: '質問' } })
    fireEvent.change(screen.getByLabelText('質問文（160文字まで）'), { target: { value: '続けますか？' } })
  })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  expect(navigationPush).not.toHaveBeenCalled()
  expect(screen.getByText(/公開できませんでした/)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存して公開' })) })
  expect(templatesApi.create).toHaveBeenCalledTimes(1)
  expect(templatesApi.update).toHaveBeenCalledTimes(1)
  expect(templatesApi.publish).toHaveBeenLastCalledWith('question-1', { expectedVersion: 0, expectedDraftRevision: 2 })
  expect(navigationPush).toHaveBeenCalledWith('/templates?tab=question')
})
