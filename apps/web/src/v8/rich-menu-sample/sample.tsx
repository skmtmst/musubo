'use client'

import { useEffect, useMemo, useState } from 'react'
import { Image as ImageIcon, Info } from 'lucide-react'
import Link from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import StaleStyleNotice from '@/components/shared/stale-style-notice'
import StatusBadge from '@/components/shared/status-badge'
import { RowMenu } from '@/components/shared/row-actions'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import { usePreparingDialog, PREPARING_TITLE, PREPARING_WORD } from '@/components/shared/preparing-dialog'
import HelpTip from '@/components/shared/help-tip'
import { DetailPage, DetailColumns } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import ListState from '@/components/shared/list-state'
import { useStarterMenu } from '@/v8/onboarding/public/use-starter-menu/index'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { styleApi } from '@/lib/api/helpers/styles'
import { FEATURES, featureHref, featureName, sampleMenuFor, styleLabel, type StyleWarning } from '@/v8/onboarding/public/model/index'
import { SampleMenuTiles } from '@/v8/onboarding/public/sample-menu/index'
import styles from './sample.module.css'

/*
 * 見本のリッチメニュー（★V8 修正案の列 VHp7p `cAaGY`。決まり ・ 追記）。
 *
 * スタイルを選んだときに入った見本のリッチメニューを、ボタンごとに「押したら何が開くか・使えるか」で見せる。
 * 中身が決まっていない機能のボタンは、上の帯・表の札「中身が未設定」・右のお客さまの見え方
 * （押したときは準備中の案内）で知らせ、［決まりを入れる］でその設定の画面へ案内する。
 * 画像を変える・保存・押したときの変更は、組4の口ができるまで準備中の窓。
 */

const AREAS = ['A', 'B', 'C', 'D', 'E', 'F']
const areaLabel = (index: number) => AREAS[index] ?? String(index + 1)
const featureMeta = (feature: string) =>
  Object.prototype.hasOwnProperty.call(FEATURES, feature) ? FEATURES[feature] : undefined

