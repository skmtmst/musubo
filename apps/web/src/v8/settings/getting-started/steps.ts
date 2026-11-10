import type {
  AccountStyle,
  FriendAddRouting,
  FriendAddRoutingVersion,
  LineAccount,
  Scenario,
  StaffMember,
} from '@line-crm/shared'
import type { GettingStartedStep } from '@/lib/api'

/*
 * ★V8 はじめの設定の6段の判定。
 * V8 の両入口が使う表示モデル。完了の判定はAPIの実際の状態を優先する。
 * 画面に出す2段目の言葉だけ絵どおり（「チャネル ID」「自分の LINE」の空き）。
 */

/** 初期セットの選択状況（feature-presets.ts の写し）。 */
export type FeatureSetEntry =
  | { kind: 'picker' }
  | { kind: 'configured' }
  | { kind: 'forbidden' }

export function featureSetEntry(input: { forbidden: boolean; version: number }): FeatureSetEntry {
  if (input.forbidden) return { kind: 'forbidden' }
  if (input.version > 0) return { kind: 'configured' }
  return { kind: 'picker' }
}

/** 段の状態。**「まだです」と「止まっています」を言い分ける。** */
export type StepState =
  /** 終わりました */
  | 'done'
  /** 止まっています（作りかけがあるのに動いていない） */
  | 'stalled'
  /** まだです（手つかず） */
  | 'todo'
  /** 権限がありません */
  | 'forbidden'
  /** 確かめられません（数える口がまだ無い） */
  | 'unknown'

export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: '終わりました',
  stalled: '止まっています',
  todo: 'まだです',
  forbidden: '権限がありません',
  unknown: '確かめられません',
}

export type StepKey = GettingStartedStep['key'] | 'hours' | 'followup'

export interface StepResult {
  key: StepKey
  /** 左の丸に出す文字。板の段番号。 */
  ordinal: string
  title: string
  /** 板の2段目の言葉。 */
  sub: string
  state: StepState
  /** 終わったと見なす条件。 */
  condition: string
  /** 次にすること。「いま止まっている理由」に出す。 */
  next: string
  /** 行き先。押せないときは null。 */
  action: { label: string; href: string } | null
  /** 押せないときの理由。押せるときは null。 */
  blockedReason: string | null
}

/** 判定に使う実物。**足りないものは `null` で受け、勝手に「終わった」ことにしない。** */
export interface GettingStartedInput {
  accounts: LineAccount[]
  /** 初期セットの選択状況。機能設定の実物。`null` は未取得。 */
  featureSet: FeatureSetEntry | null
  tagCount: number
  friendFieldCount: number
  /*
    `routing` は無いことがある。**「設定した」と「中身が読めた」は別。**
    実画面（撮影ハーネス）で `configured` だけ返って `routing` が来ず、
    ここで落ちた。型が言い切っていても、外から来る値は疑う。
  */
  friendAdd: { configured: boolean; routing?: FriendAddRouting | null } | null
  friendAddDraft: FriendAddRoutingVersion | null
  scenarios: Scenario[]
  role: StaffMember['role'] | null
}

/** 業種の設定画面で実物を読んだ結果。未取得・失敗はnull、対象外の段は省略できる。 */
export type StyleSetupProgress = {
  notices?:Array<{message:string;href:string}>
  style: AccountStyle
  steps: Partial<Record<'attributes' | 'friendAdd' | 'scenario' | 'hours' | 'followup', { complete: boolean | null; reason?: string }>>
}

