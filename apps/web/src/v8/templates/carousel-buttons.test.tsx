// @vitest-environment happy-dom
import { useState } from 'react'
import { Zap } from 'lucide-react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFormErrors } from '@/lib/use-form-errors'
import type { Panel } from './carousel-core'

vi.mock('@/components/auto-replies/inline-action-list', () => ({ default: ({ actions, onChange }: { actions: unknown[]; onChange: (value: unknown[]) => void }) => <button onClick={() => onChange([...actions, { key: 'two', actionType: 'tag', config: { op: 'add', tagIds: ['t2'] } }])}>次の処理を追加する</button> }))
import CarouselButtons from './carousel-buttons'

const options = { tags: [{ id: 't1', name: '購入済み' }, { id: 't2', name: '連絡済み' }], fields: [], marks: [], scenarios: [], vars: [] }
function Harness({ host = false }) {
  const [actions, onChange] = useState<Panel['actions']>([{ label: '詳しく見る', kind: 'action', uri: '', text: '', formId: '', actions: [{ key: 'one', actionType: 'tag', config: { op: 'add', tagIds: ['t1'] } }] }])
  const fields = useFormErrors()
  return <><output data-testid="value">{JSON.stringify(actions)}</output><CarouselButtons actions={actions} onChange={onChange} selectedIndex={0} fields={fields} host={host} hqHost={false} folderAccountId="a1" liffId="l1" sources={{}} actionOptions={options} kindOptions={() => ['uri', 'action']} extraKinds={[{ value: 'action', label: '動きを実行する', icon: Zap }]} /></>
}
afterEach(cleanup)
it('動きは要約で表示し、開いた設定の変更を閉じても同じボタンへ保持する', () => {
  render(<Harness />)
  expect(screen.queryByRole('button', { name: '次の処理を追加する' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'カード1のボタン1の動きを変更する' }))
  fireEvent.click(screen.getByRole('button', { name: '次の処理を追加する' }))
  fireEvent.click(screen.getByRole('button', { name: '設定を閉じる' }))
  expect(screen.queryByRole('button', { name: '次の処理を追加する' })).toBeNull()
  expect(JSON.parse(screen.getByTestId('value').textContent!)[0].actions).toHaveLength(2)
  expect(screen.getByText('タグ「購入済み」を付ける ほか1')).toBeTruthy()
})
it('統括の本文では従来の2列と展開した編集欄を保持する', () => {
  const { container } = render(<Harness host />)
  expect(screen.getByRole('button', { name: '次の処理を追加する' })).toBeTruthy()
  expect(container.querySelector('[data-form-row="columns"]')?.children).toHaveLength(2)
  expect(container.querySelector('[data-tap-action-columns]')).toBeNull()
})