export default function RichMenuSampleV8() {
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const canEdit = canManageRole(role)
  const preparing = usePreparingDialog()
  const profile = useAccountStyle(selectedAccountId)
  const style = profile.data?.style ?? null
  const resolvedMenu = useStarterMenu(selectedAccountId, style ?? 'standard')
  const [savedMenu, setSavedMenu] = useState<{ accountId: string; style: string; name: string | null; targetId: string | null } | null>(null)
  const [warnings, setWarnings] = useState<StyleWarning[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [asideOpen, setAsideOpen] = useState(false)

  useEffect(() => {
    setSavedMenu(null); setWarnings([]); setSelected(null)
    if (!selectedAccountId || !style) return
    let cancelled = false
    void Promise.all([styleApi.starterSet(selectedAccountId, style), styleApi.starterItems(selectedAccountId)]).then(([res, items]) => {
      if (cancelled || !res.success || !items.success) return
      const definition=res.data.definition.items.find(item=>item.kind==='rich_menu');
      setSavedMenu({accountId:selectedAccountId,style,name:definition?.name??null,targetId:items.data.items.find(item=>item.kind==='rich_menu'&&item.key===definition?.key)?.target_id??null})
    }).catch(() => { /* 編集先が読めなければ操作を出さない。 */ })
    void styleApi.warnings(selectedAccountId).then((res) => { if (!cancelled && res.success) setWarnings(res.data.items ?? []) }).catch(() => { /* 帯を出さない */ })
    return () => { cancelled = true }
  }, [selectedAccountId, style])

  const sample = sampleMenuFor(style ?? 'standard')
  const menu = { ...sample, tiles: resolvedMenu.buttons.map(button => ({ ...button, icon: sample.tiles.find(tile => tile.feature === button.feature)?.icon ?? 'file' })) }
  const warned = useMemo(() => new Set(warnings.map((warning) => warning.feature)), [warnings])
  const notReady=(tile:typeof menu.tiles[number])=>tile.ready===undefined?warned.has(tile.feature):!tile.ready
  const firstWarned = menu.tiles.findIndex(notReady)
  const validSelected = selected !== null && selected >= 0 && selected < menu.tiles.length ? selected : null
  const shown = validSelected ?? (firstWarned >= 0 ? firstWarned : 0)
  const shownTile = menu.tiles[shown]
  const hrefOf = (feature: string) => featureHref(feature, warnings.find((warning) => warning.feature === feature)?.href ?? '/rich-menus', style ?? undefined)
  /* 設定の画面がまだ無い機能（クーポン・回数券）は、［決まりを入れる］で準備中の窓。 */
  const configure = (feature: string) => {
    const preparingInfo = featureMeta(feature)?.preparing
    return preparingInfo
      ? <Button onClick={() => preparing.open(preparingInfo)}>決まりを入れる</Button>
      : <Button href={hrefOf(feature)}>決まりを入れる</Button>
  }
  const currentMenu = savedMenu?.accountId === selectedAccountId && savedMenu.style === style ? savedMenu : null
  const editHref = currentMenu?.targetId ? `/rich-menus/edit?id=${encodeURIComponent(currentMenu.targetId)}` : null
  const title = currentMenu?.name ?? (style ? `${styleLabel(style)}の見本` : 'リッチメニューの見本')

  const aside = (
    <div className={styles.aside}>
      <div className={styles.asideHead}><h3 className={styles.asideTitle}>お客さまの見え方</h3><StatusBadge tone="neutral" dot>見本</StatusBadge></div>
      {profile.error ? <ListState kind="error" title="使い方を読み込めませんでした" error={profile.error} onRetry={profile.reload} /> : resolvedMenu.error ? <ListState kind="error" title="見本を読み込めませんでした" error={resolvedMenu.error} onRetry={resolvedMenu.reload} /> : style ? <SampleMenuTiles style={style} buttons={resolvedMenu.buttons} imageUrl={resolvedMenu.imageUrl} imageHeight={resolvedMenu.imageHeight} size="preview" selected={shown} warned={[...warned]} onSelect={setSelected} label="お客さまの見え方（押すと、押したときの見え方を出します）" /> : <ListState kind="loading" title="使い方を確認しています" />}
      {shownTile ? (
        <section className={styles.tap} aria-live="polite">
          <p className={styles.tapLabel}>{`押したとき（${areaLabel(shown)} ${shownTile.label}）`}</p>
          {notReady(shownTile) ? (
            <>
              <p className={styles.tapTitle}>{PREPARING_TITLE}</p>
              <p className={styles.tapNote}>もうしばらくお待ちください。ほかのメニューはお使いいただけます。</p>
            </>
          ) : (
            <>
              <p className={styles.tapTitle}>{shownTile.destination??featureMeta(shownTile.feature)?.opens??'ページを開く'}</p>
              <p className={styles.tapNote}>お客さまの LINE で、このページが開きます。</p>
            </>
          )}
        </section>
      ) : null}
    </div>
  )

  return (
    <DetailPage
      boardId="cAaGY"
      title={title}
      leading={<Link href="/rich-menus" className={styles.parent}>リッチメニュー ›</Link>}
      help="スタイルを選んだときに入った見本のリッチメニューです。見本のまま使えます。"
      actions={canEdit && editHref ? <>
        <Button href={editHref}><ImageIcon aria-hidden="true" className={styles.buttonIcon} />画像を変更する</Button>
        <Button variant="primary" href={editHref}>見本を編集する</Button>
      </> : null}
    >
      <DetailColumns presentation="card" aside={aside} asideLabel="お客さまの見え方" expanded={asideOpen} onExpandedChange={setAsideOpen}>
        {profile.stale ? <StaleStyleNotice onRetry={profile.reload} /> : null}
        {[...warned].filter((feature) => menu.tiles.some((tile) => tile.feature === feature)).map((feature) => (
          <Notice key={feature} tone="warn" appearance="soft" action={canEdit ? configure(feature) : undefined}>
            {`「${menu.tiles.find((tile) => tile.feature === feature)!.label}」のボタンの中身が決まっていません。お客さまが押すと「${PREPARING_WORD}です」と出ます。`}
          </Notice>
        ))}
        <section className={styles.section} aria-labelledby="rm-sample-buttons">
          <div className={styles.sectionHead}><h3 id="rm-sample-buttons" className={styles.sectionTitle}>ボタンの動き</h3><HelpTip label="ボタンの動きの説明">リッチメニューの各面について、お客さまが押したら何が開くかと、今使えるかを出します。</HelpTip></div>
          <GridTable label="ボタンの動き" design={{ columns: 'var(--rms-col-area) var(--rms-col-button) minmax(0, 1fr) var(--rms-col-state) var(--rms-col-menu)', gap: 'var(--polish-space-card)', rowPadding: '0 var(--polish-space-section)', rowHeight: 'var(--rms-row-h)', fontSize: 'var(--text-caption)' }}>
            <GridHeadRow>
              <GridCell role="columnheader">面</GridCell>
              <GridCell role="columnheader">ボタン</GridCell>
              <GridCell role="columnheader">押したら</GridCell>
              <GridCell role="columnheader">状態</GridCell>
              <GridCell role="columnheader">操作</GridCell>
            </GridHeadRow>
            {menu.tiles.map((tile, index) => {
              const open = notReady(tile)
              const meta = featureMeta(tile.feature)
              return (
                <GridRow key={`${tile.feature}:${index}`}>
                  <GridCell>{areaLabel(index)}</GridCell>
                  <GridCell><button type="button" className={styles.buttonName} onClick={() => setSelected(index)}>{tile.label}</button></GridCell>
                  <GridCell className={styles.opens}>
                    <span className={open ? styles.opensMain : undefined}>{tile.destination??meta?.opens??'ページを開く'}</span>
                    {open ? <span className={styles.opensNote}>{tile.reason??`${featureName(tile.feature)}の決まりが未設定`}</span> : null}
                  </GridCell>
                  <GridCell><StatusBadge tone={open ? 'warning' : 'success'} dot>{open ? '中身が未設定' : '使える'}</StatusBadge></GridCell>
                  <GridCell>
                    {canEdit && (editHref || open) ? <RowMenu appearance="box" size="row" label={`${tile.label}の操作`} items={[
                      ...(editHref ? [{ id: 'change', label: '押したときを変更する', href: editHref }] : []),
                      ...(open ? [meta?.preparing ? { id: 'configure', label: '決まりを入れる', onSelect: () => preparing.open(meta.preparing!) } : { id: 'configure', label: '決まりを入れる', href:tile.formId?`/form-submissions/edit?id=${encodeURIComponent(tile.formId)}&tab=basic`:tile.target==='history'?'/getting-started/rich-menu':hrefOf(tile.feature) }] : []),
                    ]} /> : null}
                  </GridCell>
                </GridRow>
              )
            })}
          </GridTable>
          <p className={styles.help}><Info aria-hidden="true" className={styles.helpIcon} />見本で入ったボタンです。押したときの動きは行の「…」から変えられます。</p>
        </section>
      </DetailColumns>
      {preparing.dialog}
    </DetailPage>
  )
}
