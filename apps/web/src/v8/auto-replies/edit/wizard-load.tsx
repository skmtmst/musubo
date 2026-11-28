'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors';
import { ApiError,api } from '@/lib/api';
import type { Dispatch,RefObject,SetStateAction } from 'react';
import { EMPTY_FORM,InputIssue,LoadState,WizardForm,formFromSettings } from './wizard-model';

type LoadWizardDraftContext = {
  autoReplyId: string | null
  creationAccountId: string | null
  savedSnapshotRef: RefObject<string>
  savedVersionRef: RefObject<number | null>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  setForm: Dispatch<SetStateAction<WizardForm>>
  setInputIssue: Dispatch<SetStateAction<InputIssue | null>>
  setIsActive: Dispatch<SetStateAction<boolean>>
  setLifecycleStatus: Dispatch<SetStateAction<string>>
  setLoadError: Dispatch<unknown>
  setLoadState: Dispatch<SetStateAction<LoadState>>
  setMatchedAccountId: Dispatch<SetStateAction<string | null>>
  setMatchedLast28Days: Dispatch<SetStateAction<number | null>>
  setTemplates: Dispatch<SetStateAction<{ id: string; name: string; messageType: string; messageContent: string; folderId?: string | null; updatedAt?: string; }[]>>
  setTemplateState?: Dispatch<SetStateAction<'loading' | 'ready' | 'error' | 'retrying'>>
  setVersionNumber: Dispatch<SetStateAction<number | null>>
  setWasPublished: Dispatch<SetStateAction<boolean>>
}

export async function loadWizardDraft({ autoReplyId, creationAccountId, savedSnapshotRef, savedVersionRef, saveErrors, setForm, setInputIssue, setIsActive, setLifecycleStatus, setLoadError, setLoadState, setMatchedAccountId, setMatchedLast28Days, setTemplates, setTemplateState, setVersionNumber, setWasPublished }: LoadWizardDraftContext) {
    setLoadState('loading')
    setLoadError(null)
    setInputIssue(null)
    setTemplateState?.('loading')
    try {
      const [draftRes, liveRes] = await Promise.all([
        autoReplyId ? api.autoReplies.getDraft(autoReplyId) : Promise.resolve(null),
        autoReplyId ? api.autoReplies.get(autoReplyId).catch(() => null) : Promise.resolve(null),
      ])
      let accountId: string | null = null
      if (autoReplyId) {
        if (!draftRes?.success || !draftRes.data?.settings) {
          setLoadState(draftRes && !draftRes.success ? 'not-found' : 'error')
          return
        }
        const version = draftRes.data
        accountId = version.settings.lineAccountId || null
        const nextForm = formFromSettings(version.settings)
        setForm(nextForm)
        savedSnapshotRef.current = JSON.stringify(nextForm)
        savedVersionRef.current = version.versionNumber
        setVersionNumber(version.versionNumber)
        setWasPublished(version.status === 'published')
        setMatchedLast28Days(version.matchedLast28Days ?? null)
        setIsActive(liveRes?.success ? liveRes.data.isActive : false)
        setLifecycleStatus(
          liveRes?.success ? String(liveRes.data.lifecycleStatus ?? 'published') : 'published',
        )
        // 公開済みで下書きの無いものはそのまま編集に入る。保存で新しい下書きが作られる。
      } else {
        accountId = creationAccountId
        savedSnapshotRef.current = JSON.stringify(EMPTY_FORM)
        setForm(EMPTY_FORM)
      }
      setMatchedAccountId(accountId)
      // 返す文の候補は、この応答のアカウントだけ。
      const tplRes = await api.templates.list(undefined, accountId ?? undefined).catch(() => null)
      if (tplRes?.success && Array.isArray(tplRes.data)) {
        setTemplates(
          tplRes.data.map((t) => ({
            id: t.id,
            name: t.name,
            messageType: t.messageType,
            messageContent: t.messageContent,
            folderId: t.folderId,
            updatedAt: t.updatedAt,
          })),
        )
        setTemplateState?.('ready')
      } else {
        setTemplateState?.('error')
      }
      setLoadState('ready')
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setLoadError(caught) }
      { if (!fieldFailure)
      setLoadState(caught instanceof ApiError && caught.status === 404 ? 'not-found' : 'error')
    }
  }
  }
