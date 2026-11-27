// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      templates: {
        ...actual.api.templates,
        create: mocks.create,
        update: mocks.update,
      },
    },
  }
})

import { saveTemplateEdit, templateUsageEntries, type TemplateSaveResult, type TemplateUsedBy } from './core'

function Harness({ usedBy }: { usedBy: TemplateUsedBy }) {
  const [result, setResult] = useState<TemplateSaveResult | null>(null)
  const entries = templateUsageEntries(usedBy)

  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          setResult(
            await saveTemplateEdit({
              templateId: null,
              templateStatus: 'idle',
              templateAccountId: null,
              selectedAccountId: 'acc-1',
              name: 'お知らせ',
              category: 'general',
              folderId: null,
              messageType: 'text',
              messageContent: 'こんにちは',
            }),
          )
        }}
      >
        保存する
      </button>
      {result && !result.ok ? <p role="alert">{result.error}</p> : null}
      <ul>
        {entries.map((entry) => (
          <li key={entry.key}>{entry.href ? <a href={entry.href}>{entry.label}</a> : entry.label}</li>
        ))}
      </ul>
    </div>
  )
}

const usedByFixture = {
  scenarioSteps: [{ stepId: 's1', scenarioId: 'sc/1&a=b', scenarioName: '来店後', stepOrder: 1 }],
  autoReplies: [{ id: 'ar#1?x=1', keyword: '予約' }],
  automations: [],
  reminderSteps: [{ stepId: 'r1', reminderId: 'rm 1&2', reminderName: '前日案内' }],
  reminderEnrollments: [{ enrollmentId: 'e1', reminderId: 'rm/2?z=9', reminderName: '当日案内', versionNumber: 1, enrollmentStatus: 'pending' }],
  richMenuAreas: [{ areaId: 'a1', groupId: 'rg/1#top', groupName: '通常メニュー', pageName: '1面' }],
  trackedLinks: [{ id: 'tl&1=2', name: 'チラシ' }],
} as unknown as TemplateUsedBy

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('テンプレート保存応答の失敗補完と利用先リンクIDエンコード', () => {
  it('空の失敗文や欠けたdataでも日本語エラーを返し、利用先リンクのIDをURLエンコードする', async () => {
    mocks.create
      .mockResolvedValueOnce({ success: false, error: '' })
      .mockResolvedValueOnce({ success: true, data: null })

    render(<Harness usedBy={usedByFixture} />)

    // 利用先リンクのIDがすべて encodeURIComponent されている
    expect(screen.getByRole('link', { name: /シナリオ「来店後」/ }).getAttribute('href')).toBe('/scenarios/detail?id=sc%2F1%26a%3Db')
    expect(screen.getByRole('link', { name: /自動応答「予約」/ }).getAttribute('href')).toBe('/auto-replies/edit?id=ar%231%3Fx%3D1')
    expect(screen.getByRole('link', { name: /リマインダ「前日案内」/ }).getAttribute('href')).toBe('/reminders/edit?id=rm%201%262')
    expect(screen.getByRole('link', { name: /リマインダ「当日案内」/ }).getAttribute('href')).toBe('/reminders/detail?id=rm%2F2%3Fz%3D9')
    expect(screen.getByRole('link', { name: /リッチメニュー「通常メニュー」/ }).getAttribute('href')).toBe('/rich-menus/edit?id=rg%2F1%23top')
    expect(screen.getByRole('link', { name: /流入リンク「チラシ」/ }).getAttribute('href')).toBe('/inflow-links/detail?id=tl%261%3D2')

    // success:false で error が空でも日本語の既定エラーを返す
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect((await screen.findByRole('alert')).textContent).toBe('保存できませんでした')

    // success:true でも data が欠けていたら安全にエラーを返す
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect((await screen.findByRole('alert')).textContent).toBe('保存結果を確認できませんでした')
  })
})
