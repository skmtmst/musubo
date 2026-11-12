'use client'

import { createPageErrorMessage, createPageReturnHref } from '@/components/shared/create-page'
import { Suspense, useEffect, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { ChevronDown, ChevronUp, Inbox, RefreshCw, Send } from 'lucide-react'
import { EC_EVENT_TYPES, ecEventLabel } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useStaffRole, canManageRole } from '@/lib/staff-role'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import Checkbox from '@/components/shared/checkbox'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Notice from '@/components/shared/notice'
import CopyTextButton from '@/components/shared/copy-text-button'
import Select from '@/components/shared/select'
import { isStepUpRequired, useStepUpGate } from '@/components/step-up-prompt'
import { MIN_SECRET_LENGTH, generateSecret } from './secret'
import { canManageWebhooksNow, captureWebhookWriteAccess } from './write-access'
import styles from './create.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 外部連携「送り先を作る」（Pencil 、競合 ）。
 *
 * 型（CreatePage）に、どちら向き・どこへ・いつ・送れなかったときのカードと、
 * 右の列（届く中身の見本・試しに送る・気をつけること）、下の帯
 * （キャンセル・下書きを保存・つくって動かす）をはめる。
 * データの口は 管理画面 と同じ（作成・本人確認・未保存の番兵）。`?event=` で見本の出来事を選んでおく。
 * 絵と今の作りが合わない所は BEHAVIOR.md に書いた（競合の口が無い・それでも送れないときの口が無い など）。
 */

/*
 * 送る出来事。正本は packages/db/src/webhooks.ts の KNOWN_OUTGOING_EVENT_TYPES。
 * 絵の箱（友だち・運用・EC）に出すのはよく使うものだけ。ほかの出来事も消さずに、
 * 「詳細条件」を開くと選べる（選んであれば最初から開いておく）。
 */
export const EVENT_GROUPS: ReadonlyArray<{ id: string; label: string; events: ReadonlyArray<{ value: string; label: string }> }> = [
  {
    id: 'friends',
    label: '友だち',
    events: [
      { value: 'friend_add', label: '友だちになった' },
      { value: 'friend_unfollow', label: '友だちを解除された' },
      { value: 'tag_change', label: 'タグが付いた' },
    ],
  },
  {
    id: 'operation',
    label: '運用',
    events: [
      { value: 'message_received', label: '問い合わせが来た' },
      { value: 'booking_created', label: '予約が入った' },
    ],
  },
  {
    id: 'ec',
    label: 'EC',
    events: [
      { value: 'ec.order.confirmed', label: '注文が確定した' },
      { value: 'ec.order.shipped', label: '発送した' },
    ],
  },
]
const PRIMARY_EVENTS = new Set(EVENT_GROUPS.flatMap((group) => group.events.map((event) => event.value)))
export const OTHER_EVENTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'form_submitted', label: 'フォームが送られた' },
  { value: 'postback_received', label: 'ボタンが押された' },
  { value: 'staff_assigned', label: '担当が決まった' },
  { value: 'manual_reply_sent', label: '個別に返信した' },
  { value: 'cv_fire', label: '成果地点が起きた' },
  ...EC_EVENT_TYPES.filter((value) => !PRIMARY_EVENTS.has(value)).map((value) => ({ value, label: ecEventLabel(value) })),
]
const ALL_EVENTS = [...PRIMARY_EVENTS, ...OTHER_EVENTS.map((event) => event.value)]

const RETRY_OPTIONS = [
  { value: '0', label: '送り直さない' },
  { value: '1', label: '1 回まで' },
  { value: '3', label: '3 回まで（1分・5分・30分あと）' },
  { value: '7', label: '7 回まで' },
]

/* 届く中身の見本（実際に送る形の例。値は見本と分かるもの）。1行ずつ持つ。 */
const SAMPLES: Record<string, { when: string; lines: string[] }> = {
  friend_add: {
    when: '友だちになったとき',
    lines: ['{', '  "できごと": "友だちになった",', '  "友だちID": "U4af…",', '  "名前": "Demo Person",', '  "タグ": ["Instagram"],', '  "日時": "2026-09-30T10:12"', '}'],
  },
  booking_created: {
    when: '予約が入ったとき',
    lines: ['{', '  "できごと": "予約が入った",', '  "予約ID": "bk_8f2…",', '  "メニュー": "カウンセリング 30分",', '  "友だち": "Masato S."', '}'],
  },
  'ec.order.confirmed': {
    when: '注文が確定したとき',
    lines: ['{', '  "できごと": "注文が確定した",', '  "注文番号": "ord_123…",', '  "金額": 4980,', '  "友だち": "見本 15"', '}'],
  },
}

