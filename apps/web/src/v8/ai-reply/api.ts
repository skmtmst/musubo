/*
 * G2 AI の要約・返信案と Q&A の自動応答（要件 G2 §3 の口）。
 * 口は Codex の Worker が作る途中のため、画面側にだけ置く（lib/api* は Codex の持ち物）。
 * 形は要件 §3「データと API の形（案）」どおり。Worker ができたら lib へ移す。
 */
import { fetchApi, type StepUpPurpose } from '@/lib/api'
import { aiDraftApi as gap2 } from '@/lib/api/helpers/gap2'
import type { QaEntry as Gap2QaEntry } from '@line-crm/shared'

type Result<T> = { success: true; data: T }
const e = encodeURIComponent
const account = (path: string, id: string) => `${path}${path.includes('?') ? '&' : '?'}account_id=${e(id)}`
const json = (method: string, body: unknown, headers?: Record<string, string>) => ({ method, body: JSON.stringify(body), ...(headers ? { headers } : {}) })

/** AI の段（店ごと）。off＝使っていない（初期）・draft_only＝返信案だけ・auto_qa＝Q&A で自動で答える・suspended＝止まっている。 */
export type AiMode = 'off' | 'draft_only' | 'auto_qa' | 'suspended'

export interface AiSettings {
  mode: AiMode
  /** 止まっている理由（提供元の障害・月の上限）。止まっていないときは null。 */
  suspendedReason: 'provider' | 'monthly_limit' | null
  /** 公開中の Q&A の件数（自動で答えるを選べるかの判断と窓の文に使う）。 */
  publishedQaCount: number | null
  /** 確かめ待ち（下書き）の件数。窓の「確かめ待ちの 1 件は使いません」に使う。 */
  draftQaCount: number | null
  version: number
  /** 組2：Q&A の自動応答は今の段では使えない（false）。使えないときは選ぶ欄に出さない。 */
  autoReplyAvailable?: boolean
}

export type QaStatus = 'draft' | 'published' | 'stopped'

export interface QaEntry {
  id: string
  questions: string[]
  answerText: string
  status: QaStatus
  source: 'manual' | 'import_pdf' | 'import_web' | 'from_log'
  useCount: number
  version: number
  updatedAt: string
}

export interface QaPage { items: QaEntry[]; total: number }

export interface ChatSummary { lines: string[]; generatedAt: string; basedOnMessageId: string | null; messageCount?: number }
export interface DraftSource { type: 'qa' | 'past_reply'; id: string; title: string }
export interface ChatDraft { text: string; sources: DraftSource[]; generatedAt: string }

export type AnswerAction = 'answered' | 'handed_off' | 'customer_asked_human'
export interface AiAnswerLog {
  id: string
  createdAt: string
  chatId: string
  friendId: string
  friendName: string
  questionText: string
  action: AnswerAction
  handoffReason: string | null
  qaEntryId: string | null
  qaTitle: string | null
  qaVersion: number | null
}
export interface AiAnswerLogDetail extends AiAnswerLog {
  answerText: string | null
  /** 元の Q&A の今の様子。消されていれば null。 */
  qa: { id: string; title: string; status: QaStatus; useCount: number; updatedAt: string; version: number; currentAnswerText: string } | null
  /** そのあとの会話の短い説明（伏せた形）。 */
  afterNote: string | null
}
export interface AiAnswerSummary { answered: number; handedOff: number; askedAgainRate: number | null }
export interface AiAnswerLogPage { items: AiAnswerLog[]; total: number; summary: AiAnswerSummary }

export interface AiTestResult { qaTitle: string | null; handoffReason: string | null }

/** 本人確認の目的。lib/api の StepUpPurpose に Codex が足すまで、画面側で名前だけ決める。 */
export const AI_SETTINGS_STEP_UP = 'ai.settings' as StepUpPurpose

/*
 * 組2（gap2）の口 `aiDraftApi`（lib/api-gap2・契約 API-CONTRACT-GAP2 §G2）を画面の形に合わせる。
 * 口が無い物（Q&A の取り込み・AI が答えた記録・テストの質問）は要件 §3 の案の道のまま（撮影は見本）。
 */
