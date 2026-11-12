


// =============================================================================
// Rich Menu Editor — groups / pages / areas
// =============================================================================
//
// 1 group = 1 リッチメニューセット (1 ページ構成も 1 group として扱う)
// 1 page  = タブ 1 枚 = LINE 上の richmenu 1 個
// 1 area  = page 内のタップ可能矩形。LINE 上限 20 個まで
//
// alias は決定論的に lhx-{groupId 先頭 8 文字}-{order_index} で命名。
// richmenuswitch アクションの遷移先は self の page_id を `targetPageId` で持つ。
// publish 時に publisher 側で alias_id へ解決する。

export interface RichMenuGroup {
  id: string;
  confirmation_revision?: number;
  account_id: string;
  name: string;
  chat_bar_text: string;
  size: 'large' | 'compact';
  default_page_id: string | null;
  is_default_for_all: number;
  status: 'draft' | 'published';
  publishing_at: string | null;
  /** 公開leaseの所有者(run ID等)。NULLは誰も持っていない。 */
  publishing_owner: string | null;
  publishing_generation: number;
  /** 公開leaseの期限(UTCのISO8601)。過ぎたら別runが回収できる。 */
  publishing_expires_at: string | null;
  /** 出し分けの条件（SegmentCondition の JSON）。未設定なら null。 */
  targeting_condition: string | null;
  /** 複数のメニューに当てはまったときの順番。小さいほうが先。 */
  targeting_priority: number;
  targeting_enabled: number;
  /** 159: フォルダ。分けていなければ null。 */
  folder_id: string | null;
  /** 160: 自分で決める並び順。小さいほど先。 */
  display_order: number;
  /** V8: トークを開いたときメニューを出した状態にするか（LINE の `selected`）。 */
  default_open: number;
  /** M951: 下書き保存の版。保存のたびに +1。古い画面からの保存は 409 で止める。 */
  version: number;
  created_at: string;
  updated_at: string;
}

export interface RichMenuPage {
  id: string;
  group_id: string;
  order_index: number;
  name: string;
  alias_id: string;
  line_richmenu_id: string | null;
  image_r2_key: string | null;
  image_content_type: string | null;
  created_at: string;
  updated_at: string;
}

// 運用者から見た「何をするボタンか」。datetime（日時を選ぶ）と clipboard
//（文字をコピーする）は LINE の動き（datetimepicker・clipboard）そのまま。
// DB の action_type は CHECK で4つのままなので、この2つは postback に
// 載せて保存し、publish 時に intent から本来の動きへ戻す。
export type RichMenuAreaIntent =
  | 'url'      // URLを開く       → uri
  | 'tel'      // 電話をかける     → uri (tel:)
  | 'text'     // テキストを送る   → message
  | 'template' // テンプレートを送る → postback (こちらから送る)
  | 'booking'
  | 'booking_history'
  | 'visit_stamp'
  | 'form'     // 回答フォームを開く → uri (LIFF)
  | 'switch'   // メニューを切り替える → richmenuswitch
  | 'postback'
  | 'datetime' // 日時を選ぶ       → datetimepicker
  | 'clipboard'; // 文字をコピーする → clipboard

