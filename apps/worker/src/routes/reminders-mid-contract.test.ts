import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

/**
 * 通知ルールの入口を通し、応答状態と実効のある操作を確かめる。
 */

const dbMocks = vi.hoisted(() => ({
  getReminderById: vi.fn(),
  getRemindersByIds: vi.fn(),
  reorderReminders: vi.fn(),
  updateReminder: vi.fn(),
  createReminderStep: vi.fn(),
  saveReminderDraftVersion: vi.fn(),
  getReminderDraftVersion: vi.fn(),
}))

const accessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(),
}))

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  ...dbMocks,
}))

vi.mock('../services/account-access.js', () => accessMocks)

const { reminders } = await import('./reminders.js')

const baseSettings = {
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
}

const textStep = {
  stableStepId: 'step-1',
  offsetMinutes: -60,
  messageType: 'text',
  messageContent: '予約の1時間前です',
  offsetDays: null,
  sendAtTime: null,
  templateId: null,
  targetCondition: {},
  action: {},
}

function createApp(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const app = new Hono<any>()
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role, readOnly: false, tenantId: 'tenant-a' })
    // 型紙・タグ・情報欄の存在確認は実DB相当の最小の偽物で通す（見つかった扱い）。
    c.env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ id: 'template-1' }),
            all: async () => ({ results: [] }),
            run: async () => ({}),
          }),
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
  dbMocks.getReminderById.mockResolvedValue({
    id: 'reminder-1', line_account_id: 'account-1', trigger_type: 'booking',
  })
  dbMocks.getRemindersByIds.mockResolvedValue([
    { id: 'reminder-1', line_account_id: 'account-1' },
  ])
  dbMocks.reorderReminders.mockResolvedValue(undefined)
  dbMocks.updateReminder.mockResolvedValue(undefined)
  dbMocks.getReminderDraftVersion.mockResolvedValue(null)
  dbMocks.createReminderStep.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    id: 'step-9',
    reminder_id: input.reminderId,
    offset_minutes: input.offsetMinutes,
    message_type: input.messageType,
    message_content: input.messageContent,
    offset_days: input.offsetDays ?? null,
    send_at_time: input.sendAtTime ?? null,
    template_id: input.templateId ?? null,
    created_at: '2026-09-07T00:00:00.000Z',
  }))
  dbMocks.saveReminderDraftVersion.mockImplementation(async (_db: unknown, id: string) => ({
    reminder_id: id,
    id: 'version-2',
    version_number: 2,
    status: 'draft',
    settings_snapshot: '{}',
    last_test_status: null,
    last_tested_at: null,
    published_at: null,
  }))
})

describe('通知ステップの種類と本文を検証してから保存する', () => {
  const postStep = (body: unknown) => request('/api/reminders/reminder-1/steps', {
    method: 'POST', body: JSON.stringify(body),
  })

  it('下書き側にない種類はDBへ入れず400で止める', async () => {
    const response = await postStep({ offsetMinutes: 0, messageType: 'carrier-pigeon', messageContent: '本文' })
    expect(response.status).toBe(400)
    expect(dbMocks.createReminderStep).not.toHaveBeenCalled()
  })

  it('5000文字を超える本文はDBへ入れず400で止める', async () => {
    const response = await postStep({ offsetMinutes: 0, messageType: 'text', messageContent: 'あ'.repeat(5001) })
    expect(response.status).toBe(400)
    expect(dbMocks.createReminderStep).not.toHaveBeenCalled()
  })

  it('空白だけの本文は受け付けない', async () => {
    const response = await postStep({ offsetMinutes: 0, messageType: 'text', messageContent: '   ' })
    expect(response.status).toBe(400)
    expect(dbMocks.createReminderStep).not.toHaveBeenCalled()
  })

  it('5000文字ちょうどは通す', async () => {
    const response = await postStep({ offsetMinutes: 0, messageType: 'text', messageContent: 'あ'.repeat(5000) })
    expect(response.status).toBe(201)
    expect(dbMocks.createReminderStep).toHaveBeenCalled()
  })
})

