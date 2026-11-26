'use client'

/*
 * テンプレートの作る・編集の外枠。作る型（CreatePage）と同じ板の頭・左右の列・
 * 下の帯を、型の部品（PageFrame・PageHeading）と型の CSS で組む。
 * 型に無いのは1つだけ：頭のすぐ下の「帯の段」（競合の帯）。
 */
import { useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import Drawer from '@/components/shared/drawer'
import HelpTip from '@/components/shared/help-tip'
import StatusBadge from '@/components/shared/status-badge'
import Button from '@/components/shared/button'
import type { TemplateEditHost } from './host'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import PreviewLauncher from '@/components/templates/preview-launcher'
import tpl from '@/components/templates/page-templates.module.css'
import StickyBar from '@/components/shared/sticky-bar'
import styles from './edit.module.css'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { ToggleField } from '@/components/shared/toggle'

/** ［保存して公開］の手前の一言。公開は版の切替で、友だちへの送信はしない。 */
export function TemplatePublishNote() {
  return <p className={styles.publishNote}>公開しても、この操作では友だちに送信しません</p>
}

export function TemplateEditFrame({
  boardId,
  title,
  description,
  band,
  children,
  side,
  footerActions,
  footerInfo,
  status,
  composerHost,
  onComposerInsert,
  inputReason,
}: {
  /** 必須入力が空の時だけ渡す。形式・長さの検査は各画面の保存時に保つ。 */
  inputReason?: string | null
  onComposerInsert?: (alsoSave: boolean) => void
  composerHost?: TemplateEditHost
  boardId: string
  title: string
  description: ReactNode
  band?: ReactNode
  children: ReactNode
  side: ReactNode | ((inDialog: boolean) => ReactNode)
  /** 閲覧のみでは渡さない（押せない操作は置かない）。 */
  footerActions?: ReactNode
  /** 操作の手前に添える読むだけの一言（下の帯の左）。 */
  footerInfo?: ReactNode
  /** 下の帯の左の文（下書きの自動保存の状態）。 */
  status?: ReactNode
}) {
  const [alsoSave, setAlsoSave] = useState(false)
  const sideContent = typeof side === 'function' ? side(false) : side
  const dialogContent = typeof side === 'function' ? side(true) : side
  if (composerHost?.composer) return <Drawer open dirty={false} width="composer" viewportInset heightMode="viewport" title={title} titleAccessory={<span className={styles.composerTitleAccessories}><HelpTip label="この画面の使い方">テンプレートと同じ編集画面です。作ったものをこの吹き出しに入れます。</HelpTip><StatusBadge tone="neutral" dot={false}>{`吹き出し ${composerHost.composer.index + 1} に入ります`}</StatusBadge></span>} onClose={composerHost.onCancel} busy={composerHost.busy} footer={<div className={styles.composerFooter}>
    {composerHost.composer.canSaveTemplate !== false ? <span className={styles.composerTitleAccessories}><SaveErrorField names={["alsoSave","also_save"]}><ToggleField disabled={composerHost.busy} checked={alsoSave} onChange={setAlsoSave}>テンプレートとしても保存する</ToggleField></SaveErrorField><HelpTip label="テンプレートとしても保存する">入れた中身をテンプレートの一覧にも残します。ほかの配信でも呼び出せます。</HelpTip></span> : <span />}
    <span className={styles.composerFooterActions} data-incomplete={Boolean(inputReason) || undefined}><Button disabled={composerHost.busy} onClick={composerHost.onCancel}>キャンセル</Button><Button variant="primary" disabled={composerHost.busy || Boolean(inputReason)} disabledReason={inputReason} busy={composerHost.busy} onClick={() => onComposerInsert?.(alsoSave)}><Check size={16} aria-hidden="true" />この吹き出しに入れる</Button></span>
  </div>}><div className={styles.composerSplit}><div className={styles.composerContent}>{band}{children}</div><aside className={styles.composerSide}>{sideContent}</aside></div></Drawer>
  return (
    <PageFrame kind="create" boardId={boardId} hasFooter={Boolean(footerActions)}>
      {/* 板の頭に戻る（← テンプレートへ）は置かない。戻るのは上の帯のパンくずと下の帯の［キャンセル］（オーナー 2026-10-08）。 */}
      <PageHeading
        title={title}
        help={description}
      />
      {band ? <div className={styles.bandRow}>{band}</div> : null}
      <div className={tpl.asideToggle}><PreviewLauncher>{dialogContent}</PreviewLauncher></div>
      <div className={tpl.split} data-template-region="body">
        <div className={tpl.createContent} data-template-region="content">{children}</div>
        <aside className={styles.side} data-template-region="preview" data-preview-narrow="hidden">
          <div className={styles.sideContent}>{sideContent}</div>
        </aside>
      </div>
      {footerActions ? (
        <div className={tpl.footer} data-template-region="footer"><StickyBar actions={footerActions} status={status} info={footerInfo} /></div>
      ) : null}
    </PageFrame>
  )
}
