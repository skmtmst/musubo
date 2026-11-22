'use client'

/*
 * ★V8 飲食店向け 店舗を追加（Pencil：①利用規約への同意 ・②店舗の基本情報 ）。
 * ③LINE公式アカウントを作る・④Messaging APIで接続・⑤接続の確認は絵がまだ無いので、①②と同じ形で置く。
 *
 * 板の頭（題・「ステップ n / 5」）→ 手順の帯（5つ）→ 左：手順の中身／右：わからないときは（幅340）
 * → 下の線の下にキャンセル・次へ（中央）。口と決まりは今の画面（app/restaurant-test/stores/new）と同じ。
 * 動きは BEHAVIOR.md。
 */
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type ReactNode, type ReactElement } from 'react'
import { ArrowRight, BookOpen, CircleCheck } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import { TERMS_DOCUMENT } from '@/content/terms/musubo-terms'
import { MANUAL_LINKS } from '@/lib/manual-links'
import { useTaskManualHref } from '@/lib/use-manual-href'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { Steps, StepContent } from '@/components/templates/steps'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import { Field as SharedField } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import TermsBody from './terms-body'
import { LEGAL_LINKS } from '@/lib/auth-email'
import { canSubmitTerms, formatAgreedAt, hasReadTerms, initialWizardStep, STEP } from './terms-state'
import styles from './store-new.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

const STEPS = [
  ['利用規約への同意', 'musubo の利用規約と、個人情報の取扱いをご確認ください。'],
  ['店舗の基本情報', '店舗名と、管理画面で使う略称を入力します。'],
  ['LINE公式アカウントを作る', 'LINE側で店舗専用の公式アカウントを用意します。'],
  ['Messaging APIで接続', 'チャネルIDとチャネルシークレットを確認します。'],
  ['接続の確認', 'LINEへ接続し、店舗を登録します。'],
] as const

const ONBOARDING_GUIDE_KEY = 'onboarding-line-guide'
const PROVIDER_NOTE = '店舗ごとに、新しいプロバイダーを作ってください。LINE のユーザーIDはプロバイダーごとに発行されます。複数の店舗を同じプロバイダーにまとめると、同じお客様を店舗ごとに別々に管理できなくなります。'

type FieldErrors = Partial<Record<'name' | 'channelId' | 'channelSecret', string>>

/** 見出しと入力を結ぶ（R174：読み上げの項目名・補足・エラーを結ぶのは今の画面と同じ）。 */
function Field({ label, required, help, error, children }: { label: string; required: boolean; help?: string; error?: string; children: ReactNode }) {
  const baseId = useId()
  const inputId = `${baseId}-input`
  const helpId = `${baseId}-help`
  const errorId = `${baseId}-error`
  const describedBy = error ? `${helpId} ${errorId}` : helpId
  // SaveErrorField wraps the input. Attach the explanation to the input itself.
  const controlProps = { id: inputId, 'aria-describedby': describedBy, 'aria-required': required || undefined, ...(error ? { 'aria-invalid': true as const } : null) }
  const wrapped = isValidElement<{ children?: ReactNode }>(children) ? children.props.children : null
  const field = isValidElement(wrapped) && isValidElement<{ children?: ReactNode }>(children)
    ? cloneElement(children, { children: cloneElement(wrapped as ReactElement<Record<string, unknown>>, controlProps) })
    : isValidElement(children) ? cloneElement(children as ReactElement<Record<string, unknown>>, controlProps) : children
  return <SharedField label={label} htmlFor={inputId} required={required} help={help}>{field}<span id={helpId} className="sr-only">{help || '空欄なら店舗名を使います'}</span>{error ? <p id={errorId} role="alert" className={styles.error}>{error}</p> : null}</SharedField>
}

