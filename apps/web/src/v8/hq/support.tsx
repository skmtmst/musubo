'use client'

import { PageContent } from '@/components/templates/page-frame'
import { Field as SharedField } from '@/components/shared/form-controls'
import { Tabs } from '@/components/shared/tabs'
import StatusBadge from '@/components/shared/status-badge'
import { CheckCircle2, MessageCircleQuestion, Plus, X } from 'lucide-react'
import EmptyList from '@/components/shared/empty-list'
import Link from '@/components/shared/list-navigation'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ListPage } from '@/components/templates'
import Button from '@/components/shared/button'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import Dialog from '@/components/shared/dialog'
import Select from '@/components/shared/select'
import { HqAccountSelectField } from '@/components/shared/hq-account-picker'
import { TextArea, TextField } from '@/components/shared/text-field'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useTenantStatus } from '@/components/tenant-access-context'
import { api } from '@/lib/api'
import { readFileAsBase64 } from '@/lib/hq-banners'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { EMPTY_SUPPORT_INPUT, SUPPORT_ATTACHMENT_MAX, SUPPORT_BODY_MAX, SUPPORT_SUBJECT_MAX, validateSupportAttachment, validateSupportInput, type HqSupportContext, type HqSupportInput, type HqSupportKind, type HqSupportRequest } from '@/lib/hq-support'
import HqSettingsNavV8, { useHqSettingsFolderNav } from './settings-nav'
import NoticeLineDialogV8 from './notice-line-dialog'
import { supportStatusWord, supportStatusTone, supportKindWord, supportTime } from './support-words'
import styles from './support.module.css'
import ImageFrame from '@/components/shared/image-frame'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import TruncatedText from '@/components/shared/truncated-text'

/*
 * ★V8 統括のお問い合わせ（Pencil 。運営の LINE を登録する窓を開いた状態が ）。
 *
 * 管理画面 の画面（app/hq/support/page.tsx）と読み書きの口・権限・失敗時の扱いは同じ。
 * 見た目だけを絵どおりに一から組んだ：頭（型 ListPage）・左の「統括の設定」の列
 * （型のフォルダの列）・問い合わせのカード・これまでの問い合わせの表。
 */

type Attachment = { name: string; mimeType: string; data: string; size: number; previewUrl: string }

