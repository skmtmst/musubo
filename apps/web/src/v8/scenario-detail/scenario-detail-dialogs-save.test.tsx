// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScenarioWithSteps, StepFormState } from './detail-model'

const mocks = vi.hoisted(() => ({
  updateScenario: vi.fn(),
  loadScenario: vi.fn(),
  setAudienceOpen: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      scenarios: {
        ...actual.api.scenarios,
        update: (...args: unknown[]) => mocks.updateScenario(...args),
      },
    },
  }
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', accounts: [] }),
}))

vi.mock('@/components/scenarios/scenario-reference-data', () => ({
  scenarioReferenceData: {
    load: vi.fn(async () => ({ tags: [], fields: [], marks: [], scenarios: [], forms: [] })),
  },
}))

vi.mock('@/components/shared/condition-builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/condition-builder')>()
  return {
    ...actual,
    default: () => <div data-testid="condition-builder" />,
  }
})

import { ScenarioDetailDialogs } from './scenario-detail-dialogs'

const SCENARIO: ScenarioWithSteps = {
  id: 'sc-1',
  lineAccountId: 'acc-1',
  name: '体験シナリオ',
  description: '',
  triggerType: 'manual',
  isActive: false,
  allowConcurrent: true,
  folderId: null,
  audienceCondition: null,
  onCompleteMode: 'pause',
  onCompleteScenarioId: null,
  steps: [],
} as unknown as ScenarioWithSteps

const STEP_FORM: StepFormState = {
  stepOrder: 1,
  delayDays: 0,
  delayHours: 0,
  delayMinutes: 0,
  sendAtTime: '',
  messageType: 'text',
  messageContent: '',
  templateId: '',
  targetCondition: null,
  question: null,
} as unknown as StepFormState

beforeEach(() => {
  mocks.updateScenario.mockReset()
  mocks.loadScenario.mockReset().mockResolvedValue(undefined)
  mocks.setAudienceOpen.mockReset()
})

afterEach(cleanup)

describe('ScenarioDetailDialogs の配信対象保存失敗ガード', () => {
  it('対象の絞り込み保存で API が success:false を返したら窓を閉じずエラーを出す', async () => {
    mocks.updateScenario.mockResolvedValueOnce({ success: false, error: '保存できませんでした' })

    render(
      <ScenarioDetailDialogs
        renameOpen={false}
        saving={false}
        scenario={SCENARIO}
        setEditForm={() => {}}
        setRenameOpen={() => {}}
        handleSaveScenario={async () => {}}
        editForm={{ name: '体験シナリオ', description: '', triggerType: 'manual', isActive: false, allowConcurrent: true, folderId: '' }}
        folderState="ready"
        folders={[]}
        canEdit={true}
        setFolders={() => {}}
        editFolderMissing={false}
        compareOpen={false}
        setCompareOpen={() => {}}
        acceptLatestAndContinue={async () => {}}
        latestSummary=""
        currentSummary=""
        leaveTarget={null}
        confirmLeave={() => {}}
        cancelLeave={() => {}}
        startOpen={false}
        startBusy={false}
        startError=""
        preflightLoading={false}
        preflightFailed={false}
        handleStart={async () => {}}
        startConfirmed={false}
        setStartOpen={() => {}}
        setStartError={() => {}}
        startAccountLabel="Aアカウント"
        triggerHeadline="手動"
        simulation={null}
        sortedSteps={[]}
        startCompleteSummary="一時停止"
        setSimRetry={() => {}}
        startChecks={[]}
        setStartConfirmed={() => {}}
        stopOpen={false}
        stopBusy={false}
        stopError=""
        setStopOpen={() => {}}
        setStopError={() => {}}
        stats={null}
        handleStop={async () => {}}
        duplicateOpen={false}
        duplicating={false}
        setDuplicateOpen={() => {}}
        duplicateName=""
        setDuplicateName={() => {}}
        modeLabel="時間経過"
        handleDuplicate={async () => {}}
        previewOpen={false}
        id="sc-1"
        setPreviewOpen={() => {}}
        deleteStepTarget={null}
        deletingStepId={null}
        deleteStepError=""
        handleDeleteStep={async () => {}}
        setDeleteStepTarget={() => {}}
        setDeleteStepError={() => {}}
        deleteScenarioOpen={false}
        deletingScenario={false}
        deleteScenarioError=""
        handleDeleteScenario={async () => {}}
        setDeleteScenarioOpen={() => {}}
        setDeleteScenarioError={() => {}}
        discardDuplicateOpen={false}
        duplicateRemainder={null}
        discardingDuplicate={false}
        discardDuplicateError=""
        handleDiscardDuplicate={async () => {}}
        setDiscardDuplicateOpen={() => {}}
        setDiscardDuplicateError={() => {}}
        audienceOpen={true}
        loadScenario={mocks.loadScenario}
        setAudienceOpen={mocks.setAudienceOpen}
        onCompleteOpen={false}
        setOnCompleteOpen={() => {}}
        actionCounts={{}}
        setActionTarget={() => {}}
        stepTargetOpen={false}
        stepForm={STEP_FORM}
        setStepForm={() => {}}
        setStepTargetOpen={() => {}}
        canTestSend={false}
        testSend={null}
        deliveryMode="elapsed"
        templates={[]}
        setTestSend={() => {}}
        triggerOpen={false}
        setTriggerOpen={() => {}}
        setTriggerCount={() => {}}
        setTriggerRevision={() => {}}
        actionTarget={null}
        reloadActionCounts={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'この条件を反映' }))

    await waitFor(() => expect(mocks.updateScenario).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/条件を保存できませんでした/)).toBeTruthy()
    expect(mocks.setAudienceOpen).not.toHaveBeenCalled()
    expect(mocks.loadScenario).not.toHaveBeenCalled()
  })
})
