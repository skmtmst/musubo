'use client'

import { describeApiFailure } from '@/components/shared/api-error-message'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { loadStaffIdentity, useStaffRole, canManageRole } from '@/lib/staff-role'
import { PageContent } from '@/components/templates/page-frame'
import StatusBadge from '@/components/shared/status-badge'
import { Paperclip, Send, X } from 'lucide-react'
import Link from '@/components/shared/list-navigation'
import { Suspense, useCallback, useEffect, useId, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import type { StaffMember } from '@line-crm/shared'
import { ListPage } from '@/components/templates'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Button from '@/components/shared/button'
import TargetMissing from '@/components/shared/target-missing'
import { TextArea } from '@/components/shared/text-field'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api, ApiError } from '@/lib/api'
import { readFileAsBase64 } from '@/lib/hq-banners'
import { SUPPORT_ATTACHMENT_MAX, SUPPORT_BODY_MAX, validateSupportAttachment, type HqSupportDetail, type HqSupportRequest } from '@/lib/hq-support'
import HqSettingsNavV8, { useHqSettingsFolderNav } from './settings-nav'
import { supportStatusWord, supportStatusTone, supportKindWord, supportTime } from './support-words'
import styles from './support-detail.module.css'
import ImageFrame from '@/components/shared/image-frame'
import { Field } from '@/components/shared/form-controls'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/*
 * ★V8 お問い合わせのやり取り（Pencil ）。
 *
 * 管理画面 の画面（app/hq/support/detail/page.tsx）と読み書きの口・失敗時の扱いは同じ。
 * 見た目だけを絵どおりに一から組んだ：頭（題＝件名・説明＝受付番号・種類・店舗・送った日時）・
 * 左の「統括の設定」の列・状態の札・やり取りのカード（自分は右の緑、運営は左の灰）・
 * 続きを送るカード・右に送信者とこれまでの問い合わせ。
 * 静的書き出しのため動的セグメントは使わず `?id=` で受ける（管理画面 と同じ）。
 */

type Attachment = { name: string; mimeType: string; data: string; size: number; previewUrl: string }

/** 状態の札の横の一言（メールが無い人にメール到着を言わない：R609）。 */
function statusNote(status: HqSupportRequest['status'], hasEmail: boolean): string {
  if (status === 'open') return hasEmail ? '運営が確認しています。返事は登録メールにも届きます' : '運営が確認しています。返事はこの画面に届きます'
  if (status === 'answered') return hasEmail ? '運営から返事が届いています。登録メールにも同じ内容が届きます' : '運営から返事が届いています'
  if (status === 'closed') return '解決済みです。続きを送ると、運営がもう一度確認します'
  return '問い合わせの状態を確認できません'
}

/** 送るボタンの横の一言（管理画面 の supportSendStatus を短くした絵の言葉）。 */
const SEND_NOTE = '送ると運営の対応は「対応中」に戻ります'

function sentNotice(hasEmail: boolean): string {
  return hasEmail
    ? '続きを送りました。運営に届き、控えが登録メールアドレスにも届きます。'
    : '続きを送りました。運営に届きました。返信はこの画面のやり取りに届きます。'
}

/*
 * WEB212：同じ画面のまま別の問い合わせ（?id=）へ移ったら、画面を作り直す。
 * 初めに1回だけ URL を読むと、前の問い合わせ・入力が残り、前の id へ送ってしまう。
 */
export default function HqSupportDetailV8() {
  return (
    <Suspense fallback={null}>
      <HqSupportDetailByQuery />
    </Suspense>
  )
}

function HqSupportDetailByQuery() {
  const queryId = useSearchParams().get('id')?.trim() || null
  return <HqSupportDetailInner key={queryId ?? ''} queryId={queryId} />
}

