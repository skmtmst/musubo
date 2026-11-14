import type { ReactNode, Ref } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { StatusBadgeTone } from './status-badge'
/*
 * 受信箱の幅640の器を、作ってあるものを選ぶ窓へ共通化（・163・164・165・175）。
 * 行の選択は下書きで、確定したときだけ呼び出し元へ返す。
 * 欄全体で開き、複数選択の札は窓を開かず外せる。作成先は下の文字リンク。
 */

export interface EntityPickerItem {
  id: string
  name: string
  /** 候補自身の印の色。指定しない候補は既存の札の色を使う。 */
  color?: string | null
  /** 置き場のフォルダ。null は未分類。undefined はフォルダを持たない種類。 */
  folderId?: string | null
  /** 種類の札（テキスト・カルーセル など）。渡した窓だけ札の列と絞り込みを出す。 */
  category?: string
  categoryLabel?: string
  tone?: StatusBadgeTone
  /** 行の右の補足（「更新 10/8」「友だち 1,284」など）。 */
  meta?: string
  /** 名前のほかに探す言葉（LINE ID など）。 */
  keywords?: string
  /** 選べない行（停止中のアカウントなど）。理由は meta に書く。 */
  disabled?: boolean
  /** 必須の選択。まとめて解除・札の×でも外さない。 */
  locked?: boolean
  /** 行に見せる本文の抜粋。 */
  content?: string
  /** 利用実績のある候補。未取得は undefined のまま。 */
  frequent?: boolean
}

export interface EntityPickerFolder { id: string; name: string; color?: string | null }

export interface EntityPickerCategory { id: string; label: string }

export type SingleProps = {
  scrollBody?: boolean
  title: string
  /** 窓の頭の説明。省くと題だけ。 */
  description?: string
  /** 主ボタンの文字。既定は「選ぶ」。 */
  confirmLabel?: string
  items: EntityPickerItem[]
  folders?: EntityPickerFolder[]
  /** フォルダを読み込めなかったとき。列は「すべて」だけにし、そう書く。 */
  foldersFailed?: boolean
  categories?: EntityPickerCategory[]
  query?: string
  onQueryChange?: (query: string) => void
  initialId?: string
  /** 一覧の代わりに出す状態（読み込み中・失敗）。 */
  listFooter?: ReactNode
  state?: ReactNode
  /** 右の中身の見本。渡さない種類は見本の列を出さず、真ん中を広くする。 */
  preview?: ReactNode | ((item: EntityPickerItem | null) => ReactNode)
  error?: string
  busy?: boolean
  confirmDisabled?: boolean
  /** 書き換え直前と非同期の応答後に確かめる、失効を記憶するlease。 */
  canChangeNow?: () => boolean
  /** 確定だけを権限で止める。開いた候補とプレビューは残す。 */
  confirmLockedReason?: string
  readOnly?: boolean
  createHref?: string
  createLabel?: string
  searchPlaceholder?: string
  designNode?: string
  createAction?: { label: (query: string) => string; onCreate: (query: string) => void | Promise<void> }
  /** プレビュー専用。候補の表示を切り替えるだけで、保存しない。 */
  onSelect?: (id: string) => void
  onConfirm: (id: string) => void
  onCancel: () => void
}

export type EntityPickerWindowProps = {
  title: string
  description?: string
  onCancel: () => void
  busy?: boolean
  error?: string
  designNode?: string
  initialFocusId?: string
  /** データ取得を呼ぶ側で管理するときの中身。窓の形は共通のまま。 */
  children: ReactNode
  scrollBody?: boolean
  footer: ReactNode
  band?: ReactNode
  /** 頭の×の左の操作（S2Vgi の「＋タグを作る」）。 */
  headerAction?: ReactNode
  /** 指定した窓だけ、一覧と並ぶ読み取り用の見本を出す。 */
  preview?: { title: string; content: ReactNode; actions?: ReactNode; onClose: () => void }
  /** 種類の切替など、一覧と見本に共通する頭の段。 */
  navigation?: ReactNode
  /** 指定した窓だけ既存の広い段を使う。 */
  wide?: boolean
}

export type MultiBodyProps = {
  items: EntityPickerItem[]
  folders?: EntityPickerFolder[]
  foldersFailed?: boolean
  selected: string[]
  onChange: (ids: string[]) => void
  query: string
  /** 選んだものだけ見る。 */
  onlySelected?: boolean
  readOnly?: boolean
  busy?: boolean
  disabled?: boolean
  lockedReason?: string
  canChangeNow?: () => boolean
  listFooter?: ReactNode
  state?: ReactNode
  /** 行の右の状態（接続の状態など）。 */
  rowExtra?: (item: EntityPickerItem) => ReactNode
  /** 窓の外（メンバーの窓など）に埋め込むとき、探す欄を中に置く。 */
  searchSlot?: ReactNode
  listLabel?: string
  /** フォルダの絞り込みを呼ぶ側で持つとき（URL の ?folder= など）。 */
  folder?: string
  onFolder?: (id: string) => void
  /** フォルダの列の見出し。 */
  folderHeading?: string
  /** 開いたときに絞っておくフォルダ。 */
  initialFolder?: string
  /** ほかの窓の中に埋め込むとき。高さを決めて一覧だけを送る。 */
  embedded?: boolean
  /** 行を2段にする（名前の下に補足と状態）。名前を補足に押されて切らない（ 送るアカウント）。 */
  stacked?: boolean
}

