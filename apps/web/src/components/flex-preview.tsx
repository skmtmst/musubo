'use client'

/**
 * Flex Message visual preview — renders LINE Flex JSON as a styled card.
 * Supports bubble (single) and carousel (multiple bubbles).
 * Covers: text, button, separator, image, box, icon, spacer, span.
 */

interface FlexNode {
  type: string
  text?: string
  contents?: FlexNode[]
  action?: { type: string; label?: string; text?: string; uri?: string }
  // Style
  size?: string
  weight?: string
  color?: string
  wrap?: boolean
  margin?: string
  flex?: number
  align?: string
  gravity?: string
  layout?: string
  spacing?: string
  backgroundColor?: string
  cornerRadius?: string
  paddingAll?: string
  paddingTop?: string
  paddingBottom?: string
  paddingStart?: string
  paddingEnd?: string
  style?: string
  height?: string
  width?: string
  url?: string
  aspectRatio?: string
  aspectMode?: string
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  position?: string
  borderWidth?: string
  borderColor?: string
  hero?: FlexNode
  header?: FlexNode
  body?: FlexNode
  footer?: FlexNode
  justifyContent?: string
  // 未知のLINE属性は受け入れるが、描画前に既知の型へ絞る。
  [key: string]: unknown
}

const sizeMap: Record<string, string> = {
  xxs: '10px', xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '18px', xxl: '22px',
  '3xl': '26px', '4xl': '30px', '5xl': '36px',
}

const marginMap: Record<string, string> = {
  none: '0', xs: '2px', sm: '4px', md: '8px', lg: '12px', xl: '16px', xxl: '20px',
}

const spacingMap = marginMap

function getSize(s?: string) { return s ? sizeMap[s] || s : undefined }
function getMargin(m?: string) { return m ? marginMap[m] || m : undefined }
function getSpacing(s?: string) { return s ? spacingMap[s] || s : undefined }

/*
 * LINE の flex:0 は「中身の幅で固定・伸ばさない」。`flex: 0`（= 0 1 0%）の
 * ままだと基準幅 0% から最小内容幅まで縮み、日本語の短い文字が1字ずつ
 * 縦に崩れる（E29）。最大幅で吹き出しからはみ出さない。
 */
function flexGrowStyle(flex: number | undefined): React.CSSProperties {
  if (flex === undefined) return {}
  if (flex === 0) return { flex: '0 0 auto', maxWidth: '100%' }
  return { flex }
}

export function safeFlexAssetUrl(value?: string): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.local')) return null
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return null
    const match = host.match(/^172\.(\d+)\./)
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return null
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')) return null
    return url.toString()
  } catch {
    return null
  }
}

function FlexText({ node }: { node: FlexNode }) {
  const style: React.CSSProperties = {
    fontSize: getSize(node.size) || '14px',
    fontWeight: node.weight === 'bold' ? 700 : 400,
    color: node.color || '#111',
    textDecoration: node.decoration === 'line-through' || node.decoration === 'underline' ? node.decoration : undefined,
    margin: 0,
    lineHeight: 1.4,
    ...(node.wrap === false ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : { wordBreak: 'break-word' }),
    ...(node.align === 'center' ? { textAlign: 'center' } : node.align === 'end' ? { textAlign: 'right' } : {}),
    ...flexGrowStyle(node.flex),
  }
  return <p style={style}>{Array.isArray(node.contents) && node.contents.length ? node.contents.map((span, index) => <span key={index} style={{ fontSize: span.size ? getSize(span.size) : undefined, color: span.color, fontWeight: span.weight === 'bold' ? 700 : undefined }}>{span.text ?? ''}</span>) : node.text || ''}</p>
}

function FlexButton({ node }: { node: FlexNode }) {
  const isPrimary = node.style === 'primary'
  const isLink = node.style === 'link'
  const btnColor = node.color || (isPrimary ? 'var(--color-accent)' : undefined)
  const style: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '10px 16px',
    borderRadius: 'var(--radius-control)',
    fontSize: '14px',
    fontWeight: 600,
    textAlign: 'center',
    cursor: 'default',
    border: isPrimary || isLink ? 'none' : '1px solid #ccc',
    backgroundColor: isPrimary ? btnColor : 'transparent',
    color: isPrimary ? '#fff' : isLink ? (btnColor || 'var(--color-accent)') : '#333',
  }
  return <div style={style}>{node.action?.label || 'Button'}</div>
}

function FlexSeparator({ node }: { node: FlexNode }) {
  return (
    <hr style={{
      border: 'none',
      borderTop: `1px solid ${node.color || '#e0e0e0'}`,
      marginTop: getMargin(node.margin) || '0',
      marginBottom: '0',
    }} />
  )
}

