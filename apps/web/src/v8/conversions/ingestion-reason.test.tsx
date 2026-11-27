// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversionDetailDialog, type ConversionDetailDialogProps } from './dialogs'

afterEach(cleanup)

it('受信履歴は未知の理由を共通の案内に変え、既知の理由は具体的に表示する', () => {
  const reasons = ['signature_mismatch', 'new_reason', 'constructor', 'toString', '__proto__']
  const props: ConversionDetailDialogProps = {
    detailTarget: { id: 'p', name: '問い合わせ', state: 'active', status: 'active', sourceType: 'manual', measureMethod: 'webhook', valueMode: 'none', value: null, reversalPolicy: 'manual', sourceConfig: {}, usageCount: 0, ingest: { configured: true, disabledAt: null }, metrics: { netCount: 0 }, deduplicationMode: 'every' } as ConversionDetailDialogProps['detailTarget'],
    setDetailTarget: vi.fn(), publishing: false, publishDraft: vi.fn(), openEdit: vi.fn(), openStop: vi.fn(), issueIngest: vi.fn(), toggleIngest: vi.fn(), ingestBusy: '', ingestError: '', issuedSecret: '',
    ingestEvents: reasons.map((reason, index) => ({ id: String(index), conversionPointId: 'p', result: 'rejected', reason, isTest: false, sourceEventId: null, friendId: null, payloadShape: null, signatureSha256: null, createdAt: '2026-11-26T00:00:00Z' })),
    definitionEvents: [], eventsFailed: false, canReverse: false, openReversal: vi.fn(),
  }
  render(<ConversionDetailDialog {...props} />)
  expect(screen.getByText(/署名が一致しませんでした/)).toBeTruthy()
  expect(screen.getAllByText(/理由は管理側の記録を確認してください/)).toHaveLength(4)
  expect(screen.queryByText(/function Object|\[object Object\]/)).toBeNull()
})