export type MultiProps = {
  title: string
  description?: string
  items: EntityPickerItem[]
  folders?: EntityPickerFolder[]
  foldersFailed?: boolean
  initialIds: string[]
  query?: string
  onQueryChange?: (query: string) => void
  maxSelected?: number
  /** 数の単位（「アカウント」「件」）。 */
  unit?: string
  listFooter?: ReactNode
  state?: ReactNode
  error?: string
  busy?: boolean
  confirmDisabled?: boolean
  confirmLockedReason?: string
  canChangeNow?: () => boolean
  readOnly?: boolean
  createHref?: string
  createLabel?: string
  /** 頭の「＋〇〇を作る」。名前を受けて作り、作った候補を返す（返した候補は選んだ状態で足す）。 */
  createAction?: { label: string; placeholder?: string; onCreate: (name: string) => Promise<EntityPickerItem | null> }
  /** 下の段の左の案内。省くと「いくつでも選べます」（上限があれば「N件まで選べます」）。 */
  note?: string
  searchPlaceholder?: string
  /** 1件も選ばずに確定してよいか（タグを全部外す など）。 */
  allowEmpty?: boolean
  rowExtra?: (item: EntityPickerItem) => ReactNode
  initialFolder?: string
  /** 行を2段にする（名前の下に補足と状態）。 */
  stacked?: boolean
  onConfirm: (ids: string[]) => void
  onCancel: () => void
}

export type FieldBase = {
  /** 欄の名前（読み上げと窓の題に使う）。 */
  label: string
  /** 何を選ぶか（「テンプレート」）。窓の題「〇〇を選ぶ」と空のときの文に使う。 */
  noun: string
  icon?: LucideIcon
  items: EntityPickerItem[]
  folders?: EntityPickerFolder[]
  foldersFailed?: boolean
  /** 窓を開いたときに読み込む（フォルダ・最新の候補）。 */
  onOpen?: () => void
  onClose?: () => void
  /** 候補の取得状態。省略時は従来の表示を保つ。 */
  candidatesStatus?: 'loading' | 'ready' | 'error'
  /** 候補を読み込んでいる・失敗したときの窓の中身。 */
  listFooter?: ReactNode
  state?: ReactNode
  placeholder?: string
  valuePrefix?: string
  compact?: boolean
  actionHidden?: boolean | 'label'
  disabled?: boolean
  disabledReason?: string
  lockedReason?: string
  /** 指定した時だけ、開いた窓を残して変更前後に新鮮な権限を確かめる。 */
  canChangeNow?: () => boolean
  readOnly?: boolean
  invalid?: boolean
  createHref?: string
  createLabel?: string
  /** 窓の頭の説明。 */
  description?: string
  /** 窓の題（既定は「〇〇を選ぶ」）。 */
  title?: string
  searchPlaceholder?: string
  id?: string
  buttonRef?: Ref<HTMLButtonElement>
  describedBy?: string
  'aria-describedby'?: string
  ariaLabel?: string
  defaultOpen?: boolean
  query?: string
  onQueryChange?: (query: string) => void
  maxSelected?: number
}

export type SingleField = FieldBase & {
  multiple?: false
  value: string | null | undefined
  onChange: (id: string) => void
  /** 選ばない（空）に戻せる欄。「外す」を出す。 */
  clearable?: boolean
  categories?: EntityPickerCategory[]
  preview?: SingleProps['preview']
  confirmLabel?: string
  createAction?: SingleProps['createAction']
  /** プレビュー専用。候補の表示を切り替えるだけで、保存しない。 */
  onSelect?: (id: string) => void
  confirmDisabled?: boolean
}

export type MultiField = FieldBase & {
  multiple: true
  value: string[]
  onChange: (ids: string[]) => void
  unit?: string
  allowEmpty?: boolean
  rowExtra?: (item: EntityPickerItem) => ReactNode
  /** 欄の補足（既定は名前を「・」でつなぐ）。 */
  summarize?: (items: EntityPickerItem[]) => string
  /** 窓の頭の「＋〇〇を作る」。 */
  headerCreate?: MultiProps['createAction']
  /** 窓の下の段の案内。 */
  note?: string
}