/** マニュアルへの道。URL が決まっている時だけ出す（押しても行き先が無いボタンを置かない）。 */
function ManualButton({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return null
  return <Button external href={href} className={styles.helpButton}><BookOpen aria-hidden className={styles.icon15} />{children}</Button>
}

function HelpPanel({ step }: { step: number }) {
  /* 「アカウント作成方法・連携ガイド」は正本表の手順キー（①同意 ・②基本情報  で共通）。 */
  const guideHref = useTaskManualHref(ONBOARDING_GUIDE_KEY)
  const faq = <><p className={styles.helpSub}>よくある質問</p><p className={styles.faq}>{'・「Messaging APIを利用する」ボタンが表示されません\n・チャネルシークレットが正しくないと表示されます'}</p></>
  return (
    <aside className={styles.helpPanel} aria-label="わからないときは">
      <h2 className={styles.helpTitle}>わからないときは</h2>
      <p className={styles.helpText}>今の手順に対応するマニュアルを確認できます。</p>
      {step === STEP.OFFICIAL_ACCOUNT ? (
        <>
          <ManualButton href={MANUAL_LINKS.createOfficialAccount}>LINE公式アカウントを作る</ManualButton>
          <Notice tone="warn">{PROVIDER_NOTE}</Notice>
        </>
      ) : step === STEP.CREDENTIALS ? (
        <>
          <ManualButton href={MANUAL_LINKS.enableMessagingApi}>Messaging APIを有効にする</ManualButton>
          <ManualButton href={MANUAL_LINKS.findChannelCredentials}>2つの値の場所を見る</ManualButton>
          {faq}
        </>
      ) : step === STEP.CONNECT ? (
        <><p className={styles.helpSub}>よくある質問</p><p className={styles.helpText}>接続できない場合は、1つ前の手順へ戻り、LINE Developersから値をコピーし直してください。</p></>
      ) : (
        <>
          <ManualButton href={guideHref}>アカウント作成方法・連携ガイド</ManualButton>
          {faq}
        </>
      )}
    </aside>
  )
}

/** ①の同意：枠の中の規約を最後まで読む → チェック → 下の「同意して次へ進む」。 */
function useTermsReading() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [readToEnd, setReadToEnd] = useState(false)
  const evaluate = useCallback(() => {
    const element = scrollRef.current
    if (element && hasReadTerms(element)) setReadToEnd(true)
  }, [])
  useEffect(() => {
    evaluate()
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(evaluate)
    observer.observe(element)
    return () => observer.disconnect()
  }, [evaluate])
  return { scrollRef, readToEnd, evaluate }
}