/** 業種の3〜5段は、その設定の実測だけで済みを決める。標準の配信判定は流用しない。 */
export function stepsForStyle(steps: ReadonlyArray<StepResult>, style: AccountStyle | null, progress?: StyleSetupProgress): StepResult[] {
  if (!style || style === 'standard') return [...steps]
  const copy = steps.filter(step => style !== 'restaurant' || !['hours', 'followup'].includes(step.key)).map((step): StepResult => ['attributes', 'friendAdd', 'scenario'].includes(step.key) && step.state !== 'forbidden'
    ? { ...step, state: 'unknown', blockedReason: null, next: '業種の設定状況を確認できませんでした。' }
    : { ...step })
  const replace = (key: keyof StyleSetupProgress['steps'], title: string, sub: string, label: string, href: string, condition: string, instruction: string) => {
    const step = copy.find((item) => item.key === key)
    if (!step) return
    step.title = title
    step.sub = sub
    step.condition = condition
    const result = progress?.style === style ? progress.steps[key] : undefined
    if (step.state !== 'forbidden') {
      step.state = result?.complete === true ? 'done' : result?.complete === false ? 'todo' : 'unknown'
      step.blockedReason = null
    }
    if (step.state === 'done') step.next = `終わっています。${label}から設定を見直せます。`
    else if (step.state === 'unknown') step.next = result?.reason?.trim() || `${sub}ための設定状況を確認できませんでした。`
    else if (step.state === 'todo') step.next = instruction
    step.action = step.state === 'forbidden' ? null : { label, href }
  }
  switch (style) {
    case 'restaurant':
      replace('attributes', '卓と席を登録する', '座席・卓を用意する', '座席・卓を開く', '/restaurant-test/tables', '座席・卓が登録されている', '座席と卓を登録し、予約で使う席を用意します。')
      replace('friendAdd', 'コースとメニューを登録する', '予約で受け付ける内容を決める', 'メニュー管理を開く', '/restaurant-test/menu', '予約で受け付けるコースとメニューが登録されている', '予約で受け付けるコースとメニューを登録します。')
      replace('scenario', '予約枠と在庫を設定する', '予約枠と在庫を用意する', '予約枠を開く', '/restaurant-test/inventory', '予約枠と在庫が用意され、受付を確認している', '予約枠と在庫を用意し、予約の受付を確認します。')
      if (copy.length > 0) {
        const add = (key: 'hours' | 'followup', title: string, href: string, condition: string) => {
          const result = progress?.style === style ? progress.steps[key] : undefined
          const forbidden = copy.find(step => step.key === 'attributes')?.state === 'forbidden'
          const state: StepState = forbidden ? 'forbidden' : result?.complete === true ? 'done' : result?.complete === false ? 'todo' : 'unknown'
          const step: StepResult = { key, ordinal: '', title, sub: condition, condition, state,
            next: state === 'done' ? '終わっています。設定を見直せます。' : result?.reason?.trim() || `${title}ための設定状況を確認できませんでした。`,
            action: forbidden ? null : { label: '設定を開く', href }, blockedReason: forbidden ? '管理者に頼んでください' : null }
          const before = key === 'hours' ? copy.findIndex(item => item.key === 'friendAdd') : copy.findIndex(item => item.key === 'firstMessage')
          copy.splice(before < 0 ? copy.length : before, 0, step)
        }
        add('hours', '営業時間を設定する', '/restaurant-test/google?tab=hours', 'Googleビジネスの店舗と営業時間が設定されている')
        add('followup', 'LINE来店フォローを確認する', '/restaurant-test/line-followup', '選んだ来店フォローの設定を確認している')
      }
      break
    case 'lesson':
      replace('attributes', 'クラスを作る', 'クラスの時間と定員を決める', 'イベント予約を開く', '/events', 'クラスの時間と定員が設定されている', 'クラスを作り、開催する時間と定員を設定します。')
      replace('friendAdd', '会員を登録する', '予約する会員を用意する', '友だちを開く', '/friends', '予約する会員が登録されている', '友だちの画面で、クラスを予約する会員を登録します。')
      replace('scenario', 'クラスの予約を受け付ける', 'イベント予約の受付を確認する', 'イベント予約を開く', '/events', 'クラスの予約受付を確認している', 'イベント予約で、クラスの予約を受け付けられるか確認します。')
      break
    case 'salon':
      replace('attributes', 'メニューを登録する', '予約で受け付ける内容を決める', '予約設定を開く', '/booking/menus', '予約メニューが登録されている', '予約で受け付けるメニューを登録します。')
      replace('friendAdd', '担当者を登録する', 'メニューを担当する人を決める', '担当者を開く', '/booking/menus?tab=staff', 'メニューを担当する人が登録されている', 'メニューを担当する人を登録します。')
      replace('scenario', '予約の受付を確認する', '受付枠と予約ページを用意する', '予約設定を開く', '/booking/menus?tab=hours', '受付枠と予約ページを確認している', '受付枠を設定し、予約ページから受け付けられるか確認します。')
      break
    case 'consult':
      replace('attributes', '面談の枠を作る', '面談できる日時を決める', '予約設定を開く', '/booking/menus?tab=hours', '面談を受け付ける日時が設定されている', '面談を受け付ける日時を設定します。')
      replace('friendAdd', '面談の URL を用意する', '予約ページを確認する', '予約ページを開く', '/booking/menus', '面談の予約ページを確認している', '面談の予約ページを開き、案内するURLを確認します。')
      replace('scenario', '面談の受付を確認する', '受付枠を公開する', '予約設定を開く', '/booking/menus?tab=hours', '面談の受付枠を公開し、受付を確認している', '面談の受付枠を公開し、予約できるか確認します。')
      break
    case 'ec':
      replace('attributes', 'ストアをつなぐ', 'ECストアの連携を設定する', 'EC連携を開く', '/ec-commerce', 'ECストアの連携を設定している', 'ECストアをつなぎ、連携の設定を確認します。')
      replace('friendAdd', 'ストアの商品を確認する', 'つないだストアの商品を確認する', 'EC連携を開く', '/ec-commerce', 'つないだストアの商品を確認している', 'つないだECストアの商品を確認します。')
      replace('scenario', '注文の受付を確認する', 'ストアから注文を受け取れる状態にする', 'EC連携を開く', '/ec-commerce', 'ストアから注文を受け取れる状態を確認している', 'ECストアから注文を受け取れるか確認します。')
      break
    default:
      style satisfies never
  }
  return copy.map((step, index) => ({ ...step, ordinal: String(index + 1) }))
}