function FlexImage({ node }: { node: FlexNode }) {
  const url = safeFlexAssetUrl(node.url)
  if (!url) return null
  const style: React.CSSProperties = {
    width: node.size === 'full' ? '100%' : (getSize(node.size) || '100%'),
    maxWidth: '100%',
    borderRadius: node.cornerRadius || '0',
    objectFit: (node.aspectMode === 'cover' ? 'cover' : 'contain') as React.CSSProperties['objectFit'],
    ...(node.aspectRatio ? { aspectRatio: node.aspectRatio.replace(':', '/') } : {}),
  }
  return <img width={1040} height={676} src={url} alt="" style={style} referrerPolicy="no-referrer" loading="lazy" />
}

function FlexIcon({ node }: { node: FlexNode }) {
  const url = safeFlexAssetUrl(node.url)
  if (!url) return null
  const s = getSize(node.size) || '16px'
  return <img width={16} height={16} src={url} alt="" style={{ width: s, height: s, objectFit: 'contain' }} referrerPolicy="no-referrer" loading="lazy" />
}

function FlexSpacer({ node }: { node: FlexNode }) {
  const h = node.size === 'xs' ? '4px' : node.size === 'sm' ? '8px' : node.size === 'md' ? '16px' : node.size === 'lg' ? '24px' : node.size === 'xl' ? '32px' : '16px'
  return <div style={{ height: h }} />
}

function FlexBox({ node }: { node: FlexNode }) {
  const isHorizontal = node.layout === 'horizontal' || node.layout === 'baseline'
  const gap = getSpacing(node.spacing) || '0'

  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection: isHorizontal ? 'row' : 'column',
    gap,
    backgroundColor: node.backgroundColor || 'transparent',
    borderRadius: node.cornerRadius || '0',
    ...(node.paddingAll ? { padding: node.paddingAll } : {}),
    ...(node.paddingTop ? { paddingTop: node.paddingTop } : {}),
    ...(node.paddingBottom ? { paddingBottom: node.paddingBottom } : {}),
    ...(node.paddingStart ? { paddingLeft: node.paddingStart } : {}),
    ...(node.paddingEnd ? { paddingRight: node.paddingEnd } : {}),
    ...(node.width ? { width: node.width } : {}),
    ...(node.height ? { height: node.height } : {}),
    ...flexGrowStyle(node.flex),
    ...(isHorizontal ? { alignItems: node.gravity === 'center' ? 'center' : node.gravity === 'bottom' ? 'flex-end' : 'flex-start' } : {}),
    ...(node.align === 'center' ? { alignItems: 'center' } : node.align === 'end' ? { alignItems: 'flex-end' } : {}),
    ...(node.justifyContent ? { justifyContent: node.justifyContent === 'center' ? 'center' : node.justifyContent === 'flex-end' ? 'flex-end' : node.justifyContent === 'space-between' ? 'space-between' : node.justifyContent === 'space-around' ? 'space-around' : 'flex-start' } : {}),
    ...(node.borderWidth ? { border: `${node.borderWidth} solid ${node.borderColor || '#e0e0e0'}` } : {}),
    ...(node.position === 'absolute' ? { position: 'absolute', top: node.offsetTop, bottom: node.offsetBottom, left: node.offsetStart, right: node.offsetEnd } : {}),
  }

  return (
    <div style={style}>
      {(node.contents || []).map((child, i) => (
        <FlexNodeRenderer key={i} node={child} />
      ))}
    </div>
  )
}

function FlexNodeRenderer({ node }: { node: FlexNode }) {
  if (!node || !node.type) return null

  const marginStyle: React.CSSProperties = { ...(node.margin ? { marginTop: getMargin(node.margin) } : {}), ...flexGrowStyle(node.flex), minWidth: 0 }

  return (
    <div style={marginStyle}>
      {node.type === 'text' && <FlexText node={node} />}
      {node.type === 'button' && <FlexButton node={node} />}
      {node.type === 'separator' && <FlexSeparator node={node} />}
      {node.type === 'image' && <FlexImage node={node} />}
      {node.type === 'icon' && <FlexIcon node={node} />}
      {node.type === 'box' && <FlexBox node={node} />}
      {node.type === 'spacer' && <FlexSpacer node={node} />}
      {node.type === 'span' && <span style={{ fontSize: getSize(node.size), color: node.color, fontWeight: node.weight === 'bold' ? 700 : undefined }}>{node.text}</span>}
    </div>
  )
}

