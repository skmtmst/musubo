import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const dbMocks = vi.hoisted(() => ({
  getReminderById: vi.fn(),
  getReminderDraftVersion: vi.fn(),
  publishReminderDraftVersion: vi.fn(),
  recordReminderDraftTest: vi.fn(),
}))

const accessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(),
}))

const draftMocks = vi.hoisted(() => ({
  previewReminderDraft: vi.fn(),
  testReminderDraft: vi.fn(),
  validateReminderDraft: vi.fn(),
}))

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...dbMocks,
}))

vi.mock('../services/account-access.js', () => accessMocks)
vi.mock('../services/reminder-draft.js', () => draftMocks)

const { reminders } = await import('./reminders.js')

const settings = {
  name: '予約前のお知らせ',
  description: null,
  lineAccountId: 'account-1',
  triggerType: 'booking',
  deliveryMode: 'time',
  triggerFieldId: null,
  repeatYearly: false,
  triggerOffsetMinutes: null,
  sendAtTime: null,
  targetTagId: null,
  folderId: null,
  stopConditions: {
    bookingCancelled: true,
    supportMarkCompleted: false,
    daysAfterTarget: null,
    friendBlocked: true,
  },
  steps: [{
    stableStepId: 'step-1',
    offsetMinutes: -60,
    messageType: 'text',
    messageContent: '予約の1時間前です',
    offsetDays: null,
    sendAtTime: null,
    templateId: null,
    targetCondition: {},
    action: {},
  }],
} as const

const version = {
  id: 'version-1',
  reminder_id: 'reminder-1',
  version_number: 1,
  status: 'draft',
  settings_snapshot: JSON.stringify(settings),
  last_test_status: 'succeeded',
  last_tested_at: '2026-09-03T10:00:00.000Z',
  last_tested_by_staff_id: 'staff-1',
  published_at: null,
  published_by_staff_id: null,
  created_at: '2026-09-03T09:00:00.000Z',
  updated_at: '2026-09-03T10:00:00.000Z',
} as const

function createApp(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role, readOnly: false, tenantId: 'tenant-a' })
    c.env = {
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }),
        }),
      },
    }
    await next()
  })
  app.route('/', reminders)
  return app
}

function request(path: string, init?: RequestInit, role?: 'owner' | 'admin' | 'staff') {
  return createApp(role).request(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  accessMocks.canAccessAllLineAccounts.mockResolvedValue(true)
  dbMocks.getReminderById.mockResolvedValue({ id: 'reminder-1', line_account_id: 'account-1' })
  dbMocks.getReminderDraftVersion.mockResolvedValue(version)
  dbMocks.publishReminderDraftVersion.mockResolvedValue({
    ...version,
    status: 'published',
    published_at: '2026-09-03T11:00:00.000Z',
  })
  dbMocks.recordReminderDraftTest.mockResolvedValue(undefined)
  draftMocks.previewReminderDraft.mockResolvedValue({ targetDate: '2026-09-10T00:00:00.000Z', items: [] })
  draftMocks.testReminderDraft.mockResolvedValue({ sent: 1, recipientName: 'テスト担当', replayed: false })
  draftMocks.validateReminderDraft.mockResolvedValue({ valid: true, checks: [], audience: { matched: 1, excluded: 0 } })
})

describe('リマインダ下書きのAPI契約', () => {
  it('閲覧できないリマインダは下書きの存在も返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false)
    const response = await request('/api/reminders/reminder-1/draft')
    expect(response.status).toBe(404)
    expect(dbMocks.getReminderDraftVersion).not.toHaveBeenCalled()
  })

  it('下書きは版と設定を画面用の形で返す', async () => {
    const response = await request('/api/reminders/reminder-1/draft')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        reminderId: 'reminder-1',
        versionId: 'version-1',
        status: 'draft',
        settings: { lineAccountId: 'account-1' },
      },
    })
  })

  it('staffは下書きを見られるが、公開はできない', async () => {
    expect((await request('/api/reminders/reminder-1/draft', undefined, 'staff')).status).toBe(200)
    const publish = await request('/api/reminders/reminder-1/publish', { method: 'POST' }, 'staff')
    expect(publish.status).toBe(403)
    expect(dbMocks.publishReminderDraftVersion).not.toHaveBeenCalled()
  })

  it('予定確認は正しい基準日だけを下書きの計算へ渡す', async () => {
    const invalid = await request('/api/reminders/reminder-1/preview', {
      method: 'POST', body: JSON.stringify({ targetDate: 'not-a-date' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: '基準日が正しくありません' })
    expect(draftMocks.previewReminderDraft).not.toHaveBeenCalled()

    const response = await request('/api/reminders/reminder-1/preview', {
      method: 'POST', body: JSON.stringify({ targetDate: '2026-09-10T00:00:00.000Z' }),
    })
    expect(response.status).toBe(200)
    expect(draftMocks.previewReminderDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'account-1' }),
      new Date('2026-09-10T00:00:00.000Z'),
    )
  })

  it('基準日の省略と null は固定した現在から7日後を使う', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-03T10:00:00.000Z'))
    try {
      for (const body of [{}, { targetDate: null }]) {
        draftMocks.previewReminderDraft.mockClear()
        const response = await request('/api/reminders/reminder-1/preview', {
          method: 'POST', body: JSON.stringify(body),
        })
        expect(response.status).toBe(200)
        expect(draftMocks.previewReminderDraft).toHaveBeenCalledWith(
          expect.anything(), expect.objectContaining({ lineAccountId: 'account-1' }),
          new Date('2026-09-10T10:00:00.000Z'),
        )
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('テスト送信は冪等キーを必須にし、結果を版へ記録する', async () => {
    const missingKey = await request('/api/reminders/reminder-1/test-send', { method: 'POST' })
    expect(missingKey.status).toBe(400)
    expect(draftMocks.testReminderDraft).not.toHaveBeenCalled()

    const response = await request('/api/reminders/reminder-1/test-send', {
      method: 'POST',
      headers: { 'Idempotency-Key': '123e4567-e89b-42d3-a456-426614174000' },
    })
    expect(response.status).toBe(200)
    expect(draftMocks.testReminderDraft).toHaveBeenCalledWith(
      expect.anything(),
      version,
      expect.objectContaining({ lineAccountId: 'account-1' }),
      '123e4567-e89b-42d3-a456-426614174000',
      // REMINDER-12: 操作者を渡し、本人宛てと登録宛先を区別する。
      { staffId: 'staff-1' },
    )
    expect(dbMocks.recordReminderDraftTest).toHaveBeenCalledWith(
      expect.anything(),
      'version-1',
      { succeeded: true, staffId: 'staff-1' },
    )
  })

  it('公開前確認が失敗した下書きは公開しない', async () => {
    draftMocks.validateReminderDraft.mockResolvedValueOnce({
      valid: false,
      checks: [{ key: 'test_send', status: 'failed' }],
      audience: { matched: 1, excluded: 0 },
    })
    const rejected = await request('/api/reminders/reminder-1/publish', { method: 'POST' })
    expect(rejected.status).toBe(422)
    expect(dbMocks.publishReminderDraftVersion).not.toHaveBeenCalled()

    const accepted = await request('/api/reminders/reminder-1/publish', { method: 'POST' })
    expect(accepted.status).toBe(200)
    expect(dbMocks.publishReminderDraftVersion).toHaveBeenCalledWith(
      expect.anything(),
      'reminder-1',
      'staff-1',
    )
  })
})
