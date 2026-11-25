import { AutoFormLeaveGuard, FormLeaveGuard } from '@/components/shared/form-leave-guard'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import type { ReactNode, HTMLAttributes, Ref } from 'react'
import StickyBar from '@/components/shared/sticky-bar'
import FormSecondaryActions from './form-secondary-actions'
import { normalizeProgressActionArrows, splitFormActions } from './page-action-nodes'
import { PageFrame, PageHeading, type PageHeadingProps } from './page-frame'
import PreviewLauncher from './preview-launcher'
import styles from './page-templates.module.css'
import { StepContent } from './steps'

export interface CreatePageProps extends PageHeadingProps {
  step?: number | null
  readOnly?: boolean | 'hq'
  /** 本文の入力をネイティブfieldsetでまとめて無効にする。 */
  contentDisabled?: boolean
  contentLabel?: string
  dirty?: boolean
  busy?: boolean
  boardId?: string
  elementRef?: Ref<HTMLDivElement>
  standalone?: boolean
  /** 短い入力は内容の高さ、長い入力は画面内に収めて本文だけを送る。 */
  heightMode?: 'viewport' | 'content'
  children: ReactNode
  preview?: ReactNode | ((inDialog: boolean) => ReactNode)
  /** 畳んだ右欄の役目。LINE以外の設定・試算にも同じ入口を使う。 */
  previewLabel?: string
  previewTitle?: string
  /** 狭い板でプレビューを開くボタン・パネルは画面が持つ。 */
  previewToggle?: ReactNode
  /** ★V8：狭い板（白い板 1100 未満）で右の列の余白を 16 に詰める。渡さなければ今までどおり 24。 */
  previewCompactWhenNarrow?: boolean
  /** 白い板が1100未満のとき右欄を畳む。見本は既存のボタンで開く。 */
  hidePreviewWhenNarrow?: boolean
  /** 板の頭のすぐ下に、入力欄と右の列の両方にまたがる幅で置く帯（同時編集の知らせなど。）。 */
  notice?: ReactNode
  /** 板の頭のすぐ下に、板の幅で置くタブの段（店のタブ。）。一覧・詳細の型の tabs と同じ置き方。 */
  tabs?: ReactNode
  /**
   * 帯の置き場の余白。`'band'` は「帯の段」の絵（上 0・左右 24・下 8。・ ほかの競合の帯）。
   * 渡さなければ今までどおり（上下 12・左右 24。）。
   */
  noticeSpacing?: 'band'
  /**
   * 入力欄と右の列の余白の口。渡さなければ型の既定（入力欄 上下 24・左右 28・段の間 16、右の列 24）。
   * `'flush-top'` は板の頭のすぐ下から始める絵（両方とも上 4・左右 24・下 24、入力欄の段の間 28。
   * E-9 統括の一括配信 p17Qku）。画面の CSS で型の余白を上書きせず、ここで選ぶ。
   * `'notice-after-preview'` は先頭Noticeと直前の表示面を8pxで離す。狭幅のプレビュー操作と広幅のタブの両方へ適用する。
   * `'notice-after-read-only'` は閲覧帯と本文先頭のNoticeが直に続くとき、後者の上余白だけで間隔を持つ。
   */
  contentSpacing?: 'flush-top' | 'notice-after-preview' | 'notice-after-read-only'
  /** 本文末尾へ中央配置する補助操作。固定フッターとは別に置く。 */
  bodyEndActions?: ReactNode
  /** 右の列の地。`'plain'` は地の色を敷かない（E-9 p17Qku）。渡さなければ白い板と同じ地。 */
  previewSurface?: 'plain'
  footerActions: ReactNode
  footerLead?: ReactNode
  /** 浮いた帯が本文の末尾の余白に重なる板。入力段の中身には重ねない。 */
  footerPlacement?: 'floating'
  /** 枠のある下部の帯を描く板だけで使う。StickyBar の既定は変えない。 */
  footerOutlined?: boolean
  destructive?: ReactNode
  status?: ReactNode
}
export function CreatePage({ step = null, readOnly, contentDisabled, contentLabel, dirty, busy, boardId, elementRef, standalone, heightMode, children, preview, previewLabel, previewTitle, previewToggle, previewCompactWhenNarrow, hidePreviewWhenNarrow = true, notice, tabs, noticeSpacing, contentSpacing, bodyEndActions, previewSurface, footerActions, footerLead, footerPlacement, footerOutlined, destructive, status, ...heading }: CreatePageProps) {
  const formActions = splitFormActions(normalizeProgressActionArrows(footerActions))
  const Content = StepContent
  const readOnlyAfterHeading = !!readOnly && contentSpacing === 'notice-after-read-only'
  const aside = typeof preview === 'function' ? preview(false) : preview
  const dialogPreview = typeof preview === 'function' ? preview(true) : preview
  const body = <>
    {readOnlyAfterHeading ? <div className={styles.createNotice} data-template-region="notice" data-content-spacing={contentSpacing}><ReadOnlyNotice scope={heading.readOnlyBand === 'hq' ? 'hq' : 'store'} need={heading.readOnlyNeed} /></div> : null}
    {tabs ? <div className={styles.tabs} data-template-region="tabs">{tabs}</div> : null}
    {notice ? <div className={styles.createNotice} data-template-region="notice" data-notice-spacing={noticeSpacing}>{notice}</div> : null}
    {previewToggle || (preview && hidePreviewWhenNarrow) ? <div className={styles.asideToggle} data-content-spacing={contentSpacing === 'notice-after-preview' ? contentSpacing : undefined}>{previewToggle ?? <PreviewLauncher label={previewLabel} title={previewTitle}>{dialogPreview}</PreviewLauncher>}</div> : null}
    <div className={styles.split} data-template-region="body">
      <Content step={step} as={contentDisabled === undefined ? 'div' : 'fieldset'} className={styles.createContent} data-template-region="content" data-content-spacing={contentSpacing} disabled={contentDisabled} aria-label={contentDisabled === undefined ? undefined : contentLabel ?? '入力内容'}>
        {children}
        {bodyEndActions ? <div className={styles.bodyEndActions} data-template-region="body-end-actions">{bodyEndActions}</div> : null}
      </Content>
      {preview ? <aside aria-label={previewLabel} className={styles.preview} data-template-region="preview" data-preview-narrow={hidePreviewWhenNarrow ? 'hidden' : previewCompactWhenNarrow ? 'compact' : undefined} data-content-spacing={contentSpacing} data-preview-surface={previewSurface}><div className={styles.previewContent}>{aside}</div></aside> : null}
    </div>
  </>
  return <PageFrame kind="create" boardId={boardId} elementRef={elementRef} standalone={standalone} heightMode={heightMode ?? (footerActions ? 'viewport' : 'content')} hasFooter={!!footerActions}>
    {dirty === undefined ? <AutoFormLeaveGuard busy={busy} /> : dirty ? <FormLeaveGuard dirty busy={busy} /> : null}
    {/* 閲覧帯は頭の中に置く（tagf）。本文先頭にも知らせが続く画面（notice-after-read-only）だけは、余白を後の知らせへ集約するため頭の直下に置く。 */}
    <PageHeading {...heading} readOnlyBand={readOnlyAfterHeading ? heading.readOnlyBand : readOnly || heading.readOnlyBand} actions={<>{heading.actions}{formActions.secondary.length ? <FormSecondaryActions buttons={formActions.secondary} /> : null}</>} />
    {contentSpacing === undefined ? <div className={styles.createFlow} data-template-region="create-flow">{body}</div> : body}
    {footerActions ? <div className={styles.footer} data-template-region="footer" data-footer-placement={footerPlacement}><StickyBar actions={formActions.main} outlined={footerOutlined} destructive={destructive} status={status} leadAction={footerLead} /></div> : null}
  </PageFrame>
}

/** 右の見え方は入力の高さへ収め、長い見本だけを欄の中で送る。 */
export function CreateColumns({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={styles.createColumns} data-template-region="body">{children}</div>
}