/**
 * 見る・直すの区別。閲覧者は最終確認（実際に送る）を進められない。
 *
 * **役割が読めなかったとき（`null`）を「権限がない」と読まない。**
 * 読めないのと、無いのは違う。読めないときは止めず、確かめられないと言う。
 */
function isViewer(role: StaffMember['role'] | null): boolean {
  return role === 'viewer'
}

/**
 * 段1 LINEアカウントをつなぐ。
 * 登録済みアカウントが1件以上あれば完了。接続状態は運用画面で扱う。
 */
function accountsStep(input: GettingStartedInput): StepResult {
  const done = input.accounts.length > 0
  return {
    key: 'accounts',
    ordinal: '1',
    title: 'LINE アカウントをつなぐ',
    sub: 'チャネル ID とアクセストークン',
    state: done ? 'done' : 'todo',
    condition: 'LINEアカウントが1つ以上登録されている',
    next: done
      ? '終わっています。つなぎ先を見直したいときはこちらから。'
      : 'LINEアカウントを1つ登録します。',
    action: { label: done ? '接続の確認を見る' : 'LINEアカウントを開く', href: '/accounts' },
    blockedReason: null,
  }
}

/**
 * 段2 使う機能の初期セット。保存済みの設定（version > 0）があれば終わり。
 * まだ選んでいなければ、機能設定で選ぶ。
 */
export function featureSetStep(entry: FeatureSetEntry | null): StepResult {
  const state: StepState = entry === null ? 'unknown' : entry.kind === 'configured' ? 'done' : entry.kind === 'forbidden' ? 'forbidden' : 'todo'
  return {
    key: 'featureSet',
    ordinal: '2',
    title: '使う機能の初期セット',
    sub: '業種に合わせて機能を出す',
    state,
    condition: '使う機能の初期セットを選んである',
    next: state === 'done'
      ? '終わっています。機能の入り切りは機能設定から。'
      : state === 'forbidden'
        ? '管理者に頼んでください。'
        : '業種に合う初期セットを選ぶと、使う機能がそろいます。',
    action: state === 'todo' ? { label: '使う機能を選ぶ', href: '/settings' } : null,
    blockedReason: state === 'forbidden' ? '管理者に頼んでください' : state === 'unknown' ? '状態を読み込めませんでした' : null,
  }
}

/** 段3 友だちの分け方を決める。タグか友だち情報欄が1つでもあればよい。 */
function attributesStep(input: GettingStartedInput): StepResult {
  const done = input.tagCount > 0 || input.friendFieldCount > 0
  return {
    key: 'attributes',
    ordinal: '3',
    title: '友だちの分け方を決める',
    sub: 'タグと友だち情報欄を作る',
    state: done ? 'done' : 'todo',
    condition: 'タグか友だち情報欄が1つ以上ある',
    next: done
      ? '終わっています。タグを増やすときはこちらから。'
      : 'タグを1つ作ると、友だちを分けて配信できるようになります。',
    action: { label: '友だちの分け方へ', href: '/tags?tab=tags' },
    blockedReason: null,
  }
}

/**
 * 段3 友だち追加時の配信を作る。
 *
 * 「どれにも当たらない人を受ける決まり」＝ 以前からの友だち側の分岐。
 * この仕組みでは、はじめての人と以前からの人の2つで全員を受けるので、
 * **公開されていれば受け皿は必ずある。**
 */
