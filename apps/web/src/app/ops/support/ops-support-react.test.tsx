// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsSupportPage from './page'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import { compareLabel, durationLabel, elapsedLabel } from '../../../v8/ops/support/format'
import type { OpsKnowledgeReference, OpsSupportDetail } from '@/lib/api'
import { OPS_READONLY_LOCK_REASON } from '../../../v8/ops/use-ops-read-only'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))

/** ★管理画面 37-6 お問い合わせ。一覧・内容・返信・AI下書きの3状態が API の形どおりに出ること。 */

const ticket = {
  id: 't1', ticketNo: 312, ticketLabel: '#MB-0312', tenantId: 'tenant-a', tenantName: '株式会社サンプル',
  tenantPlanKey: 'standard', tenantPlanStatus: 'active', tenantStatus: 'active',
  staffId: 's1', staffName: '見本 141', staffRole: 'owner', staffEmailRegistered: true,
  kind: 'bug', kindLabel: '不具合', subject: '回答フォームからタグが付かない', subjectAuto: false,
  body: '設定したタグが友だちに付きません。', attachments: [{ key: 'support/a.png', url: 'https://api.example.test/images/support/a.png', name: 'a.png' }],
  stage: 'new', stageLabel: '新規', priority: 'high', priorityLabel: '高', channel: 'admin', channelLabel: '管理画面',
  assigneeStaffId: null, replyCount: 0, firstRepliedAt: null, lastMessageAt: new Date().toISOString(), resolvedAt: null, closedAt: null,
  createdAt: '2026-09-15T08:40:00.000+09:00', updatedAt: '2026-09-15T08:40:00.000+09:00',
}

let host: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>
let draft: { body: string; aiGenerated: boolean; generatedAt: string | null; updatedAt: string; references?: OpsKnowledgeReference[] } | null
let availableReferences: OpsKnowledgeReference[] = []
let aiFails = false
let viewerMe = false
let knowledge: OpsSupportDetail['knowledge']

function respond(url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
  calls.push({ url, method, body })
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  if (url.endsWith('/api/ops/me')) return json({ success: true, data: { id: 'ops-1', readOnly: viewerMe } })
  if (url.endsWith('/api/ops/support/summary')) {
    return json({ success: true, data: { byStage: { all: 86, new: 3, in_progress: 2, waiting: 1, resolved: 12, closed: 68 }, kpis: { untouched: 3, untouchedFromLine: 3, avgFirstReplyMinutes: 84, prevAvgFirstReplyMinutes: 117, resolutionRate: 96.7, prevResolutionRate: 90.7, avgResolutionMinutes: 312, prevAvgResolutionMinutes: 310 } } })
  }
  if (url.includes('/api/ops/support/tickets?')) return json({ success: true, data: [ticket], total: 86 })
  if (url.endsWith('/api/ops/knowledge/tickets/t1/process')) {
    knowledge = { ...knowledge!, job: { status: 'done', source_current: 1 } }
    return json({ success: true, data: knowledge })
  }
  if (url.endsWith('/draft/ai')) {
    if (aiFails) return json({ success: false, error: 'AI の応答が 45 秒以内に返りませんでした' }, 504)
    const excluded = (body?.excludeArticleIds ?? []) as string[]
    draft = { body: '山田さま\nご連絡ありがとうございます。', aiGenerated: true, generatedAt: '2026-09-15T09:31:00.000+09:00', updatedAt: '2026-09-15T09:31:00.000+09:00', references: availableReferences.filter(ref => !excluded.includes(ref.id)) }
    return json({ success: true, data: draft }, 201)
  }
  if (url.endsWith('/reply')) return json({ success: true, data: { ticket: { ...ticket, stage: 'waiting', stageLabel: '待ち' }, message: {}, mailSent: true, mailSkippedReason: null } }, 201)
  if (url.endsWith('/api/ops/support/tickets/t1')) {
    return json({ success: true, data: { ticket, tenant: { accountCount: 4, staffCount: 6, staffWithLine: 5, pastTickets: 12, pastOpen: 0 }, messages: [
      { id: 'm1', authorKind: 'ops', authorName: '見本 25', body: '該当のフォームを確認します。', attachments: [], aiAssisted: false, deliveredVia: ['screen', 'email'], createdAt: '2026-09-15T09:05:00.000+09:00' },
    ], draft, knowledge, ai: { available: true } } })
  }
  return json({ success: false, error: `unexpected ${method} ${url}` }, 404)
}

