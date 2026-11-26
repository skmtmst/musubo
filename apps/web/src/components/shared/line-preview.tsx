'use client'

/* LINEの見え方は書き出しもブラウザも現在のスマホ枠だけ。中身と操作は画面が渡す。 */
import { usePhonePreviewScale } from './use-phone-preview-scale'
import { PhonePreviewScale } from './phone-preview-scale'
import { Fragment, type ReactNode } from 'react'
import { BatteryFull, ChevronDown, ChevronLeft, Menu, Phone, Search, Signal, Wifi } from 'lucide-react'
import HelpTip from './help-tip'
import FlexPreview, { safeFlexAssetUrl, sampleFlexText } from '@/components/flex-preview'
import { broadcastButtonsFlex } from '@line-crm/shared'
import { fillPreviewSample, previewSampleNote } from './preview-sample'
import styles from './line-preview.module.css'
import TruncatedText from './truncated-text'

export interface LinePreviewProps {
  /** 狭い選択窓ではスマホを列の内側に収める。省略時は正本の幅のまま。 */
  fit?: boolean
  scaleToFit?:boolean
  compact?:boolean
  /** 枠の中身。各画面の吹き出し・カードをそのまま渡す。 */
  children?: ReactNode
  /** V8で画面が指定する題。nullなら外側の題だけを使う。 */
  title?: string | null
  /**
   * 題の下に見える札。届く日時・件数など、その場で見せたい情報。
   * 動く内容なので ? には入れず、見えるまま残す。
   * v8 のスマホではトークの中の日付の札の位置に出る。
   */
  caption?: ReactNode
  /** 静かな説明だけ。題の横の？に入り、本文には出さない。 */
  note?: string
  /** 送り主の表示名（分かっている画面だけ渡す）。v8 ではトーク頭の名前になる。 */
  accountName?: string
  /**
   * まだ中身が無いとき。`true` なら `children` を空の箱で出し、
   * 文字ならその文を空の箱で出す。
   */
  empty?: boolean | string
  /**
   * リッチメニュー（★V8 gobhu・egdGx・K0gu1・gQabc）。渡すと、本物の LINE と同じく
   * **トーク画面のいちばん下（入力の帯の位置）**にメニューを出し、トークはその上で縮む。
   * 下の帯は1本だけで、文字は `chatBarText`（無ければ「メニュー」）。
   * 渡さない画面はこれまでどおり（トーク＋「メニュー ∨」の帯）。
   */
  richMenu?: ReactNode
  /** リッチメニューの下の帯の文字（トーク画面の下の文言）。`richMenu` と一緒に使う。 */
  chatBarText?: string
}

export default function LinePreview({
  fit = false,
  scaleToFit=false,
  compact=false,
  children,
  title = 'LINEでの見え方',
  caption,
  note,
  accountName,
  empty = false,
  richMenu,
  chatBarText,
}: LinePreviewProps) {


  /*
   * ★V8（夕15・cfVyj）：本物のスマホの枠 330×690。題は外の上、
   * 届く日時はトークの中の日付の札の位置、中身はトークの中だけが
   * 縦に送れる。見た目は line-preview.module.css の v8 節に集める。
   */

    const scaled=usePhonePreviewScale(scaleToFit)
    return (
      <section ref={scaled.ref} aria-label="LINEでの見え方" className={styles.phoneRoot} data-line-preview-part="phone" data-fit={fit || undefined}>
        {/* 題は列の左、スマホはその下の真ん中。テンプレートでは「届き方」や外側の題を使う。 */}
        {title !== null ? <p className={styles.phoneTitle}>
          <span>{title}</span>
          {note ? <HelpTip label="LINEでの見え方の説明">{note}</HelpTip> : null}
        </p> : null}
        <PhonePreviewScale enabled={scaleToFit} scale={scaled.scale}><div className={styles.phone} data-compact={compact||undefined} data-line-preview-part="device-frame">
          <div className={styles.screen}>
            <div className={styles.statusBar}>
              <span className={styles.clock}>9:41</span>
              <span className={styles.island} aria-hidden="true" />
              <span className={styles.statusIcons}>
                <Signal size={16} strokeWidth={1.8} aria-hidden="true" />
                <Wifi size={16} strokeWidth={1.8} aria-hidden="true" />
                <BatteryFull size={20} strokeWidth={1.8} aria-hidden="true" />
              </span>
            </div>
            <div className={styles.talkHead}>
              <ChevronLeft size={20} aria-hidden="true" />
              <span className={styles.talkName}>{accountName ?? '公式アカウント'}</span>
              <Search size={16} aria-hidden="true" />
              <Phone size={16} aria-hidden="true" />
              <Menu size={16} aria-hidden="true" />
            </div>
            <div className={styles.talk} data-line-preview-part="talk">
              {/* リッチメニューの見本（gobhu）はトークが空で、日付の札も無い。届く日時を渡したときだけ出す。 */}
              {richMenu && caption === undefined ? null : <p className={styles.dateChip}><span>{caption ?? '今日'}</span></p>}
              {empty ? (
                <p className={styles.emptyNote}>
                  {typeof empty === 'string' ? empty : children}
                </p>
              ) : (
                children
              )}
            </div>
            {richMenu ? <div className={styles.richMenu} data-line-preview-part="rich-menu">{richMenu}</div> : null}
            <div className={styles.menuBar} data-line-preview-part="menu-bar">
              <span>{richMenu ? (chatBarText || 'メニュー') : 'メニュー'}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
            <div className={styles.homeBar}><span className={styles.homeLine} aria-hidden="true" /></div>
          </div>
        </div>
      </PhonePreviewScale></section>
    )


}

