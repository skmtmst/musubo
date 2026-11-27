'use client'

import { readLineImageContent } from '@/lib/line-image-content'

import type { AccountWithStats } from '@/contexts/account-context';


import {
MESSAGE_KIND_WORDS
} from '@/v8/auto-replies/auto-reply-words';
import {
exactAllMismatchNotice,
toActionPayload,
toKeywordPayload
} from '@/components/auto-replies/draft-fields';
import { findConditionDraftIssue } from '@/lib/segment-condition';
import type {
AutoReplyDraftInput
} from '@line-crm/shared';
import { validateFlexContent } from '@line-crm/shared';
import { InputIssue,WizardForm,isKnownReceiveSource } from './wizard-model';

type BuildWizardInputContext = {
  accounts: AccountWithStats[]
  form: WizardForm
  matchedAccountId: string | null
  selectedAccountId: string | null
  templates: { id: string; name: string; messageType: string; messageContent: string; folderId?: string | null; updatedAt?: string; }[]
}

export function buildWizardInput({ accounts, form, matchedAccountId, selectedAccountId, templates }: BuildWizardInputContext): AutoReplyDraftInput | InputIssue {
    const effectiveRules = form.keywordRules.filter((rule) => rule.keyword.trim() !== '')
    const firstKeyword = effectiveRules[0]?.keyword.trim() ?? ''
    if (!form.respondToAll && !firstKeyword) {
      return { error: '反応する言葉を入れてください', field: 'wiz-keywords', step: 'trigger' }
    }
    const mismatchNotice = exactAllMismatchNotice(effectiveRules, form.keywordMatchMode)
    if (mismatchNotice) return { error: mismatchNotice, field: 'wiz-keywords', step: 'trigger' }
    if (!Array.isArray(form.receiveSources) || form.receiveSources.some((source) => !isKnownReceiveSource(source))) {
      return { error: '受信元を確認できません。選び直してください', step: 'trigger' }
    }
    const conditionIssue = findConditionDraftIssue(
      form.friendTarget === 'filtered' ? form.friendConditions : null,
    )
    if (conditionIssue) return { error: conditionIssue, field: 'wiz-conditions', step: 'trigger' }

    if (form.mode === 'template' && !form.templateId) {
      return { error: '返すテンプレートを選んでください', field: 'wiz-template', step: 'response' }
    }
    if (form.mode === 'inline-text' && !form.responseContent.trim()) {
      return { error: '返す内容を入力してください', field: 'wiz-content', step: 'response' }
    }
    if (form.mode === 'inline-flex') {
      if (!form.responseContent.trim()) return { error: 'カードの内容を入力してください', field: 'wiz-flex', step: 'response' }
      const flexError = validateFlexContent('flex', form.responseContent)
      if (flexError) return { error: flexError, field: 'wiz-flex', step: 'response' }
    }
    if (form.mode === 'inline-image' && !readLineImageContent(form.responseContent)) {
      return { error: '返信する画像を選んでください', field: 'wiz-image', step: 'response' }
    }
    if (form.cooldownOn) {
      const cooldownValue = Number(form.cooldownMinutes)
      if (!Number.isInteger(cooldownValue) || cooldownValue <= 0 || cooldownValue > 10080) {
        return { error: '「同じ人へ続けて返さない」の時間は1〜10080の整数（分）で入れてください', field: 'wiz-cooldown', step: 'response' }
      }
    }
    const accountId = matchedAccountId ?? selectedAccountId ?? accounts[0]?.id ?? null
    if (!accountId) {
      return { error: 'LINEアカウントを選んでから作ってください' }
    }
    const body: AutoReplyDraftInput = {
      keyword: firstKeyword || form.keywordRules[0]?.keyword.trim() || 'すべてのメッセージ',
      matchType: effectiveRules[0]?.matchType ?? form.matchType,
      responseType:
        form.mode === 'silent'
          ? 'silent'
          : form.mode === 'inline-flex'
            ? 'flex'
            : form.mode === 'inline-image'
              ? 'image'
              : 'text',
      responseContent: form.mode === 'silent' ? '' : form.responseContent,
      templateId: form.mode === 'template' ? form.templateId : null,
      lineAccountId: accountId,
      activeFrom: form.timeMode === 'custom' ? form.activeFrom || null : null,
      activeUntil: form.timeMode === 'custom' ? form.activeUntil || null : null,
      cooldownMinutes: form.cooldownOn ? Number(form.cooldownMinutes) : null,
      skipWhenOperatorActive: form.skipWhenOperatorActive,
      priority: form.priority,
      messageKinds:
        form.messageKinds.length === 0 || form.messageKinds.length === MESSAGE_KIND_WORDS.length
          ? null
          : form.messageKinds,
      receiveSources: form.receiveSources.length > 0 ? form.receiveSources : ['line'],
      friendConditions:
        form.friendTarget === 'filtered'
          ? (form.friendConditions as Record<string, unknown> | null)
          : null,
      actions: form.actions.length > 0 ? form.actions.map(toActionPayload) : null,
      responseWeekdays:
        form.weekdays.length === 0 || form.weekdays.length === 7 ? null : form.weekdays,
      responseHolidayRule: form.holidayRule === 'ignore' ? null : form.holidayRule,
      oncePerFriend: form.oncePerFriend,
      keywords:
        effectiveRules.length > 0
          ? (effectiveRules.map(toKeywordPayload) as AutoReplyDraftInput['keywords'])
          : null,
      respondToAll: form.respondToAll,
      name: form.ruleName.trim() || null,
      keywordMatchMode: form.keywordMatchMode,
      folderId: form.folderId || null,
      internalMemo: form.internalMemo.trim() || null,
      replyDelaySeconds: Number(form.replyDelaySeconds) > 0 ? Number(form.replyDelaySeconds) : null,
      unmatchedAction: form.unmatchedMode === 'notify_operator' ? { type: 'notify_operator' } : null,
    }
    if (form.mode === 'template' && form.templateId) {
      const tpl = templates.find((t) => t.id === form.templateId)
      if (tpl) {
        body.responseType = tpl.messageType
        body.responseContent = tpl.messageContent
      }
    }
    return body
  }