export default function HqSupportV8() {
  const saveErrors = useSaveFormErrors()
  // ★V8 上の帯のパンくずは「ホーム › 統括の設定 › 画面名」。
  usePageTitle('お問い合わせ')
  const settingsNav = useHqSettingsFolderNav('contact')
  usePageCrumbs([{ label: '統括の設定', href: '/hq/settings' }])
  const tenantStatus = useTenantStatus()
  const tenantUnavailable = tenantStatus === 'suspended' || tenantStatus === 'archived'
  const uid = useId()
  const [kinds, setKinds] = useState<Array<{ key: HqSupportKind; label: string }>>([])
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [sender, setSender] = useState({ tenantName: '', name: '', email: null as string | null, planLabel: '—' })
  const [history, setHistory] = useState<HqSupportRequest[] | null>(null)
  const [chosenTab, setChosenTab] = useState<'history' | 'send' | null>(null)
  const [historyError, setHistoryError] = useState(false)
  const [input, setInput] = useState<HqSupportInput>(EMPTY_SUPPORT_INPUT)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState<HqSupportRequest | null>(null)
  const [lineGuide, setLineGuide] = useState(false)

  const tab = chosenTab ?? (history?.length || historyError || history === null ? 'history' : 'send')

  const loadHistory = async () => {
    setHistory(null)
    setHistoryError(false)
    try {
      const res = await api.hqSupport.list()
      if (!res.success) throw new Error(res.error)
      if (!Array.isArray(res.data)) throw new Error('unexpected history shape')
      setHistory(res.data)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setHistory([])
      { if (!fieldFailure)
      setHistoryError(true) }
    }
  }

  useEffect(() => {
    let cancelled = false
    void api.hqSupport.context().then((res) => {
      if (cancelled || !res.success) return
      // 形が違っても入力欄は出す（偽APIの既定の器で `kinds.map` が落ちた 2026-09-25 の守り）。
      const data = res.data as Partial<HqSupportContext> | undefined
      setKinds(Array.isArray(data?.kinds) ? data.kinds : [])
      setAccounts(Array.isArray(data?.accounts) ? data.accounts : [])
      if (data?.sender) {
        setSender({
          tenantName: data.sender.tenantName ?? '',
          name: data.sender.name ?? '',
          email: data.sender.email ?? null,
          planLabel: data.sender.planLabel ?? emptyValue('unknown'),
        })
      }
    }).catch(() => {
      // 履歴と送信は独立して使える。表示用情報だけ空のままにする。
    })
    void loadHistory()
    return () => {
      cancelled = true
    }
  }, [])

  const set = <K extends keyof HqSupportInput>(key: K, next: HqSupportInput[K]) => {
    setSent(null)
    setInput((v) => ({ ...v, [key]: next }))
  }

  /** 書き方のひな形（起きたこと／期待したこと／起きた日時）を本文へ入れる。書いた文章は残す。 */
  const insertTemplate = () => {
    const template = '【起きたこと】\n\n【期待したこと】\n\n【起きた日時】\n'
    const body = input.body.trim().length === 0 ? template : `${input.body.replace(/\s+$/, '')}\n\n${template}`
    set('body', body.slice(0, SUPPORT_BODY_MAX))
    document.getElementById(`${uid}-body`)?.focus({ preventScroll: true })
  }

  const addFile = async (file: File | undefined) => {
    if (!file) return
    const reason = validateSupportAttachment(file, attachments.length)
    if (reason) {
      setError(reason)
      return
    }
    setError('')
    try {
      const data = await readFileAsBase64(file)
      setAttachments((prev) => [...prev, { name: file.name, mimeType: file.type, data, size: file.size, previewUrl: URL.createObjectURL(file) }])
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('画像を読み取れませんでした') }
    } finally {
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const target = prev[index]
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  const blocked = useMemo(() => validateSupportInput(input), [input])

  const send = async () => {
    if (blocked || sending) return
    setSending(true)
    setError('')
    try {
      const res = await api.hqSupport.create({
        kind: input.kind as HqSupportKind,
        subject: input.subject.trim(),
        body: input.body.trim(),
        lineAccountId: input.lineAccountId || null,
        attachments: attachments.map((a) => ({ mimeType: a.mimeType, data: a.data })),
      })
      if (!res.success) throw new Error(res.error)
      setSent(res.data)
      setInput(EMPTY_SUPPORT_INPUT)
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl))
      setAttachments([])
      void loadHistory()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // M027：原文のまま出さず、共通の状態別案内へ渡す。
      { if (!fieldFailure)

      setError(japaneseDetailOf(caught) || describeApiFailure(caught, '送信', {
        scope: 'hq',
      })) }
      // 確定応答を失った再送でも履歴で確かめられるよう、履歴を読み直す（重複は口側 M028 が防ぐ）。
      void loadHistory()
    } finally {
      setSending(false)
    }
  }

  /*
   * 書きかけの件名・内容・添えた画像は送るまで画面にしか無い。左の列やメニューで離れると
   * 消えるので、離れる前に確かめる。送る・消すで空になると外れる（種類・アカウントの選択だけでは出さない）。
   */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: input.subject.trim() !== '' || input.body.trim() !== '' || attachments.length > 0,
    busy: sending,
  })

  const clear = () => {
    setInput(EMPTY_SUPPORT_INPUT)
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl))
    setAttachments([])
    setError('')
    setSent(null)
  }

  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      boardId="b8xBtZ"
      title="お問い合わせ"
      help="使い方の質問・不具合・料金の相談を運営へ送れます。返信は登録メールアドレスと、「これまでの問い合わせ」タブに届きます（平日 2 営業日以内）。"
      folders={<HqSettingsNavV8 active="contact" />} folderNav={settingsNav}
    >
      <PageContent>
        <Tabs label="問い合わせの表示" items={[
          { id: `${uid}-history-tab`, controls: `${uid}-history`, label: 'これまでの問い合わせ', current: tab === 'history', onClick: () => setChosenTab('history') },
          { id: `${uid}-send-tab`, controls: `${uid}-send`, label: '問い合わせを送る', current: tab === 'send', onClick: () => setChosenTab('send') },
        ]} />
        {/* 契約者専用LINEの登録案内（2026-09-18 決定：ここからもいつでも開ける。開いた状態が板 D6fh3） */}
        {!tenantUnavailable ? <NoticeLineDialogV8 open={lineGuide} onClose={() => setLineGuide(false)} /> : null}

        <UnsavedLeaveDialog open={leaveTarget !== null} subject="書きかけの問い合わせ" onConfirm={confirmLeave} onCancel={cancelLeave} />

        {/* 送信完了の知らせ（2026-09-18 決定：帯だけでは気づきにくいので、窓で止めて伝える） */}
        <Dialog
          open={sent !== null}
          title="送信完了しました"
          description={sent?.notified
            ? '運営に届きました。控えが登録メールアドレスにも届きます。返信は登録メールアドレスと、この画面の「これまでの問い合わせ」に届きます（平日 2営業日以内）。'
            : '運営に届きました。控えメールは送れませんでしたが、内容は運営に届いています。返信はこの画面の「これまでの問い合わせ」に届きます。'}
          titleIcon={<CheckCircle2 aria-hidden="true" className={styles.doneIcon} />}
          onCancel={() => setSent(null)}
          designNode="b8xBtZ"
        >
          {sent?.ticketLabel ? <p className={styles.sentLine}>受付番号：<strong>{sent.ticketLabel}</strong>　件名：{sent.subject}</p> : null}
        </Dialog>

        <div id={`${uid}-send`} role="tabpanel" aria-labelledby={`${uid}-send-tab`} hidden={tab !== 'send'}>
        <form
          className={styles.card}
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <div className={styles.pair}>
            <Field label="種類" htmlFor={`${uid}-kind`} required>
              <SaveErrorField names={["kind","input.kind"]}><Select
                aria-label="種類"
                id={`${uid}-kind`}
                size="full"
                value={input.kind}
                disabled={sending}
                onChange={(value) => set('kind', value as HqSupportKind | '')}
                options={[{ value: '', label: '種類を選んでください' }, ...kinds.map((k) => ({ value: k.key, label: supportKindWord(k.key, k.label) }))]}
              /></SaveErrorField>
            </Field>
            <Field label="関係する店舗" htmlFor={`${uid}-account`}>
              <HqAccountSelectField
                label="関係する店舗"
                id={`${uid}-account`}
                accounts={accounts}
                value={input.lineAccountId}
                disabled={sending}
                clearable
                placeholder="（指定しない）"
                onChange={(value) => set('lineAccountId', value)}
              />
            </Field>
          </div>

          <Field label="件名" htmlFor={`${uid}-subject`} tone="large" required>
            <SaveErrorField names={["subject","input.subject"]}><TextField
              id={`${uid}-subject`}
              value={input.subject}
              maxLength={SUPPORT_SUBJECT_MAX}
              disabled={sending}
              placeholder="例：バナー生成で日本語の文字が崩れることがある"
              onChange={(e) => set('subject', e.target.value)}
              className={styles.full}
            /></SaveErrorField>
          </Field>

          <Field label="本文" htmlFor={`${uid}-body`} required>
            <div className={styles.templateRow}>
              <Button variant="secondary" disabled={sending} onClick={insertTemplate}>書き方のひな形を入れる</Button>
            </div>
            <SaveErrorField names={["body","input.body"]}><TextArea
              id={`${uid}-body`}
              value={input.body}
              maxLength={SUPPORT_BODY_MAX}
              disabled={sending}
              placeholder="困っていること・期待する動き・起きた日時"
              onChange={(e) => set('body', e.target.value)}
              className={styles.textarea}
            /></SaveErrorField>
          </Field>

          {attachments.length > 0 ? (
            <ul className={styles.thumbs}>
              {attachments.map((a, i) => (
                <li key={`${a.name}-${i}`} className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img width={112} height={80} src={a.previewUrl} alt={a.name} className={styles.thumbImage} />
                  <button type="button" onClick={() => removeAttachment(i)} aria-label={`${a.name} を外す`} className={styles.thumbRemove}>
                    <X aria-hidden="true" className={styles.smallIcon} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachments.length < SUPPORT_ATTACHMENT_MAX ? (
            <div className={styles.attachSlot}>
              <ImageFrame

                title="画像を添える"
                accept="image/png,image/jpeg"
                maxBytes={5 * 1024 * 1024} help={`${SUPPORT_ATTACHMENT_MAX}枚まで`}
                disabled={sending}
                onFile={(file) => void addFile(file)}
              />
            </div>
          ) : null}

          <div className={styles.sender}>
            <span className={styles.senderText} title="この内容が問い合わせに添えられます。返信はこのメールアドレスに届きます。">
              {`送信者：${sender.name || emptyValue('unknown')}${sender.email ? `（${sender.email}）` : ''}・統括：${sender.tenantName || emptyValue('unknown')}・プラン：${sender.planLabel}`}
            </span>
            {!tenantUnavailable ? (
              <button type="button" onClick={() => setLineGuide(true)} className={styles.linkButton}>
                運営からの大事なお知らせを LINE で受け取る
              </button>
            ) : null}
          </div>

          {error ? <Notice tone="danger" >{error}</Notice> : null}
          {blocked && (input.subject || input.body || input.kind) ? <Notice tone="danger" className={styles.warnNoticePlacement} >{blocked}</Notice> : null}

          <div className={styles.actions}>
            <Button onClick={clear} disabled={sending}>内容をクリア</Button>
            <Button variant="primary" title={sending ? '送信しています' : blocked || undefined} onClick={() => void send()} disabled={sending || Boolean(blocked)} busy={sending} busyLabel="送信中…">
              <Plus aria-hidden="true" className={styles.buttonIcon} />送信する
            </Button>
          </div>
        </form>
        </div>

        <section id={`${uid}-history`} role="tabpanel" aria-labelledby={`${uid}-history-tab`} hidden={tab !== 'history'} className={styles.history}>
          <h2 className={styles.historyTitle}>これまでの問い合わせ</h2>
          {history === null ? (
            <p className={styles.empty}>読み込んでいます…</p>
          ) : historyError ? (
            <p className={styles.empty}>
              履歴を読み込めませんでした。
              <button type="button" onClick={() => void loadHistory()} className={styles.linkButton}>もう一度読み込む</button>
            </p>
          ) : history.length === 0 ? (
            <EmptyList icon={<MessageCircleQuestion aria-hidden="true" />} title="まだ問い合わせはありません" description="「問い合わせを送る」から送った問い合わせと、運営からの返事がここに並びます。" canCreate={false} />
          ) : (
            <GridTable label="これまでの問い合わせ" design={{ columns: 'var(--tpl-hq-col-ticket) minmax(0, 1fr) var(--tpl-hq-col-paystate) var(--tpl-hq-col-paystate) var(--tpl-hq-col-ticket)', gap: 'var(--polish-space-card)', rowPadding: '0 var(--tpl-list-inset)', fontSize: 'var(--polish-text-body)' }}>
              <GridHeadRow>
                <GridCell role="columnheader">受付番号</GridCell>
                <GridCell role="columnheader">件名</GridCell>
                <GridCell role="columnheader">種類</GridCell>
                <GridCell role="columnheader">状態</GridCell>
                <GridCell role="columnheader">更新</GridCell>
              </GridHeadRow>
              {history.slice(0, 10).map((item) => {
                const latestReply = item.replies?.reduce<(NonNullable<HqSupportRequest['replies']>[number]) | null>((latest, reply) => !latest || reply.createdAt > latest.createdAt ? reply : latest, null)
                return (
                <GridRow key={item.id}>
                  <GridCell>{item.ticketLabel ?? emptyValue('unknown')}</GridCell>
                  <GridCell className={styles.subjectCell}>
                    <Link href={`/hq/support/detail?id=${encodeURIComponent(item.id)}`}><TruncatedText value={item.subject} /></Link>
                    {!tenantUnavailable && item.replies && item.replies.length > 0 ? (
                      <span className={styles.replyNote}><TruncatedText value={`最新の返事：${latestReply?.body ?? ''}`} /></span>
                    ) : null}
                  </GridCell>
                  <GridCell>{supportKindWord(item.kind, item.kindLabel)}</GridCell>
                  <GridCell>
                    <StatusBadge tone={supportStatusTone(item.status)}>{supportStatusWord(item.status)}</StatusBadge>
                  </GridCell>
                  <GridCell><span className={styles.shortText}>{supportTime(latestReply?.createdAt ?? item.createdAt)}</span></GridCell>
                </GridRow>
              )})}
            </GridTable>
          )}
        </section>
      </PageContent>
    </ListPage></SaveErrorScope>
  )
}

function Field({ label, htmlFor, children, required }: { label: string; htmlFor: string; tone?: 'large'; children: ReactNode; required?: boolean }) {
  return <SharedField label={label} htmlFor={htmlFor} required={required}>{children}</SharedField>
}