/**
 * 本文の URL は途中で折らず1行にし、入らないときは末尾を「…」にする（全文は title・）。
 */
function withUrlLines(text: string): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s]+)/g)
  if (parts.length === 1) return text
  return parts.map((part, index) => index % 2 === 1
    ? <span key={index} className={styles.urlLine} title={part}>{part}</span>
    : <Fragment key={index}>{part}</Fragment>)
}

/** cfVyj の受信メッセージ。日時・送り主・本文をそのまま渡す。 */
export function LinePreviewMessage({ accountName, avatar, time, children, direction = 'incoming', density, bare = false }: {
  accountName: string; avatar: ReactNode; time: string; children: ReactNode; direction?: 'incoming' | 'outgoing'; density?: 'compact'
  /** 写真など、それ自体が角丸の札になる中身。白い吹き出しとしっぽを付けず、そのまま置く。 */
  bare?: boolean
}) {
  /* 本文が文字なら、差し込みの記号を見本の値にして出す（記号のままスマホに出さない）。 */
  const sample = typeof children === 'string' ? fillPreviewSample(children) : null
  const body = sample ? sample.text : children
  const sampleNote = sample ? previewSampleNote(sample.kinds) : null
  if (direction === 'outgoing') return <div className={styles.outgoingRow}>
    {time ? <span className={styles.messageTime}>{time}</span> : null}
    <div className={styles.outgoingBubble}>{body}</div>
  </div>
  return <div className={styles.messageRow} data-density={density}>
    <span className={styles.senderAvatar}>{avatar}</span>
    <div className={styles.senderBody}>
      <TruncatedText value={accountName} className={styles.senderName} />
      <div className={styles.bubbleRow}>
        {bare ? children : <div className={styles.bubble}>
          <svg className={styles.tail} viewBox="0 0 10 8" aria-hidden="true"><path d="M8 0 0 6 10 8Z" fill="currentColor" /></svg>
          <div className={styles.bubbleBody}><span className={styles.bubbleText}>{typeof body === 'string' ? withUrlLines(body) : body}</span></div>
        </div>}
        <span className={styles.messageTime}>{time}</span>
      </div>
      {sampleNote ? <LinePreviewSampleNote>{sampleNote}</LinePreviewSampleNote> : null}
    </div>
  </div>
}

/** 差し込みを見本の値にしたことを、吹き出しの下に小さく添える。 */
export function LinePreviewSampleNote({ children }: { children: ReactNode }) {
  return <span className={styles.sampleNote} data-preview-sample-note="">{children}</span>
}

/** cfVyj の商品カード。操作は必ず呼び出し側から渡す。 */
export function LinePreviewCard({ imageUrl, title, description, price, time, actions }: {
  imageUrl: string; title: string; description: string; price: string; time: string;
  actions: Array<{ label: string; onClick: () => void; secondary?: boolean }>
}) {
  return <div className={styles.cardRow}>
    <div className={styles.productCard}>
      <div className={styles.productImage} role="img" aria-label={title} style={{ backgroundImage: `url(${JSON.stringify(imageUrl)})` }} />
      <div className={styles.productCopy}>
        <span className={styles.productTitle}>{title}</span>
        <span className={styles.productDescription}>{description}</span>
        <span className={styles.priceRow}><span className={styles.price}>{price}</span><span className={styles.tax}>税込</span></span>
      </div>
      {actions.map(action => <button key={action.label} type="button" className={`${styles.productAction} ${action.secondary ? styles.secondaryAction : ''}`} onClick={action.onClick}>{action.label}</button>)}
    </div>
    <span className={styles.messageTime}>{time}</span>
  </div>
}

/**
 * カルーセル：写真・題・短い文・押す所のカードを横に並べ、はみ出した分は横へ送る。
 * 見本なので押す所は押せない文字にする。写真が無いカードは画像欄を省く。
 */
