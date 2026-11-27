'use client'

/*
 * Q&A を作る・直す窓（要件 G2 §2-1 y4nixm の［Q&A を追加］・記録の［Q&A に足す］）。
 * 入るのはいつも下書き。公開は一覧の「…」から（管理者以上）。スタッフには公開のお願いの一言を出す。
 */
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useContext, useEffect, useRef, useState } from 'react'
import Dialog from '@/components/shared/dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { Field } from '@/components/shared/form-controls'
import { TextArea } from '@/components/shared/text-field'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import { aiReplyApi, type QaEntry } from './api'
import styles from './qa-list.module.css'

export interface QaDraftSeed { entry?: QaEntry; question?: string }

export default function QaEditDialog({ open, accountId, seed, canPublish, onSaved, onClose }: {
  open: boolean
  accountId: string
  seed: QaDraftSeed | null
  canPublish: boolean
  onSaved: (entry: QaEntry) => void
  onClose: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [questions, setQuestions] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [questionError, setQuestionError] = useState('')
  const [answerError, setAnswerError] = useState('')
  const saveTicket = useRef<object | null>(null)
  const scope = useRef({ open, accountId, id: seed?.entry?.id, version: seed?.entry?.version, question: seed?.question })
  if (scope.current.open !== open || scope.current.accountId !== accountId || scope.current.id !== seed?.entry?.id || scope.current.version !== seed?.entry?.version || scope.current.question !== seed?.question) {
    scope.current = { open, accountId, id: seed?.entry?.id, version: seed?.entry?.version, question: seed?.question }
    saveTicket.current = null
  }

  useEffect(() => {
    if (!open) return
    setQuestions(seed?.entry ? seed.entry.questions.join('\n') : seed?.question ?? '')
    setAnswer(seed?.entry?.answerText ?? '')
    setError('')
    setQuestionError('')
    setAnswerError('')
  }, [open, seed, accountId])
  useEffect(() => { setBusy(false) }, [open, accountId, seed?.entry?.id, seed?.entry?.version, seed?.question])

  const initialQuestions = seed?.entry ? seed.entry.questions.join('\n') : seed?.question ?? ''
  const dirty = questions !== initialQuestions || answer !== (seed?.entry?.answerText ?? '')
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: open && (dirty || busy), busy: open && busy, onDiscard: onClose })
  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])
  useEffect(() => { guard.cancelLeave() }, [accountId, guard.cancelLeave])
  const current = useRef({ open, busy, accountId, target: guard.leaveTarget })
  current.current = { open, busy, accountId, target: guard.leaveTarget }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const discardAndLeave = () => {
    const target = guard.leaveTarget
    if (!alive.current || !current.current.open || current.current.busy || current.current.accountId !== accountId || !target || current.current.target !== target) return
    current.current.target = null
    guard.disarm(); guard.confirmLeave()
  }

  const save = async () => {
    if (saveTicket.current) return
    const list = questions.split('\n').map((line) => line.trim()).filter(Boolean)
    const qe = list.length === 0 ? '質問を 1 つ以上入れてください' : ''
    const ae = answer.trim() ? '' : '答えを入れてください'
    setQuestionError(qe)
    setAnswerError(ae)
    if (qe || ae) return
    const ticket = {}
    const saveScope = scope.current
    saveTicket.current = ticket
    const isCurrent = () => alive.current && scope.current === saveScope && saveTicket.current === ticket
    setBusy(true)
    setError('')
    try {
      const res = seed?.entry
        ? await aiReplyApi.updateQa(accountId, seed.entry.id, { questions: list, answerText: answer.trim(), expectedVersion: seed.entry.version })
        : await aiReplyApi.createQa(accountId, { questions: list, answerText: answer.trim() })
      if (!isCurrent()) return
      notifyToast(seed?.entry ? 'Q&A を保存しました' : 'Q&A を下書きで作りました')
      onSaved(res.data)
    } catch (caught) {
      if (!isCurrent()) return
      if (!saveErrors.capture(caught)) setError(describeApiFailure(caught, 'Q&A の保存'))
    } finally {
      if (isCurrent()) { saveTicket.current = null; setBusy(false) }
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={open}
      title={seed?.entry ? 'Q&A を編集する' : 'Q&A を追加する'}
      designWidth={560}
      dirty={dirty}
      busy={busy}
      error={error || undefined}
      confirmLabel={seed?.entry ? '保存する' : '下書きで保存する'}
      onConfirm={() => void save()}
      onCancel={() => { if (!busy) onClose() }}
    >
      <div className={styles.form}>
        <Field label="質問" htmlFor="qa-questions" required note="言い方が違う聞かれ方を 1 行に 1 つ入れます" error={questionError || undefined}>
          <TextArea id="qa-questions" rows={3} value={questions} invalid={Boolean(questionError)} onChange={(event) => setQuestions(event.target.value)} placeholder="例：駐車場はありますか" />
        </Field>
        <Field label="答え" htmlFor="qa-answer" required note="自動で答えるときは、この文をそのまま返します" error={answerError || undefined}>
          <TextArea id="qa-answer" rows={5} value={answer} invalid={Boolean(answerError)} onChange={(event) => setAnswer(event.target.value)} />
        </Field>
        {!canPublish ? <p className={styles.formNote}>公開は管理者にお願いしてください。保存すると下書きで入ります。</p> : null}
      </div>
    </Dialog><OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={open && guard.leaveTarget !== null} subject="Q&A の変更" onConfirm={discardAndLeave} onCancel={guard.cancelLeave} busy={busy} /></OverlayDepthContext.Provider></SaveErrorScope>
  )
}
