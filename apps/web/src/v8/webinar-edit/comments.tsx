'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { notifySaved } from '@/components/shared/toast'
import { useEffect, useRef, useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import { PageFrame, PageContent } from '@/components/templates/page-frame'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import Notice from '@/components/shared/notice'
import Disclosure from '@/components/shared/disclosure'
import { TextArea } from '@/components/shared/text-field'
import { WEBINAR_SAKURA_COMMENTS_MAX } from '@/components/webinars/webinar-limits'
import { webinarErrorText } from '@/components/webinars/webinar-error-text'
import { ApiError, webinarApi, type WebinarSakuraComment } from '@/lib/api'
import { DetailHead } from './chrome'
import { fmtSec, parseSec } from './helpers'
import type { DetailChrome, EditContext, PaneSaveProps } from './types'
import styles from './comments.module.css'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import CommentViewerStats from './comment-stats'
import { formatNumber } from '@/lib/format'
import { TextField as SharedTextField } from '@/components/shared/text-field'


/*
 * ★V8 ウェビナーのコメント演出（Pencil ）。
 * 左に流すコメントの表（秒数・名前・本文はその場で直せる。行の右端は消す）、右に視聴画面での見え方。
 * 口・件数の上限・JSON の読み込み・保存の決まりは BEHAVIOR.md。
 */

/** 1行の中身を確かめる。直せないときは理由の文を返す。 */
function validateRow(raw: unknown): WebinarSakuraComment | string {
  if (typeof raw !== 'object' || raw === null) return 'オブジェクトではありません'
  const rec = raw as Record<string, unknown>
  const atSeconds = Math.floor(Number(rec.atSeconds))
  if (!Number.isFinite(atSeconds) || atSeconds < -3600) return 'atSeconds が不正です (-3600〜)'
  const authorName = typeof rec.authorName === 'string' ? rec.authorName.trim() : ''
  if (!authorName) return 'authorName が空です'
  if (authorName.length > 50) return 'authorName が50字を超えています'
  const body = typeof rec.body === 'string' ? rec.body.trim() : ''
  if (!body) return 'body が空です'
  if (body.length > 500) return 'body が500字を超えています'
  return { atSeconds, authorName, body }
}

/** 秒数の欄：「分:秒」で見せて、離れたときに秒へ直す。読めない書き方は前の値に戻す。 */
function SecondsInput({ value, label, disabled, onChange }: { value: number; label: string; disabled: boolean; onChange: (next: number) => void }) {
  const [draft, setDraft] = useState(fmtSec(value))
  useEffect(() => { setDraft(fmtSec(value)) }, [value])
  return (
    <SaveErrorField names={["draft"]}><NumberInput numericText
      className={styles.cellSec}
      value={draft}
      aria-label={label}
      disabled={disabled}
      inputMode="numeric"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const parsed = parseSec(draft)
        if (parsed === null) setDraft(fmtSec(value))
        else onChange(parsed)
      }}
    /></SaveErrorField>
  )
}

