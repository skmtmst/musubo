'use client'

import { useEffect, useRef, useState } from 'react'
import type { Chat, Reminder, Scenario, Tag, Template } from '@line-crm/shared'
import { api } from '@/lib/api'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import { runOptimistic, runUndoable } from '@/lib/undoable'
import DateTimeField from '@/components/shared/date-time-field'
import Select from '@/components/shared/select'
import Button from '@/components/shared/button'
import ScheduleDialog from './schedule-dialog'
import { TextArea } from '@/components/shared/text-field'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/**
 * 1人だけ選んだときの操作（設計 `BulkBar` の6つ）。
 *
 * **6つとも「まとめて実行する口」が無いだけで、1人ぶんの口は全部ある。**
 * これまで人数によらず押せない形にしていたので、1人のときもできなかった。
 *
 *   対応状況を変更する        PUT  /api/chats/<friendId>       （友だちIDで引ける）
 *   テンプレートを送る      POST /api/chats/<friendId>/send
 *   シナリオを開始          POST /api/scenarios/:id/enroll/:friendId
 *   タグを付ける・外す      POST/DELETE /api/friends/:id/tags
 *   友だち情報を書き換える  PUT  /api/friends/:id/metadata
 *   リマインダを開始        POST /api/reminders/:id/enroll/:friendId
 *
 * 2人以上のときは押せないままにする。1人ぶんの口を人数ぶん叩くと、
 * 途中で失敗したときにどこまで終わったのか分からなくなる。
 */

export type FriendAction =
  | 'status'
  | 'operator'
  | 'template'
  | 'scenario'
  | 'tag'
  | 'field'
  | 'reminder'
  | 'schedule'

const LABELS: Record<FriendAction, string> = {
  status: '対応状況を変更する',
  operator: '担当者を変更する',
  template: 'テンプレートを送る',
  scenario: 'シナリオを開始',
  tag: 'タグを付ける・外す',
  field: '友だち情報を書き換える',
  reminder: 'リマインダを開始',
  schedule: '予約して送る',
}

export default function SingleFriendActions({
  friendId,
  friendName,
  tags,
  accountId,
  onDone,
  friendTags,
  onFriendTagsChange,
  initialAction,
  hideActions = false,
}: {
  initialAction?: FriendAction
  hideActions?: boolean
  friendId: string
  friendName: string
  tags: Tag[]
  /** この友だちの所属アカウント。候補はこのアカウントだけに絞る（R23横展開）。 */
  accountId: string | null
  onDone: () => void
  /** その友だちに今付いているタグ（楽観的更新の起点）。 */
  friendTags?: Tag[]
  /**
   * タグの付け外しを先に画面へ反映する（★管理画面 sTJsh §1）。返す関数を
   * 呼ぶと変更前へ戻る。省略したらタグ操作は従来どおり返事を待つ。
   */
  onFriendTagsChange?: (next: Tag[]) => () => void
}) {
  const [open, setOpen] = useState<FriendAction | null>(initialAction ?? null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<{ success: boolean; error?: string }>, done: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    let res: { success: boolean; error?: string }
    try { res = await fn() } catch { res = { success: false, error: '通信できませんでした。もう一度お試しください。' } }
    setBusy(false)
    if (!res.success) {
      setError(res.error ?? 'できませんでした')
      return
    }
    setMessage(done)
    setOpen(null)
    onDone()
  }

  return (
    <div className="w-full" data-design-node="CYJ0L">
      {!hideActions && <div className="flex flex-wrap gap-2">
        {(Object.keys(LABELS) as FriendAction[]).map((a) => (
          <Button variant="primary" className={(`rounded-control border px-2.5 py-1 text-xs ${
              open === a
                ? 'border-accent bg-accent-deep text-on-accent'
                : 'border-hairline bg-canvas text-ink-secondary hover:bg-canvas-sunken'
            }`) + ' h-auto whitespace-normal'} key={a} type="button" onClick={() => {
              setOpen(open === a ? null : a)
              setError('')
              setMessage('')
            }} aria-pressed={open === a}>
            {LABELS[a]}
          </Button>
        ))}
      </div>}

      {message && <p className="text-success mt-2 text-xs">{message}</p>}
      {error && <p className="text-danger mt-2 text-xs">{error}</p>}

      {open && (
        <div className="bg-canvas rounded-card border-hairline mt-2 border p-3">
          <p className="text-ink-faint mb-2 text-xs">
            {friendName} に「{LABELS[open]}」
          </p>
          {open === 'operator' && <OperatorPanel friendId={friendId} accountId={accountId} busy={busy} run={run} />}
          {open === 'status' && <StatusPanel friendId={friendId} busy={busy} run={run} />}
          {open === 'template' && <TemplatePanel friendId={friendId} accountId={accountId} busy={busy} run={run} />}
          {open === 'scenario' && <ScenarioPanel friendId={friendId} accountId={accountId} busy={busy} run={run} />}
          {open === 'tag' && (
            <TagPanel
              friendId={friendId}
              tags={tags}
              friendTags={friendTags ?? []}
              onTagsChange={onFriendTagsChange}
              onDone={onDone}
              closePanel={() => setOpen(null)}
              busy={busy}
              run={run}
            />
          )}
          {open === 'field' && <FieldPanel friendId={friendId} busy={busy} run={run} />}
          {open === 'reminder' && <ReminderPanel friendId={friendId} busy={busy} run={run} />}
        </div>
      )}

      {/*
       * ★V8 `MyJP7` 予約して送るの小窓。受信箱を開かずに予約できる。
       * 文と日時だけ送る（画像の予約送信の口が無いため画像は付けない）。
       */}
      {open === 'schedule' && (
        <ScheduleDialog
          friendId={friendId}
          friendName={friendName}
          accountId={accountId}
          onClose={() => setOpen(null)}
          onReserved={() => { setMessage('予約しました'); onDone() }}
        />
      )}
    </div>
  )
}