/* 1欄ずつの確かめ。文は「何をすれば直るか」を1文で書く。 */
const nameRequirement = { required: true, check: validateName }
const urlRequirement = { required: true, check: validateUrl }
function validateName(value: string): string | null {
  return value.trim() ? null : '名前を入力してください'
}
function validateUrl(value: string): string | null {
  return /^https:\/\//.test(value.trim()) ? null : 'URLは https:// で始めてください'
}
function validateSecret(value: string): string | null {
  return value.length >= MIN_SECRET_LENGTH ? null : `秘密の鍵は${MIN_SECRET_LENGTH}文字以上にしてください`
}

/* useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。入口が包まなくても動くよう、ここで包む。 */
export default function WebhooksCreateV8() {
  return (
    <Suspense fallback={null}>
      <WebhooksCreateV8Inner />
    </Suspense>
  )
}

function WebhooksCreateV8Inner() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('送り先を作る')
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const accountRef = useRef(selectedAccountId)
  /* WEB232：作れたが止められなかった送り先（下書きのつもりで、いまは動いている）。 */
  const createdActiveRef = useRef<{ id: string; accountId: string } | null>(null)
  accountRef.current = selectedAccountId
  const searchParams = useSearchParams()
  const presetEvent = searchParams.get('event')
  const presetValid = Boolean(presetEvent && ALL_EVENTS.includes(presetEvent))
  const staffRole = useStaffRole()

  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState(generateSecret)
  /* 既定は「選んだものだけ送る」。すべて送ると要らない個人情報まで出るので、選んでもらう。 */
  const [sendAll, setSendAll] = useState(false)
  const [selectedEvents, setSelectedEvents] = useState<string[]>(presetValid && presetEvent ? [presetEvent] : [])
  const [incomingSources, setIncomingSources] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(Boolean(presetValid && presetEvent && !PRIMARY_EVENTS.has(presetEvent)))
  const [maxRetries, setMaxRetries] = useState('3')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const { gate, prompt: stepUpPrompt, cancel: cancelStepUp } = useStepUpGate()

  useEffect(() => { cancelStepUp() }, [selectedAccountId, cancelStepUp])

  const initialSecretRef = useRef(secret)
  const dirty = Boolean(
    name || url || incomingSources || maxRetries !== '3'
    || secret !== initialSecretRef.current
    || sendAll
    || selectedEvents.join(',') !== (presetValid && presetEvent ? presetEvent : ''),
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  const validate = (): Record<string, string> => {
    const errors: Record<string, string> = {}
    const nameError = nameRequirement.check(name)
    if (nameError) errors.name = nameError
    const urlError = urlRequirement.check(url)
    if (urlError) errors.url = urlError
    const secretError = validateSecret(secret)
    if (secretError) errors.secret = secretError
    if (!sendAll && selectedEvents.length === 0 && !incomingSources.trim()) {
      errors.events = '送るものを選ぶか、「すべて送る」を選んでください'
    }
    return errors
  }

  /* 欄から離れたときの確かめ。触った欄だけその場で教え、直したらその場で消す。 */
  const blurField = (key: 'name' | 'url' | 'secret', value?: string) => {
    const current = value ?? (key === 'name' ? name : key === 'url' ? url : secret)
    const message = key === 'name' ? validateName(current) : key === 'url' ? validateUrl(current) : validateSecret(current)
    setFieldErrors((prev) => {
      if (!message) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      return prev[key] === message ? prev : { ...prev, [key]: message }
    })
  }

  const toggleEvent = (value: string) => {
    setSelectedEvents((current) => (current.includes(value) ? current.filter((item) => item !== value) : [...current, value]))
  }

  async function save(next: 'draft' | 'active') {
    if (!canManageWebhooksNow()) {
      setError(permissionDeniedMessage('store'))
      return
    }
    const canContinue = captureWebhookWriteAccess()
    const accountId = selectedAccountId
    if (!accountId || accountRef.current !== accountId) {
      setError('上のバーでLINE公式アカウントを選んでください')
      return
    }
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setError(null)
      requestAnimationFrame(() => {
        const first = document.getElementById(`wh-new-${Object.keys(errors)[0]}`)
        first?.focus()
        first?.scrollIntoView?.({ block: 'center' })
      })
      return
    }
    setSaving(true)
    setError(null)
    /*
     * WEB232：前の「下書きを保存」で作れたのに止められなかった送り先がある。もう一度作らず、
     * 止めるところだけやり直す。停止状態を返さない場合にも再試行できる。
     */
    const pendingStop = createdActiveRef.current
    if (next === 'active' && pendingStop && pendingStop.accountId === accountId) {
      // もう作れていて動いている。同じ送り先をもう1つ作らない。
      createdActiveRef.current = null
      router.push(createPageReturnHref('/webhooks', pendingStop.id))
      return
    }
    if (next === 'draft' && pendingStop && pendingStop.accountId === accountId) {
      try {
        const stop = await api.webhooks.outgoing.update(pendingStop.id, accountId, { isActive: false })
        if (!stop.success) throw new Error(stop.error)
        createdActiveRef.current = null
        router.push(createPageReturnHref('/webhooks', pendingStop.id))
      } catch (saveFailure) {
        const fieldFailure = saveErrors.capture(saveFailure)

        { if (!fieldFailure)


        setError('送り先は作れましたが、まだ止められていません（いまは動いています）。もう一度「下書きを保存」を押すと、止めるところだけやり直します。') }
        setSaving(false)
      }
      return
    }
    try {
      const payload = {
        lineAccountId: accountId,
        isActive: next === 'active',
        name: name.trim(),
        url: url.trim(),
        eventTypes: sendAll
          ? ['*']
          : [
              ...selectedEvents,
              ...incomingSources.split(',').map((value) => value.trim()).filter(Boolean).map((value) => `incoming_webhook.${value}`),
            ],
        secret,
        maxRetries: Number(maxRetries) || 0,
      }
      const create = (stepUpToken?: string) => {
        if (!canContinue() || accountRef.current !== accountId) throw new Error('権限やLINEアカウントが変わったため中止しました。')
        return api.webhooks.outgoing.create(payload, stepUpToken)
      }
      let res
      try {
        res = await create()
      } catch (caught) {
        saveErrors.capture(caught);

        if (!isStepUpRequired(caught)) {
          if (caught instanceof ApiError && caught.status === 403) throw new Error(permissionDeniedMessage('store'))
          throw caught
        }
        const token = await gate('webhook.secret', 'Webhookを登録する')
        if (!token) throw caught
        if (accountRef.current !== accountId) throw new Error('LINEアカウントが切り替わりました。登録せずに止めました。もう一度やり直してください。')
        res = await create(token)
      }
      if (!res.success) throw new Error(res.error)
      if (next === 'draft' && res.data.isActive !== false) {
        // 停止状態を返さない古い API では、作成後に停止を確認する。
        // WEB232：止められなかったら一覧へ移らず、この画面で知らせて、止めるところだけやり直せるようにする。
        createdActiveRef.current = { id: res.data.id, accountId }
        let stopped = false
        try {
          if (!canContinue() || accountRef.current !== accountId) throw new Error('権限やLINEアカウントが変わったため中止しました。')
          const stop = await api.webhooks.outgoing.update(res.data.id, accountId, { isActive: false })
          stopped = stop.success
        } catch (saveFailure) {
          saveErrors.capture(saveFailure)
          stopped = false
        }
        if (!stopped) {
          throw new Error('送り先は作れましたが、まだ止められていません（いまは動いています）。もう一度「下書きを保存」を押すと、止めるところだけやり直します。')
        }
        createdActiveRef.current = null
      }
      router.push(createPageReturnHref('/webhooks', res.data.id))
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)


      setError(createPageErrorMessage(cause)) }
      setSaving(false)
    }
  }

  const sampleKey = selectedEvents.find((value) => SAMPLES[value]) ?? 'friend_add'
  const sample = SAMPLES[sampleKey]

  /* 作成の入口の許可は保ち、本人が確定するまでは入力を始めない。 */
  if (!canManageRole(staffRole)) {
    return (
      <SaveErrorScope errors={saveErrors}><CreatePage
        boardId="hsD8e"
        title="送り先を作る"
        help="友だちの動きを、決めたタイミングでほかのシステムへ送ります。試しに送ってから動かすと安心です。"
        readOnly footerActions={<Button href="/webhooks">一覧へ戻る</Button>} dirty={false}
      >
        {null}
      </CreatePage></SaveErrorScope>
    )
  }

  const preview = (
    <div className={styles.side}>
      <Card spacing="preview" aria-labelledby="wh-new-sample">
        <CardHeader size="stacked" titleId="wh-new-sample" title="届く中身の見本" />
        <p className={styles.sideNote}>{sample.when}</p>
        <div className={styles.sampleBox} aria-label="届く中身の見本">
          {sample.lines.map((line, index) => <div key={index} className={styles.sampleLine}>{line}</div>)}
        </div>
      </Card>
      <Card spacing="preview" aria-labelledby="wh-new-test">
        <CardHeader size="stacked" titleId="wh-new-test" title="試しに送る" />
        <p className={styles.sideNote}>見本の中身を1回だけ送ります</p>
        <div>
          <Button disabled title="送り先を作ってから送れます（一覧の「設定 → 試しに送る」）"><Send size={16} aria-hidden="true" />試しに送る</Button>
        </div>
      </Card>
      <Card spacing="preview" aria-labelledby="wh-new-care">
        <CardHeader size="stacked" titleId="wh-new-care" title="気をつけること" />
        <p className={styles.careText}>
          ・作り直すと、前の鍵では届かなくなります<br />
          ・個人情報は必要なものだけ送ります
        </p>
      </Card>
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="hsD8e"
      title="送り先を作る"
      help="友だちの動きを、決めたタイミングでほかのシステムへ送ります。試しに送ってから動かすと安心です。"
      previewLabel="送るデータを見る"
      previewTitle="送るデータの見本"
      preview={preview}
      status="下書き（まだ動いていません）"
      footerActions={(
        <>
          <Button href="/webhooks">キャンセル</Button>
          <Button disabled={saving} onClick={() => void save('draft')} busy={saving}>下書きを保存</Button>
          <Button variant="primary" disabled={saving} onClick={() => void save('active')} busy={saving}>つくって動かす</Button>
        </>
      )} dirty={false}
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card variant="form" aria-labelledby="wh-new-direction">
        <CardHeader size="stacked" titleId="wh-new-direction" title="どちら向きの連携か" />
        <SaveErrorField names={["wh-new-direction","direction"]}><RadioCardGroup legend="どちら向きの連携か" className={styles.cardRow}>
          <RadioCard
            name="wh-new-direction"
            value="outgoing"
            checked={direction === 'outgoing'}
            onChange={() => setDirection('outgoing')}
            icon={<Send size={16} aria-hidden="true" />}
            title="こちらから送る"
            note="友だちの動きをほかへ知らせる"
            className={styles.dirCard}
          />
          <RadioCard
            name="wh-new-direction"
            value="incoming"
            checked={direction === 'incoming'}
            onChange={() => setDirection('incoming')}
            icon={<Inbox size={16} aria-hidden="true" />}
            title="こちらで受け取る"
            note="ほかからの知らせを受け取る"
            className={styles.dirCard}
          />
        </RadioCardGroup></SaveErrorField>
        {direction === 'incoming' ? (
          <p className={styles.cardNote}>
            受け取り口はこの画面では作れません。<Link href="/webhooks?tab=incoming" className={styles.inlineLink}>「こちらで受け取る」から作ってください</Link>。
          </p>
        ) : null}
      </Card>

      <Card variant="form" aria-labelledby="wh-new-dest">
        <CardHeader size="stacked" titleId="wh-new-dest" title="どこへ送りますか" />
        <Field requirement={nameRequirement} label="名前" htmlFor="wh-new-name" error={fieldErrors.name}>
          <SaveErrorField names={["name"]}><TextField
            id="wh-new-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              if (fieldErrors.name && validateName(event.target.value) === null) blurField('name', event.target.value)
            }}
            onBlur={() => blurField('name')}
            placeholder="顧客台帳（CRM）"
            aria-invalid={fieldErrors.name ? true : undefined}
            required
          /></SaveErrorField>
        </Field>
        <Field requirement={urlRequirement} label="送り先の URL" htmlFor="wh-new-url" error={fieldErrors.url}>
          <SaveErrorField names={["url"]}><TextField
            id="wh-new-url"
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              if (fieldErrors.url && validateUrl(event.target.value) === null) blurField('url', event.target.value)
            }}
            onBlur={() => blurField('url')}
            placeholder="https://crm.example.com/line/hook"
            aria-invalid={fieldErrors.url ? true : undefined}
            required
          /></SaveErrorField>
        </Field>
        <div className={styles.secretRow}>
          <div className={styles.grow}>
            <Field required label="秘密の鍵" htmlFor="wh-new-secret" error={fieldErrors.secret}>
            <SaveErrorField names={["secret"]}><TextField
              id="wh-new-secret"
              value={secret}
              readOnly
              aria-invalid={fieldErrors.secret ? true : undefined}
              required
            /></SaveErrorField>
          </Field>
          </div>
          <CopyTextButton value={secret} label="コピー" variant="secondary" aria-label="秘密の鍵をコピー" />
          <Button type="button" onClick={() => {
            const next = generateSecret()
            setSecret(next)
            saveErrors.clear('secret')
            if (fieldErrors.secret) blurField('secret', next)
          }}><RefreshCw size={16} aria-hidden="true" />作り直す</Button>
        </div>
        <Notice tone="warn" marker="dot">保存すると秘密の鍵は二度と表示されません。今コピーしてください。</Notice>
      </Card>

      <Card variant="form" aria-labelledby="wh-new-when">
        <CardHeader size="stacked" titleId="wh-new-when" title="いつ送りますか" meta="選んだできごとが起きるたびに送ります" />
        <div id="wh-new-events" tabIndex={-1} aria-invalid={Boolean(fieldErrors.events) || undefined} aria-describedby={fieldErrors.events ? "wh-new-events-error" : undefined}>
        <SaveErrorField names={["wh-new-mode","sendAll"]}><RadioCardGroup legend="送る範囲" className={styles.radioRow}>
          <RadioCard variant="row" invalid={Boolean(fieldErrors.events)} name="wh-new-mode" value="all" checked={sendAll} onChange={() => setSendAll(true)} title="すべて送る" />
          <RadioCard variant="row" invalid={Boolean(fieldErrors.events)} name="wh-new-mode" value="selected" checked={!sendAll} onChange={() => setSendAll(false)} title="選んだものだけ送る" />
        </RadioCardGroup></SaveErrorField>
        {fieldErrors.events ? <p id="wh-new-events-error" className={styles.fieldError} role="alert">{fieldErrors.events}</p> : null}
        </div>
        {!sendAll ? (
          <>
            {EVENT_GROUPS.map((group) => (
              <Card key={group.id} surface="muted" padding="compact" layout="vertical" gap="tight">
                <p className={styles.eventGroupTitle}>{group.label}</p>
                <div className={styles.eventChecks}>
                  {group.events.map((event, saveFieldIndex) => (
                    <SaveErrorField names={[`events.${saveFieldIndex}.value`,"value","event.value"]} key={event.value}><Checkbox key={event.value} checked={selectedEvents.includes(event.value)} onCheckedChange={() => toggleEvent(event.value)}>
                      {event.label}
                    </Checkbox></SaveErrorField>
                  ))}
                </div>
              </Card>
            ))}
            <div>
              <Button variant="text" textTone="ink" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
                {detailsOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}詳細条件
              </Button>
            </div>
            {detailsOpen ? (
              <Card surface="muted" padding="compact" layout="vertical" gap="tight">
                <p className={styles.eventGroupTitle}>ほかの出来事</p>
                <div className={styles.eventChecks}>
                  {OTHER_EVENTS.map((event, saveFieldIndex) => (
                    <SaveErrorField names={[`OTHER_EVENTS.${saveFieldIndex}.value`,"value","event.value"]} key={event.value}><Checkbox key={event.value} checked={selectedEvents.includes(event.value)} onCheckedChange={() => toggleEvent(event.value)}>
                      {event.label}
                    </Checkbox></SaveErrorField>
                  ))}
                </div>
              </Card>
            ) : null}
            {detailsOpen ? (
              <div className={styles.field}><Field label="受け取った知らせも送る（受け取り口の種類。カンマで区切る）" htmlFor="wh-new-incoming"><SaveErrorField names={["incomingSources","incoming_sources"]}><TextField
                  id="wh-new-incoming"
                  value={incomingSources}
                  onChange={(event) => setIncomingSources(event.target.value)}
                  placeholder="例：form, booking"
                /></SaveErrorField></Field></div>
            ) : null}
          </>
        ) : null}
      </Card>

      <Card variant="form" aria-labelledby="wh-new-retry">
        <CardHeader size="stacked" titleId="wh-new-retry" title="送れなかったとき" />
        <div className={styles.pickRow}>
          <div className={styles.field}>
            <span className={styles.pickLabel} id="wh-new-retries-label">やり直し</span>
            <SaveErrorField names={["maxRetries","max_retries"]}><Select aria-label="やり直し" size="full" value={maxRetries} onChange={(value) => setMaxRetries(value)} options={RETRY_OPTIONS} /></SaveErrorField>
          </div>
          <span className={styles.field} aria-hidden="true" />
        </div>
      </Card>

      {stepUpPrompt}
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した送り先" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </CreatePage></SaveErrorScope>
  )
}