function HqSupportDetailInner({ queryId }: { queryId: string | null }) {
  const settingsNav = useHqSettingsFolderNav('contact')
  const uid = useId()
  /* U099: `undefined` はまだ URL を読んでいない、`null` は URL に id が無い。 */
  const [id, setId] = useState<string | null | undefined>(undefined)
  const [detail, setDetail] = useState<HqSupportDetail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [detailMissing, setDetailMissing] = useState(false)
  const [detailLoading, setDetailLoading] = useState(true)
  const role = useStaffRole()
  const canReply = canManageRole(role) || role === 'staff'
  const [me, setMe] = useState<StaffMember | null>(null)
  const [tenantName, setTenantName] = useState('')
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [history, setHistory] = useState<HqSupportRequest[] | null>(null)
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setId(queryId)
  }, [queryId])

  /* WEB212：続きの本文・添付を書きかけのまま離れるときは確かめる（新しい問い合わせと同じ）。 */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: body.trim() !== '' || attachments.length > 0,
    busy: sending,
  })

  const idMissing = id === null
  const hasSenderEmail = (me?.email ?? '').trim().length > 0

  const load = useCallback(async (requestId: string) => {
    setLoadError('')
    setDetailMissing(false)
    setDetailLoading(true)
    try {
      const res = await api.hqSupport.detail(requestId)
      if (!res.success) { setLoadError(res.error || '読み込めませんでした'); return }
      setDetail(res.data)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) setDetailMissing(true)
      else setLoadError('読み込めませんでした')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!id) return
    void load(id)
    void Promise.allSettled([loadStaffIdentity(), api.tenants.me(), api.hqSupport.list(), api.hqSupport.context()]).then(([meRes, tenantRes, listRes, contextRes]) => {
      if (meRes.status === 'fulfilled' && meRes.value.success) setMe(meRes.value.data)
      if (tenantRes.status === 'fulfilled' && tenantRes.value.success) setTenantName(tenantRes.value.data.name)
      if (listRes.status === 'fulfilled' && listRes.value.success) setHistory(listRes.value.data)
      if (contextRes.status === 'fulfilled' && contextRes.value.success && Array.isArray(contextRes.value.data?.accounts)) setAccounts(contextRes.value.data.accounts)
    })
  }, [id, load])

  const addFile = async (file: File | undefined) => {
    if (!file) return
    const reason = validateSupportAttachment(file, attachments.length)
    if (reason) { setError(reason); return }
    setError('')
    try {
      const data = await readFileAsBase64(file)
      setAttachments((prev) => [...prev, { name: file.name, mimeType: file.type, data, size: file.size, previewUrl: URL.createObjectURL(file) }])
    } catch {
      setError('画像を読み取れませんでした')
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

  const blocked = !body.trim() ? '本文を入力してください' : body.length > SUPPORT_BODY_MAX ? `本文は${SUPPORT_BODY_MAX}文字以内で入力してください` : ''

  const send = async () => {
    if (!canReply) return
    if (!id || blocked || sending) return
    setSending(true)
    setError('')
    setNotice('')
    try {
      const res = await api.hqSupport.followUp(id, { body: body.trim(), attachments: attachments.map((a) => ({ mimeType: a.mimeType, data: a.data })) })
      if (!res.success) throw new Error(res.error)
      setBody('')
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl))
      setAttachments([])
      setNotice(sentNotice(hasSenderEmail))
      await load(id)
    } catch (caught) {
      setError(describeApiFailure(caught, '送信', { scope: 'hq' }))
    } finally {
      setSending(false)
    }
  }

  const ready = !idMissing && !detailLoading && id !== undefined && !detailMissing && !loadError && detail
  const accountName = detail?.lineAccountId ? accounts.find((a) => a.id === detail.lineAccountId)?.name ?? null : null
  const title = ready ? detail.subject : 'お問い合わせのやり取り'
  // ★V8 パンくずは「ホーム › 統括の設定 › お問い合わせ › 番号」。番号が無い・読み込み中は「お問い合わせ」。
  const ticketLabel = ready ? detail.ticketLabel ?? '' : ''
  usePageTitle(ticketLabel || 'お問い合わせ')
  usePageCrumbs(ticketLabel ? [{ label: '統括の設定', href: '/hq/settings' }, { label: 'お問い合わせ', href: '/hq/support' }] : [{ label: '統括の設定', href: '/hq/settings' }])
  const description = ready
    ? [detail.ticketLabel, supportKindWord(detail.kind, detail.kindLabel), accountName, `${supportTime(detail.createdAt)} に送信`].filter(Boolean).join('・')
    : '問い合わせの内容と運営からの返事を確認します。'

  if (idMissing) return <TargetMissing kind="unspecified" title="開くお問い合わせが指定されていません" description="一覧から開くお問い合わせを選び直してください。" backHref="/hq/support" backLabel="問い合わせの一覧へ戻る" />

  return (
    <ListPage boardId="OhguS" title={title} help={description} folders={<HqSettingsNavV8 active="contact" />} folderNav={settingsNav}>
      <PageContent>
        <div className={styles.main}>
          {idMissing ? (
            <TargetMissing kind="unspecified" title="開くお問い合わせが指定されていません" description="一覧から開くお問い合わせを選び直してください。" backHref="/hq/support" backLabel="問い合わせの一覧へ戻る" />
          ) : detailLoading || id === undefined ? (
            <DetailLoading />
          ) : detailMissing || (!loadError && !detail) ? (
            <TargetMissing kind="not-found" title="このお問い合わせは見つかりません" description="削除されたか、別の記録です。一覧から選び直してください。" backHref="/hq/support" backLabel="問い合わせの一覧へ戻る" />
          ) : loadError || !detail ? (
            <TargetMissing kind="error" title="お問い合わせを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。" onRetry={() => { if (id) void load(id) }} />
          ) : (
            <>
              <div className={styles.statusRow}>
                <StatusBadge tone={supportStatusTone(detail.status)}>{supportStatusWord(detail.status)}</StatusBadge>
                <span className={styles.statusNote}>{statusNote(detail.status, hasSenderEmail)}</span>
              </div>

              <ol className={styles.thread} aria-label="やり取り">
                <Message mine author={detail.staffName || tenantName || '統括'} at={detail.createdAt} body={detail.body} attachments={detail.attachments} />
                {(detail.messages ?? []).map((m) => (
                  <Message key={m.id} mine={m.authorKind !== 'ops'} author={m.authorName} at={m.createdAt} body={m.body} attachments={m.attachments} />
                ))}
              </ol>

              {canReply ? <div className={styles.compose}><Field label="続きを送る" htmlFor={`${uid}-body`}><SaveErrorField names={["body"]}><TextArea
                  id={`${uid}-body`}
                  value={body}
                  onChange={(event) => { setBody(event.target.value); setNotice('') }}
                  placeholder="運営の返信への返事や、追加で分かったこと"
                  maxLength={SUPPORT_BODY_MAX}
                  disabled={sending}
                  className={styles.textarea}
                /></SaveErrorField>
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
<div className={styles.composeRow}>
                  <span className={styles.spacer} />
                  <span className={styles.sendNote}>{blocked && body ? <span className={styles.warn}>{blocked}</span> : SEND_NOTE}</span>
                  <Button variant="primary" title={sending ? '送信しています' : blocked || (!detail ? 'お問い合わせを読み込んでいます' : undefined)} onClick={() => void send()} disabled={sending || Boolean(blocked) || !detail} busy={sending} busyLabel="送信中…">
                    <Send aria-hidden="true" className={styles.buttonIcon} />送る
                  </Button>
                </div>
{notice ? <p className={styles.notice} role="status">{notice}</p> : null}
{error ? <Notice tone="danger" >{error}</Notice> : null}</Field></div> : <ReadOnlyNotice />}
            </>
          )}
        </div>

        {ready ? <aside className={styles.side}>
          <section className={styles.sender} aria-label="送信者">
            <h2 className={styles.senderTitle}>送信者</h2>
            <p className={styles.senderLines} title={hasSenderEmail ? 'この内容が続きに添えられます。返信はこのメールアドレスに届きます。' : 'この内容が続きに添えられます。返信はこの画面のやり取りに届きます。'}>
              {`名前：${me?.name ?? emptyValue('unknown')}`}<br />
              {`メール：${me?.email ?? emptyValue('unknown')}`}<br />
              {`統括：${tenantName || emptyValue('unknown')}`}
            </p>
          </section>

          <CreateSummaryCard title="これまでの問い合わせ" variant="record" rows={Array.isArray(history) ? history.slice(0, 10).map(item => ({
            key: item.id,
            label: <Link href={`/hq/support/detail?id=${encodeURIComponent(item.id)}`} aria-current={item.id === id ? 'page' : undefined} title={item.subject}>{[item.ticketLabel, item.subject].filter(Boolean).join(' ')}</Link>,
            value: <StatusBadge tone={supportStatusTone(item.status)}>{supportStatusWord(item.status)}</StatusBadge>,
          })) : []}>
            {history === null ? <DetailLoading /> : !Array.isArray(history) ? <p>これまでの問い合わせを読み込めませんでした。</p> : history.length === 0 ? <p>まだ問い合わせはありません。</p> : null}
          </CreateSummaryCard>
        </aside> : null}
      </PageContent>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="書きかけの続き" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </ListPage>
  )
}

function Message({ mine, author, at, body, attachments }: { mine: boolean; author: string; at: string; body: string; attachments?: Array<{ key: string; url: string }> }) {
  const files = attachments ?? []
  return (
    <li className={mine ? `${styles.message} ${styles.messageMine}` : styles.message}>
      <span className={styles.author}>{`${author}・${supportTime(at)}`}</span>
      <p className={mine ? `${styles.bubble} ${styles.bubbleMine}` : styles.bubble}>{body}</p>
      {files.length > 0 ? (
        <span className={styles.files}>
          {files.map((a) => (
            <TextLink external key={a.key} href={a.url}   className={styles.file}>
              <Paperclip aria-hidden="true" className={styles.smallIcon} />
              {(a.key ?? '').split('/').pop()}
            </TextLink>
          ))}
        </span>
      ) : null}
    </li>
  )
}
