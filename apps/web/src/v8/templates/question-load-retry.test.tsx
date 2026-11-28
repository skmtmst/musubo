// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

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
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href, ...rest }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=tpl-1'),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '然 - NEN -' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
}))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))

import QuestionNewV8 from './question-new'

beforeEach(() => {
  document.documentElement.setAttribute('data-theme', 'v8')
  for (const fn of Object.values(templatesApi)) fn.mockReset()
})

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-theme')
})

describe('質問テンプレート編集の読み込み失敗時再読み込み', () => {
  it('読み込み失敗時は空の上書き保存を止め、その場でもう一度読み込んで復帰できる', async () => {
    templatesApi.get
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'tpl-1',
          name: '継続の意思をうかがう',
          accountId: 'account-a',
          category: '未分類',
          folderId: null,
          publishedVersion: 1,
          draftRevision: 1,
          usedBy: { scenarios: [], broadcasts: [], autoReplies: [], reminders: [] },
          question: {
            intro: 'いつもありがとうございます。',
            text: '来月も続けますか？',
            tapMode: 'single',
            choices: [
              { key: 'c1', label: 'はい', behavior: 'reply', reply: 'ありがとうございます。' },
              { key: 'c2', label: 'いいえ', behavior: 'reply', reply: '承知しました。' },
            ],
          },
        },
      })

    render(<QuestionNewV8 />)

    await screen.findByText(/質問テンプレートを読み込めませんでした/)
    const draftBtn = screen.getByRole('button', { name: '下書きを保存' }) as HTMLButtonElement
    expect(draftBtn.disabled).toBe(true)
    expect(screen.queryByText('テンプレート名を入力してください。')).toBeNull()

    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    await waitFor(() => {
      expect((screen.getByLabelText('テンプレート名') as HTMLInputElement).value).toBe('継続の意思をうかがう')
      expect((screen.getByRole('button', { name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(false)
    })
    expect(screen.queryByText(/質問テンプレートを読み込めませんでした/)).toBeNull()
    expect(templatesApi.get).toHaveBeenCalledTimes(2)
  })
})