const parseList = (text: string): string[] => { try { const value = JSON.parse(text); return Array.isArray(value) ? value.map(String) : [] } catch { return [] } }
const answerText = (text: string): string => { try { const value = JSON.parse(text); return Array.isArray(value) ? value.map((m: { text?: string } | string) => (typeof m === 'string' ? m : m.text ?? '')).join('\n') : String(value ?? '') } catch { return text } }
const toQa = (row: Gap2QaEntry): QaEntry => ({ id: row.id, questions: parseList(row.questions_json), answerText: answerText(row.answer_messages_json), status: row.status, source: 'manual', useCount: 0, version: row.version, updatedAt: row.updated_at })
const key = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `qa-${Date.now()}`)
const write = (input: { questions: string[]; answerText: string }) => ({ questions: input.questions, answer: input.answerText })

export const aiReplyApi = {
  settings: async (accountId: string): Promise<Result<AiSettings>> => {
    const [res, qa] = await Promise.all([gap2.settings(accountId), gap2.qa(accountId, '', 0).catch(() => null)])
    const items = qa?.success && Array.isArray(qa.data) && qa.data.every((row) => row && typeof row.status === 'string') ? qa.data : null
    const countOf = (status: string) => items ? items.filter((row) => row.status === status).length : null
    return { success: true, data: { mode: res.data.mode, suspendedReason: null, publishedQaCount: countOf('published'), draftQaCount: countOf('draft'), version: res.data.version, autoReplyAvailable: res.data.autoReplyAvailable } }
  },
  saveSettings: async (accountId: string, input: { mode: AiMode; expectedVersion: number; reason?: string }, _stepUpToken?: string): Promise<Result<AiSettings>> => {
    if (input.mode === 'auto_qa') throw new Error('自動で答えるは、まだ使えません')
    await gap2.saveSettings(accountId, { mode: input.mode, expectedVersion: input.expectedVersion, confirmed: true, ...(input.reason ? { reason: input.reason } : {}) })
    return aiReplyApi.settings(accountId)
  },
  test: (accountId: string, question: string) => fetchApi<Result<AiTestResult>>(account('/api/ai-settings/test', accountId), json('POST', { question })),
  summary: (chatId: string, _refresh?: boolean) => gap2.summary(chatId) as Promise<Result<ChatSummary>>,
  draft: (chatId: string) => gap2.draft(chatId) as Promise<Result<ChatDraft>>,
  listQa: async (accountId: string, query: { q?: string; status?: QaStatus | ''; page: number; limit: number }): Promise<Result<QaPage>> => {
    /* 口は 20 件ずつ（offset）。状態の絞り込みは画面で行う。 */
    const res = await gap2.qa(accountId, query.q ?? '', (query.page - 1) * query.limit)
    const items = res.data.map(toQa).filter((row) => !query.status || row.status === query.status)
    return { success: true, data: { items, total: query.status ? items.length : res.total } }
  },
  createQa: async (accountId: string, input: { questions: string[]; answerText: string }): Promise<Result<QaEntry>> => {
    const res = await gap2.createQa(accountId, write(input), key())
    return { success: true, data: toQa(res.data) }
  },
  updateQa: async (accountId: string, id: string, input: { questions: string[]; answerText: string; expectedVersion: number }): Promise<Result<QaEntry>> => {
    const res = await gap2.saveQa(accountId, id, { ...write(input), expectedVersion: input.expectedVersion })
    return { success: true, data: { id, questions: input.questions, answerText: input.answerText, status: res.data.status, source: 'manual', useCount: 0, version: res.data.version, updatedAt: new Date().toISOString() } }
  },
  publishQa: (accountId: string, id: string, expectedVersion: number) => gap2.publishQa(accountId, id, expectedVersion),
  stopQa: (accountId: string, id: string, expectedVersion: number) => gap2.stopQa(accountId, id, expectedVersion),
  deleteQa: (accountId: string, id: string, expectedVersion: number) => gap2.archiveQa(accountId, id, expectedVersion),
  importQa: (accountId: string, input: { kind: 'web'; url: string }) => fetchApi<Result<{ jobId: string }>>(account('/api/qa-entries/import', accountId), json('POST', input)),
  logs: (accountId: string, query: { action?: AnswerAction | ''; days: number; page: number; limit: number }) => {
    const q = new URLSearchParams({ days: String(query.days), page: String(query.page), limit: String(query.limit) })
    if (query.action) q.set('action', query.action)
    return fetchApi<Result<AiAnswerLogPage>>(account(`/api/ai-answer-logs?${q}`, accountId))
  },
  log: (accountId: string, id: string) => fetchApi<Result<AiAnswerLogDetail>>(account(`/api/ai-answer-logs/${e(id)}`, accountId)),
}
