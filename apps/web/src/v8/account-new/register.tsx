'use client'

import { scrollMotion } from '@/components/shared/overlay-utils'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import ListState from '@/components/shared/list-state'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, ArrowRight, Check, CircleAlert, CircleDashed, Copy, Plug,
} from 'lucide-react'
import { api, type FollowerImportState, type LineAccountConnectData, type LineRegistrationReceipt } from '@/lib/api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import { StepContent } from '@/components/templates/steps'
import { CreateStepColumns } from '@/components/templates/create-step-columns'
import { Steps } from '@/components/templates/steps'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import StickyBar from '@/components/shared/sticky-bar'
import Checkbox from '@/components/shared/checkbox'
import Notice from '@/components/shared/notice'
import TextLink from '@/components/shared/text-link'
import NoticeLineRegisterDialog from '@/components/hq/notice-line-register-dialog'
import {
  DRAFT_KEY, LOGIN_ACKS, WEBHOOK_ACKS, allAcked, allV06RowsOk, channelErrors, channelLengthWarning, checkActionLabel, checkErrorText,
  checkStage, handoverProgress, isDuplicateChannelError, latestFollowerImportState,
  loginChannelErrors, matchRegisteredAccountId, messagingApiErrors, nextCursor, providerIdErrors, readDraft, stepLabel, subTotal,
  toV06CheckRows,
  precheckBack, precheckBlocked, precheckNext, precheckNote, precheckStateLabel, precheckSummary,
  type DraftState, type PrecheckAnswers, type PrecheckAt, type PrecheckKey, type StepNumber,
} from './logic'
import { PROVIDER_MEMBERSHIP_GUIDANCE } from './check-rows'
import Step1Precheck from './step1-precheck'
import Step2Connect, { type Step2Field } from './step2-connect'
import Step4Template from './step4-template'
import RegistrationStyleDialog from './registration-style-dialog'
import RegistrationUnsavedGuard from './registration-unsaved-guard'
import Step5Completion from './step5-completion'
import RegistrationSession from './registration-session'
import { registrationImportChoiceKey, registrationStorageKey } from './registration-storage'
import { REGISTRATION_STYLE_KEY, useRegistrationStyle } from './use-registration-style'
import styles from './register.module.css'
import { qrToDataURL } from '@/lib/qr-image'
import TruncatedText from '@/components/shared/truncated-text'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { describeActionFailure } from '@/lib/use-action-error'

/*
 * ★v07 LINEアカウントを登録（板 ①p6zMkA ②Fqy29 ③Lwxyh ④X0pGdw ⑤Plmq1）。
 * 絵の正本は利用者承認済みの LINE新規追加_v07.pen（2026-10-18 承認）。
 * ②の小さな段は正本どおり Messaging API → Webhook の設定 → LINE Login の順。
 * 段の中身・使う口・端末の下書きなど、動きの一覧は同じ場所の BEHAVIOR.md。
 */

const V8_STEPS: ReadonlyArray<{ number: StepNumber; label: string; node: string; lead: string }> = [
  { number: 1, label: '事前確認', node: 'p6zMkA', lead: 'LINE公式アカウントと2つのチャネルを用意します。接続確認が通るまで、アカウントは作られません。' },
  { number: 2, label: 'アカウント接続', node: 'Fqy29', lead: 'LINE Developers の画面からコピーして貼り付けます。秘密値は保存後に画面へ表示されません。' },
  { number: 3, label: '接続確認', node: 'Lwxyh', lead: '5つの確認がすべて通ってから登録します。そのあと自分のスマホで友だち追加を試します。' },
  { number: 4, label: '使い方を選ぶ', node: 'X0pGdw', lead: 'いちばん近い使い方を選びます。あとから変えられます。' },
  { number: 5, label: '完了', node: 'Plmq1', lead: 'いまの友だちを引き継いでいます。終わると完了です。' },
]

const PROVIDER_CONFIRMATION_LABEL = 'LINE Developersで同じプロバイダーにあることを確かめた'
const PROVIDER_CONFIRMATION_REASON = '接続の確認と登録の前に、このチェックで確認してください。'

type BusyAction = 'check' | 'save' | null
interface FormState {
  name: string; channelId: string; channelSecret: string; providerId: string; loginChannelId: string; loginChannelSecret: string
  lineId: string; tagIds: string[]; parentId: string; staffIds: string[]; liffId: string; importFriends: boolean
}
const emptyForm: FormState = {
  name: '', channelId: '', channelSecret: '', providerId: '', loginChannelId: '', loginChannelSecret: '',
  lineId: '', tagIds: [], parentId: '', staffIds: [], liffId: '', importFriends: true,
}

export default function AccountRegisterV8() {
  const role = useStaffRole()
  const identity = readStaffIdentity()
  const draftKey = registrationStorageKey(DRAFT_KEY, identity)
  const resumeKey = registrationStorageKey(REGISTRATION_STYLE_KEY, identity)
  usePageTitle('LINEアカウントを登録')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'アカウント', href: '/hq' }])

  // API の接続・登録と同じくオーナー・管理者だけ。権限確認前に下書きの復元や変更処理を起動しない。
  if (!canManageRole(role)) return <PageFrame kind="wizard" boardId="p6zMkA">
    <PageHeading title="LINEアカウントを登録" />
    <PageContent layout="stats">{role === null ? <ListState kind="loading" /> : <ReadOnlyNotice>LINEアカウントの登録はオーナーか管理者ができます。オーナーか管理者に頼んでください。</ReadOnlyNotice>}</PageContent>
    <StickyBar actions={<Button variant="secondary" href="/accounts">LINEアカウントの一覧へ戻る</Button>} />
  </PageFrame>
  return <RegistrationSession key={draftKey ?? 'unverified'} resumeKey={resumeKey}>
    <AccountRegistrationForm draftKey={draftKey} resumeKey={resumeKey} />
  </RegistrationSession>
}