function friendAddStep(input: GettingStartedInput): StepResult {
  const published = input.friendAddDraft?.publishedAt != null
  const hasDraft = input.friendAdd?.configured === true || input.friendAddDraft != null
  const done = published && input.friendAdd?.configured === true
  return {
    key: 'friendAdd',
    ordinal: '4',
    title: '友だち追加時の配信を作る',
    sub: '友だちになった人へのあいさつ',
    state: done ? 'done' : hasDraft ? 'stalled' : 'todo',
    condition: '公開したルールが1つ以上あり、どれにも当たらない人を受ける決まりがある',
    next: done
      ? '終わっています。振り分けを見直したいときはこちらから。'
      : hasDraft
        ? '下書きがありますが、まだ公開していません。公開すると動きはじめます。'
        : '友だちが増えたときに何をするかを決めて、公開します。',
    action: { label: '友だち追加時の配信へ', href: '/friend-add-settings' },
    blockedReason: null,
  }
}

/**
 * 段4 シナリオを作る。
 *
 * 「段3のルールから始まる」＝ 友だち追加時の振り分けが指しているシナリオであること。
 * 公開シナリオがあっても、段3から始まらなければ順路としては終わっていない。
 */
function scenarioStep(input: GettingStartedInput): StepResult {
  const active = input.scenarios.filter((s) => s.isActive)
  const startedIds = new Set(
    [input.friendAdd?.routing?.firstTime?.scenarioId, input.friendAdd?.routing?.returning?.scenarioId]
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )
  const done = active.some((s) => startedIds.has(s.id))
  const hasAny = input.scenarios.length > 0
  return {
    key: 'scenario',
    ordinal: '5',
    title: 'シナリオを作る',
    sub: '決まった日数ごとに送る',
    state: done ? 'done' : hasAny ? 'stalled' : 'todo',
    condition: '公開したシナリオが1つ以上あり、段3のルールから始まる',
    next: done
      ? '終わっています。中身を直すときはこちらから。'
      : hasAny
        ? 'シナリオはありますが、段3のルールから始まるものがまだありません。'
        : 'レシピから作ると、7通ぶんの下書きが一度にできます。',
    action: hasAny
      ? { label: 'シナリオ配信へ', href: '/scenarios' }
      : { label: 'レシピから作る', href: '/recipes' },
    blockedReason: null,
  }
}

/** 最初の1通の判定は V8 の実APIが行う。画面単独の判定では未確認のまま。 */
function firstMessageStep(input: GettingStartedInput): StepResult {
  const allowed = !isViewer(input.role)
  return {
    key: 'firstMessage',
    ordinal: '6',
    title: '最初の1通を受け取る',
    sub: '自分の LINE で受け取って確かめる',
    state: allowed ? 'unknown' : 'forbidden',
    condition: '友だち追加時の配信かシナリオの1通目が、実際に1件届いている',
    next: allowed
      ? 'QRを読んで自分を友だちに追加するか、シナリオのテスト送信で確かめてください。受信箱からの手動返信は完了条件に含めません。'
      : 'QRを読んで自分を友だちに追加するか、テスト受信者へ送ります。',
    action: allowed ? { label: '受信の確認方法を見る', href: '/getting-started#first-message' } : null,
    blockedReason: allowed ? null : '管理者に頼んでください',
  }
}

export function buildSteps(input: GettingStartedInput): StepResult[] {
  return [
    accountsStep(input),
    featureSetStep(input.featureSet),
    attributesStep(input),
    friendAddStep(input),
    scenarioStep(input),
    firstMessageStep(input),
  ]
}

/**
 * サーバが判定した段を、設計の説明と操作へ結び付ける。
 * 完了判定を画面で再計算しないため、状態・権限・行き先は必ずAPIを正本にする。
 *
 * 初期セットを含む V8 の6段を両入口へ同じ形で渡す。旧応答の不足は未確認とする。
 */