export default function StoreNewV8() {
  const saveErrors = useSaveFormErrors()

  usePageTitle('店舗を追加')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'アカウント', href: '/hq' }])
  const router = useRouter()
  const { selectedAccountId } = useAccount()
  const [step, setStep] = useState<number>(STEP.TERMS)
  const [termsAgreedAt, setTermsAgreedAt] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [officialAccountReady, setOfficialAccountReady] = useState(false)
  const [channelId, setChannelId] = useState('')
  const [channelSecret, setChannelSecret] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [connectionError, setConnectionError] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<{ id: string; storeName: string; lineAccountName: string } | null>(null)
  const [termsChecked, setTermsChecked] = useState(false)
  const [agreeing, setAgreeing] = useState(false)
  const [agreeError, setAgreeError] = useState('')
  const { scrollRef, readToEnd, evaluate } = useTermsReading()

  /* R161：入力が残っている間は未保存として、離れる操作では確認を出す（今の画面と同じ）。 */
  const dirty = created === null && (name !== '' || alias !== '' || officialAccountReady || channelId !== '' || channelSecret !== '')
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  useEffect(() => {
    let active = true
    setTermsAgreedAt(null)
    setStep(STEP.TERMS)
    void restaurantTestApi.termsAgreement(selectedAccountId).then((response) => {
      if (!active) return
      const nextStep = initialWizardStep(response.data.agreedVersion)
      setTermsAgreedAt(nextStep === STEP.BASICS ? response.data.agreedAt : null)
      setStep(nextStep)
    }).catch(() => {
      if (!active) return
      setTermsAgreedAt(null)
      setStep(STEP.TERMS)
    })
    return () => { active = false }
  }, [selectedAccountId])

  const agree = async () => {
    if (!canSubmitTerms(readToEnd, termsChecked) || agreeing) return
    setAgreeing(true)
    setAgreeError('')
    try {
      const response = await restaurantTestApi.agreeToTerms(selectedAccountId, TERMS_DOCUMENT.key, TERMS_DOCUMENT.version)
      setTermsAgreedAt(response.data.agreedAt)
      setStep(STEP.BASICS)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure) setAgreeError(describeApiFailure(caught, '保存')) }
    } finally {
      setAgreeing(false)
    }
  }

  const nextFromBasics = () => {
    if (!name.trim()) { setErrors({ name: '店舗名を入力してください。' }); return }
    setErrors({})
    setStep(STEP.OFFICIAL_ACCOUNT)
  }

  const nextFromCredentials = () => {
    const next: FieldErrors = {}
    if (!channelId.trim()) next.channelId = 'チャネルIDを入力してください。'
    if (!channelSecret.trim()) next.channelSecret = 'チャネルシークレットを入力してください。'
    setErrors(next)
    if (Object.keys(next).length === 0) setStep(STEP.CONNECT)
  }

  const connect = async () => {

    setSaving(true)
    setConnectionError('')
    try {
      const response = await restaurantTestApi.connectStore(selectedAccountId, { name: name.trim(), alias: alias.trim(), channelId: channelId.trim(), channelSecret: channelSecret.trim() })
      setCreated({ id: response.data.store.id, storeName: response.data.store.name, lineAccountName: response.data.lineAccountName })
      setChannelSecret('')
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure) setConnectionError(describeApiFailure(caught, '読み込み')) }
    } finally {
      setSaving(false)
    }
  }

  const enterStore = async () => {
    if (!selectedAccountId || !created) return
    setSaving(true)
    try {
      await restaurantTestApi.selectStore(selectedAccountId, created.id)
      router.push('/restaurant-test/dashboard')
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure) setConnectionError(describeApiFailure(caught, '切り替え')) }
      setSaving(false)
    }
  }

  const agreedLabel = formatAgreedAt(termsAgreedAt)
  const disabledReason = !readToEnd ? '利用規約を最後までお読みください。' : !termsChecked ? '同意する場合は、チェックを入れてください。' : ''

  const footer = (() => {
    if (step === STEP.TERMS) {
      return <>
        <Button href="/hq">キャンセル</Button>
        <Button variant="primary" disabled={!canSubmitTerms(readToEnd, termsChecked) || agreeing} onClick={() => agree()} busy={agreeing} busyLabel="同意を記録中…">同意して次へ進む<ArrowRight aria-hidden className={styles.icon15} /></Button>
      </>
    }
    if (step === STEP.BASICS) return <><Button href="/hq">キャンセル</Button><Button variant="primary" onClick={nextFromBasics}>次へ<ArrowRight aria-hidden className={styles.icon15} /></Button></>
    if (step === STEP.OFFICIAL_ACCOUNT) return <><Button onClick={() => setStep(STEP.BASICS)}>戻る</Button><Button variant="primary" disabled={!officialAccountReady} onClick={() => setStep(STEP.CREDENTIALS)}>次へ<ArrowRight aria-hidden className={styles.icon15} /></Button></>
    if (step === STEP.CREDENTIALS) return <><Button onClick={() => setStep(STEP.OFFICIAL_ACCOUNT)}>戻る</Button><Button variant="primary" onClick={nextFromCredentials}>次へ<ArrowRight aria-hidden className={styles.icon15} /></Button></>
    if (created) {
      return selectedAccountId
        ? <Button variant="primary" disabled={saving} onClick={() => enterStore()} busy={Boolean(saving)} busyLabel="処理中…">この店舗の管理画面へ</Button>
        : <Button href="/hq">統括の店舗一覧へ</Button>
    }
    return <><Button disabled={saving} onClick={() => setStep(STEP.CREDENTIALS)}>戻る</Button><Button variant="primary" disabled={saving} onClick={() => connect()} busy={Boolean(saving)} busyLabel="接続を確認中…">アカウントセットアップ実行</Button></>
  })()

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="list" boardId={step === STEP.TERMS ? 'ao15G' : step === STEP.BASICS ? 'faGn4' : undefined}>
      <PageHeading
        title="店舗を追加"
        help={`LINEへ接続し、店舗を登録します。ステップ ${step} / 5`}
        steps={(
          <Steps
            label="店舗を追加する手順"
            readOnly={Boolean(created)}
            summaries={{ '1': '利用規約に同意済み', '2': [name, alias].filter(Boolean).join('・'), '3': '公式アカウントを準備済み', '4': '接続するチャネルを設定済み' }}
            currentKey={created ? undefined : String(step)}
            steps={STEPS.map(([title], index) => {
              const number = index + 1
              const complete = number === STEP.TERMS ? Boolean(termsAgreedAt) || Boolean(created) : number < step || Boolean(created)
              return {
                key: String(number),
                label: title,
                order: number,
                state: complete ? 'done' as const : 'todo' as const,
                /* 済んだ段を押すとその段へ戻る。①（利用規約）は同意した規約を読み直す画面へ。作った後は戻らない。 */
                onSelect: !complete ? undefined
                  : number === STEP.TERMS ? () => router.push('/restaurant-test/terms')
                    : created ? undefined : () => setStep(number),
              }
            })}
          />
        )}
      />
      <StepContent step={step} className={styles.body}>
        <div className={styles.split}>
          <section className={styles.card} aria-labelledby="store-new-step-title">
            <h2 id="store-new-step-title" className={styles.cardTitle}>{STEPS[step - 1][0]}</h2>
            <p className={styles.cardText}>{STEPS[step - 1][1]}</p>

            {step === STEP.TERMS ? (
              <>
                <div ref={scrollRef} onScroll={evaluate} tabIndex={0} role="region" aria-label="利用規約" className={styles.termsBox}>
                  <TermsBody size="compact" />
                </div>
                <div className={styles.termsRow}>
                  {disabledReason ? <p className={styles.reason}>{disabledReason}</p> : null}
                  <span className={styles.spacer} aria-hidden="true" />
                  <Button external href={LEGAL_LINKS.terms ?? undefined}>正式サイトの利用規約を読む</Button>
                </div>
                <SaveErrorField names={["termsChecked"]}><Checkbox checked={termsChecked} disabled={!readToEnd || agreeing} onCheckedChange={setTermsChecked}>上記の利用規約および個人情報の取扱いに同意します</Checkbox></SaveErrorField>
                {agreeError ? <Notice tone="danger" >{agreeError}</Notice> : null}
              </>
            ) : null}

            {step === STEP.BASICS ? (
              <>
                <Field label="店舗名" required help="店舗名はあとから店舗設定で変更できます。" error={errors.name}>
                  <SaveErrorField names={["name"]}><TextField value={name} onChange={(event) => setName(event.target.value)} autoComplete="organization" /></SaveErrorField>
                </Field>
                <Field label="店舗の略称" required={false} error={undefined}>
                  <SaveErrorField names={["alias"]}><TextField value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="空欄なら店舗名を使います" /></SaveErrorField>
                </Field>
                <Notice tone="warn">{PROVIDER_NOTE}</Notice>
                {termsAgreedAt ? <p className={styles.agreed}><CircleCheck aria-hidden className={styles.checkIcon} />{`利用規約に同意済み${agreedLabel ? `（${agreedLabel}）` : ''}`}</p> : null}
              </>
            ) : null}

            {step === STEP.OFFICIAL_ACCOUNT ? (
              <>
                <div className={styles.grayBox}>
                  <p className={styles.grayTitle}>まずはLINE公式アカウントの登録を行いましょう。</p>
                  <p className={styles.cardText}>LINE公式アカウントをお持ちでない方は、LINE for Businessから無料で店舗専用のアカウントを開設してください。作成後、この画面へ戻ってチェックを入れます。</p>
                </div>
                <SaveErrorField names={["officialAccountReady"]}><Checkbox checked={officialAccountReady} onCheckedChange={setOfficialAccountReady}>LINE公式アカウントを作成済みです</Checkbox></SaveErrorField>
              </>
            ) : null}

            {step === STEP.CREDENTIALS ? (
              <>
                <Notice tone="info">
                  LINE公式アカウントのチャネルIDとチャネルシークレットを使用して、アカウントセットアップを行います。
                </Notice>
                <Field label="チャネルID" required help="LINE Developersの「チャネル基本設定」にある数字をコピーしてください。" error={errors.channelId}>
                  <SaveErrorField names={["channelId"]}><TextField value={channelId} onChange={(event) => setChannelId(event.target.value)} inputMode="numeric" autoComplete="off" /></SaveErrorField>
                </Field>
                <Field label="チャネルシークレット" required help="同じ「チャネル基本設定」のチャネルシークレットをコピーしてください。保存後、この値は画面に表示されません。" error={errors.channelSecret}>
                  <SaveErrorField names={["channelSecret"]}><TextField type="password" value={channelSecret} onChange={(event) => setChannelSecret(event.target.value)} autoComplete="new-password" /></SaveErrorField>
                </Field>
              </>
            ) : null}

            {step === STEP.CONNECT ? (
              created ? (
                <>
                  <Notice tone="success">
                    <p className={styles.doneTitle}>接続できました</p>
                    <p className={styles.cardText}>{`「${created.storeName}」とLINE公式アカウント「${created.lineAccountName}」を登録しました。`}</p>
                  </Notice>
                  {connectionError ? <Notice tone="danger" className={styles.errorBoxNoticePlacement} >{connectionError}</Notice> : null}
                </>
              ) : (
                <>
                  <div className={styles.grayBox}>
                    <p className={styles.grayTitle}>以下のLINE公式アカウントのセットアップを行います。</p>
                    <p className={styles.cardText}>トークンとボット表示名を取得できた場合だけ、店舗とLINE公式アカウントをまとめて登録します。</p>
                    <dl className={styles.summary}>
                      <div><dt className={styles.help}>店舗名</dt><dd className={styles.summaryValue}>{name}</dd></div>
                      <div><dt className={styles.help}>店舗の略称</dt><dd className={styles.summaryValue}>{alias || name}</dd></div>
                    </dl>
                  </div>
                  {connectionError ? <Notice tone="danger" className={styles.errorBoxNoticePlacement} >{connectionError}</Notice> : null}
                </>
              )
            ) : null}
          </section>
          <HelpPanel step={step} />
        </div>
        <div className={styles.footer}>{footer}</div>
      </StepContent>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した店舗の内容" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </PageFrame></SaveErrorScope>
  )
}
