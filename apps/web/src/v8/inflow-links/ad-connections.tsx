'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, History, RotateCw, Send, XCircle } from 'lucide-react'
import type { AdEventMapping } from '@line-crm/shared'
import { api } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { INFLOW_TABLE_LAYOUT } from './table-layout'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { adMappingReturns, groupAdMappings, useAdLogs, type AdMappingRow } from './ad-shared'
import adsStyles from './ads.module.css'
import styles from './ad-pages.module.css'
import { DetailPage } from '@/components/templates'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import AdMappingDialog from './ad-mapping-dialog'

/*
 * ★V8 広告とのつなぎ（Pencil ・`/inflow-links?tab=connections`）。
 *
 * 2026-10-07 src/v8 に一から書いた（今の V8 は 13%）。頭は広告連携と同じ形。
 * 本文（間14）：返すしくみの3枚 → 数の4枚（共通の数の帯）→ 成果地点と広告に返す名前の対応（F-21）→ 注。
 * 呼ぶ口：送信記録の30日の集計（今と同じ）・対応表 `GET /api/ad-platforms/mappings`（F-21）・
 * 結びつける `PUT /api/ad-platforms/mappings/:pointId`（owner・admin）。BEHAVIOR.md の「広告とのつなぎ」。
 */

const STEPS = [
  { title: 'クリックの目印を持ち帰る', text: '広告から中継リンクを通った人の目印を残します。中継リンクを通らないと広告と結びつきません。' },
  { title: '成果が出たら順に送る', text: '成果地点で数えたら、待ち行列に入れてから広告へ送ります。' },
  { title: '同じ成果は2回送らない', text: 'やり直しても同じ目印を使います。広告側で2重に数えられません。' },
] as const

type MappingState = { kind: 'loading' } | { kind: 'ready'; rows: AdMappingRow[] } | { kind: 'error' }