type Run = (
  fn: () => Promise<{ success: boolean; error?: string }>,
  done: string,
) => Promise<void>

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

function Go({ busy, onClick, label = '実行' }: { busy: boolean; onClick: () => void; label?: string }) {
  return (
    <Button variant="primary" className="px-3 py-1.5 text-xs font-medium disabled:opacity-50 border-0 h-auto whitespace-normal" type="button" onClick={onClick} disabled={busy}>
      {busy ? '実行中…' : label}
    </Button>
  )
}

const SELECT =
  'border-hairline rounded-control bg-canvas text-ink border px-2 py-1.5 text-xs'

function StatusPanel({ friendId, busy, run }: { friendId: string; busy: boolean; run: Run }) {
  const [status, setStatus] = useState<Chat['status']>('resolved')
  return (
    <Row>
      {/* R117: 読み上げで何を変える欄か分かるよう、共通Selectでも固有の名前を付ける。 */}
      <SaveErrorField names={["status"]}><Select
        aria-label="対応状況"
        value={status}
        onChange={(value) => setStatus(value as Chat['status'])}
        options={[
          { value: 'unread', label: '未対応' },
          { value: 'in_progress', label: '対応中' },
          { value: 'on_hold', label: '保留' },
          { value: 'resolved', label: '対応済み' },
        ]}
      /></SaveErrorField>
      {/* 友だちIDでも引ける（resolveOrCreateChat）。トークが無い人にも当てられる。 */}
      <Go busy={busy} onClick={() => void run(() => api.chats.update(friendId, { status }), '対応状況を変えました')} />
    </Row>
  )
}