export interface RichMenuArea {
  id: string;
  page_id: string;
  bounds_x: number;
  bounds_y: number;
  bounds_width: number;
  bounds_height: number;
  action_type: 'uri' | 'message' | 'postback' | 'richmenuswitch';
  action_data: string; // JSON serialized
  intent: RichMenuAreaIntent | null;
  label: string | null;
  tag_ids: string | null; // JSON serialized string[]
  score_change: number | null;
  template_id: string | null;
  form_id: string | null;
  tracked_link_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RichMenuAreaInput {
  // 保存のたびに新しい id を振ると、押された回数の集計がボタン単位で切れる。
  // 既存 area の id を渡せば、そのまま引き継ぐ (page と同じ流儀)。
  id?: string;
  boundsX: number;
  boundsY: number;
  boundsWidth: number;
  boundsHeight: number;
  actionType: 'uri' | 'message' | 'postback' | 'richmenuswitch';
  actionData: Record<string, unknown>;
  intent?: RichMenuAreaIntent | null;
  label?: string | null;
  tagIds?: string[] | null;
  scoreChange?: number | null;
  templateId?: string | null;
  formId?: string | null;
  trackedLinkId?: string | null;
}

export interface RichMenuPageInput {
  // PATCH (replaceRichMenuPages) で **既存 page を保持** したい場合に同じ id を渡す。
  // 新規ページは undefined。この id が rich_menu_pages.id とそのまま一致するので、
  // `richmenuswitch.actionData.targetPageId` を再 PATCH で安定して解決できる。
  // また、保持された page の image_r2_key / line_richmenu_id は失われない。
  id?: string;
  name: string;
  orderIndex: number;
  areas: RichMenuAreaInput[];
}

export interface CreateRichMenuGroupInput {
  accountId: string;
  name: string;
  chatBarText: string;
  size: 'large' | 'compact';
  pages: RichMenuPageInput[];
  /** 作成直後のフォルダ。作成後に付け直す2口目を使わず、1口で決める。 */
  folderId?: string | null;
  /** 最初に見せるページの orderIndex。未指定なら先頭ページ。 */
  defaultPageIndex?: number | null;
  /** 「すべての友だちの既定にする」か。 */
  isDefaultForAll?: boolean;
  /** 出し分け設定。有効にするなら targetingCondition が必須。 */
  targetingEnabled?: boolean;
  targetingCondition?: string | null;
  targetingPriority?: number;
  /** V8: トークを開いたときメニューを出した状態にするか。 */
  defaultOpen?: boolean;
}

export interface UpdateRichMenuGroupMetaInput {
  name?: string;
  chatBarText?: string;
  isDefaultForAll?: boolean;
  /** null を渡すと条件を消す。 */
  targetingCondition?: string | null;
  targetingPriority?: number;
  targetingEnabled?: boolean;
  /** 159: フォルダ。null で未分類に戻す。 */
  folderId?: string | null;
  /** 160: 自分で決める並び順。 */
  displayOrder?: number;
  /** V8: トークを開いたときメニューを出した状態にするか（LINE の `selected`）。 */
  defaultOpen?: boolean;
}

export type RichMenuAreaWithParsed = RichMenuArea & {
  actionData: Record<string, unknown>;
  tagIds: string[];
};

export interface RichMenuPageWithAreas extends RichMenuPage {
  areas: RichMenuAreaWithParsed[];
}

export interface RichMenuGroupWithPages extends RichMenuGroup {
  pages: RichMenuPageWithAreas[];
}

export type RichMenuDeleteImpactReferenceKind = 'automation' | 'common_action';

export interface RichMenuDeleteImpactReference {
  kind: RichMenuDeleteImpactReferenceKind;
  ownerId: string;
  ownerName: string;
}

export interface RichMenuDeleteImpactIncomingSwitch {
  sourceGroupId: string;
  sourceGroupName: string;
  sourcePageId: string;
  sourcePageName: string;
  areaId: string;
  areaLabel: string | null;
  targetPageId: string;
  targetPageName: string;
}

export interface RichMenuDeleteImpactNextCandidate {
  groupId: string;
  name: string;
  targetingPriority: number;
  isTargetingEnabled: boolean;
  isDefaultForAll: boolean;
}

/**
 * リッチメニューを消す前に、DBで確認できる影響をまとめたもの。
 *
 * LINEは「いま各友だちに何が表示されているか」の台帳を返さないため、
 * currentAudience は自前の割当台帳に記録できた現在値だけを返す。導入前の割当を
 * 推測で補わず partial と明示する。削除可否は、公開状態、LINE上の実体、DB内の
 * 参照をサーバー側で再確認して決める。
 */
export interface RichMenuDeleteImpact {
  group: {
    id: string;
    accountId: string;
    name: string;
    status: RichMenuGroup['status'];
    version: number;
    publishingGeneration: number;
  };
  currentAudience: {
    value: number;
    state: 'partial';
    reason: 'preexisting_assignments_not_backfilled';
  };
  nextDisplay: {
    guaranteedGroupId: null;
    reason: 'friend_specific_rules';
    candidates: RichMenuDeleteImpactNextCandidate[];
  };
  incomingSwitches: RichMenuDeleteImpactIncomingSwitch[];
  operationalReferences: RichMenuDeleteImpactReference[];
  lineResources: {
    pageCount: number;
    pagesWithLineRichMenuId: number;
    isDefaultForAll: boolean;
    publishing: boolean;
    pages:Array<{id:string;orderIndex:number;lineRichMenuId:string|null}>;
  };
  blockers: Array<
    | 'published'
    | 'publishing'
    | 'default_for_all'
    | 'line_resources'
    | 'incoming_switches'
    | 'operational_references'
  >;
  canDelete: boolean;
  recommendedAction: 'delete' | 'unpublish' | 'review_references';
}

export type PageKeepMeta = {
  existingMap: Map<
    string,
    {
      id: string;
      image_r2_key: string | null;
      image_content_type: string | null;
      line_richmenu_id: string | null;
      created_at: string;
    }
  >;
  existingAreaIds: Set<string>;
};

export interface SaveRichMenuGroupDraftInput {
  meta: UpdateRichMenuGroupMetaInput;
  pages?: RichMenuPageInput[];
  /**
   * 保存元画面が読んだときの版 (M951・タグ編集と同じ約束)。
   * 現在の版と違えば書かず version_conflict を返す。
   */
  expectedVersion: number;
}

export type SaveRichMenuGroupDraftResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'version_conflict'; currentVersion: number | null };