export function LinePreviewCarousel({ columns, time }: {
  columns: Array<{ title: string; text: string; imageUrl?: string | null; actions: string[] }>; time?: string
}) {
  return <div className={styles.cardRow}>
    <div className={styles.carouselTrack}>
      {columns.map((column, index) => <div key={index} className={`${styles.productCard} ${styles.carouselCard}`}>
        {column.imageUrl ? <div className={styles.productImage} role="img" aria-label={fillPreviewSample(column.title || 'カードの写真').text} style={{ backgroundImage: `url(${JSON.stringify(column.imageUrl)})` }} /> : null}
        <div className={styles.productCopy}>
          {column.title ? <span className={styles.productTitle} title={fillPreviewSample(column.title).text}>{fillPreviewSample(column.title).text}</span> : null}
          {column.text ? <span className={styles.productDescription} title={fillPreviewSample(column.text).text}>{fillPreviewSample(column.text).text}</span> : null}
        </div>
        {column.actions.map((label) => <span key={label} className={styles.productAction}>{fillPreviewSample(label).text}</span>)}
      </div>)}
    </div>
    {time ? <span className={styles.messageTime}>{time}</span> : null}
  </div>
}

/** Flex はトーク枠内で描く。JSON の検査・安全な描画は既存レンダラーに任せる。 */
function TemplatePreview({ value, maxWidth }: { value: Record<string, unknown>; maxWidth?: number }) {
  if ((value.type === 'carousel' || value.type === 'image_carousel') && Array.isArray(value.columns)) {
    return <div style={{ display: 'flex', gap: 8, overflowX: 'auto', maxWidth: '100%' }}>{value.columns.map((column, index) => {
      if (!column || typeof column !== 'object') return null
      const card = column as Record<string, unknown>
      if (value.type === 'image_carousel') {
        const image = typeof card.imageUrl === 'string' ? safeFlexAssetUrl(card.imageUrl) : null
        const label = typeof (card.action as Record<string, unknown> | undefined)?.label === 'string' ? String((card.action as Record<string, unknown>).label) : ''
        return image ? <div key={index} style={{ position: 'relative', width: maxWidth || 210, flexShrink: 0, overflow: 'hidden', borderRadius: 12 }}><img src={image} alt="" width={210} height={210} style={{ display: 'block', width: '100%', aspectRatio: '1', objectFit: 'cover' }} referrerPolicy="no-referrer" />{label ? <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '8px', textAlign: 'center', color: 'var(--color-on-accent)', background: 'rgba(0,0,0,.45)' }}>{label}</span> : null}</div> : null
      }
      return <div key={index} style={{ flexShrink: 0 }}><TemplatePreview value={{ ...card, type: 'buttons' }} maxWidth={maxWidth} /></div>
    })}</div>
  }
  const actions = Array.isArray(value.actions) ? value.actions : []
  const horizontal = value.type === 'confirm'
  const image = typeof value.thumbnailImageUrl === 'string' ? safeFlexAssetUrl(value.thumbnailImageUrl) : null
  return <div style={{ width: maxWidth || 210, maxWidth: '100%', overflow: 'hidden', borderRadius: 12, background: 'var(--color-canvas)', color: 'var(--color-ink)' }}>
    {image ? <img src={image} alt="" width={210} height={140} style={{ width: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" /> : null}
    <div style={{ padding: '12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {typeof value.title === 'string' && value.title ? <strong>{value.title}</strong> : null}
      <div>{typeof value.text === 'string' ? value.text : ''}</div>
    </div>
    <div style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', borderTop: '1px solid var(--color-hairline)' }}>
      {actions.map((item, index) => <div key={index} style={{ flex: 1, minWidth: 0, padding: '12px 4px', color: 'var(--tpl-rt-rich-link)', textAlign: 'center', borderTop: !horizontal && index ? '1px solid var(--color-hairline)' : undefined, borderLeft: horizontal && index ? '1px solid var(--color-hairline)' : undefined, overflowWrap: 'anywhere' }}>{item && typeof item === 'object' && 'label' in item ? String(item.label) : ''}</div>)}
    </div>
  </div>
}

export function LinePreviewFlex({ content, maxWidth }: { content: string; maxWidth?: number }) {
  try {
    const parsed = sampleFlexText(JSON.parse(content)) as Record<string, unknown> | null
    const template = parsed?.type === 'template' && parsed.template && typeof parsed.template === 'object' ? parsed.template as Record<string, unknown> : parsed
    if (template && (template.type === 'buttons' || template.type === 'confirm' || ((template.type === 'carousel' || template.type === 'image_carousel') && Array.isArray(template.columns)))) return <TemplatePreview value={template} maxWidth={maxWidth} />
  } catch { /* FlexPreview は不正な JSON を案内する。 */ }
  return <FlexPreview content={content} maxWidth={maxWidth} sample />
}

/** 別の Flex として送る追加ボタンを、同じ送信データから表示する。 */
export function LinePreviewButtons({ buttons }: { buttons: Array<{ label: string; value: string; type?: string }> }) {
  if (!buttons.length) return null
  return <div style={{ paddingLeft: 40 }}><LinePreviewFlex maxWidth={210} content={JSON.stringify(broadcastButtonsFlex(buttons))} /></div>
}