export default function AdConnectionsV8() {
  const saveErrors = useSaveFormErrors()
  usePageTitle('広告とのつなぎ')
  usePageCrumbs([
    { label: 'ホーム', href: '/' },
    { label: '流入と計測', href: '/inflow-links' },
  ])
  const role = useStaffRole()
  /* 結びつけ（PUT）は owner・admin。役割が読めるまでは出さない（押すと 403 になるため）。 */
  const manage = canManageRole(role)
  const readonly = role !== null && !manage
  const model = useAdLogs({ page: 1, status: 'all', query: '' })
  const accountId = model.selectedAccountId
  const [mapping, setMapping] = useState<MappingState>({ kind: 'loading' })
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [saveError, setSaveError] = useState('')
  const [editing, setEditing] = useState<AdEventMapping | null>(null)
  const generationRef = useRef(0)
  const mappingsInFlightRef = useRef(false)

  const loadMappings = useCallback(async ({ userInitiated = false } = {}) => {
    if (userInitiated && mappingsInFlightRef.current) return
    const generation = ++generationRef.current
    if (!accountId) {
      mappingsInFlightRef.current = false
      setMapping({ kind: 'ready', rows: [] })
      return
    }
    mappingsInFlightRef.current = true
    setMapping({ kind: 'loading' })
    try {
      const res = await api.adPlatforms.mappings(accountId)
      if (generation !== generationRef.current) return
      setMapping(res.success ? { kind: 'ready', rows: groupAdMappings(res.data) } : { kind: 'error' })
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (generation === generationRef.current) setMapping({ kind: 'error' })
    } finally {
      if (generation === generationRef.current) mappingsInFlightRef.current = false
    }
  }, [accountId, saveErrors])

  useEffect(() => {
    void loadMappings();

    return () => {
      generationRef.current += 1
      mappingsInFlightRef.current = false
    }
  }, [loadMappings])

  /*
   * WEB041：前のアカウントで押した保存の結果で、今のアカウントの対応表を
   * 読み直さない（前のアカウントの古い読み直しが今の表を上書きする）。
   * 切り替えたら保存中・失敗の文も捨てる。
   */
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  useEffect(() => {
    setSavingKey(null)
    setSaveError('')
    setEditing(null)
  }, [accountId])

  const saveMapping = async (item: AdEventMapping, values: Pick<AdEventMapping, 'mode' | 'eventName' | 'googleActionId'>) => {
    if (!accountId || !manage || savingKey) return false
    const accountAtStart = accountId
    setSavingKey(`${item.pointId}:${item.provider}`)
    try {
      const result = await api.adPlatforms.saveMapping(item.pointId, {
        account_id: accountId, provider: item.provider, ...values, expectedVersion: item.version,
      })
      if (accountRef.current !== accountAtStart) return false
      if (!result.success) throw new Error(result.error ?? '対応を保存できませんでした。読み直してからもう一度お試しください。')
      await loadMappings()
      if (accountRef.current !== accountAtStart) return false
      setEditing(null)
      return true
    } finally {
      if (accountRef.current === accountAtStart) setSavingKey(null)
    }
  }

  /* 結びつけない ⇔ 自動で返す（口が出す自動の名前）。版が合わないと 409（ほかの人が先に変えた）。 */
  const saveMode = async (item: AdEventMapping, mode: 'auto' | 'off') => {
    if (!accountId || savingKey) return
    const key = `${item.pointId}:${item.provider}`
    const accountAtStart = accountId
    const moved = () => accountRef.current !== accountAtStart
    setSavingKey(key)
    setSaveError('')
    try {
      const res = await api.adPlatforms.saveMapping(item.pointId, {
        account_id: accountId,
        provider: item.provider,
        mode,
        expectedVersion: item.version,
      })
      if (moved()) return
      if (!res.success) setSaveError(res.error ?? '対応を保存できませんでした。読み直してからもう一度お試しください。')
      await loadMappings()
    } catch (saveFailure) {
      if (moved()) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setSaveError('対応を保存できませんでした。通信状態を確かめて、もう一度お試しください。') }
    } finally {
      if (!moved()) setSavingKey(null)
    }
  }

  const nameCell = (item: AdEventMapping | null, label: string) => {
    if (adMappingReturns(item)) return manage
      ? <button type="button" className={styles.cellText} title={item!.eventName ?? ''} aria-label={`${item!.pointName} ${item!.provider}の対応を編集`} onClick={() => setEditing(item)}>{item!.eventName}</button>
      : <span className={styles.cellText} title={item!.eventName ?? ''}>{item!.eventName}</span>
    if (item && manage && item.automaticEventName) {
      return (
        <Select
          aria-label={`${item.pointName}を${label}に返す名前`}
          value={item.mode === 'off' ? 'off' : 'auto'}
          width={180}
          disabled={savingKey !== null}
          onChange={(value) => value === 'manual' ? setEditing(item) : void saveMode(item, value === 'auto' ? 'auto' : 'off')}
          options={[
            { value: 'off', label: '結びつけない' },
            { value: 'auto', label: `自動で返す（${item.automaticEventName}）` },
            { value: 'manual', label: '名前を指定する' },
          ]}
        />
      )
    }
    return item && manage
      ? <button type="button" className={styles.cellFaint} aria-label={`${item.pointName} ${item.provider}の対応を編集`} onClick={() => setEditing(item)}>{emptyValue('unknown')}</button>
      : <EmptyCell />
  }

  if (!accountId) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="empty" title="LINEアカウントを選択してください" description="選んだLINEアカウントの広告とのつなぎだけを表示します。" /></SaveErrorScope>
  }

  let table
  if (mapping.kind === 'loading') {
    table = <ListState kind="loading" title="対応表を読み込んでいます" />
  } else if (mapping.kind === 'error') {
    table = (
      <ListState
        kind="error"
        title="対応表を読み込めませんでした"
        description="対応は消えていません。読み直して、もう一度お試しください。"
        onRetry={() => void loadMappings({ userInitiated: true })}
      />
    )
  } else if (mapping.rows.length === 0) {
    table = <ListState kind="empty" title="成果地点がまだありません" description="成果地点を作ると、ここで広告に返す名前を決められます。" />
  } else {
    table = (
      <DataTable aria-label="成果地点と、広告に返す名前の対応" columnLayout={INFLOW_TABLE_LAYOUT} columnSizing="controls"><thead>
        <TableHeadRow data-table-layout="columns">
          <Th grow>成果地点</Th>
          <Th className={styles.colName}>Google広告に返す名前</Th>
          <Th className={styles.colName}>Meta広告に返す名前</Th>
          <Th className={styles.colState}>状態</Th>
        </TableHeadRow></thead><tbody>
        {mapping.rows.map((row) => {
          const returns = model.platforms.some(platform => platform.isActive && platform.verifiedAt && ((platform.name === 'google' && adMappingReturns(row.google)) || (platform.name === 'meta' && adMappingReturns(row.meta))))
          return (
            <Tr key={row.pointId} data-table-layout="columns">
              <Td grow><span className={styles.cellText} title={row.pointName}>{row.pointName}</span></Td>
              <Td className={styles.colName}>{nameCell(row.google, 'Google広告')}</Td>
              <Td className={styles.colName}>{nameCell(row.meta, 'Meta広告')}</Td>
              <Td className={styles.colState}>
                <StatusBadge tone={!model.loading && !model.failed && returns ? 'success' : 'neutral'} size="compact">{model.loading ? '確認中' : model.failed ? '確認できません' : returns ? '返している' : '返していない'}</StatusBadge>
              </Td>
            </Tr>
          )
        })}
      </tbody></DataTable>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><DetailPage boardId="FDBsG" contentPadding="0 var(--tpl-head-pad-side)" title={<>広告とのつなぎ</>}
        help={<>LINE で出た成果を広告へ返し、広告の配信を賢くします。お客様の名前やメールアドレスは広告へ送りません。</>}
        actions={<><Button href="/inflow-links?tab=connections&view=history"><History size={16} aria-hidden="true" />送信履歴を見る</Button></>}>

      <div className={adsStyles.body}>
        {editing && manage ? <AdMappingDialog key={`${accountId}:${editing.pointId}:${editing.provider}`} item={editing} onClose={() => setEditing(null)} onSave={(values) => saveMapping(editing, values)} /> : null}
        {readonly ? (
          <div className={adsStyles.viewerBand}><ReadOnlyNotice role="status"></ReadOnlyNotice></div>
        ) : null}
        <h2 className={adsStyles.sectionTitle}>返すしくみ</h2>
        <ol className={styles.steps} aria-label="返すしくみ">
          {STEPS.map((step, index) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepHead}>
                <span className={styles.stepNum} aria-hidden="true">{index + 1}</span>
                <span className={styles.stepTitle}>{step.title}</span>
              </span>
              <span className={styles.stepText}>{step.text}</span>
            </li>
          ))}
        </ol>
        {model.failed ? (
          <ListState
            kind="error"
            title="広告への送信の数を表示できませんでした"
            description="送信の記録は消えていません。読み直して、もう一度お試しください。"
            onRetry={() => { if (!model.loading) void model.reload() }}
          />
        ) : (
          <KpiBand aria-label="広告への送信の概要">
            <KpiCard icon={<Send size={16} aria-hidden="true" />} title="送った件数" loading={model.loading} value={model.loading ? null : model.sentCount} unit="件" detail={model.loading ? '読み込んでいます' : 'この30日'} />
            <KpiCard icon={<Clock size={16} aria-hidden="true" />} title="待っている" loading={model.loading} value={model.loading ? null : model.pendingCount} unit="件" detail={model.loading ? '読み込んでいます' : '送信処理を待っています'} />
            <KpiCard icon={<XCircle size={16} aria-hidden="true" />} title="断られた" loading={model.loading} value={model.loading ? null : model.failedCount} unit="件" detail={model.loading ? '読み込んでいます' : '送信履歴で理由を見られます'} />
            {/* やり直して成功の数を返す口が無いので「—」（0 にしない）。 */}
            <KpiCard icon={<RotateCw size={16} aria-hidden="true" />} title="やり直して成功" value={null} unit="" detail="自動でやり直し" />
          </KpiBand>
        )}
        <h2 className={adsStyles.sectionTitle}>成果地点と、広告に返す名前の対応</h2>
        {saveError ? <Notice tone="danger" className={adsStyles.errorNoticePlacement} >{saveError}</Notice> : null}
        {table}
        <p className={adsStyles.notice}>
          気をつけること：広告側で成果の名前を先に作ってから対応を決めてください。失敗した送信のやり直しは、送信履歴から行えます。
        </p>
      </div>
    </DetailPage></SaveErrorScope>
  )
}
