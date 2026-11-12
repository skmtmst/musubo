'use client'
import Card from '@/components/shared/card'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Globe, Play, Send } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { useTestRecipients } from './use-test-recipients'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import { publicationStateLabel } from '@/components/webinars/publication-label'
import { webinarErrorText } from '@/components/webinars/webinar-error-text'
import { webinarApi, type WebinarPublishValidation } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import type { EditContext, WizardChrome } from './types'
import form from './form.module.css'
import styles from './review.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { summaryRows, reviewActionSummaryText, reviewMonitoringText, reviewTestSummaryBody } from './review-summary'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import StatusBadge from '@/components/shared/status-badge'


/*
 * ★V8 ウェビナーの ⑤確認（Pencil ）。
 * 公開前の確認（検査の行：できた／まだ・右に中身）→ 公開できない理由 → ページをテスト・通知のテスト
 * → 設定のまとめ。右は公開ページでの見え方。下の帯の主ボタンは「この版を公開」。
 * 口・公開の決まりは BEHAVIOR.md。
 */

const FLAGS = ['registrationEnabled', 'dayBeforeEnabled', 'hourBeforeEnabled', 'startEnabled', 'missedEnabled', 'completedEnabled'] as const

export default function ReviewPane({ ctx, chromeFor }: { ctx: EditContext; chromeFor: (primary: ReactNode) => WizardChrome }) {
  const saveErrors = useSaveFormErrors()
  const { webinar, editor, readOnly } = ctx
  const [validation, setValidation] = useState<WebinarPublishValidation | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [testing, setTesting] = useState<false | 'page' | 'notify'>(false)
  const [notice, setNotice] = useState('')
  const [notifyConfirm, setNotifyConfirm] = useState(false)
  const testRecipients = useTestRecipients(webinar.id, notifyConfirm)
  const [notifyCount, setNotifyCount] = useState<{ on: number; missedOff: boolean } | null>(null)
  const requestId = useRef(0)
  const lock = useRef(false)
  const version = useRef(editor.version)
  useEffect(() => { version.current = editor.version }, [editor.version])

  const load = useCallback(() => {
    const id = ++requestId.current
    setState('loading')
    setValidation(null)
    void webinarApi.publishValidation(webinar.id).then((response) => {
      if (!Array.isArray(response.data.checks)) throw new Error('invalid_validation')
      if (id !== requestId.current) return
      setValidation(response.data)
      setState('ready')
    }).catch(() => { if (id === requestId.current) setState('error') })
  }, [webinar.id])
  useEffect(() => {
    load()
    return () => { requestId.current += 1 }
  }, [load, editor.version])
  useEffect(() => {
    let active = true
    setNotifyCount(null)
    void webinarApi.notifications(webinar.id).then((response) => {
      const settings = response.data.settings
      if (active && settings) setNotifyCount({ on: FLAGS.filter((flag) => settings[flag]).length, missedOff: !settings.missedEnabled })
    }).catch(() => { if (active) setNotifyCount(null) })
    return () => { active = false }
  }, [webinar.id])

  const checks = validation?.checks ?? []
  const failed = checks.filter((check) => check.status === 'failed')
  const passed = checks.filter((check) => check.status === 'passed').length
  const canPublish = !readOnly && state === 'ready' && validation !== null && validation.version === editor.version && failed.length === 0 && !publishing && testing === false

  const testPage = async () => {
    if (lock.current) return
    lock.current = true
    setTesting('page')
    setNotice('')
    try {
      const response = await webinarApi.testPublicPage(webinar.id, version.current)
      version.current = response.data.version
      ctx.onEditorChange(response.data)
      setNotice(response.data.publicPage.test?.status === 'passed' ? '公開ページを確かめました。' : '公開ページに未設定があります。')
      load()
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setNotice(webinarErrorText(cause, '公開ページを確かめられませんでした。')) }
    } finally {
      lock.current = false
      setTesting(false)
    }
  }
  const testNotify = async () => {
    if (lock.current || !notifyConfirm || !testRecipients.isCurrent() || !testRecipients.preview) return
    lock.current = true
    setTesting('notify')
    setNotice('')
    try {
      const res = await webinarApi.testNotifications(webinar.id, testRecipients.preview!.token, testRecipients.preview!.confirmationId)
      setNotifyConfirm(false)
      setNotice(`通知をテスト送信しました。成功 ${formatNumber(res.data.sent)} 件・失敗 ${formatNumber(res.data.failed)} 件`)
      // Delivery was acknowledged. A failed refresh must never resend it.
      void webinarApi.editor(webinar.id).then(refreshed => ctx.onEditorChange(refreshed.data)).catch(cause => { setNotice(webinarErrorText(cause, '表示を読み直してください。')) })
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setNotice(webinarErrorText(cause, 'テスト送信できませんでした。時間をおいてもう一度お試しください。')) }
      return false
    } finally {
      lock.current = false
      setTesting(false)
    }
  }
  const publish = async () => {
    if (!canPublish || !validation || lock.current) return
    const confirmedVersion = validation.version
    lock.current = true
    setPublishing(true)
    setPublishError('')
    try {
      await webinarApi.publish(webinar.id, confirmedVersion)
      ctx.onPublished()
      window.location.assign(`/webinars/published?id=${encodeURIComponent(webinar.id)}`)
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setPublishError(webinarErrorText(cause, '公開できませんでした')) }
      setPublishing(false)
      lock.current = false
    }
  }

  const summary: Array<[string, string]> = [
    ['開催形式', editor.deliveryKind === 'scheduled' ? '日時指定・開催回あり' : editor.deliveryKind === 'external' ? '外部の動画' : 'オンデマンド・いつでも視聴'],
    ['公開期間', publicationStateLabel(webinar.publicationState, webinar.publicationStartsAt, webinar.publicationEndsAt) ?? '—（公開期間は未設定）'],
    ['案内ボタン', ctx.ctaCount > 0 ? `${formatNumber(ctx.ctaCount)}件` : emptyValue('unconfigured')],
    ['通知', notifyCount === null ? emptyValue('unknown') : `${notifyCount.on} つ${notifyCount.missedOff ? '（見逃し案内は止めている）' : ''}`],
    ['視聴後の動き', reviewActionSummaryText(validation)],
  ]
  const chrome = chromeFor(readOnly ? null : (
    <Button variant="primary" disabled={!canPublish} title={canPublish ? undefined : '公開前の確認が全部通ると公開できます'} busy={publishing} busyLabel="公開しています…" onClick={() => void publish()}><Check size={16} aria-hidden="true" />この版を公開</Button>
  ))

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage
      boardId="XCUNf"
      title={chrome.title}
      actions={chrome.actions}
      identity={chrome.identity}
      steps={chrome.steps}
      help={`${summaryRows(webinar, ctx.analytics).map(row => `${row.label}：${row.value}${row.note ? `（${row.note}）` : ''}`).join('・')}。すべての段がそろうと公開できます。公開すると、申込ページと LINE の案内が使えるようになります。 ${reviewTestSummaryBody(validation, state)}${editor.monitoring ? ` 監視：${reviewMonitoringText(editor.monitoring.notificationFailures + editor.monitoring.viewSegmentFailures + editor.monitoring.actionFailures)}` : ''}`}
      footerActions={chrome.footerActions}
      status={chrome.status}
      preview={<>
        <h2 className={form.previewTitle}>公開ページでの見え方</h2>
        <div className={styles.pageCard}>
          <p className={styles.pageTitle} title={webinar.title}>{webinar.title}</p>
          <span className={styles.player} aria-hidden="true"><Play size={40} /></span>
        </div>
        <div className={form.previewActions}>
          {ctx.canOpenPublicPage && ctx.publicUrl ? <Button external href={ctx.publicUrl}  >公開ページを見る</Button> : null}
          {readOnly ? null : <Button disabled={testing !== false || publishing} onClick={() => { setNotice(''); setNotifyConfirm(true) }}><Send size={16} aria-hidden="true" />テストを送る</Button>}
        </div>
        {!ctx.canOpenPublicPage && ctx.publicPageReason ? <p className={form.previewNote}>{ctx.publicPageReason}</p> : null}
        {ctx.analytics ? <p className={form.previewNote}>{`申込 ${formatNumber(ctx.analytics.summary.reservations)} 人`}</p> : null}
      </>}
    >
      <Card variant="form" gap="normal" aria-labelledby="webinar-review-title" data-wc-pane="review">
        <div className={form.cardHeadRow}><h2 id="webinar-review-title" className={form.cardTitle}>{state === 'ready' ? `公開前の確認 ${passed}/${checks.length}` : '公開前の確認'}</h2></div>
        <p className={styles.desc}>{state === 'ready' ? `${checks.length}つ全部が通ると公開できます。` : '公開に要るものを確かめます。'}</p>
        {state === 'error' ? <Notice tone="info" action={<Button onClick={load}>もう一度読み込む</Button>}>公開前の確認を読み込めませんでした。このままでは公開できません。</Notice> : null}
        {state === 'loading' ? <p className={form.cardNote} role="status">公開前の確認を読み込んでいます。</p> : null}
        {checks.map((check) => (
          <div key={check.key} className={styles.check}>
            <StatusBadge tone={check.status === 'passed' ? 'success' : check.status === 'warning' ? 'caution' : 'danger'}>{check.status === 'passed' ? 'できた' : 'まだ'}</StatusBadge>
            <span className={`${styles.checkLabel} ${form.ellipsis}`} title={check.label}>{check.label}</span>
            {check.detail ? <span className={`${styles.checkDetail} ${form.ellipsis}`} title={check.detail}>{check.detail}</span> : null}
          </div>
        ))}
        {state === 'ready' && failed.length > 0 ? (
          <Notice tone="danger" className={styles.blockerNoticePlacement} >{`このままでは公開できません：${(validation?.blockers.length ? validation.blockers : failed.map((check) => `${check.label}がまだです。`)).join('・')}`}</Notice>
        ) : state === 'ready' ? <p className={styles.ok}>必要なものはそろっています。</p> : null}
        {readOnly ? null : (
          <div className={form.buttons}>
            <Button variant={failed.some((check) => check.key === 'public_page_test') ? 'primary' : 'secondary'} disabled={testing !== false || publishing} busy={testing === 'page'} busyLabel="確かめています…" onClick={() => void testPage()}><Globe size={16} aria-hidden="true" />ページをテスト</Button>
            <Button disabled={testing !== false || publishing} onClick={() => { setNotice(''); setNotifyConfirm(true) }}><Send size={16} aria-hidden="true" />通知のテストを送る</Button>
          </div>
        )}
        {notice ? <p className={form.cardNote} role="status">{notice}</p> : null}
        {publishError ? <Notice tone="danger" className={form.fieldErrorNoticePlacement} >{publishError}</Notice> : null}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="webinar-summary-title">
        <div className={form.cardHead}><h2 id="webinar-summary-title" className={form.cardTitle}>設定のまとめ</h2></div>
        <dl className={styles.summary}>
          {summary.map(([label, value]) => (
            <div key={label} className={styles.summaryRow}>
              <dt className={styles.summaryLabel}>{label}</dt>
              <dd className={`${styles.summaryValue} ${form.ellipsis}`} title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <ConfirmDialog open={notifyConfirm} title="通知をテスト送信しますか？" description="アカウント設定で登録したテスト受信者へ、実際のLINEメッセージを送ります。申込者全員には届きません。" confirmLabel="テストを送る" confirmDisabled={!testRecipients.preview || testRecipients.preview.count === 0} busy={testing === 'notify'} onCancel={() => { if (testing === false) setNotifyConfirm(false) }} error={notice || undefined} onSuccess={() => setNotifyConfirm(false)} onConfirm={() => testNotify()}><OperationTargetSummary accounts={[{ id: webinar.accountId ?? '' }]} />
        <p>{testRecipients.preview ? `テスト受信者 ${testRecipients.preview.count} 人：${testRecipients.preview.recipients.map(person => person.displayName || '名前未設定').join('、')}` : testRecipients.error ? 'テスト受信者を確認できません。設定を確かめて開き直してください。' : 'テスト受信者を確認しています。'}</p></ConfirmDialog>
    </CreatePage></SaveErrorScope>
  )
}
