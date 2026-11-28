// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoReplyDraftInput } from '@line-crm/shared'
import { buildWizardInput } from './wizard-input'
import { formFromSettings, type WizardForm } from './wizard-model'
import { WizardTriggerStep } from './wizard-trigger-step'

function baseSettings(receiveSources: unknown): AutoReplyDraftInput {
  return {
    name: 'テスト',
    respondToAll: false,
    keyword: '予約',
    matchType: 'contains',
    keywords: null,
    responseType: 'text',
    templateId: null,
    responseContent: '承りました',
    responseWeekdays: [1],
    messageKinds: null,
    replyDelaySeconds: 0,
    cooldownMinutes: null,
    receiveSources,
    priority: 0,
    actions: [],
  } as unknown as AutoReplyDraftInput
}

function Harness({
  initialSources,
  onSave,
}: {
  initialSources: unknown
  onSave: (payload: AutoReplyDraftInput) => void
}) {
  const [form, setForm] = useState<WizardForm>(() => formFromSettings(baseSettings(initialSources)))
  const [weekdayNotice, setWeekdayNotice] = useState('')
  const [issue, setIssue] = useState<string | null>(null)
  const patch = (part: Partial<WizardForm>) => setForm((prev) => ({ ...prev, ...part }))
  const handleSave = () => {
    const built = buildWizardInput({
      accounts: [],
      form,
      matchedAccountId: 'acc-1',
      selectedAccountId: 'acc-1',
      templates: [],
    })
    if ('error' in built) {
      setIssue(built.error)
      return
    }
    setIssue(null)
    onSave(built)
  }
  return (
    <div>
      <WizardTriggerStep
        effectiveKeywords={form.keywordRules.filter((r) => r.keyword.trim() !== '')}
        fieldError={() => undefined}
        form={form}
        moreKindsButton={null}
        narrow={false}
        patch={patch}
        setWeekdayNotice={setWeekdayNotice}
        showMoreKinds={false}
        weekdayNotice={weekdayNotice}
      />
      <button type="button" onClick={handleSave}>
        保存する
      </button>
      {issue ? <p role="alert">{issue}</p> : null}
    </div>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('auto-replies/edit/wizard-trigger-step 受信元チェック操作ガード', () => {
  it('未知の受信元を含む設定でメールのチェックを外しても未知値が消えず、保存は呼ばれず LINE に変わらない', () => {
    const onSave = vi.fn()
    render(<Harness initialSources={['unknown', 'email']} onSave={onSave} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'メール' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('受信元を確認できません。選び直してください')

    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].receiveSources).toEqual(['line'])
  })

  it('既知の受信元をすべて外して空にした場合は勝手に line へ置き換えず保存を止め、選び直せば保存できる', () => {
    const onSave = vi.fn()
    render(<Harness initialSources={['line']} onSave={onSave} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'LINE' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('受信元を1つ以上選んでください')

    fireEvent.click(screen.getByRole('checkbox', { name: 'メール' }))
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].receiveSources).toEqual(['email'])
  })
})
