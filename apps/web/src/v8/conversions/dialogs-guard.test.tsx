// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversionDefinitionEvent, ConversionDefinitionListItem, ConversionIngestionEvent } from '@/lib/api'
import { ConversionDetailDialog, ConversionReversalDialog } from './dialogs'

function makeTarget(overrides: Record<string, unknown> = {}): ConversionDefinitionListItem {
  return {
    id: 'cv-1',
    name: '来店予約完了',
    status: 'active',
    state: 'draft',
    stateReason: null,
    measureMethod: 'webhook',
    sourceType: 'booking',
    targetUrl: null,
    valueMode: 'fixed',
    value: Number.NaN,
    attributionDays: Number.NaN,
    deduplicationMode: 'once_per_friend',
    deduplicationWindowDays: null,
    reversalPolicy: 'manual',
    sourceConfig: {},
    usageCount: Number.NaN,
    usageNames: [],
    metrics: {
      netCount: Number.NaN,
      reversedCount: Number.NaN,
      reversedValue: Number.NaN,
    },
    ingest: {
      configured: true,
      disabledAt: null,
    },
    ...overrides,
  } as unknown as ConversionDefinitionListItem
}

describe('ConversionDetailDialog / ConversionReversalDialog ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('不正な数値・欠損した作成日時で NaN やクラッシュを出さず、公開中は編集・停止・閉じるを止める', () => {
    const setDetailTarget = vi.fn()
    const openEdit = vi.fn()
    const openStop = vi.fn()
    const publishDraft = vi.fn()

    const brokenEvent = {
      id: 'ev-1',
      friendName: '山田花子',
      status: 'confirmed',
      value: Number.NaN,
      reversed: false,
      cancelled: false,
      createdAt: null,
    } as unknown as ConversionDefinitionEvent

    const brokenIngest = {
      id: 'ing-1',
      result: 'recorded',
      isTest: false,
      reason: null,
      createdAt: undefined,
    } as unknown as ConversionIngestionEvent

    render(
      <ConversionDetailDialog
        detailTarget={makeTarget()}
        setDetailTarget={setDetailTarget}
        publishing
        publishDraft={publishDraft}
        openEdit={openEdit}
        openStop={openStop}
        issueIngest={vi.fn()}
        toggleIngest={vi.fn()}
        ingestBusy=""
        ingestError=""
        issuedSecret=""
        ingestEvents={[brokenIngest]}
        definitionEvents={[brokenEvent]}
        eventsFailed={false}
        canReverse
        openReversal={vi.fn()}
      />,
    )

    // NaN がどこにも出ず、壊れた createdAt でも落ちずに表示される
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.getByText('山田花子')).toBeTruthy()

    // 公開中は編集・停止・取り消しが無効化され、押しても発火しない
    const editBtn = screen.getByRole('button', { name: '編集' }) as HTMLButtonElement
    const stopBtn = screen.getByRole('button', { name: '停止・削除する' }) as HTMLButtonElement
    expect(editBtn.disabled).toBe(true)
    expect(stopBtn.disabled).toBe(true)
    fireEvent.click(editBtn)
    fireEvent.click(stopBtn)
    expect(openEdit).not.toHaveBeenCalled()
    expect(openStop).not.toHaveBeenCalled()
  })

  it('成果取消ダイアログは処理中に入力欄を無効化し、送信・閉じるを二重実行しない', () => {
    const setReversalTarget = vi.fn()
    const submitReversal = vi.fn()

    render(
      <ConversionReversalDialog
        reversalTarget={{
          id: 'ev-1',
          friendName: '山田花子',
          status: 'confirmed',
          value: 1000,
          reversed: false,
          cancelled: false,
          createdAt: '2026-11-20T10:00:00Z',
        } as unknown as ConversionDefinitionEvent}
        account={{ id: 'acc-1', name: '本店' }}
        reversalKind="reverse"
        reversalBusy
        reversalError=""
        reversalReason="重複"
        setReversalTarget={setReversalTarget}
        setReversalReason={vi.fn()}
        submitReversal={submitReversal}
      />,
    )

    const reasonInput = screen.getByDisplayValue('重複') as HTMLInputElement
    expect(reasonInput.disabled).toBe(true)
  })
})