describe('リマインドの並び替えは存在と操作権限を確認する', () => {
  const reorder = (ids: string[]) => request('/api/reminders/reorder', {
    method: 'PATCH', body: JSON.stringify({ ids }),
  })

  it('操作できないアカウントのidが混ざったら403にし、並べ替えない', async () => {
    dbMocks.getRemindersByIds.mockResolvedValue([
      { id: 'reminder-1', line_account_id: 'account-1' },
      { id: 'other-1', line_account_id: 'account-2' },
    ])
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false)
    const response = await reorder(['reminder-1', 'other-1'])
    expect(response.status).toBe(403)
    expect(dbMocks.reorderReminders).not.toHaveBeenCalled()
    expect(accessMocks.canAccessAllLineAccounts).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.arrayContaining(['account-1', 'account-2']),
    )
  })

  it('存在しないidが混ざったら404にし、並べ替えない', async () => {
    dbMocks.getRemindersByIds.mockResolvedValue([
      { id: 'reminder-1', line_account_id: 'account-1' },
    ])
    const response = await reorder(['reminder-1', 'ghost-1'])
    expect(response.status).toBe(404)
    expect(dbMocks.reorderReminders).not.toHaveBeenCalled()
  })

  it('自分のものだけなら並べ替える', async () => {
    const response = await reorder(['reminder-1'])
    expect(response.status).toBe(200)
    expect(dbMocks.reorderReminders).toHaveBeenCalledWith(expect.anything(), ['reminder-1'])
  })
})

describe('作成済みリマインドのきっかけの変更を拒否する', () => {
  const put = (body: unknown) => request('/api/reminders/reminder-1', {
    method: 'PUT', body: JSON.stringify(body),
  })

  it('triggerTypeを変えようとすると422で止め、保存しない', async () => {
    const response = await put({ triggerType: 'event' })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ success: false })
    expect(dbMocks.updateReminder).not.toHaveBeenCalled()
  })

  it('同じtriggerTypeの再送は通す（フォルダ移動などを壊さない）', async () => {
    dbMocks.getReminderById.mockResolvedValue({
      id: 'reminder-1', name: '予約前日', is_active: 1, line_account_id: 'account-1', trigger_type: 'booking',
    })
    const response = await put({ triggerType: 'booking', folderId: null })
    expect(response.status).toBe(200)
    expect(dbMocks.updateReminder).toHaveBeenCalled()
  })

  it('triggerTypeを送らない更新は従来どおり通す', async () => {
    const response = await put({ folderId: null })
    expect(response.status).toBe(200)
    expect(dbMocks.updateReminder).toHaveBeenCalled()
  })
})

describe('公開版のないリマインドは再開を拒否する', () => {
  const put = (body: unknown) => request('/api/reminders/reminder-1', {
    method: 'PUT', body: JSON.stringify(body),
  })

  it('公開版の無い再開は409で止め、文面で公開へ案内する', async () => {
    dbMocks.updateReminder.mockRejectedValue(new Error('REMINDER_NOT_PUBLISHED'))
    const response = await put({ isActive: true })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'まだ公開していない下書きは再開できません。先に公開してください',
    })
  })

  it('止める方は従来どおり通す', async () => {
    dbMocks.updateReminder.mockResolvedValue(undefined)
    dbMocks.getReminderById.mockResolvedValue({
      id: 'reminder-1', name: '予約前日', is_active: 0, line_account_id: 'account-1', trigger_type: 'booking',
    })
    const response = await put({ isActive: false })
    expect(response.status).toBe(200)
  })
})

describe('リマインドの下書きは型紙なしの空本文を拒否する', () => {
  const putDraft = (settings: unknown) => request('/api/reminders/reminder-1/draft', {
    method: 'PUT', body: JSON.stringify(settings),
  })

  it('型紙なしの空本文は422で止め、保存しない', async () => {
    const response = await putDraft({ ...baseSettings, steps: [{ ...textStep, messageContent: '  ' }] })
    expect(response.status).toBe(422)
    expect(dbMocks.saveReminderDraftVersion).not.toHaveBeenCalled()
  })

  it('5000文字超えも422で止める', async () => {
    const response = await putDraft({ ...baseSettings, steps: [{ ...textStep, messageContent: 'あ'.repeat(5001) }] })
    expect(response.status).toBe(422)
    expect(dbMocks.saveReminderDraftVersion).not.toHaveBeenCalled()
  })

  it('型紙付きの空本文は通す', async () => {
    const response = await putDraft({
      ...baseSettings,
      steps: [{ ...textStep, messageContent: '', templateId: 'template-1' }],
    })
    expect(response.status).toBe(200)
    expect(dbMocks.saveReminderDraftVersion).toHaveBeenCalled()
  })
})