function TemplatePanel({ friendId, accountId, busy, run }: { friendId: string; accountId: string | null; busy: boolean; run: Run }) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [id, setId] = useState('')
  const sendKeysRef = useRef(new IdempotencyKeyStore())
  useEffect(() => {
    // R23横展開: 送る文の候補はこの友だちのアカウントだけ。切替で取り直し、残った選択は外す。
    setTemplates([])
    setId('')
    void api.templates.list(undefined, accountId ?? undefined).then((res) => {
      if (res.success) {
        // 文字のものだけ。画像やカードは中身がJSONで、そのまま送ると文字になる。
        setTemplates((res.data as unknown as Template[]).filter((t) => t.messageType === 'text'))
      }
    })
  }, [accountId])
  const picked = templates.find((t) => t.id === id)
  const sendPicked = async () => {
    if (!picked) return { success: false, error: 'テンプレートを選んでください' }
    const signature = JSON.stringify({ friendId, messageType: 'text', content: picked.messageContent })
    const result = await api.chats.send(
      friendId,
      { content: picked.messageContent },
      sendKeysRef.current.get(signature),
    )
    if (result.success) sendKeysRef.current.clear(signature)
    return result
  }
  return (
    <div className="space-y-2">
      <Row>
        <div className="min-w-0 flex-1"><SaveErrorField names={["id"]}><EntityKindField kind="template" label="テンプレート" options={templates} value={id} onChange={setId} /></SaveErrorField></div>
        <Go
          busy={busy || !picked}
          onClick={() =>
            picked &&
            void run(sendPicked, '送りました')
          }
          label="送る"
        />
      </Row>
      {picked && (
        <p className="bg-canvas-sunken text-ink-secondary rounded-control px-2 py-1.5 text-xs whitespace-pre-wrap">
          {picked.messageContent}
        </p>
      )}
    </div>
  )
}

function ScenarioPanel({ friendId, accountId, busy, run }: { friendId: string; accountId: string | null; busy: boolean; run: Run }) {
  const [items, setItems] = useState<Scenario[]>([])
  const [id, setId] = useState('')
  useEffect(() => {
    // R23横展開: 始めるシナリオの候補はこの友だちのアカウントだけ。切替で取り直し、残った選択は外す。
    setItems([])
    setId('')
    void api.scenarios.list(accountId ? { accountId } : undefined).then((res) => {
      if (res.success) setItems(res.data)
    })
  }, [accountId])
  return (
    <Row>
      <div className="min-w-0 flex-1"><SaveErrorField names={["id"]}><EntityKindField kind="scenario" label="シナリオ" options={items} accountId={accountId} value={id} onChange={setId} /></SaveErrorField></div>
      <Go
        busy={busy || !id}
        onClick={() => void run(() => api.scenarios.enroll(id, friendId), 'シナリオを開始しました')}
        label="開始する"
      />
    </Row>
  )
}

/*
 * タグの付け外しは取り消せる軽い操作（★管理画面 sTJsh §1・§4）。
 * 付ける: 押した瞬間に一覧へ反映して裏で保存し、失敗したら元に戻す。
 * 外す: 先に外した形にして、サーバーへは5秒後に送る。
 *       知らせの「元に戻す」で止めたら送らず、付いたままに戻す。
 * 親が `onTagsChange` を渡さない限り、従来どおり返事を待つ動きのまま。
 */
function TagPanel({
  friendId,
  tags,
  friendTags,
  onTagsChange,
  onDone,
  closePanel,
  busy,
  run,
}: {
  friendId: string
  tags: Tag[]
  friendTags: Tag[]
  onTagsChange?: (next: Tag[]) => () => void
  onDone: () => void
  closePanel: () => void
  busy: boolean
  run: Run
}) {
  const [id, setId] = useState('')
  const picked = tags.find((t) => t.id === id)

  const attach = () => {
    if (!picked || !onTagsChange) {
      void run(() => api.friends.addTag(friendId, id), 'タグを付けました')
      return
    }
    if (friendTags.some((tag) => tag.id === picked.id)) {
      closePanel()
      return
    }
    const revert = onTagsChange([...friendTags, picked])
    closePanel()
    runOptimistic({
      request: () => api.friends.addTag(friendId, picked.id),
      revert,
      failureMessage: `「${picked.name}」を付けられませんでした。`,
      retry: attach,
      onSuccess: onDone,
    })
  }

  const detach = () => {
    if (!onTagsChange) {
      void run(() => api.friends.removeTag(friendId, id), 'タグを外しました')
      return
    }
    if (!picked) return
    if (!friendTags.some((tag) => tag.id === picked.id)) {
      closePanel()
      return
    }
    const revert = onTagsChange(friendTags.filter((tag) => tag.id !== picked.id))
    closePanel()
    runUndoable({
      message: `「${picked.name}」を外しました`,
      commit: () => api.friends.removeTag(friendId, picked.id),
      undo: revert,
      onCommitError: () => {
        revert()
        onDone()
      },
      failureMessage: `「${picked.name}」を外せませんでした。`,
      onCommitted: onDone,
    })
  }

  return (
    <Row>
      <div className="min-w-0 flex-1"><SaveErrorField names={["id"]}><EntityKindField kind="tag" label="タグ" options={tags} value={id} onChange={setId} /></SaveErrorField></div>
      <Go busy={busy || !id} onClick={attach} label="付ける" />
      <Button variant="secondary" className="text-ink-secondary px-3 py-1.5 text-xs disabled:opacity-50 h-auto whitespace-normal" type="button" disabled={busy || !id} onClick={detach}>
        外す
      </Button>
    </Row>
  )
}

