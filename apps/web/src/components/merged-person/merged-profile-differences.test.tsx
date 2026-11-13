// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MergedProfileDialog, { emptyProfileCandidateDraft } from './merged-profile-dialog'
import { sameKnownValues } from '@/components/shared/differences-filter'
import type { FriendProfileCandidate } from '@/lib/api'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const candidates: FriendProfileCandidate[] = [
  { fieldKey: 'name', fieldLabel: '本名', options: ['見本 171', '見本 161'].map((valuePreview, i) => ({ candidateId: `n${i}`, sourceFriendId: `f${i}`, sourceLabel: `候補${i}`, valuePreview, verified: true })) },
  { fieldKey: 'plan', fieldLabel: '会員区分', options: ['一般', '一般'].map((valuePreview, i) => ({ candidateId: `p${i}`, sourceFriendId: `f${i}`, sourceLabel: `候補${i}`, valuePreview, verified: true })) },
]
afterEach(cleanup)
it('一致・不明・マスク済みの値を区別する', () => {
  expect(sameKnownValues(['同じ', '同じ'])).toBe(true)
  for (const values of [[null, null], ['a***', 'a***'], ['同じ'], ['a', 'b']]) expect(sameKnownValues(values)).toBe(false)
})
it('一致項目を必要なときに開き、選択を残したまま同じ保存口へ渡す', () => {
  const saved = vi.fn()
  function View() {
    const [draft, setDraft] = useState(emptyProfileCandidateDraft(candidates))
    return <MergedProfileDialog open candidates={candidates} sourceLabels={{ f0: '本店・見本 171', f1: '支店・見本 161' }} draft={draft} revision={1} busy={false} onChange={setDraft} onCancel={() => {}} onSave={() => saved(draft)} />
  }
  render(<View />)
  expect(screen.getByRole('switch', { name: '違う項目だけ' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.queryByLabelText('会員区分の採用値')).toBeNull()
  fireEvent.click(screen.getByRole('switch', { name: '違う項目だけ' }))
  fireEvent.click(screen.getByRole('button', { name: '会員区分の採用値' }))
  fireEvent.click(screen.getByRole('option', { name: '支店・見本 161：一般' }).querySelector('button')!)
  fireEvent.click(screen.getByRole('switch', { name: '違う項目だけ' }))
  expect(screen.queryByLabelText('会員区分の採用値')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '選んだ1項目を保存' }))
  expect(saved.mock.calls[0][0].plan).toEqual({ optionIndex: '1', updateMode: 'fixed' })
})

it('保存失敗では一致項目も開き、選択を直せる', () => {
  const props = { open: true, candidates, draft: emptyProfileCandidateDraft(candidates), revision: 1, busy: false, onChange: vi.fn(), onCancel: vi.fn(), onSave: vi.fn() }
  const { rerender } = render(<MergedProfileDialog {...props} />)
  expect(screen.queryByLabelText('会員区分の採用値')).toBeNull()
  rerender(<MergedProfileDialog {...props} error="先に別の人が変更しました。値を確かめてください。" />)
  expect(screen.getByLabelText('会員区分の採用値')).toBeTruthy()
})
