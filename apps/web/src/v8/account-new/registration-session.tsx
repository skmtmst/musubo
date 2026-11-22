'use client'

import { useEffect, useState, type ReactNode } from 'react'
import ListState from '@/components/shared/list-state'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import ResumeRegistrationStyle from './resume-style'
import { PENDING_REGISTRATION_RECEIPT } from './registration-storage'

/** 接続済みIDの再開判定が済むまで、新しい登録フォームを起動しない。 */
export default function RegistrationSession({ resumeKey, children }: {
  resumeKey: string | null
  children: (pendingAccountId: string, onReceiptConfirmed: (accountId: string) => void) => ReactNode
}) {
  const [resumeId, setResumeId] = useState<string>()
  useEffect(() => {
    let id = ''
    try { if (resumeKey) id = sessionStorage.getItem(resumeKey) ?? '' } catch { /* 保存値が読めなくても入口から登録できる。 */ }
    setResumeId(id)
  }, [resumeKey])

  if (resumeId === undefined) return <PageFrame kind="wizard" boardId="p6zMkA">
    <PageHeading title="LINEアカウントを登録" />
    <PageContent layout="stats"><ListState kind="loading" title="登録の状態を確認しています" /></PageContent>
  </PageFrame>
  if (resumeId.startsWith(PENDING_REGISTRATION_RECEIPT)) {
    return children(resumeId.slice(PENDING_REGISTRATION_RECEIPT.length), setResumeId)
  }
  return resumeId ? <ResumeRegistrationStyle accountId={resumeId} /> : children('', setResumeId)
}
