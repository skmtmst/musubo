'use client'

import { useEffect, useState } from 'react'
import { api, type OperationSendPath, type OperationSendPathsResponse } from '@/lib/api'
import { formatOperationDate } from '@/lib/operation-status'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { CAPABILITY_LABEL } from '@/lib/operation-restore'

export const SEND_PATH_KIND_LABEL: Record<OperationSendPath['kind'], string> = {
  manual: '手の操作',
  auto: '自動',
  scheduled: '予約',
  proxy: 'プロキシ経由',
  external: '外部へ送信',
}

/*
 * 台帳（Worker）の言葉には作り手向けの語（cron・manual 指定・ヘッダ名・claim など）が混じる。
 * 運用者が読む画面では運用の言葉に置き換え、置き換えられない補足は出さない（ 2026-10-15）。
 */
const DEV_WORDS = /cron|claim|tick|pending|queued|failed|outbox|sweep|retry_wait|requested|active|replyToken|push|multicast|broadcast|send_|process[A-Z]|nen-|\bjob\b|\btoken\b|#\d|\b\d{3}\b/
export function operatorPathLabel(label: string): string {
  return label
    .replace(/（cron）/g, '')
    .replace(/（manual 指定）/g, '（担当者の返信として送ったもの）')
    .replace(/自動 push・multicast・broadcast/g, '自動送信')
}
export function operatorPathNote(text: string | null | undefined): string | null {
  if (!text) return null
  if (/X-Line-Harness-Source/.test(text)) return '担当者の返信として送る1対1の送信は、手動返信と同じく対象外です。'
  return DEV_WORDS.test(text) ? null : text
}

/*
 * 停止ボタンが届く経路の一覧 (#1050)。管理画面 の control タブと V8 の
 * control-v8 で同じ台帳を見せるため、page.tsx から切り出した共通部品。
 * 見た目・文言は 管理画面 のまま変えない。
 *
 * 「止める」と押したとき実際にどの送信経路が止まるか、口が返す台帳
 * (`GET /api/operations/send-paths`) をそのまま見せる。対象外の経路も
 * 理由付きで出し、「表示されているのに止まらない」事故を防ぐ。
 * 台帳と実装がずれているとき(problems)は警告として先頭に出す。
 */
export function SendPathCoveragePanel({ accountId, revision }: { accountId: string | null; revision: number }) {
  const [data, setData] = useState<OperationSendPathsResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setFailed(false)
    api.operations.sendPaths(accountId)
      .then((response) => {
        if (cancelled) return
        if (!response.success) {
          setFailed(true)
          return
        }
        /*
         * 形の違う応答は置かない。そのまま回すと `capabilities` で
         * 画面ごと落ちる（全ルート監査 A1、2026-09-25）。
         */
        const data = response.data as unknown as { capabilities?: unknown; paths?: unknown } | null
        if (data && Array.isArray(data.capabilities) && Array.isArray(data.paths)) {
          setData(response.data)
        } else {
          setFailed(true)
        }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [accountId, revision, retryCount])

  if (failed) {
    return <Notice
      tone="warn"
      action={
        <Button
          variant="text"
          size="inline"
          data-notice-inline-action
          type="button"
          onClick={() => setRetryCount((value) => value + 1)}
        >
          もう一度読み込む
        </Button>
      }
    >
      送信経路の台帳を読み込めませんでした。停止の届く範囲が確認できないため、経路の網羅は保証できません。時間をおいて読み直してください。
    </Notice>
  }
  if (!data) {
    return <section className="border-hairline rounded-card border bg-canvas px-4 py-3 text-xs text-ink-faint">送信経路の台帳を読み込んでいます…</section>
  }

  const groups: Array<{ title: string; stopped: boolean; excluded: boolean; paths: OperationSendPath[] }> = []
  for (const capability of data.capabilities) {
    const paths = data.paths.filter((path) => path.capability === capability)
    if (paths.length === 0) continue
    groups.push({
      title: CAPABILITY_LABEL[capability],
      stopped: paths.some((path) => path.state === 'stopped'),
      excluded: false,
      paths,
    })
  }
  const excluded = data.paths.filter((path) => path.capability === null)
  if (excluded.length > 0) groups.push({ title: '対象外（止まりません）', stopped: false, excluded: true, paths: excluded })

  return <section className="content-card rounded-card overflow-hidden border bg-canvas">
    <div className="border-hairline border-b px-4 py-3">
      <h2 className="text-base font-bold text-ink">停止が届く送信経路</h2>
      <p className="mt-0.5 text-xs text-ink-faint">緊急停止が実際に届く経路と、対象外の経路の一覧です。{formatOperationDate(data.evaluatedAt)}時点</p>
      {(data.problems ?? []).length > 0 && <Notice tone="warn" className="mt-2">台帳と実装がずれています: {(data.problems ?? []).join(' / ')}</Notice>}
    </div>
    <div className="divide-y divide-hairline">
      {groups.map((group) => <div key={group.title} className="px-4 py-3">
        <p className={`text-xs font-medium ${group.excluded ? 'text-ink-faint' : group.stopped ? 'text-danger' : 'text-ink-secondary'}`}>
          {group.title}{group.stopped ? '（停止中）' : ''}
        </p>
        <ul className="mt-2 space-y-1.5">
          {group.paths.map((path) => <li key={path.id} className="flex flex-wrap items-baseline gap-x-3 text-xs" style={{ rowGap: 2 }}>
            <span className={`shrink-0 rounded-pill px-2 py-0.5 font-bold ${path.state === 'stopped' ? 'bg-danger-bg text-danger' : path.state === 'running' ? 'bg-success-bg text-success' : 'bg-canvas-sunken text-ink-faint'}`}>
              {path.state === 'stopped' ? '停止中' : path.state === 'running' ? '稼働中' : '対象外'}
            </span>
            <span className="min-w-0 font-bold text-ink">{operatorPathLabel(path.label)}</span>
            <span className="text-ink-faint">{SEND_PATH_KIND_LABEL[path.kind]}</span>
            <span className="min-w-0 flex-1 text-ink-faint">{operatorPathNote(path.excludedReason ?? path.note)}</span>
          </li>)}
        </ul>
      </div>)}
    </div>
  </section>
}