function FieldPanel({ friendId, busy, run }: { friendId: string; busy: boolean; run: Run }) {
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  return (
    <Row>
      <SaveErrorField names={["key"]}><SharedTextField
        aria-label="項目名"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="項目名"
        className={SELECT}
      /></SaveErrorField>
      <SaveErrorField names={["value"]}><SharedTextField
        aria-label="値"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="値"
        className={SELECT}
      /></SaveErrorField>
      <Go
        busy={busy || !key.trim()}
        onClick={() =>
          void run(
            () => api.friends.updateMetadata(friendId, { [key.trim()]: value }),
            '友だち情報を書き換えました',
          )
        }
        label="書き換える"
      />
    </Row>
  )
}

function ReminderPanel({ friendId, busy, run }: { friendId: string; busy: boolean; run: Run }) {
  const [items, setItems] = useState<Reminder[]>([])
  const [id, setId] = useState('')
  // ゴール日時（予約日・開催日）。リマインダはここを起点に逆算するので、
  // これが決まらないと登録できない。以前はこの欄が無く、登録が必ず失敗していた。
  const [targetDate, setTargetDate] = useState('')
  useEffect(() => {
    void api.reminders.list().then((res) => {
      if (res.success) setItems(res.data)
    })
  }, [])
  return (
    <Row>
      <div className="min-w-0 flex-1"><SaveErrorField names={["id"]}><EntityKindField kind="reminder" label="リマインダ" options={items} value={id} onChange={setId} /></SaveErrorField></div>
      <SaveErrorField names={["targetDate","target_date"]}><DateTimeField
        value={targetDate}
        onChange={setTargetDate}
        aria-label="ゴール日時"
        className="w-60"
      /></SaveErrorField>
      <Go
        busy={busy || !id || !targetDate}
        onClick={() =>
          void run(
            // datetime-local は "2026-09-01T15:00" の形。日本時間として送る。
            () => api.reminders.enroll(id, friendId, `${targetDate}:00+09:00`),
            'リマインダを開始しました',
          )
        }
        label="開始する"
      />
    </Row>
  )
}

function OperatorPanel({ friendId, accountId, busy, run }: { friendId: string; accountId: string | null; busy: boolean; run: Run }) {
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([])
  const [id, setId] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setOperators([])
    setId('')
    if (!accountId) return () => { active = false }
    void api.operators.list(accountId).then((res) => {
      if (!active) return
      if (res.success) setOperators(res.data)
      else setFailed(true)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [accountId])
  return <Row>
    <SaveErrorField names={["id","operatorId"]}><EntitySelect aria-label="担当者" value={id} onChange={setId} options={[{ value: '', label: '未割り当て' }, ...operators.map((operator) => ({ ...entityOptionMetadata(operator), value: operator.id, label: operator.name }))]} /></SaveErrorField>
    <Go busy={busy || failed} onClick={() => void run(() => api.chats.update(friendId, { operatorId: id || null }), '担当者を変えました')} />
    {failed && <p role="alert" className="text-xs text-danger">担当者を読み込めませんでした。閉じてもう一度開いてください。</p>}
  </Row>
}