/**
 * publish lease の持ち主を表す札。
 *
 * owner だけでは足りない。公開確定 (markRichMenuGroupPublished) や解放で
 * owner は NULL に戻るため、「まだ自分のものか」と「自分のあとに誰かが取って
 * 手放したか」を区別できない。世代 (取得のたびに +1、戻さない) を併せて持ち、
 * 確定は世代一致を書込み条件にする。
 */
export type PublishLeaseFence = { owner: string; generation: number };

// =============================================================================
// タップされたボタンを引く
// =============================================================================
//
// リッチメニューのボタンを押すと、LINE から postback が飛んでくる。その data に
// 忍ばせた area の id から、「どのボタンが押されたか」と「押されたら何をするか」
// をまとめて引く。webhook から使う。

export interface RichMenuAreaTapTarget {
  areaId: string;
  pageId: string;
  groupId: string;
  accountId: string;
  intent: RichMenuAreaIntent | null;
  label: string | null;
  tagIds: string[];
  scoreChange: number | null;
  templateId: string | null;
  formId: string | null;
  scenarioId: string | null;
}

export interface RichMenuAreaTapCount {
  areaId: string;
  groupId: string;
  pageId: string;
  /** ボタン名。消されたボタンは、押された時点の名前が出る。 */
  label: string | null;
  taps: number;
  /** そのうち、計測リンク経由で数えた分。 */
  viaTrackedLink: number;
}

export interface RichMenuTapStats {
  from: string;
  to: string;
  byArea: RichMenuAreaTapCount[];
  byGroup: { groupId: string; taps: number }[];
  total: number;
}

// =============================================================================
// 個別割当の現在値・実行履歴（309）
// =============================================================================

export interface RichMenuAudienceStat {
  groupId: string;
  currentAudience: number;
  monthlyUniqueAudience: number;
}

export interface RecordRichMenuAssignmentInput {
  friendId: string;
  lineAccountId: string;
  /** null は個別割当を外してアカウント既定へ戻したことを表す。 */
  lineRichMenuId: string | null;
  reasonKind: string;
  reasonEventId?: string | null;
  idempotencyKey?: string;
  assignedAt?: string;
}

// =============================================================================
// 出し分け（149）
// =============================================================================

export interface RichMenuTargetingCandidate {
  groupId: string;
  name: string;
  priority: number;
  /** SegmentCondition の JSON。 */
  condition: string;
  /** 友だちに出すのは 1 ページ目の richmenu。 */
  lineRichMenuId: string | null;
}

// =============================================================================
// 下書き複製（同じ鍵のやり直しを1回に数える台帳つき）
// =============================================================================

export interface RichMenuDuplicateRequest {
  id: string;
  account_id: string;
  source_group_id: string;
  created_group_id: string;
  idempotency_key: string;
  created_at: string;
}

export type DuplicateRichMenuGroupOutcome =
  | { outcome: 'created'; groupId: string }
  | { outcome: 'existing'; groupId: string }
  | { outcome: 'conflict' };