beforeEach(() => {
  calls = []
  draft = null
  aiFails = false
  viewerMe = false
  knowledge = undefined
  availableReferences = []
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function flush() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve() })
}

describe('表記の決まり', () => {
  it('経過時間は 分前・時間前・日前', () => {
    const now = Date.parse('2026-09-15T10:00:00.000+09:00')
    expect(elapsedLabel('2026-09-15T09:35:00.000+09:00', now)).toBe('25分前')
    expect(elapsedLabel('2026-09-15T08:00:00.000+09:00', now)).toBe('2時間前')
    expect(elapsedLabel('2026-09-11T10:00:00.000+09:00', now)).toBe('4日前')
  })
  it('所要時間は 1時間24分 のように出す', () => {
    expect(durationLabel(84)).toBe('1時間24分')
    expect(durationLabel(312)).toBe('5時間12分')
    expect(durationLabel(30)).toBe('30分')
    expect(durationLabel(null)).toBe('—')
  })
  it('先月との比べ方（時間は短いほど良い、割合は高いほど良い）', () => {
    expect(compareLabel(84, 117, 'time')).toBe('先月より 28% 早い')
    expect(compareLabel(96.7, 90.7, 'rate')).toBe('先月より 6% 改善')
    expect(compareLabel(312, 310, 'time')).toBe('先月とほぼ同じ')
    expect(compareLabel(84, null, 'time')).toBe('先月の記録なし')
    expect(compareLabel(null, 10, 'rate')).toBe('今月の記録なし')
  })
})

