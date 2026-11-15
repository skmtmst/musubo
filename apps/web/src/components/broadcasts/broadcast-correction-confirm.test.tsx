// @vitest-environment happy-dom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { renderBroadcastConfirmDialogs } from './broadcast-confirm-dialogs'

afterEach(cleanup)
it('訂正の予約は共通の確認窓に台帳人数と1人運用の入力欄を表示し、一致するまで確定しない', () => {
 const props = {
  correction:true, approvalCountInput:'', setApprovalCountInput:vi.fn(), confirmOpen:true, currentStep:null,
  leaveTarget:null, conditionDialogOpen:false, preflightDialogOpen:false, needsApproval:true, needsApprovalSingle:true,
  approvalConfig:{threshold:1,singleOperator:true}, approvalConfigState:'ready', canConfirm:true, confirmationBlocked:false,
  confirmationFields:null, preflightChecks:[], approvalCandidates:[], approvalCandidatesState:'ready', approvalNote:'', approverId:'',
  audienceCount:10, broadcastRole:'owner', bubbles:[], canSendBroadcast:true, concurrentBroadcasts:[], conditionDraft:null,
  confirmAudienceLabel:'元の配信を送れた人', error:'', exclusionNote:null, quota:null, quotaInsufficient:false, quotaNote:null,
  scheduledDate:'2099-01-01', scheduledTime:'10:00', sendMode:'scheduled', sendWhenLabel:'2099年1月1日 10:00',
  sendPreview:{state:'ready',data:{recipients:10,excluded:{blocked:0,optedOut:0,duplicate:0,hidden:0,missingDestination:0},expectedVersion:3,firstText:'本文',sender:null,quietHoursShiftTo:null}},
  saving:false, targetMode:'all', title:'訂正',
  cancelLeave:vi.fn(),confirmLeave:vi.fn(),confirmMessage:vi.fn(),goToStep:vi.fn(),runPreflight:vi.fn(),save:vi.fn(),saveDraftNow:vi.fn(),
  setApprovalNote:vi.fn(),setApproverId:vi.fn(),setCondition:vi.fn(),setConditionDialogOpen:vi.fn(),setConditionDraft:vi.fn(),setConfirmOpen:vi.fn(),setPreflightDialogOpen:vi.fn(),setPreviewSeq:vi.fn(),
 }
 const element=(value:string)=>renderBroadcastConfirmDialogs({...props,approvalCountInput:value} as never)
 const view=render(element(''))
 expect(screen.getByLabelText('人数を入れる')).toBeTruthy()
 expect((screen.getByRole('button',{name:/10 人に.*予約する/}) as HTMLButtonElement).disabled).toBe(true)
 view.rerender(element('10'))
 expect((screen.getByRole('button',{name:/10 人に.*予約する/}) as HTMLButtonElement).disabled).toBe(false)
})
