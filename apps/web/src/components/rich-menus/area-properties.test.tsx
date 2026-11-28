
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AreaProperties } from './area-properties'
import type { Area } from './area-types'
// @vitest-environment happy-dom
// : メニュー→選ぶ窓→確定。取消では保存値を変えない。

afterEach(() => cleanup())

const TAGS = [
  { id: 'tag-1', name: 'NEN会員' },
  { id: 'tag-2', name: '定期便' },
  { id: 'tag-3', name: '定期便提案対象' },
  { id: 'tag-4', name: 'ギフト' },
]

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [area, setArea] = useState<Area>({
    id: 'area-a',
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: 'message',
    actionData: { text: '予約する' },
    intent: 'text',
    label: '予約する',
    tagIds: initial,
  })
  const onUpdate = vi.fn((patch: Partial<Area>) => setArea((prev) => ({ ...prev, ...patch })))
  return (
    <>
      <AreaProperties
        area={area}
        pages={[]}
        tags={TAGS}
        templates={[]}
        forms={[]}
        trackedLinks={[]}
        taps={null}
        onUpdate={onUpdate}
        showManagementDetails={false}
      />
      <span data-testid="tag-ids">{(area.tagIds ?? []).join(',')}</span>
    </>
  )
}

function openTags() {
  fireEvent.click(screen.getByRole('button', { name: '行うことを足す' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /タグを付ける/ }))
  return screen.getByRole('dialog', { name: 'タグを選ぶ' })
}

describe('ボタンのタグ選び（・R19/R20）', () => {
  it('打つと候補が絞り込める', async () => {
    render(<Harness />)
    const dialog = openTags()
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '定期' } })
    await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: 'NEN会員' })).toBeNull())
    expect(within(dialog).getByRole('checkbox', { name: '定期便' })).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: '定期便提案対象' })).toBeTruthy()
  })
  it('まとまりの読み上げ名の入れ子がなく、各項目は個別の名前だけ', () => {
    render(<Harness />)
    const dialog = openTags()
    expect(dialog.querySelectorAll('label label')).toHaveLength(0)
    expect(within(dialog).getByRole('checkbox', { name: 'NEN会員' })).toBeTruthy()
    expect(within(dialog).getByRole('checkbox', { name: 'ギフト' })).toBeTruthy()
  })
  it('設定済みの行からタグを外せる', () => {
    render(<Harness initial={['tag-1']} />)
    fireEvent.click(screen.getByRole('button', { name: 'NEN会員' }))
    fireEvent.click(screen.getByRole('button', { name: 'タグを付ける：変更する' }))
    const dialog = screen.getByRole('dialog', { name: 'タグを選ぶ' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'NEN会員' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する（0件）' }))
    expect(screen.getByTestId('tag-ids').textContent).toBe('')
  })
  it('確定まで保存値を変えず、取消しても空の行を作らない', () => {
    render(<Harness />)
    let dialog = openTags()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ギフト' }))
    expect(screen.getByTestId('tag-ids').textContent).toBe('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('button', { name: 'ギフト' })).toBeNull()
    dialog = openTags()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ギフト' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
    expect(screen.getByTestId('tag-ids').textContent).toBe('tag-4')
  })
})

function IntentHarness({ intent }: { intent: 'datetime' | 'clipboard' }) {
  const [area, setArea] = useState<Area>({
    id: 'area-b',
    boundsX: 0,
    boundsY: 0,
    boundsWidth: 100,
    boundsHeight: 100,
    actionType: intent === 'datetime' ? 'datetimepicker' : 'clipboard',
    actionData: intent === 'datetime' ? { mode: 'date' } : { text: '' },
    intent,
    label: intent === 'datetime' ? '日時を選ぶ' : 'コピーする',
  })
  const onUpdate = vi.fn((patch: Partial<Area>) => setArea((prev) => ({ ...prev, ...patch })))
  return (
    <AreaProperties
      area={area}
      pages={[]}
      tags={[]}
      templates={[]}
      forms={[]}
      trackedLinks={[]}
      taps={null}
      onUpdate={onUpdate}
      showManagementDetails={false}
    />
  )
}

describe('日時を選ぶ・文字をコピーするボタン（O）', () => {
  it('日時の種類とはじめの値を入れられる', () => {
    render(<IntentHarness intent="datetime" />)
    expect(screen.getByLabelText('日時の種類')).toBeTruthy()
    expect(screen.getByPlaceholderText('例：2026-10-01')).toBeTruthy()
  })

  it('コピーする文字を入れられる', () => {
    render(<IntentHarness intent="clipboard" />)
    expect(screen.getByPlaceholderText('例：合言葉は「さくら」')).toBeTruthy()
  })

  it('種類の選択肢に日時・コピーが増えている', () => {
    render(<Harness />)
    const group = screen.getByRole('group', { name: '押したときの動き' })
    expect(within(group).getByRole('radio', { name: '日時を選ぶ' })).toBeTruthy()
    expect(within(group).getByRole('radio', { name: '文字をコピーする' })).toBeTruthy()
  })
})