function AccountRegistrationForm({ draftKey, resumeKey }: { draftKey: string | null; resumeKey: string | null }) {
  const router = useRouter()
  const saveErrors = useSaveFormErrors()

  // ①事前確認（v07 p6zMkA）。答えと、いま出している面。
  const [precheck, setPrecheck] = useState<PrecheckAnswers>({})
  const [precheckAt, setPrecheckAt] = useState<PrecheckAt>('q1')
  const [currentStep, setCurrentStep] = useState<StepNumber>(1)
  const [sub, setSub] = useState(1)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [importFriendsExplicit, setImportFriendsExplicit] = useState(false)
  const importFriendsExplicitRef = useRef(false)
  const [acks, setAcks] = useState<Record<string, boolean>>({})
  const [providerConfirmed, setProviderConfirmed] = useState(false)
  const [providerRevision, setProviderRevision] = useState(0)
  const providerGuard = useRef({ active: true, confirmed: false, revision: 0 })
  const [connection, setConnection] = useState<LineAccountConnectData | null>(null)
  const [importState, setImportState] = useState<FollowerImportState | null>(null)
  const [busyAction, setBusyAction] = useState<BusyAction>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [touchedFields, setTouchedFields] = useState<Partial<Record<Step2Field, boolean>>>({})
  const [reviewedLengthStep, setReviewedLengthStep] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [recoveredAccountId, setRecoveredAccountId] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const [checkCursor, setCheckCursor] = useState(0)
  const [checkRunning, setCheckRunning] = useState(false)
  const [checkAttempted, setCheckAttempted] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [receipt, setReceipt] = useState<LineRegistrationReceipt>({ status: 'waiting', receivedAt: null })
  const [receiptRequestFailed, setReceiptRequestFailed] = useState(false)
  const [receiptChecking, setReceiptChecking] = useState(false)
  const [idleSeconds, setIdleSeconds] = useState(0)
  const [importRequestError, setImportRequestError] = useState(false)
  const [importRefreshing, setImportRefreshing] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [draftReady, setDraftReady] = useState(false)
  const [noticeDialog, setNoticeDialog] = useState<'idle' | 'open' | 'done'>('idle')
  const [styleDialogOpen, setStyleDialogOpen] = useState(true)
  const busyLock = useRef(false)
  const importProgressRef = useRef('')
  const stepPanelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const guard = providerGuard.current
    guard.active = true
    return () => { guard.active = false; guard.confirmed = false }
  }, [])

  const providerConfirmationIsCurrent = () => {
    const guard = providerGuard.current
    return guard.active && guard.confirmed && guard.revision === providerRevision
  }
  const requireProviderConfirmation = () => {
    if (providerConfirmationIsCurrent()) return true
    if (providerGuard.current.active) setError(PROVIDER_CONFIRMATION_REASON)
    return false
  }
  const changeProviderConfirmation = (next: boolean) => {
    const guard = providerGuard.current
    if (!guard.active || (next && guard.revision !== providerRevision)) return
    if (!next) {
      guard.revision += 1
      setProviderRevision(guard.revision)
      setConnection(null)
      setCheckCursor(0)
      setCheckRunning(false)
      setCheckAttempted(false)
      setStepUp(null)
    }
    guard.confirmed = next
    setProviderConfirmed(next)
    setError('')
  }

  const checkRows = toV06CheckRows(connection, { running: checkRunning, cursor: checkCursor })
  const rowsOk = allV06RowsOk(checkRows)
  const checkNotice = checkErrorText(checkStage(connection, checkRunning), checkRows)
  const badge = currentStep === 1 ? precheckStateLabel(precheckAt) : stepLabel(currentStep, sub)
  // 「公式アカウントをこれから作る人」は Q1=いいえ の人。
  const accountMethod: 'existing' | 'new' = precheck.q1 === 'no' ? 'new' : 'existing'
  const precheckRows = precheckSummary(precheckAt, precheck)
  const precheckGuide = precheckAt === 'done' && precheck.q4 === 'yes' && precheck.q5
    ? precheckNote('q5', precheck)
    : precheckNote(precheckAt, precheck)
  // 回答を保存した時点で次の質問（またはチェック結果）を出す。
  const answerPrecheck = (key: PrecheckKey, value: string) => {
    const answers = { ...precheck, [key]: value } as PrecheckAnswers
    setPrecheck(answers)
    if (key === 'q2' && !importFriendsExplicitRef.current) setForm(previous => ({ ...previous, importFriends: value === 'yes' }))
    setError('')
    if (key !== precheckAt || precheckBlocked(key, answers, acks)) return
    const nextAt = precheckNext(key, answers)
    if (nextAt) setPrecheckAt(nextAt)
  }
  const createdId = connection?.id ?? ''
  // Webhook URLは②Step3で表示する。Callback URLは入力させない。
  const registrationStyle = useRegistrationStyle(createdId, currentStep === 4)
  const templateKey = registrationStyle.choice
  const finishStyle = async (action: 'save' | 'skip') => {
    const succeeded = await registrationStyle[action]()
    if (succeeded) { setStyleDialogOpen(false); setCurrentStep(5); setSub(1) }
  }
  const importPhase = importState?.phase ?? connection?.followerImport.phase ?? ''
  const importRunning = importPhase === 'importing_ids' || importPhase === 'hydrating_profiles'
  const importAttention = (importRunning || importState?.phase === 'completed') && (Boolean(importState?.lastError) || importRequestError || (importRunning && idleSeconds >= 60))
  const basicId = connection?.basicId ?? ''
  const addFriendUrl = basicId ? `https://line.me/R/ti/p/${encodeURIComponent(basicId.startsWith('@') ? basicId : `@${basicId}`)}` : ''
  const shownStep = V8_STEPS[currentStep - 1]

  const headingReady = !((currentStep === 3 && sub === 2) || currentStep === 5) || Boolean(connection)
  useEffect(() => {
    if (headingReady) stepPanelRef.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus()
  }, [currentStep, sub, precheckAt, headingReady])
  useEffect(() => {
    if (!Object.keys(fieldErrors).length) return
    const invalid = stepPanelRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')
    invalid?.focus()
    invalid?.scrollIntoView?.({ block: 'center', behavior: scrollMotion() })
  }, [fieldErrors, currentStep, sub])

  // 本人の入力だけを戻す。表示位置は必ず①の最初から（秘密値は入れ直す）。
  useEffect(() => {
    const draft = (() => { try { return draftKey ? readDraft(window.localStorage, draftKey) : null } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      return null } })()
    setDraftReady(true)
    if (!draft) return
    importFriendsExplicitRef.current = draft.importFriendsExplicit === true
    setImportFriendsExplicit(importFriendsExplicitRef.current)
    setForm((current) => ({
      ...current, name: draft.name, channelId: draft.channelId, providerId: draft.providerId, loginChannelId: draft.loginChannelId, lineId: draft.lineId,
      tagIds: draft.tagIds, parentId: draft.parentId, staffIds: draft.staffIds, liffId: draft.liffId, importFriends: draft.importFriends,
    }))
    setDraftRestored(true)
  }, [draftKey, saveErrors])

  // 変わるたびに端末の下書きを残す（秘密値は除く）。登録が終わったら消す。
  useEffect(() => {
    if (!draftReady || !draftKey) return
    if (createdId) {
      try { window.localStorage.removeItem(draftKey) } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* 消せなくても登録は続ける。 */ }
      return
    }
    const draft: DraftState = {
      step: currentStep, sub, connectionStepsVersion: 4, accountMethod, precheck, precheckAt,
      name: form.name, channelId: form.channelId, providerId: form.providerId, loginChannelId: form.loginChannelId,
      lineId: form.lineId, tagIds: form.tagIds, parentId: form.parentId, staffIds: form.staffIds, liffId: form.liffId,
      importFriends: form.importFriends,
      importFriendsExplicit,
    }
    try { window.localStorage.setItem(draftKey, JSON.stringify(draft)) } catch (saveFailure) {
      saveErrors.capture(saveFailure) /* 書けなくても入力は続ける。 */ }
  }, [draftReady, draftKey, createdId, currentStep, sub, accountMethod, precheck, precheckAt, form.name, form.channelId, form.providerId, form.loginChannelId, form.lineId, form.tagIds, form.parentId, form.staffIds, form.liffId, form.importFriends, importFriendsExplicit, saveErrors])

  /* ③-1：応答が返ったあと、5行を1行ずつ送る。止まった行（error）が出たらそこで終わる。 */
  useEffect(() => {
    if (!checkRunning || !connection) return
    const rows = toV06CheckRows(connection, { running: true, cursor: checkCursor })
    const next = nextCursor(rows, checkCursor)
    if (next === null) { setCheckRunning(false); return }
    const timer = setTimeout(() => setCheckCursor(next), 420)
    return () => clearTimeout(timer)
  }, [checkRunning, connection, checkCursor])

  // ③-2：自分のスマホで読む友だち追加のQR。作れなくてもURLは出す。
  useEffect(() => {
    if (currentStep !== 3 || sub !== 2 || !addFriendUrl) return
    let cancelled = false
    void (async () => {
      try {
        const dataUrl = await qrToDataURL(addFriendUrl, { width: 220, margin: 1 })
        if (!cancelled) setQrDataUrl(dataUrl)
      } catch (saveFailure) {
        saveErrors.capture(saveFailure) /* QRが出なくてもURLから追加できる。 */ }
    })()
    return () => { cancelled = true }
  }, [currentStep, sub, addFriendUrl, saveErrors])

  // ③-2：人数ではなく、このアカウントに登録後届いた署名付きWebhookの記録を確認する。
  useEffect(() => {
    if (currentStep !== 3 || sub !== 2 || !createdId || (receipt.status === 'confirmed' && !receiptRequestFailed)) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await api.lineAccounts.registrationReceipt(createdId)
        if (!active) return
        if (response.success) {
          setReceipt(response.data)
          setReceiptRequestFailed(false)
          if (response.data.status === 'confirmed') return
        } else setReceiptRequestFailed(true)
      } catch {
        if (active) setReceiptRequestFailed(true)
      }
      if (active) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [currentStep, sub, createdId, receipt.status, receiptRequestFailed])

  /* ⑤：画面を開いている間は1回ぶんが終わるたびに次を呼ぶ。
   * 本番では cron も拾うが、検証環境は cron を無効にしている。 */
  useEffect(() => {
    if (!createdId || !importRunning || !form.importFriends) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const advance = async () => {
      try {
        const response = await api.lineAccounts.stepFollowerImport(createdId)
        if (!active) return
        if (!response.success) {
          setImportRequestError(true)
          timer = setTimeout(() => void advance(), 5000)
          return
        }
        setImportRequestError(false)
        setImportState((current) => latestFollowerImportState(current, response.data.state))
        if (['importing_ids', 'hydrating_profiles'].includes(response.data.state.phase)) {
          /* 進めた直後は待たない（0.5秒は、何も進まない応答が続いたときの空回り止め）。 */
          timer = setTimeout(() => void advance(), response.data.busy ? 3000 : 500)
        }
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        if (active) {
          setImportRequestError(true)
          timer = setTimeout(() => void advance(), 5000)
        }
      }
    }
    void advance()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [createdId, importRunning, form.importFriends, saveErrors])

  // ⑤：バックグラウンドで進む状態も読む。POST が一時的に失敗しても表示を止めない。
  useEffect(() => {
    if (currentStep !== 5 || !createdId || !form.importFriends) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await api.lineAccounts.followerImportState(createdId)
        if (active && response.success) {
          setImportState((current) => latestFollowerImportState(current, response.data))
          setImportRequestError(false)
        } else if (active) setImportRequestError(true)
      } catch {
        if (active) setImportRequestError(true)
      }
      if (active) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [currentStep, createdId, form.importFriends])

  // ⑤：件数・段階が動いたら待ち時間を戻す。時間は目安をでっち上げず更新確認に使う。
  const importProgressKey = importState
    ? `${importState.phase}:${importState.received}:${importState.imported}:${importState.alreadyPresent}:${importState.profilesProcessed}:${importState.profilesUpdated}`
    : ''
  useEffect(() => {
    if (!importProgressKey || importProgressRef.current === importProgressKey) return
    importProgressRef.current = importProgressKey
    setIdleSeconds(0)
  }, [importProgressKey])
  useEffect(() => {
    if (currentStep !== 5 || !importRunning) return
    const timer = setInterval(() => setIdleSeconds((current) => current + 1), 1000)
    return () => clearInterval(timer)
  }, [currentStep, importRunning])

  // 登録完了（引き継ぎも終わった）直後に契約者専用LINEの案内を一度だけ出す。
  useEffect(() => {
    if (currentStep === 5 && connection && !importRunning && noticeDialog === 'idle') setNoticeDialog('open')
  }, [currentStep, connection, importRunning, noticeDialog])

  const update = (key: keyof FormState, value: string | string[] | boolean) => {
    if (key === 'importFriends') { importFriendsExplicitRef.current = true; setImportFriendsExplicit(true) }
    if (key === 'channelId' || key === 'channelSecret' || key === 'providerId' || key === 'loginChannelId' || key === 'loginChannelSecret') changeProviderConfirmation(false)
    setForm((current) => ({ ...current, [key]: value } as FormState))
    setFieldErrors((current) => {
      const next = { ...current }
      if (key === 'channelId' || key === 'channelSecret' || key === 'providerId' || key === 'loginChannelId' || key === 'loginChannelSecret') {
        const values = { ...form, [key]: value } as FormState
        const fieldError = channelErrors(values)[key]
        if (fieldError && (Boolean(value) || touchedFields[key])) next[key] = fieldError
        else delete next[key]
        if (key === 'channelId' && touchedFields.loginChannelId) {
          const loginError = channelErrors(values).loginChannelId
          if (loginError) next.loginChannelId = loginError
          else delete next.loginChannelId
        }
      } else delete next[key]
      return next
    })
    if (key === 'channelId' || key === 'channelSecret' || key === 'providerId' || key === 'loginChannelId' || key === 'loginChannelSecret') setReviewedLengthStep(null)
    if (key === 'channelId' || key === 'channelSecret' || key === 'loginChannelId' || key === 'loginChannelSecret') {
      setConnection(null)
      setCheckCursor(0)
      setCheckRunning(false)
      setCheckAttempted(false)
    }
    setError('')
    setRecoveredAccountId('')
  }

  const validateChannelField = (key: Step2Field) => {
    setTouchedFields((current) => ({ ...current, [key]: true }))
    const fieldError = channelErrors(form)[key]
    setFieldErrors((current) => {
      const next = { ...current }
      if (fieldError) next[key] = fieldError
      else delete next[key]
      return next
    })
  }

  const reviewLengthWarnings = (fields: Step2Field[]) => {
    const unusual = fields.filter((key) => channelLengthWarning(key, form[key]))
    if (!unusual.length || reviewedLengthStep === sub) return false
    setTouchedFields((current) => ({ ...current, ...Object.fromEntries(unusual.map((key) => [key, true])) }))
    setReviewedLengthStep(sub)
    return true
  }

  const toggleAck = (key: string, next: boolean) => {
    setAcks((current) => ({ ...current, [key]: next }))
    setError('')
  }

  const acknowledgePrecheck = (key: string, next: boolean) => {
    toggleAck(key, next)
    if (!next || precheckAt !== 'q2' || precheck.q2 !== 'yes') return
    const nextAt = precheckNext(precheckAt, precheck)
    if (nextAt) setPrecheckAt(nextAt)
  }

  const input = () => ({
    name: form.name.trim() || undefined,
    channelId: form.channelId.trim(),
    channelSecret: form.channelSecret,
    loginChannelId: form.loginChannelId.trim(),
    loginChannelSecret: form.loginChannelSecret,
    importFriends: form.importFriends,
    tagIds: form.tagIds, staffIds: form.staffIds, parentLineAccountId: form.parentId || null,
    ...(form.liffId.trim() ? { liffId: form.liffId.trim() } : {}),
  })

  /* R523: 同じチャネルIDで作られた行が残っていないか照合する。取れなければ null（未保存と断定しない）。 */
  const findRegisteredAccountId = async (channelId: string): Promise<string | null> => {
    try {
      const list = await api.lineAccounts.list()
      if (!list.success) return null
      return matchRegisteredAccountId(list.data, channelId)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      return null
    }
  }

  // ③-1「接続を確かめる」：4項目でLINEへ問い合わせ、5行を1行ずつ送る。
  const runCheck = async () => {
    if (!requireProviderConfirmation()) return
    const nextErrors = channelErrors(form)
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors((current) => ({ ...current, ...nextErrors }))
      setCurrentStep(2)
      setSub(nextErrors.channelId || nextErrors.channelSecret ? 1 : nextErrors.providerId ? 2 : 4)
      setError('')
      return
    }
    if (busyLock.current) return
    busyLock.current = true
    setBusyAction('check')
    setConnection(null)
    setCheckCursor(0)
    setCheckRunning(true)
    setCheckAttempted(true)
    setError('')
    try {
      const response = await api.lineAccounts.connectCheck(input())
      if (!providerConfirmationIsCurrent()) return
      if (!response.success) {
        setCheckRunning(false)
        setError(response.error)
        return
      }
      if (response.data.additionState === 'pending_payment'
        || response.data.additionState === 'pending_reconciliation') {
        providerGuard.current.active = false
        providerGuard.current.confirmed = false
        setForm((current) => ({ ...current, channelSecret: '', loginChannelSecret: '' }))
        router.push('/hq/billing/line-addition')
        return
      }
      setConnection(response.data)
      setReceipt({ status: 'waiting', receivedAt: null })
      setReceiptRequestFailed(false)
      if (response.data.basicId) setForm((current) => ({ ...current, lineId: response.data.basicId ?? current.lineId }))
      // 止まった行は③の一覧が赤で示し、下の帯が「どこを直すか」を言う。同じ文を重ねない。
    } catch (saveFailure) {
      if (!providerConfirmationIsCurrent()) return
      setCheckRunning(false)
      const fieldFailure = saveErrors.capture(saveFailure)
      /* 「時間をおいて」の一文に畳むと、権限不足の人が待ち続け、混み合いの人が連打する。
         403・404・429・入力の直しは原因どおりに言い分ける（共通の describeActionFailure）。
         登録・接続確認はオーナーと管理者が行える。 */
      if (!fieldFailure) setError(describeActionFailure(saveFailure, '接続の確認'))
    } finally {
      busyLock.current = false
      setBusyAction(null)
    }
  }

  const save = async (stepUpToken?: string) => {
    if (!requireProviderConfirmation()) return
    if (!rowsOk || busyLock.current) {
      setError('5つの確認がすべて通ってから登録してください。')
      return
    }
    busyLock.current = true
    setBusyAction('save')
    setError('')
    setRecoveredAccountId('')
    try {
      const response = await api.lineAccounts.connect(input(), stepUpToken)
      if (!response.success) {
        // R523: 重複は登録済みの詳細へ案内する。
        if (isDuplicateChannelError(response.error)) {
          const recovered = await findRegisteredAccountId(form.channelId)
          if (recovered) {
            setRecoveredAccountId(recovered)
            setError('このチャネルIDは登録済みです。登録済みのアカウントを開いて確認してください。')
            return
          }
        }
        setError(response.error)
        return
      }
      providerGuard.current.active = false
      providerGuard.current.confirmed = false
      setConnection(response.data)
      setForm((current) => ({ ...current, channelSecret: '', loginChannelSecret: '' }))
      const choiceKey = registrationImportChoiceKey(resumeKey, response.data.id ?? '')
      try { if (choiceKey) localStorage.setItem(choiceKey, String(form.importFriends)) } catch (failure) { saveErrors.capture(failure) }
      try { if (response.data.id && resumeKey) sessionStorage.setItem(resumeKey, response.data.id) } catch (failure) { saveErrors.capture(failure) }
      // v07：登録できたら③の2つめ（友だち追加のためし）へ進む。
      setCurrentStep(3)
      setSub(2)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // LINEの接続は大事な操作。本人確認を求められたら窓を立ててやり直す。
      if (!stepUpToken && isStepUpRequired(caught)) {
        if (providerConfirmationIsCurrent()) setStepUp({ purpose: 'line_account.connect', action: 'LINEの接続を登録する', retry: save })
        return
      }
      // R523: 応答が無い失敗は「未保存」と断定しない。
      const recovered = await findRegisteredAccountId(form.channelId)
      if (recovered) {
        setRecoveredAccountId(recovered)
        if (!fieldFailure) setError('保存は終わっている可能性があります。登録済みのアカウントを開いて確認してください。')
        return
      }
      if (!fieldFailure) setError('登録できませんでした。時間をおいて、もう一度お試しください。')
    } finally {
      busyLock.current = false
      setBusyAction(null)
    }
  }

  const moveNext = () => {
    setError('')
    if (currentStep === 1) {
      // 質問間は回答時に進む。ここでの「次へ」はチェック結果から②への一度だけ。
      if (precheckAt !== 'done') return
      setCurrentStep(2)
      setSub(1)
      return
    }
    if (currentStep === 2) {
      if (sub === 1) {
        const nextErrors = messagingApiErrors(form)
        if (Object.keys(nextErrors).length > 0) { setFieldErrors((current) => ({ ...current, ...nextErrors })); return }
        if (reviewLengthWarnings(['channelId', 'channelSecret'])) return
        setSub(2)
        return
      }
      if (sub === 2) {
        const nextErrors = providerIdErrors(form)
        if (Object.keys(nextErrors).length > 0) { setFieldErrors((current) => ({ ...current, ...nextErrors })); return }
        if (reviewLengthWarnings(['providerId'])) return
        setSub(3)
        return
      }
      if (sub === 3) {
        if (!allAcked(WEBHOOK_ACKS, acks)) return
        setSub(4)
        return
      }
      const loginErrors = loginChannelErrors(form)
      if (Object.keys(loginErrors).length > 0) { setFieldErrors((current) => ({ ...current, ...loginErrors })); return }
      if (reviewLengthWarnings(['loginChannelId', 'loginChannelSecret'])) return
      if (!allAcked(LOGIN_ACKS, acks)) return
      setCurrentStep(3)
      setSub(1)
      return
    }
    if (currentStep === 3) {
      if (sub === 1) {
        if (!rowsOk) return
        void save()
        return
      }
      if (receipt.status !== 'confirmed' || receiptChecking || !createdId) return
      // 表示済みの結果だけを信じず、押した時点でサーバの受信記録をもう一度確かめる。
      setReceiptChecking(true)
      void (async () => {
        try {
          const response = await api.lineAccounts.registrationReceipt(createdId)
          if (response.success) {
            setReceipt(response.data)
            setReceiptRequestFailed(false)
            if (response.data.status === 'confirmed') {
              setCurrentStep(4)
              setSub(1)
            }
          } else setReceiptRequestFailed(true)
        } catch {
          setReceiptRequestFailed(true)
        } finally {
          setReceiptChecking(false)
        }
      })()
      return
    }
    // ④の保存とスキップはポップアップ内の操作から行う。
  }

  const moveBack = () => {
    setError('')
    if (currentStep === 1) {
      // ①の中は答えた質問をさかのぼる。先頭の質問より手前には戻らない。
      const backAt = precheckBack(precheckAt, precheck)
      if (backAt) setPrecheckAt(backAt)
      return
    }
    if (sub > 1) { setSub(sub - 1); return }
    if (currentStep > 1) {
      const previous = (currentStep - 1) as StepNumber
      setCurrentStep(previous)
      setSub(Math.max(1, subTotal(previous)))
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    moveNext()
  }

  const handover = handoverProgress({
    phase: importState?.phase ?? connection?.followerImport.phase ?? 'not_started',
    received: importState?.received ?? 0,
    imported: importState?.imported ?? 0,
    alreadyPresent: importState?.alreadyPresent ?? 0,
    reactivated: importState?.reactivated ?? 0,
    claimedUnassigned: importState?.claimedUnassigned ?? 0,
    conflicts: importState?.conflicts ?? 0,
    invalid: importState?.invalid ?? 0,
    profilesUpdated: importState?.profilesUpdated ?? 0,
  })
  const refreshImport = async () => {
    if (!createdId || importRefreshing) return
    setImportRefreshing(true)
    try {
      const response = await api.lineAccounts.followerImportState(createdId)
      if (response.success) {
        setImportState((current) => latestFollowerImportState(current, response.data))
        setImportRequestError(false)
      } else setImportRequestError(true)
    } catch {
      setImportRequestError(true)
    } finally {
      setImportRefreshing(false)
    }
  }
  const busy = Boolean(busyAction) || registrationStyle.busy
  // 登録したあとは戻らない（③の2つめから先）。
  const canBack = !createdId && (currentStep > 1 || sub > 1 || (currentStep === 1 && precheckBack(precheckAt, precheck) !== null))
  const missingConnectionReason = currentStep !== 2 ? null
    : sub === 1 && (!form.channelId.trim() || !form.channelSecret.trim()) ? 'チャネルIDとチャネルシークレットを入力してください。'
    : sub === 2 && !form.providerId.trim() ? 'プロバイダーIDを入力してください。'
    : sub === 4 && (!form.loginChannelId.trim() || !form.loginChannelSecret.trim()) ? 'LINEログインのチャネルIDとチャネルシークレットを入力してください。'
    : null
  const nextBlocked = (currentStep === 1 && precheckBlocked(precheckAt, precheck, acks))
    || Boolean(missingConnectionReason)
    || (currentStep === 2 && sub === 3 && !allAcked(WEBHOOK_ACKS, acks))
    || (currentStep === 2 && sub === 4 && !allAcked(LOGIN_ACKS, acks))
    || (currentStep === 3 && sub === 1 && (!rowsOk || !providerConfirmed))
    || (currentStep === 3 && sub === 2 && (receipt.status !== 'confirmed' || receiptRequestFailed || receiptChecking))
  // v07 Fqy29／Lwxyh：②の中だけ「次のステップへ」と行き先を名前で書いた「戻る」。ほかの段は「次へ」「戻る」。
  const backLabel = currentStep === 3 && sub === 1 ? 'LINEログインへ戻る'
    : currentStep !== 2 ? '戻る'
    : sub === 1 ? '事前確認へ戻る' : sub === 2 ? 'Messaging API へ戻る' : sub === 3 ? 'プロバイダーIDへ戻る' : 'Webhook の設定へ戻る'
  const nextLabel = currentStep === 3 && sub === 1 ? '登録する' : currentStep === 2 ? '次のステップへ' : '次へ'

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="wizard" boardId={shownStep.node}>
      <PageHeading
        title="LINEアカウントを登録"
        help={shownStep.lead}
        /* ★承認済み v07 p6zMkA〜Plmq1：手順は題と説明の下の行・左寄せ（板の頭 KPoLr のあと、中身の先頭 t0FvCX）。共通の決まり Fa8ED と同じ。 */
        steps={(
          <Steps
            label="登録の進捗"
            summaryLayout="aligned"
            summaries={{ '1': '事前確認済み', '2': 'LINEの接続設定を確認済み', '3': currentStep === 5 ? '' : form.name.trim(), '4': templateKey ? ({ standard: '基本の使い方', ec: 'EC・通販', salon: 'サロン', restaurant: '飲食店', school: '教室' } as Record<string, string>)[templateKey] ?? '使い方を設定済み' : '' }}
            /* v07はアカウントを③で作るので、作ったあとも⑤へ飛ばさない。 */
            currentKey={String(currentStep)}
            steps={V8_STEPS.map((step) => ({
              key: String(step.number),
              label: step.label,
              order: step.number,
              state: currentStep > step.number ? 'done' as const : 'todo' as const,
              /* 登録する前は、済んだ段を押すとその段へ戻る（入れた値はそのまま）。登録した後は戻らない。 */
              onSelect: !createdId && currentStep > step.number ? () => { setCurrentStep(step.number); setSub(1) } : undefined,
            }))}
          />
        )}
      />
      <form className={styles.body} onSubmit={submit} noValidate aria-busy={busy || undefined}>
        <StepContent elementRef={stepPanelRef} step={currentStep * 10 + sub}>
          {recoveredAccountId ? (
            <Notice
              tone="warn"
              message={error || '保存は終わっている可能性があります。登録済みのアカウントを開いて確認してください。'}
              action={<Button href={`/accounts/detail?id=${encodeURIComponent(recoveredAccountId)}`}>登録したアカウントを見る</Button>}
              onClose={() => { setError(''); setRecoveredAccountId('') }}
            />
          ) : error ? (
            <Notice tone="danger" message={error} onClose={() => setError('')} />
          ) : null}
          {currentStep === 1 && (
            <Step1Precheck
              badge={badge}
              draftRestored={draftRestored}
              onCloseDraftNotice={() => setDraftRestored(false)}
              precheckAt={precheckAt}
              onJumpTo={(key) => { setPrecheckAt(key); setError('') }}
              precheck={precheck}
              onAnswer={answerPrecheck}
              rows={precheckRows}
              guide={precheckGuide}
              acks={acks}
              onToggleAck={acknowledgePrecheck}
            />
          )}

          {currentStep === 2 && (
            <Step2Connect
              sub={sub}
              badge={badge}
              values={form}
              fieldErrors={fieldErrors}
              touchedFields={touchedFields}
              acks={acks}
              onUpdate={update}
              onTouchField={(key) => setTouchedFields((current) => ({ ...current, [key]: true }))}
              onValidateField={validateChannelField}
              onToggleAck={toggleAck}
            />
          )}

          {currentStep === 3 && sub === 1 && (
            <CreateStepColumns data-design-node="Lwxyh" previewTitle="ここで登録します" previewLabel="登録内容を見る" preview={(
                <Card className={styles.aside} layout="vertical" surface="muted" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-aside-gap)" aria-label="ここで登録します">
                <h2 className={styles.asideH2}>ここで登録します</h2>
                <p className={styles.asideP}>5つの確認がすべて通るまで、アカウントは作られません。</p>
                <p className={styles.asideP}>止まった項目を直して、もう一度「もう一度確かめる」を押します。</p>
              </Card>
              )}>
              <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label="接続確認">
                <p className={styles.subBadge}>{badge}</p>
                <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>接続確認</h2>
                <Notice tone="info"><p>{PROVIDER_MEMBERSHIP_GUIDANCE}</p><Checkbox required checked={providerConfirmed} onCheckedChange={changeProviderConfirmation}>{PROVIDER_CONFIRMATION_LABEL}</Checkbox></Notice>
                <ul className={styles.checkList}>
                  {checkRows.map((row) => (
                    <li key={row.key} className={styles.checkRow} data-phase={row.phase}>
                      <span className={styles.checkIcon}>
                        {row.phase === 'checking' ? <span className={styles.ring} />
                          : row.phase === 'ok' ? <Check size={16} aria-hidden="true" />
                          : row.phase === 'error' ? <CircleAlert size={16} aria-hidden="true" />
                          : <CircleDashed size={16} aria-hidden="true" />}
                      </span>
                      <span className={styles.checkTitle}>{row.title}</span>
                      <span className={styles.checkDetail}>{row.detail}</span>
                    </li>
                  ))}
                </ul>
                {checkNotice && (
                  <Notice tone={checkNotice.tone} role={checkNotice.tone === 'danger' ? 'alert' : undefined}>
                    <p>{checkNotice.title}</p>
                    <p>{checkNotice.body}</p>
                  </Notice>
                )}
                <Card surface="inset" contentPadding="var(--polish-space-card)">
                  <SaveErrorField names={["importFriends","form.importFriends","import_friends","form.import_friends"]}><Checkbox checked={form.importFriends} onCheckedChange={(next) => update('importFriends', next)} description="チェックすると、登録後にいまの友だちを musubo に引き継ぎます（数分かかります）">いまの友だちの引き継ぎ</Checkbox></SaveErrorField>
                </Card>
              </Card>
            </CreateStepColumns>
          )}

          {currentStep === 3 && sub === 2 && connection && (
            <CreateStepColumns data-design-node="Lwxyh" previewTitle={receipt.status === 'confirmed' && !receiptRequestFailed ? '接続の確認' : 'ためしに友だち追加'} previewLabel={receipt.status === 'confirmed' && !receiptRequestFailed ? '確認結果を見る' : '友だち追加の方法を見る'} preview={(
                <Card className={styles.aside} layout="vertical" surface="muted" contentPadding="var(--tpl-htn-aside-pad)" gap="var(--tpl-htn-aside-gap)" aria-label={receipt.status === 'confirmed' && !receiptRequestFailed ? '接続の確認' : 'ためしに友だち追加'}>
                <h2 className={styles.asideH2}>{receipt.status === 'confirmed' && !receiptRequestFailed ? '接続の確認' : 'ためしに友だち追加'}</h2>
                {receipt.status === 'confirmed' && !receiptRequestFailed ? <p className={styles.asideP}>接続を確認できました。「次へ」を押してください。</p> : <>
                  <p className={styles.asideP}>まだ友だちでなければ、スマホの LINE で QR を読み取って追加してください。</p>
                  <p className={styles.asideP}>すでに友だちなら、この公式アカウントとのトークに「接続テスト」と送ってください。受信が確認できると次へ進めます。</p>
                </>}
              </Card>
              )}>
              <Card surface="standard" layout="vertical" contentPadding="var(--tpl-htn-panel-pad)" gap="var(--tpl-htn-panel-gap)" className={styles.panel} aria-label={receipt.status === 'confirmed' && !receiptRequestFailed ? '接続確認が完了しました' : 'ためしに友だち追加'}>
                <p className={styles.subBadge}>{badge}</p>
                <h2 data-step-heading tabIndex={-1} className={styles.panelTitle}>{receipt.status === 'confirmed' && !receiptRequestFailed ? '接続確認が完了しました' : '友だち追加できるか確かめます'}</h2>
                <Notice tone="info"><p>{PROVIDER_MEMBERSHIP_GUIDANCE}</p></Notice>
                <div className={styles.qrBlock}>
                  <div className={styles.qrFrame}>
                    {qrDataUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- QRはその場で作る data URL なので次の画像最適化は通らない。 */
                      <img src={qrDataUrl} alt="友だち追加のQRコード" width={220} height={220} />
                    ) : (
                      <p className={styles.qrWait}>QRを作っています…</p>
                    )}
                  </div>
                  <div className={styles.qrSide}>
                    <span className={styles.groupLabel}>友だち追加の窓口</span>
                    <Card layout="horizontal" surface="muted" corner="control" contentPadding="var(--space-8) var(--space-8) var(--space-8) var(--polish-space-card)" gap="var(--tpl-htn-panel-gap)">
                      <span className={styles.endpointValue} ><TruncatedText value={addFriendUrl || String(emptyValue('unknown'))} url /></span>
                      <CopyButton value={addFriendUrl || String(emptyValue('unknown'))} />
                    </Card>
                    <div className={`${styles.receiptState} ${(receiptRequestFailed || receipt.status === 'error') ? styles.receiptError : receipt.status === 'confirmed' ? styles.receiptSuccess : ''}`} role="status" aria-live="polite">
                      <p>{receiptRequestFailed ? '受信を確認できませんでした' : receipt.status === 'confirmed' ? '接続を確認できました' : receipt.status === 'error' ? '受信の確認に問題があります' : '接続を待っています…'}</p>
                      <p>{receiptRequestFailed
                        ? '通信の状態を確認しています。しばらく待っても変わらない場合は、画面を読み直してください。'
                        : receipt.status === 'confirmed'
                          ? 'このアカウントの友だち追加、またはテストメッセージを musubo で確認できました。「次へ」を押してください。'
                          : receipt.status === 'error'
                            ? '受信処理に失敗しました。設定を確認して再度お試しください。解消しない場合はサポートにお問い合わせください。'
                            : '友だち追加の通知が musubo に届くと、この画面が「接続を確認できました」に変わります。確認後に「次へ」を押してください。'}</p>
                    </div>
                    <div className={styles.receiptAccount}>
                      <span className={styles.receiptAccountIcon} aria-hidden="true">{(connection.displayName ?? form.name).slice(0, 1) || 'L'}</span>
                      <span><strong>{connection.displayName ?? form.name}</strong><br />{basicId || String(emptyValue('unknown'))}</span>
                    </div>
                    {(receipt.status !== 'confirmed' || receiptRequestFailed) && <><div className={styles.receiptInstructions}>
                      <strong>すでに友だち追加している場合</strong>
                      <p>このアカウントの LINE トークから「接続テスト」と送ってください。QR を開き直すだけでは確認できません。</p>
                    </div>
                    <p className={styles.receiptHelp}>変わらない場合は LINE Developers で Webhook の利用がオンか確認してください。</p>
                    <p className={styles.receiptHelp}><TextLink href="/hq/support" inline>変わらない場合はサポートに問い合わせ</TextLink></p>
                    </>}
                  </div>
                </div>
              </Card>
            </CreateStepColumns>
          )}

          {currentStep === 4 && (
            <>
              {registrationStyle.error ? <ListState kind="error" title="使い方を確認・保存できませんでした" error={registrationStyle.error} onRetry={registrationStyle.reload} /> : null}
              <Step4Template templateKey={templateKey} onOpen={() => setStyleDialogOpen(true)} />
              <RegistrationStyleDialog
                accountName={form.name.trim() || connection?.displayName?.trim()} accountId={registrationStyle.accountId} menu={registrationStyle.menu} onMenuChange={registrationStyle.setMenu}
                open={styleDialogOpen}
                choice={templateKey}
                busy={registrationStyle.busy}
                ready={registrationStyle.version !== null}
                error={registrationStyle.error}
                onChoose={(key) => { registrationStyle.setChoice(key); setError('') }}
                onSave={() => void finishStyle('save')}
                onSkip={() => void finishStyle('skip')}
                onClose={() => setStyleDialogOpen(false)}
              />
            </>
          )}

          {currentStep === 5 && connection && (
            <Step5Completion connection={connection} accountName={form.name.trim()} createdId={createdId} importRunning={importRunning} importFriends={form.importFriends} importState={importState} handover={handover} idleSeconds={idleSeconds} requestError={importRequestError} restaurant={templateKey === 'restaurant'} onRefresh={() => void refreshImport()} refreshing={importRefreshing} />
          )}


        </StepContent>
        <StickyBar presentation="account-registration" actions={currentStep === 5 ? <>
            {importAttention ? <Button type="button" variant="primary" busy={importRefreshing} busyLabel="確認中…" onClick={() => void refreshImport()}>状態を再確認</Button> : null}
            <Button href="/hq" variant={importAttention ? 'secondary' : 'primary'}><ArrowLeft size={16} aria-hidden="true" />統括コンソールへ戻る</Button>
          </> : currentStep === 4 ? <>
            <Button type="button" onClick={() => setStyleDialogOpen(true)} disabled={busy}>スタイルを選ぶ</Button>
            <Button type="button" onClick={() => void finishStyle('skip')} disabled={busy || registrationStyle.version === null} busy={registrationStyle.busy} busyLabel="保存しています…">あとで設定する</Button>
          </> : currentStep === 3 && sub === 1 && !rowsOk ? <>
            <Button type="button" disabled={busy || !canBack} onClick={moveBack}><ArrowLeft size={16} aria-hidden="true" />{backLabel}</Button>
            <Button type="button" variant="primary" disabled={busy || checkRunning || !providerConfirmed} disabledReason={!providerConfirmed ? PROVIDER_CONFIRMATION_REASON : undefined} onClick={() => void runCheck()} busy={busyAction === 'check'} busyLabel="確認しています…"><Plug size={16} aria-hidden="true" />{checkActionLabel({ running: checkRunning, attempted: checkAttempted, allOk: rowsOk })}</Button>
          </> : <>
            {canBack
              ? <Button type="button" disabled={busy} onClick={moveBack}><ArrowLeft size={16} aria-hidden="true" />{backLabel}</Button>
              : currentStep === 1 ? <Button href="/hq">キャンセル</Button> : null}
            {(currentStep !== 1 || precheckAt === 'done') && <Button type="submit" variant="primary" disabled={busy || nextBlocked} disabledReason={currentStep === 3 && sub === 1 && !providerConfirmed ? PROVIDER_CONFIRMATION_REASON : missingConnectionReason} busy={busyAction === 'save'} busyLabel="登録しています…">{nextLabel}<ArrowRight size={16} aria-hidden="true" /></Button>}
          </>} />
      </form>
      <NoticeLineRegisterDialog open={noticeDialog === 'open'} onClose={() => setNoticeDialog('done')} />
      {currentStep === 4 ? <RegistrationUnsavedGuard dirty={registrationStyle.dirty} busy={registrationStyle.busy} onDiscard={registrationStyle.discard} /> : null}
      {!createdId && currentStep < 4 && (form.channelSecret || form.loginChannelSecret || busyAction || checkRunning) ? <RegistrationUnsavedGuard dirty={Boolean(form.channelSecret || form.loginChannelSecret)} busy={Boolean(busyAction) || checkRunning} onDiscard={() => setForm(current => ({ ...current, channelSecret: '', loginChannelSecret: '' }))} /> : null}
      {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />}
    </PageFrame></SaveErrorScope>
  )
}
function CopyButton({ value }: { value: string }) {
  return (
    <CopyTextButton value={value} label="コピーする" variant="secondary" icon={<Copy size={16} aria-hidden="true" />} aria-label="値をコピー" disabled={value === '—'} />
  )
}