export function buildStepsFromApi(serverSteps: ReadonlyArray<GettingStartedStep>): StepResult[] {
  const byKey = new Map<string, GettingStartedStep>(serverSteps.map((step) => [step.key, step]))
  const display = buildSteps({
    accounts: [],
    featureSet: null,
    tagCount: 0,
    friendFieldCount: 0,
    friendAdd: null,
    friendAddDraft: null,
    scenarios: [],
    role: null,
  })

  return display
    .filter((base) => base.key !== 'featureSet' || byKey.has('featureSet'))
    .map((base) => {
    const server = byKey.get(base.key)
    if (!server) return { ...base, state: 'unknown', action: null, blockedReason: '状態を読み込めませんでした' }

    const state = server.state
    const nextByState: Record<GettingStartedStep['key'], Partial<Record<StepState, string>>> = {
      featureSet: { done: '終わっています。機能設定で見直せます。', todo: '業種に合わせて使う機能を選び、保存してください。' },
      accounts: {
        done: '終わっています。つなぎ先を見直したいときはこちらから。',
        todo: 'LINEアカウントを1つ登録します。',
      },
      attributes: {
        done: '終わっています。タグを増やすときはこちらから。',
        todo: 'タグを1つ作ると、友だちを分けて配信できるようになります。',
      },
      friendAdd: {
        done: '終わっています。振り分けを見直したいときはこちらから。',
        stalled: server.reason ?? '下書きのルールがありますが、まだ公開していません。公開すると動きはじめます。',
        todo: '友だちが増えたときに何をするかを決めて、公開します。',
      },
      scenario: {
        done: '終わっています。中身を直すときはこちらから。',
        stalled: server.reason ?? 'シナリオはありますが、段4のルールから始まるものがまだありません。',
        todo: 'レシピから作ると、7通ぶんの下書きが一度にできます。',
      },
      firstMessage: {
        done: '終わっています。最初の配信を見直すときはこちらから。',
        todo: 'QRを読んで自分を友だちに追加するか、テスト受信者へ送ります。',
        unknown: server.reason ?? '届いたかどうかを確かめられません。受信箱で確認してください。',
        forbidden: 'QRを読んで自分を友だちに追加するか、テスト受信者へ送ります。',
      },
    }
    // 行き先の言葉は板が正本。
    const labels: Record<GettingStartedStep['key'], string> = {
      accounts: state === 'done' ? '接続の確認を見る' : 'LINEアカウントを開く',
      featureSet: '使う機能を選ぶ',
      attributes: '友だちの分け方へ',
      friendAdd: '友だち追加時の配信へ',
      scenario: state === 'todo' ? 'レシピから作る' : 'シナリオ配信へ',
      firstMessage: '受信の確認方法を見る',
    }
    let href: string | null = server.href
    // まだ無いものを作りに行く行き先は、口の保存先ではなく作る画面にする。
    if (base.key === 'scenario' && state === 'todo') href = '/recipes'
    // 送信ボタンではなく、既存のQR・シナリオのテスト送信までの道順を開く。
    if (base.key === 'firstMessage' && href) href = '/getting-started#first-message'
    const action = href && state !== 'forbidden' ? { label: labels[server.key], href } : null

    return {
      ...base,
      state,
      next: nextByState[server.key][state] ?? server.reason ?? '状態を確認してください。',
      action,
      blockedReason: action ? null : server.reason,
    }
    })
}

/**
 * 口の5段へ初期セット（段2）を足して板の6段にする。段番号を振り直す。
 * 初期セットの状態は機能設定の実物から `featureSetStep` で作る。
 */
export function insertFeatureSet(steps: ReadonlyArray<StepResult>, entry: FeatureSetEntry | null): StepResult[] {
  const feature = featureSetStep(entry)
  const at = steps.findIndex((step) => step.key === 'accounts')
  const merged = at < 0 ? [feature, ...steps] : [...steps.slice(0, at + 1), feature, ...steps.slice(at + 1)]
  return merged.map((step, index) => ({ ...step, ordinal: String(index + 1) }))
}

/** 終わった段の数。**`unknown` は終わっていない側に数える。** */
export function doneCount(steps: ReadonlyArray<StepResult>): number {
  return steps.filter((s) => s.state === 'done').length
}

/** 全部終わったか。ダッシュボードの帯を出すかどうかがこれで決まる。 */
export function allDone(steps: ReadonlyArray<StepResult>): boolean {
  return steps.every((s) => s.state === 'done')
}

/** 板の帯の1行。`2 / 6 済み` の形。数は実測だけ。 */
export function progressHeadline(steps: ReadonlyArray<StepResult>): string {
  return `${doneCount(steps)} / ${steps.length} 済み`
}

/**
 * いま止まっている理由。**止まっている段と、権限で進めない段を分けて言う。**
 * 何も無ければ空配列（帯を描かない）。
 */
export function stoppedReasons(steps: ReadonlyArray<StepResult>): string[] {
  const lines: string[] = []
  const stalled = steps.find((s) => s.state === 'stalled')
  if (stalled) lines.push(`段${stalled.ordinal}で止まっています。${stalled.next}`)
  const forbidden = steps.filter((s) => s.state === 'forbidden')
  for (const step of forbidden) {
    lines.push(`「${step.title}」は、あなたの権限では進められません。管理者に頼んでください。`)
  }
  const unknown = steps.filter((s) => s.state === 'unknown')
  for (const step of unknown) {
    lines.push(`「${step.title}」は、いまは状況を確認できません。${step.next}`)
  }
  return lines
}

/** 板の下の「気をつけること」。 */
export const CARE_ITEMS = [
  {
    head: '手順は飛ばしても使えます。',
  },
  {
    head: 'あとからこの画面に戻れます（設定 › はじめの設定）。',
  },
] as const
