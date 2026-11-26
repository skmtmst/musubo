// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqAutoReplyEditor from './auto-reply-editor'
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
afterEach(cleanup)
function Harness() {
  const [name, setName] = useState('')
  const [settings, setSettings] = useState<Record<string, unknown>>({ name: '', keyword: '', responseType: 'text', responseContent: '' })
  return <HqAutoReplyEditor title="自動応答のひな形" help="説明" notice={null} canEdit busy={false} name={name} description="" settings={settings}
    onName={setName} onDescription={() => {}} onSetting={(key, value) => setSettings(current => ({ ...current, [key]: value }))} onCancel={() => {}} onSave={vi.fn()} />
}
it('必須項目が足りない理由を示し、各入力後に次へ進める', () => {
  render(<Harness />)
  const next = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
  const basic = next('次へ：どんなときに動くか')
  expect(basic.disabled).toBe(true)
  expect(screen.getByText('統括での名前と店に届く名前を入力してください。')).toBeTruthy()
  expect(screen.getByText('統括での名前を入力してください。')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /統括での名前/ }), { target: { value: '見本の応答' } })
  fireEvent.change(screen.getByRole('textbox', { name: /店に届く名前/ }), { target: { value: '見本の返事' } })
  expect(basic.disabled).toBe(false)
  fireEvent.click(basic)
  const trigger = next('次へ：何を返すか')
  expect(trigger.disabled).toBe(true)
  expect(screen.getByText('キーワードを入力してください。')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /キーワード/ }), { target: { value: '予約' } })
  fireEvent.click(trigger)
  const reply = next('次へ：確認')
  expect(reply.disabled).toBe(true)
  expect(screen.getByText('返信する内容を入力してください。')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /返信内容/ }), { target: { value: '見本の返事です' } })
  expect(reply.disabled).toBe(false)
  fireEvent.click(reply)
  expect(screen.getByText('保存すると、配るアカウントを選べます。店には下書きとして届きます。')).toBeTruthy()
})