describe('画面', () => {
  it.each([true, false])('保存済み下書きのAI生成=%sに応じ、実際の根拠だけを確認に出す', async aiGenerated => {
    draft = {
      body: aiGenerated ? 'AIで作った返信' : '手で書いた返信', aiGenerated,
      generatedAt: aiGenerated ? '2026-09-15T09:31:00.000+09:00' : null,
      updatedAt: '2026-09-15T09:31:00.000+09:00',
      references: aiGenerated ? [{ id: 'ref-a', title: '返信の根拠', version: 1, articleKind: 'verified' }] : [],
    }
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '返信する')!.click())
    await flush()
    const confirmation = document.body.querySelector('[data-design-node="GgP2d"]')
    expect(confirmation?.textContent).toContain(draft.body)
    expect(confirmation?.textContent?.includes('AI の下書きの根拠：ナレッジ「返信の根拠」')).toBe(aiGenerated)
    expect(calls.some(c => c.url.endsWith('/reply'))).toBe(false)
  })

  it('生成予約があると対象だけを自動実行し、完了後は再実行しない', async () => {
    vi.useFakeTimers()
    knowledge = { canProcess: true, article: null, job: { status: 'queued', source_current: 1 } }
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect(calls.filter(c => c.url.endsWith('/process'))).toHaveLength(1)
    expect(calls.find(c => c.url.endsWith('/process'))?.method).toBe('POST')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) }); await flush()
    expect(calls.filter(c => c.url.endsWith('/process'))).toHaveLength(1)
    expect(calls.some(c => c.url.endsWith('/reply'))).toBe(false)
  })

  it.each([false, undefined])('書込許可が %s の画面では生成せず、状態の読取だけを行う', async canProcess => {
    vi.useFakeTimers()
    knowledge = { canProcess, article: null, job: { status: 'queued', source_current: 1 } }
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) }); await flush()
    expect(calls.some(c => c.url.endsWith('/process'))).toBe(false)
    expect(calls.filter(c => c.url.endsWith('/api/ops/support/tickets/t1'))).toHaveLength(2)
  })

  it('長い生成中も返信を書けて、完了時に入力内容を上書きしない', async () => {
    knowledge = { canProcess: true, article: null, job: { status: 'running', source_current: 1 } }
    let finish!: () => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/process')) await new Promise<void>(resolve => { finish = resolve })
      return respond(String(input), init)
    }))
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    const textarea = host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '対応内容を確認しています。')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => finish()); await flush()
    expect((host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement).value).toBe('対応内容を確認しています。')
  })

  it('実行APIが拒否しても固まらず、エラーを示して自動呼出しを止める', async () => {
    vi.useFakeTimers()
    knowledge = { canProcess: true, article: null, job: { status: 'queued', source_current: 1 } }
    const process = vi.fn(() => new Response(JSON.stringify({ success: false, error: '閲覧のみです' }), { status: 403 }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/process') ? process() : respond(String(input), init)))
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect(host.textContent).toContain('この操作をする権限がありません')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(process).toHaveBeenCalledTimes(1)
  })

  it('再オープン済みの古い生成予約は実行しない', async () => {
    knowledge = { canProcess: true, article: null, job: { status: 'queued', source_current: 0 } }
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect(calls.some(c => c.url.endsWith('/process'))).toBe(false)
  })

  it('excludes evidence only for this reply, accumulates exclusions, and does not send automatically', async () => {
    availableReferences = [
      { id: 'ref-a', title: 'フォームの根拠', version: 1, articleKind: 'verified' },
      { id: 'ref-b', title: '配信の根拠', version: 2, articleKind: 'answer_example' },
    ]
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    const click = async (label: string) => {
      await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label)!.click()); await flush()
    }
    await click('AIで下書きを作る')
    await click('除外して回答を作り直す')
    expect(calls.filter(c => c.url.endsWith('/draft/ai')).at(-1)?.body).toEqual({ excludeArticleIds: ['ref-a'] })
    expect(host.querySelector('[data-design-node="LT8m5"]')?.textContent).not.toContain('フォームの根拠')
    await click('除外して回答を作り直す')
    expect(calls.filter(c => c.url.endsWith('/draft/ai')).at(-1)?.body).toEqual({ excludeArticleIds: ['ref-a', 'ref-b'] })
    expect(host.querySelector('[data-design-node="LT8m5"]')).toBeNull()
    expect(calls.some(c => c.url.endsWith('/reply'))).toBe(false)
    aiFails = true
    await click('作り直す')
    expect((host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement).value).toContain('山田さま')
    expect(host.textContent).toContain('時間内に終わりませんでした')
  })
  it('AI が失敗（5xx）しても「作成中…」のまま固まらず、エラー文を出して手書きに戻る', async () => {
    aiFails = true
    await act(async () => { root.render(<OpsSupportPage />) })
    await flush()
    const aiButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('AIで下書きを作る'))
    await act(async () => { aiButton!.click() })
    await flush()
    expect(host.textContent).not.toContain('AIが下書きを作っています')
    expect(host.textContent).toContain('時間内に終わりませんでした')
    expect(host.querySelector('textarea[aria-label="返信"]')).not.toBeNull()
  })

  it('状態タブの件数・集計の補足・一覧・内容と返信が出る', async () => {
    await act(async () => { root.render(<OpsSupportPage />) })
    await flush()
    const text = host.textContent ?? ''
    await act(async () => { (host.querySelector('button[aria-label="お問い合わせの説明"]') as HTMLButtonElement).click() })
    const information = Array.from(document.body.querySelectorAll('[title]')).map(node => node.getAttribute('title')).join('\n')
    expect(text).toContain('すべて')
    const stages = host.querySelector<HTMLButtonElement>('button[aria-label="状態で絞る"]')!
    await act(async () => { stages.click() })
    const options = [...document.body.querySelectorAll('[role="option"]')]
    expect(options.find(option => option.textContent?.includes('すべて'))?.textContent).toContain('86件')
    expect(options.find(option => option.textContent?.includes('新規'))?.textContent).toContain('3件')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(information).toContain('未対応のチケット')
    expect(information).toContain('LINEから受付 3件')
    expect(information).toContain('1時間24分')
    expect(information).toContain('先月より 28% 早い')
    expect(information).toContain('96.7%')
    expect(text).toContain('#MB-0312')
    expect(text).toContain('回答フォームからタグが付かない')
    expect(information).toContain('管理画面のお問い合わせ')
    expect(information).toContain('6人中5人')
    // m22d: 一覧の件数と重なる「○件」は出さない。未解決を先に言う。
    expect(information).toContain('これまで12のうち未解決0件')
    expect(text).toContain('運営 見本 25')
    expect(text).toContain('a.png（契約先から）')
    expect(text).toContain('AIで下書きを作る')
    expect(host.querySelector('[data-design-node="P0jhqO"]')).not.toBeNull()
  })

  it('AIで下書きを作ると案内と作成時刻が出て、送ると aiAssisted 付きで返信 API を呼ぶ', async () => {
    availableReferences = [{ id: 'ref-banner', title: 'バナーの日本語', version: 1, articleKind: 'verified' }]
    await act(async () => { root.render(<OpsSupportPage />) })
    await flush()
    const aiButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('AIで下書きを作る'))
    expect(aiButton).toBeDefined()
    await act(async () => { aiButton!.click() })
    await flush()
    expect(host.textContent).toContain('お客様の状況・やり取りとナレッジをもとに作った下書きです')
    expect(host.textContent).toContain('作り直す')
    expect(host.querySelector('[title="09/15 09:31 に作成"]')?.textContent).toBe('AI の下書き')
    const textarea = host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement
    expect(textarea.value).toContain('山田さま')
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '返信する')
    await act(async () => { send!.click() })
    await flush()
    // 板 「この返事を送りますか？」を見てから送る。
    const confirm = document.body.querySelector('[data-design-node="GgP2d"]')
    expect(confirm, '返事の確認の窓が出ない').not.toBeNull()
    for (const row of ['この返事を送りますか？', '宛先', '状態', '優先度', '下書きを削除', '戻って直す', '送信する']) {
      expect(confirm?.textContent ?? '', `「${row}」がない`).toContain(row)
    }
    expect(confirm?.textContent).toContain('AI の下書きの根拠：ナレッジ「バナーの日本語」をもとに作成')
    const sendInDialog = Array.from(confirm?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('送信する')) as HTMLButtonElement
    await act(async () => { sendInDialog.click() })
    await flush()
    const reply = calls.find((c) => c.url.endsWith('/reply'))
    expect(reply?.body).toMatchObject({ aiAssisted: true })
    expect(String(reply?.body?.body)).toContain('山田さま')
    expect(host.textContent).toContain('登録メールにも送りました')
  })
})

describe('閲覧のみ', () => {
  it('起票も返信も優先度も押せない形＋理由で出し、押しても口を呼ばない', async () => {
    viewerMe = true
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect(host.textContent).toContain(OPS_READONLY_LOCK_REASON)
    const buttons = Array.from(host.querySelectorAll('button'))
    for (const label of ['代わりに起票する', '返信する', '解決済みにする', '代理ログイン']) {
      const button = buttons.find((b) => b.textContent === label) as HTMLButtonElement
      expect(button, `「${label}」がない`).toBeTruthy()
    }
    expect(host.querySelector('button[aria-label="優先度を変える"]'), '優先度の選びがない').toBeTruthy()
    const textarea = host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    const reply = buttons.find((b) => b.textContent === '返信する') as HTMLButtonElement
    await act(async () => { reply.click() }); await flush()
    expect(document.body.querySelector('[data-design-node="GgP2d"]')).toBeNull()
    expect(calls.some((c) => c.url.endsWith('/reply'))).toBe(false)
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })
})