function FlexBubble({ bubble, maxWidth }: { bubble: FlexNode; maxWidth?: number }) {
  const w = maxWidth || (bubble.size === 'giga' ? 340 : bubble.size === 'mega' ? 300 : bubble.size === 'kilo' ? 260 : 300)

  return (
    <div style={{
      width: w,
      backgroundColor: 'var(--color-canvas)',
      borderRadius: 'var(--radius-card)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
      fontSize: '14px',
      position: 'relative',
    }}>
      {bubble.hero && <FlexNodeRenderer node={bubble.hero} />}
      {bubble.header && (
        <div style={{
          backgroundColor: bubble.header.backgroundColor || 'transparent',
          padding: bubble.header.paddingAll || '16px',
        }}>
          {(bubble.header.contents || []).map((child: FlexNode, i: number) => (
            <FlexNodeRenderer key={i} node={child} />
          ))}
        </div>
      )}
      {bubble.body && (
        <div style={{
          backgroundColor: bubble.body.backgroundColor || 'transparent',
          padding: bubble.body.paddingAll || '16px',
        }}>
          {(bubble.body.contents || []).map((child: FlexNode, i: number) => (
            <FlexNodeRenderer key={i} node={child} />
          ))}
        </div>
      )}
      {bubble.footer && (
        <div style={{
          backgroundColor: bubble.footer.backgroundColor || 'transparent',
          padding: bubble.footer.paddingAll || '16px',
        }}>
          {(bubble.footer.contents || []).map((child: FlexNode, i: number) => (
            <FlexNodeRenderer key={i} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 保存されている Flex 本文から、描画できる容器（bubble / carousel）を
 * 取り出す。
 *
 * 書かれ方は2通りある(#982 LAY-05)：
 *   - 直接の bubble / carousel …… テンプレート編集で保存した形
 *   - `{ type:'flex', altText, contents:{...} }` …… LINEメッセージ形。
 *     送信済み・受信履歴はこちらで保存されることがある。
 *
 * 以前は直下の bubble / carousel しか処理せず、flex で包まれた過去の
 * カードはフォールバックの `pre` に落ちて、送信吹き出しの白文字を
 * 継承したまま生JSONになっていた。
 */
export function normalizeFlexContainer(parsed: unknown): FlexNode | null {
  let node = parsed as FlexNode | null
  while (
    node !== null &&
    typeof node === 'object' &&
    node.type === 'flex' &&
    node.contents
  ) {
    node = (Array.isArray(node.contents) ? node.contents[0] : node.contents) as FlexNode
  }
  if (node && (node.type === 'bubble' || node.type === 'carousel')) return node
  return null
}

/** LINEメッセージ形に付く altText。あれば代替文として出す。 */
function flexAltText(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === 'object') {
    const alt = (parsed as { altText?: unknown }).altText
    if (typeof alt === 'string' && alt.trim()) return alt.trim()
  }
  return undefined
}

/**
 * 描画できないデータの代替表示。
 *
 * 吹き出し（送信=緑・受信=白）のどちらに載っても読めるよう、
 * 背景と文字色は必ず組で指定する。元のJSONは畳んだ詳細に入れ、
 * 既定では生データだけが画面に出る形にしない。
 * 「プレビューできない」ことと「送信に失敗した」ことは別なので、
 * 失敗を思わせる文言は使わない。
 */
function FlexUnavailable({ raw, parsed }: { raw: string; parsed?: unknown }) {
  const altText = parsed === undefined ? undefined : flexAltText(parsed)
  return (
    <div
      data-flex-preview="unavailable"
      className="border-hairline bg-canvas text-ink w-full max-w-xs rounded-control border p-3 text-left text-xs"
    >
      <p className="font-semibold">このメッセージはプレビューできません</p>
      <p className="text-ink-secondary mt-1 whitespace-pre-wrap break-words">
        {altText ?? 'カード形式のメッセージです。LINEアプリで内容を確認してください。'}
      </p>
      <details className="mt-2">
        <summary className="text-ink-faint cursor-pointer text-micro">元のデータを表示</summary>
        <pre className="bg-canvas-sunken text-ink-secondary mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-mini p-2 text-micro">
          {raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw}
        </pre>
      </details>
    </div>
  )
}

export default function FlexPreview({ content, maxWidth }: { content: string; maxWidth?: number }) {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return <FlexUnavailable raw={content} />
  }

  const container = normalizeFlexContainer(parsed)

  if (container?.type === 'bubble') {
    return <FlexBubble bubble={container} maxWidth={maxWidth} />
  }

  if (container?.type === 'carousel' && Array.isArray(container.contents) && container.contents.length > 0) {
    return (
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', padding: '4px 0' }}>
        {container.contents.map((bubble: FlexNode, i: number) => (
          <FlexBubble key={i} bubble={bubble} maxWidth={maxWidth} />
        ))}
      </div>
    )
  }

  // 未対応の形・破損データ —— 白文字の生JSONではなく代替文を出す。
  return <FlexUnavailable raw={content} parsed={parsed} />
}