export default function CommentsPane({ ctx, chrome, onDirtyChange, registerSave }: { ctx: EditContext; chrome: DetailChrome } & PaneSaveProps) {
  const saveErrors = useSaveFormErrors()
  const webinarId = ctx.webinar.id
  const readOnly = ctx.readOnly
  const [comments, setComments] = useState<WebinarSakuraComment[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'denied'>('loading')
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [baseline, setBaseline] = useState('[]')
  const generation = useRef(0)
  const locked = useRef(false)
  const [importJson, setImportJson] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const request = ++generation.current
    setState('loading')
    setLoadError('')
    setMessage(null)
    setComments([])
    setBaseline('[]')
    setImportJson('')
    void webinarApi.comments(webinarId).then((response) => {
      if (!Array.isArray(response.data)) throw new Error('invalid_comments')
      if (request !== generation.current) return
      setComments(response.data)
      setBaseline(JSON.stringify(response.data))
      setState('ready')
    }).catch((cause) => {
      if (request === generation.current) {
        const denied = cause instanceof ApiError && cause.status === 403
        setState(denied ? 'denied' : 'error')
        setLoadError(denied ? '' : describeApiFailure(cause, 'コメントの読み込み'))
      }
    })
    return () => { generation.current += 1 }
  }, [webinarId, attempt])

  const dirty = state === 'ready' && (JSON.stringify(comments) !== baseline || importJson.trim() !== '')
  useEffect(() => { onDirtyChange(dirty) }, [onDirtyChange, dirty])

  const update = (index: number, patch: Partial<WebinarSakuraComment>) =>
    setComments((prev) => prev.map((comment, j) => (j === index ? { ...comment, ...patch } : comment)))

  const save = async (): Promise<boolean> => {
    if (state !== 'ready' || locked.current || readOnly) return false
    setMessage(null)
    if (importJson.trim()) { setMessage({ text: '貼り付けたJSONを読み込んでから保存してください。', error: true }); return false }
    if (comments.length > WEBINAR_SAKURA_COMMENTS_MAX) {
      setMessage({ text: `コメントは${WEBINAR_SAKURA_COMMENTS_MAX} 件までです（いま${formatNumber(comments.length)} 件）。減らしてから保存してください。`, error: true })
      return false
    }
    const cleaned: WebinarSakuraComment[] = []
    for (let index = 0; index < comments.length; index += 1) {
      const row = validateRow(comments[index])
      if (typeof row === 'string') { setMessage({ text: `${index + 1} 行目を確認してください：${row}`, error: true }); return false }
      cleaned.push(row)
    }
    const request = generation.current
    locked.current = true
    setSaving(true)
    try {
      const sorted = cleaned.sort((a, b) => a.atSeconds - b.atSeconds)
      const response = await webinarApi.saveComments(webinarId, sorted)
      if (request !== generation.current) return false
      setComments(sorted)
      setBaseline(JSON.stringify(sorted))
      notifySaved(`${formatNumber(response.data.count)}件保存しました`)
      return true
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause);

      if (request === generation.current) { if (!fieldFailure) setMessage({ text: `保存できませんでした。入力を残しました。${webinarErrorText(cause, '通信を確認して、もう一度保存してください。')}`, error: true }) }
      return false
    } finally {
      locked.current = false
      if (request === generation.current) setSaving(false)
    }
  }
  useEffect(() => {
    if (readOnly) { registerSave(null); return }
    registerSave(save)
    return () => registerSave(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerSave, comments, importJson, state, webinarId, readOnly])

  const doImport = () => {
    try {
      const parsed = JSON.parse(importJson) as unknown
      if (!Array.isArray(parsed)) throw new Error('配列ではありません')
      if (parsed.length > WEBINAR_SAKURA_COMMENTS_MAX) throw new Error(`コメントは${WEBINAR_SAKURA_COMMENTS_MAX} 件までです`)
      const rows: WebinarSakuraComment[] = []
      for (let i = 0; i < parsed.length; i += 1) {
        const result = validateRow(parsed[i])
        if (typeof result === 'string') throw new Error(`${i + 1} 行目が不正です: ${result}`)
        rows.push(result)
      }
      setComments(rows)
      setImportJson('')
      setShowImport(false)
      setMessage({ text: `${formatNumber(rows.length)} 件読み込みました（保存ボタンで確定）`, error: false })
    } catch (err) {
      const fieldFailure = saveErrors.capture(err)

      { if (!fieldFailure)
      setMessage({ text: `JSON が不正です: ${describeApiFailure(err, '保存')}`, error: true }) }
    }
  }

  // 開始後の最初のコメントと待機中の最初のコメントを見本にする。
  // 配列の先頭2件だけだと、待機中のコメントしか出ないことがある。
  const chronological = [...comments].sort((a, b) => a.atSeconds - b.atSeconds)
  const firstDuring = chronological.find((comment) => comment.atSeconds >= 0)
  const firstBefore = chronological.find((comment) => comment.atSeconds < 0)
  const preview = firstDuring && firstBefore ? [firstDuring, firstBefore] : chronological.slice(0, 2)
  const previewContent = <>
    <div className={styles.screen} data-video-player>
      {preview.map((comment, index) => (
        <p key={index} className={styles.screenLine} data-dim={index > 0 || undefined}>{`${comment.authorName}：${comment.body}`}</p>
      ))}
    </div>
    <p className={styles.sideNote}>本物の視聴者コメントは「分析」で見られます</p>
  </>
  const locked2 = saving || readOnly

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="list" boardId="Omqd4">
      <DetailHead {...chrome} current="comments" />
      <CommentViewerStats analytics={ctx.analytics} state={ctx.analyticsState} onRetry={ctx.retryAnalytics} />
      <PageContent layout="columns" data-design-node="Omqd4">
        <div className={styles.previewToggle}>
          <Disclosure title="視聴画面での見え方" size="compact">{previewContent}</Disclosure>
        </div>
        <section className={styles.card} aria-labelledby="webinar-comments-title">
          <div className={styles.cardHead}>
            <div className={styles.cardHeadText}>
              <h3 id="webinar-comments-title" className={styles.cardTitle}>流すコメント（演出）</h3>
              <p className={styles.cardDesc}>{`動画の決まった秒に、用意したコメントを流します。マイナスの秒は開始前（待機ルーム）。最大 ${WEBINAR_SAKURA_COMMENTS_MAX} 件・${state === 'ready' ? `いま ${formatNumber(comments.length)} 件` : 'いま —'}`}</p>
            </div>
            {readOnly ? null : (
              <Button variant="primary" disabled={state !== 'ready' || saving} busy={saving} busyLabel="保存しています…" onClick={() => void save()}>
                <Check size={16} aria-hidden="true" />保存する
              </Button>
            )}
          </div>
          {message ? <Notice tone={message.error ? 'danger' : 'info'}>{message.text}</Notice> : null}
          {state === 'error' ? (
            <Notice tone="danger" action={<Button onClick={() => setAttempt((value) => value + 1)}>もう一度読み込む</Button>}>コメントを読み込めませんでした。{loadError ? `（${loadError}）` : ''}保存前に読み直してください。</Notice>
          ) : state === 'denied' ? (
            <Notice tone="info">コメントを見る権限がありません。管理者に確認してください。</Notice>
          ) : state === 'loading' ? (
            <p className={styles.state} role="status">読み込んでいます。</p>
          ) : (
            <>
              <div className={styles.headRow} role="presentation">
                <span className={styles.colSec}>秒数</span>
                <span className={styles.colName}>名前</span>
                <span className={styles.colBody}>本文</span>
              </div>
              {comments.length === 0 ? <p className={styles.state}>まだコメントがありません。下の「コメントを足す」から足してください。</p> : null}
              {comments.map((comment, index) => (
                <div key={index} className={styles.row}>
                  <SecondsInput value={comment.atSeconds} label={`${index + 1} 行目の秒数`} disabled={locked2} onChange={(next) => update(index, { atSeconds: next })} />
                  <SaveErrorField names={[`comments.${index}.authorName`,`comments.${index}.author_name`,"authorName","comment.authorName","author_name","comment.author_name"]}><SharedTextField className={`${styles.cell} ${styles.cellName}`} value={comment.authorName} disabled={locked2} aria-label={`${index + 1} 行目の名前`} onChange={(event) => update(index, { authorName: event.target.value })} /></SaveErrorField>
                  <SaveErrorField names={[`comments.${index}.body`,"body","comment.body"]}><SharedTextField className={`${styles.cell} ${styles.cellBody}`} value={comment.body} disabled={locked2} aria-label={`${index + 1} 行目の本文`} onChange={(event) => update(index, { body: event.target.value })} /></SaveErrorField>
                  {readOnly ? null : (
                    <IconButton className={styles.remove} aria-label={`${comment.authorName || '名前未入力'}のコメントを消す`} title="このコメントを消す" disabled={saving} onClick={() => setComments((prev) => prev.filter((_, j) => j !== index))}>
                      <Trash2 size={16} aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              ))}
              {readOnly ? null : (
                <div className={styles.links}>
                  <button type="button" className={styles.link} disabled={saving} onClick={() => setComments((prev) => [...prev, { atSeconds: 0, authorName: '', body: '' }])}>＋ コメントを足す</button>
                  <button type="button" className={styles.link} disabled={saving} aria-expanded={showImport} onClick={() => setShowImport((prev) => !prev)}>まとめて貼り付ける（JSON）</button>
                </div>
              )}
              {showImport && !readOnly ? (
                <div className={styles.import}>
                  <p className={styles.cardDesc}>{`形：[{"atSeconds":10,"authorName":"田中","body":"こんばんは"}]（${WEBINAR_SAKURA_COMMENTS_MAX} 件まで）`}</p>
                  <SaveErrorField names={["importJson","import_json"]}><TextArea value={importJson} onChange={(event) => setImportJson(event.target.value)} rows={4} aria-label="貼り付けるJSON" /></SaveErrorField>
                  <div><Button onClick={doImport}>読み込む</Button></div>
                </div>
              ) : null}
            </>
          )}
        </section>
        <aside className={styles.side} aria-labelledby="webinar-comments-preview">
          <h3 id="webinar-comments-preview" className={styles.sideTitle}>視聴画面での見え方</h3>
          {previewContent}
        </aside>
      </PageContent>
    </PageFrame></SaveErrorScope>
  )
}
