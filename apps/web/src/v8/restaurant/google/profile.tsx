'use client'
import { useGooglePermission } from './use-google-permission'
import { useCallback, useEffect, useRef, useState } from 'react'
import { GitCompare, History, Pencil, RefreshCw } from 'lucide-react'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { restaurantGoogleApi, type GoogleProfileAddress, type GoogleProfileData } from '@/lib/restaurant-google-api'
import { errorMessage, formatPeriods, formatStampFull, formatYmdShort, summarizeWeekly } from './format'
import type { GoogleNav } from './navigation-types'
import styles from './google.module.css'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value'
import { formatNumber } from '@/lib/format'



function addressText(a: GoogleProfileAddress | null | undefined): string {
  if (!a) return '—'
  return [a.postalCode ? `〒${a.postalCode}` : '', a.administrativeArea ?? '', a.locality ?? '', ...a.addressLines].filter(Boolean).join('') || emptyValue('unknown')
}

const COMPARABLE = ['regularHours', 'specialHours', 'storefrontAddress', 'phoneNumbers', 'profile', 'title', 'websiteUri']

export default function ProfileBoard({ accountId, go }: { accountId: string; go: GoogleNav }) {
  const { allowed: canEdit, lockedReason } = useGooglePermission('manager')
  const { allowed: canSync, lockedReason: syncReason } = useGooglePermission()
  const [data, setData] = useState<GoogleProfileData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadFailure, setLoadFailure] = useState<unknown>(null)
  const [syncing, setSyncing] = useState(false)
  const syncLock = useRef(false)
  const requestSeq = useRef(0)
  const [showDiff, setShowDiff] = useState(false)
  const [showMore, setShowMore] = useState(false)

  const load = useCallback(async (sync = false) => {
    if (sync) {
      if (!canSync || syncLock.current) return
      syncLock.current = true
      setSyncing(true)
    } else setLoading(true)
    const seq = ++requestSeq.current
    setError('')
    setLoadFailure(null)
    try {
      const next = sync ? await restaurantGoogleApi.syncProfile(accountId) : await restaurantGoogleApi.profile(accountId)
      if (seq !== requestSeq.current) return
      setData(next)
    } catch (err) {
      if (seq !== requestSeq.current) return
      if (!sync) setData(null)
      setLoadFailure(err)
      setError(errorMessage(err, 'プロフィールを読み込めませんでした。'))
    } finally {
      if (seq === requestSeq.current) setLoading(false)
      if (sync) {
        syncLock.current = false
        setSyncing(false)
      }
    }
  }, [accountId, canSync])

  useEffect(() => {
    void load()
    return () => { requestSeq.current += 1 }
  }, [load])

  if (loading && !data) return <div className={styles.stateBox}><ListState kind="loading" title="プロフィールを読み込んでいます" /></div>
  if (!data) {
    return <ListState kind="error" title="プロフィールを表示できませんでした" error={loadFailure} description={error} onRetry={() => void load()} action={<TextLink inline href="/settings/sns">SNS連携で接続を確認する</TextLink>} />
  }

  const { profile } = data
  const canChange = !data.closed && canEdit
  const updates = data.googleUpdates
  const special = profile.specialHours.length
    ? profile.specialHours.slice(0, 4).map((s) => `${formatYmdShort(s.date)} ${s.closed ? '休業' : formatPeriods(s.periods)}`).join('、') + (profile.specialHours.length > 4 ? ` ほか${profile.specialHours.length - 4} 件` : '')
    : '今後の予定はありません'
  const infoRows: Array<[string, string]> = [
    ['店名', profile.title ?? emptyValue('unknown')],
    ['住所', addressText(profile.address)],
    ['電話', profile.phone ?? emptyValue('unconfigured')],
    ['サイト', profile.websiteUri ?? emptyValue('unconfigured')],
    ['カテゴリ', '—'],
  ]
  const moreRows: Array<[string, string]> = [
    ['通常の営業時間', summarizeWeekly(profile.regularHours)],
    ['特別営業時間', special],
    ['写真・店舗紹介', `${data.photoCount === null ? '店舗写真 —' : `店舗写真 ${formatNumber(data.photoCount)} 枚`} / ${profile.description ? '紹介文あり' : '紹介文なし'}`],
  ]

  return (
    <>
      {data.stale ? <Notice tone="warn" action={<Button variant="text" lockedReason={syncReason} disabled={!canSync || syncing} onClick={() => void load(true)} busy={syncing} busyLabel="取得中…">もう一度取得</Button>}>{`Googleから最新の情報を読み込めませんでした。前回取得した内容（${formatStampFull(data.fetchedAt)}）を表示しています。`}</Notice> : null}
      {!data.stale && data.closed ? <Notice tone="warn" role="alert">Google側で「臨時休業」または「閉業」になっています。営業時間の変更はGoogleビジネスプロフィールで営業状態を戻してから行ってください。</Notice> : null}
      {!data.stale && !data.closed && data.pendingChangeCount > 0 ? <Notice tone="info" action={<Button variant="text" onClick={() => go({ tab: 'profile', view: 'history', result: 'pending' })}>状態を確認する</Button>}>{`Googleに変更を送信しました。反映を確認できるまで「反映確認中」と表示します（${formatNumber(data.pendingChangeCount)} 件）。`}</Notice> : null}
      {error ? <Notice tone="danger" action={!data.stale && canSync ? <Button variant="text" size="inline" lockedReason={syncReason} disabled={!canSync || syncing} onClick={() => void load(true)} busy={syncing} busyLabel="取得中…">再同期する</Button> : undefined}>{error}</Notice> : null}
      <div><Button variant="text" onClick={() => go({ tab: 'hours' })}>営業時間を開く</Button></div>
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="gb-store-info-title">
        <SectionHeader size="small" title={<span id="gb-store-info-title">店舗情報</span>}
          helpLabel="店舗情報の説明" help={<>Googleに表示されている内容です。変更は1つの編集画面でまとめて行い、確認してから送信します。自動で以前の内容に戻すことはしません。</>} />
        <dl className={styles.facts}>
          {[...infoRows, ...(showMore ? moreRows : [])].map(([label, value]) => (
            <div key={label} className={styles.factRow}><dt className={styles.factKey}>{label}</dt><dd className={styles.factValue} title={value}>{value}</dd></div>
          ))}
        </dl>
        <div className={styles.buttonRowEnd}>
          <Button variant="text" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore}>{showMore ? 'ほかの項目を閉じる' : 'ほかの項目（特別営業時間・写真）'}</Button>
          <span className={styles.spacer} aria-hidden="true" />
          <Button onClick={() => go({ tab: 'profile', view: 'history' })}><History aria-hidden className={styles.icon15} />変更履歴を見る</Button>
          <Button variant="primary" disabled={!canChange} lockedReason={lockedReason} onClick={() => { if (canChange) go({ tab: 'profile', view: 'edit' }) }}><Pencil aria-hidden className={styles.icon15} />プロフィールを編集する</Button>
        </div>
      </Card>
      <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-labelledby="gb-google-updates-title">
        <SectionHeader size="small" title={<span id="gb-google-updates-title">Google側の変更を確認</span>} note={updates && updates.fields.length > 0 ? <StatusBadge tone="warning">{`確認が必要 ${formatNumber(updates.fields.length)} 件`}</StatusBadge> : <StatusBadge tone="neutral">{updates ? '確認が必要な変更はありません' : '未確認'}</StatusBadge>} />
        <Notice tone="warn" title="この画面で比較できるのは、店舗名・住所・電話番号・ウェブサイト・通常の営業時間・特別営業時間・店舗紹介文です。">
          Google やお客さまの提案で、店舗情報が変わることがあります。違いがあれば、ここで確かめて採るか戻すかを選びます。
        </Notice>
        {showDiff && updates ? (
          <dl className={styles.diffList}>
            {updates.fields.map((f) => {
              const key = f.mask.split('.')[0]
              if (!COMPARABLE.includes(key)) {
                return (
                  <div key={f.mask} className={styles.diffItem}>
                    <dt className={styles.fieldLabel}>{f.label}</dt>
                    <dd className={styles.muted}>この項目はこの画面で比較できません。<TextLink external iconTone="link" href="https://business.google.com/"   className={styles.textLink}>Googleの管理画面へ</TextLink></dd>
                  </div>
                )
              }
              const u = updates.updated
              const pick = (src: Partial<typeof profile>) => key === 'regularHours' ? (src.regularHours ? summarizeWeekly(src.regularHours) : emptyValue('unknown'))
                : key === 'specialHours' ? (src.specialHours ? src.specialHours.map((s) => `${formatYmdShort(s.date)} ${s.closed ? '休業' : formatPeriods(s.periods)}`).join('、') || emptyValue('none') : emptyValue('unknown'))
                  : key === 'storefrontAddress' ? addressText(src.address)
                    : key === 'phoneNumbers' ? src.phone ?? emptyValue('unknown')
                      : key === 'profile' ? src.description ?? emptyValue('unknown')
                        : key === 'title' ? src.title ?? emptyValue('unknown')
                          : src.websiteUri ?? emptyValue('unknown')
              return (
                <div key={f.mask} className={styles.diffItem}>
                  <dt className={styles.fieldLabel}>{f.label}</dt>
                  <dd className={styles.muted}>{`現在：${pick(profile)}`}</dd>
                  <dd className={styles.diffProposed}>{`Googleの提案：${pick(u)}`}</dd>
                </div>
              )
            })}
          </dl>
        ) : null}
        <div className={styles.buttonRowEnd}>
          {updates && updates.fields.length > 0 ? (
            <Button onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}><GitCompare aria-hidden className={styles.icon15} />{showDiff ? '差分を閉じる' : '差分を見る'}</Button>
          ) : (
            <Button lockedReason={syncReason} disabled={!canSync || syncing} onClick={() => void load(true)} busy={syncing} busyLabel="取得中…"><RefreshCw aria-hidden className={styles.icon15} />同期する</Button>
          )}
        </div>
      </Card>
      <p className={styles.footCaption}>{`最終取得 ${formatStampFull(data.fetchedAt)}・店舗の時刻は${data.timeZone === 'Asia/Tokyo' ? '日本時間' : data.timeZone}で表示`}</p>
    </>
  )
}
