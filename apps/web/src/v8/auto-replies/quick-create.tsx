'use client'
import { notifySaved } from '@/components/shared/toast'
import { useEffect, useRef, useState } from 'react'
import { HelpCircle, ListOrdered, Send, X } from 'lucide-react'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import { api } from '@/lib/api'
import type { AutoReplyConflict, AutoReplyDraftInput } from '@line-crm/shared'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { requiredText } from '@/lib/form-requirement'
import { isImeComposing } from '@/components/shared/ime'
import styles from './quick-create.module.css'
import { Field } from '@/components/shared/form-controls'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { InputFieldFrame, TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useFeatureAccess } from '@/lib/use-feature-access'
import { useStaffRole } from '@/lib/staff-role'
import { subscribeStaffIdentity } from '@/lib/staff-identity-state'
import { SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { canEditAutoReplyNow } from './write-access'

/*
 * ★V8 自動応答 かんたんに作る（板 、小窓 560）。
 *
 * 言葉（どれか1つを含む）と返す文だけ聞いて、その場で有効にする。
 * 重なりは作った下書きで確かめ、あるときは相手の名前を帯に出してから
 * 有効にする（確かめた分だけ承認する）。並び替えは詳しく作るで行う。
 * 見た目は絵どおりに組み直した（2026-10-07）：× は題の行に重ねる、キャンセル・保存は窓の真ん中、
 * 言葉は札（緑の地・青の字）、重なりは琥珀の帯。インラインの style は使わない。
 */

/* 1欄ぶんの確かめ。文は「何をすれば直るか」を1文で書く。 */
function validateKeywords(keywords: string[]): string | null {
  return keywords.length > 0 ? null : '反応する言葉を1つ以上入れてください。'
}

const replyRequirement = requiredText('返す文を入れてください。')
const validateReply = replyRequirement.check

function overlapNames(conflicts: AutoReplyConflict[]): string {
  const names = conflicts.map((conflict) => conflict.name).filter(Boolean)
  if (names.length <= 3) return names.join('・')
  return `${names.slice(0, 3).join('・')}ほか${names.length - 3} 件`
}

type Phase = 'editing' | 'confirming' | 'saving'

export default function QuickCreateV8({
  accountId,
  onClose,
  onCreated,
}: {
  /** 上のバーで選んでいるLINE公式アカウント。無いときは作れない。 */
  accountId: string | null
  onClose: () => void
  /** 有効にしたら一覧を読み直す。 */
  onCreated: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole()
  const featureAccess = useFeatureAccess('autoReplies')
  const resolvedReason = usePermissionLockReason(featureAccess)
  const lockedReason = role === null ? undefined : resolvedReason
  const initialAccountId = useRef(accountId)
  const accessEpoch = useRef(0)
  const accountIdRef = useRef(accountId)
  if (accountIdRef.current !== accountId) accessEpoch.current++
  accountIdRef.current = accountId
  const accountChanged = accountId !== initialAccountId.current
  const inputsDisabled = role === null || !featureAccess || Boolean(lockedReason) || accountChanged
  const mounted = useRef(true)
  const saveLock = useRef(false)
  const canEditNow = () => canEditAutoReplyNow() && accountIdRef.current === initialAccountId.current
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [reply, setReply] = useState('')
  const [keywordError, setKeywordError] = useState('')
  const [replyError, setReplyError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [phase, setPhase] = useState<Phase>('editing')
  const [overlaps, setOverlaps] = useState<AutoReplyConflict[]>([])
  const draftIdRef = useRef<string | null>(null)
  const savedInputRef = useRef('')
  const draftVersionRef = useRef<number | null>(null)

  const acknowledgedRef = useRef<string[]>([])
  const draftKeyRef = useRef<string>(crypto.randomUUID())
  const publishKeyRef = useRef<string>(crypto.randomUUID())

  useEffect(() => {
    mounted.current = true
    const invalidate = () => { accessEpoch.current++; acknowledgedRef.current = [] }
    const unsubscribe = subscribeStaffIdentity(invalidate)
    window.addEventListener(SESSION_SNAPSHOT_CHANGED, invalidate)
    return () => {
      mounted.current = false
      invalidate(); unsubscribe()
      window.removeEventListener(SESSION_SNAPSHOT_CHANGED, invalidate)
    }
  }, [])
  useEffect(() => { acknowledgedRef.current = [] }, [accountId])

  const saving = phase === 'saving'
  const keywordProblem = validateKeywords(keywords.length || !draft.trim() ? keywords : [draft.trim()])
  const replyProblem = validateReply(reply)
  const missingReason = !accountId ? '上のバーでLINE公式アカウントを選んでください'
    : keywordProblem && replyProblem ? '反応する言葉と返す文を入れてください。' : keywordProblem ?? replyProblem
  const guard = useUnsavedGuard({ dirty: keywords.length > 0 || draft !== '' || reply !== '', busy: saving, onDiscard: onClose })

  const addKeyword = (value: string) => {
    if (!canEditNow() || saveLock.current) return
    const word = value.trim()
    if (!word || keywords.includes(word)) return
    const next = [...keywords, word]
    setKeywords(next)
    if (validateKeywords(next) === null) setKeywordError('')
  }

  const removeKeyword = (value: string) => {
    if (!canEditNow() || saveLock.current) return
    setKeywords((current) => current.filter((keyword) => keyword !== value))
  }

  /* 欄を離れたとき、入れかけの言葉があれば札にする（Enter を押し忘れても消えない）。 */
  const blurKeywords = () => {
    if (!canEditNow() || saveLock.current) return
    const word = draft.trim()
    if (word) {
      const next = keywords.includes(word) ? keywords : [...keywords, word]
      setKeywords(next)
      setDraft('')
      setKeywordError(validateKeywords(next) ?? '')
      return
    }
    setKeywordError(validateKeywords(keywords) ?? '')
  }
  const blurReply = () => { if (canEditNow() && !saveLock.current) setReplyError(validateReply(reply) ?? '') }

  const buildInput = (words: string[], text: string): AutoReplyDraftInput => ({
    keyword: words[0] ?? '',
    matchType: 'contains',
    responseType: 'text',
    responseContent: text.trim(),
    templateId: null,
    lineAccountId: accountId ?? '',
    activeFrom: null,
    activeUntil: null,
    cooldownMinutes: null,
    skipWhenOperatorActive: false,
    priority: 0,
    messageKinds: null,
    receiveSources: ['line'],
    friendConditions: null,
    actions: null,
    responseWeekdays: null,
    responseHolidayRule: null,
    oncePerFriend: false,
    keywords: words.map((word) => ({ keyword: word, matchType: 'contains' })),
    respondToAll: false,
    name: null,
    keywordMatchMode: 'any',
    folderId: null,
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
  })

  const publish = async (id: string, acknowledged: string[], isCurrent: () => boolean) => {
    if (!isCurrent()) return false
    const res = await api.autoReplies.publishDraft(
      id,
      { acknowledgedConflictIds: acknowledged },
      publishKeyRef.current,
    )
    if (!res.success) {
      if (res.error?.includes('競合') || res.error?.includes('確認')) {
        throw new Error('重なりの確認が足りていません。詳しく作るで確かめてください。')
      }
      throw new Error(res.error || '自動応答を有効にできませんでした。時間をおいて、もう一度お試しください。')
    }
    return true
  }

  const save = async () => {
    if (!canEditNow() || saveLock.current) return
    const word = draft.trim()
    const words = word && !keywords.includes(word) ? [...keywords, word] : keywords
    const keywordMessage = validateKeywords(words)
    const replyMessage = validateReply(reply)
    setKeywordError(keywordMessage ?? '')
    setReplyError(replyMessage ?? '')
    if (keywordMessage || replyMessage) return
    if (word) { setKeywords(words); setDraft('') }
    if (!accountId) {
      setSaveError('上のバーでLINE公式アカウントを選んでください')
      return
    }
    saveLock.current = true
    const requestedEpoch = accessEpoch.current
    const isCurrent = () => mounted.current && canEditNow() && requestedEpoch === accessEpoch.current
    const interrupted = () => {
      if (isCurrent()) return false
      if (mounted.current) setSaveError('操作する人やアカウントの状態が変わりました。内容を確認して、もう一度お試しください。')
      return true
    }
    setPhase('saving')
    setSaveError('')
    let completed = false
    try {
      const input = buildInput(words, reply)
      const snapshot = JSON.stringify(input)
      let id = draftIdRef.current
      const changed = snapshot !== savedInputRef.current
      if (!id) {
        const created = await api.autoReplies.createDraft(input, draftKeyRef.current)
        if (!created.success) throw new Error(created.error || '下書きを作れませんでした')
        id = created.data.autoReplyId
        draftIdRef.current = id
        draftVersionRef.current = created.data.versionNumber
        savedInputRef.current = snapshot
      } else if (changed) {
        if (draftVersionRef.current === null) throw new Error('下書きの更新番号を確認できませんでした。時間をおいて、もう一度お試しください。')
        const updated = await api.autoReplies.saveDraft(id, { ...input, expectedVersion: draftVersionRef.current })
        if (!updated.success) throw new Error(updated.error || '下書きを更新できませんでした。時間をおいて、もう一度お試しください。')
        draftVersionRef.current = updated.data.versionNumber
        savedInputRef.current = snapshot
        publishKeyRef.current = crypto.randomUUID()
      }
      if (interrupted()) return
      // 通信失敗を「重なりなし」と扱わず、公開の直前にも最新の重なりを確認する。
      const found = await api.autoReplies.conflicts(id)
      if (interrupted()) return
      if (!found.success) throw new Error(found.error || '重なりを確認できませんでした。時間をおいて、もう一度お試しください。')
      const list = found.data.conflicts
      const acknowledged = list.map(conflict => conflict.autoReplyId)
      const newConflicts = acknowledged.some(conflictId => !acknowledgedRef.current.includes(conflictId))
      setOverlaps(list)
      if (list.length > 0 && (changed || newConflicts)) {
        acknowledgedRef.current = acknowledged
        setPhase('confirming')
        return
      }
      acknowledgedRef.current = acknowledged
      if (!await publish(id, acknowledged, isCurrent) || interrupted()) return
      completed = true
      publishKeyRef.current = crypto.randomUUID()
      guard.disarm()
      notifySaved('自動応答を有効にしました。')
      onCreated()
      onClose()
    } catch (cause) {
      if (interrupted()) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setSaveError(describeApiFailure(cause, '保存')) }
      setPhase(draftIdRef.current ? 'confirming' : 'editing')
    } finally {
      saveLock.current = completed
      if (mounted.current && !completed) setPhase(current => current === 'saving' ? 'editing' : current)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
    <Dialog
      open
      confirmation
      designNode="G4GejG"
      designWidth={560}
      title="言葉に自動で返す"
      busy={saving}
      error={saveError || undefined}
      onCancel={onClose}
      footer={(<DialogActions note={!saving && !inputsDisabled ? missingReason : undefined} align="center" leadingAction={<Button {...(!inputsDisabled ? { href: '/auto-replies/edit' } : { type: 'button', disabled: true })} variant="text" lockedReason={lockedReason}>
            <ListOrdered size={16} aria-hidden="true" />
            詳しく作るへ
          </Button>}>


          <Button type="button" variant="secondary" disabled={saving} onClick={onClose}>
            キャンセル
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={saving || inputsDisabled || Boolean(missingReason)}
            aria-description={!saving && !inputsDisabled ? missingReason ?? undefined : undefined}
            lockedReason={lockedReason}
            busy={saving}
            busyLabel={phase === 'confirming' ? '有効にしています…' : '保存しています…'}
            onClick={() => save()}
          >
            <Send size={16} aria-hidden="true" />
            有効にして保存
          </Button>

          {/* 左の「詳しく作るへ」と釣り合いを取り、キャンセル・保存を窓の真ん中に置く。 */}

        </DialogActions>)}
    >
      <div className={styles.body}>
        <OperationTargetSummary accounts={[{ id: initialAccountId.current ?? '' }]} />
        {lockedReason ? <ReadOnlyNotice need="feature" /> : null}
        {accountChanged ? <Notice tone="warn">アカウントが切り替わりました。いったん閉じて作り直してください。</Notice> : null}
        <div className={styles.field}>
          <p className={styles.label} id="quick-create-keywords-label">この言葉が来たら（どれか1つを含む）</p>
          <InputFieldFrame className={styles.chipBox} role="group" aria-labelledby="quick-create-keywords-label">
            {keywords.map((keyword) => (
              <span key={keyword} className={styles.chip}>
                {keyword}
                <button
                  type="button"
                  className={styles.chipRemove}
                  data-hit-area=""
                  aria-label={`「${keyword}」を外す`}
                  disabled={saving || inputsDisabled}
                  onClick={() => removeKeyword(keyword)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            ))}
            <SaveErrorField names={["draft","keyword"]}><SharedTextField
              value={draft}
              disabled={saving || inputsDisabled}
              onChange={(event) => { if (canEditNow() && !saveLock.current) setDraft(event.target.value) }}
              onBlur={blurKeywords}
              onKeyDown={(event) => {
                if (!canEditNow() || saveLock.current) return
                // 日本語の変換中のキー（確定の Enter・変換の取り消し）は入力欄のもの。札にしない。
                if (isImeComposing(event)) return
                // 空の欄で Backspace を押すと、最後の札を外す（札の×は指を乗せたとき・選んだときだけ見せる）。
                if (event.key === 'Backspace' && !draft && keywords.length > 0) {
                  removeKeyword(keywords[keywords.length - 1])
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addKeyword(draft)
                  setDraft('')
                }
              }}
              placeholder="言葉を入れて Enter"
              aria-label="追加する言葉"
              className={styles.chipInput}
            /></SaveErrorField>
          </InputFieldFrame>
          {keywordError ? <p className={styles.fieldError} role="alert">{keywordError}</p> : null}
        </div>
        <div className={styles.field}><Field label="返す文" htmlFor="quick-create-reply" requirement={replyRequirement}><SaveErrorField names={["reply"]}><SharedTextArea
            id="quick-create-reply"
            value={reply}
            disabled={saving || inputsDisabled}
            onChange={(event) => {
              if (!canEditNow() || saveLock.current) return
              const next = event.target.value
              setReply(next)
              if (replyError && validateReply(next) === null) setReplyError('')
            }}
            onBlur={blurReply}
            placeholder="例：営業時間は10:00〜19:00です"
            className={styles.textarea}
            aria-invalid={replyError ? true : undefined}
          /></SaveErrorField>
{replyError ? <p className={styles.fieldError} role="alert">{replyError}</p> : null}</Field></div>
        {overlaps.length > 0 ? (
            <Notice tone="warn" role="status" icon={<HelpCircle size={16} aria-hidden="true" />}>
              <span>{`「${overlapNames(overlaps)}」と重なります。こちらが先に動きます（並びは詳しく作るで変えられる）`}</span>
            </Notice>
        ) : null}
      </div>
    </Dialog>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={saving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    </></SaveErrorScope>
  )
}
