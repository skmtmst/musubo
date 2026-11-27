import type {
  FriendAddRouting,
  FriendAddRoutingVersion,
  LineAccount,
  Scenario,
  StaffMember,
} from '@line-crm/shared'
import type { GettingStartedStep } from '@/lib/api'
import type { FeatureSetEntry } from './feature-presets'

/**
 * 設計板 「はじめの設定」の順路（6段）。
 *
 * **画面を開いたかではなく、実際に作られたもので判断する。**
 * だから判定はすべてサーバから取った実物（アカウント・タグ・ルール・シナリオ）
 * から計算し、画面側に「見た」印は一切持たない。
 *
 * 判定は画面から切り離してここに置く。契約テストで文言ごと固定する。
 */

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

export type StepKey = GettingStartedStep['key']

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
    title: 'LINEアカウントをつなぐ',
    sub: 'チャネルIDとチャネルシークレット',
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
    action: state === 'todo' ? { label: '使う機能を選択する', href: '/settings' } : null,
    blockedReason: state === 'forbidden' ? '管理者に頼んでください' : state === 'unknown' ? '状態を取得できませんでした' : null,
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

/**
 * 最終確認 最初の1通を受け取る。
 *
 * **数えられない。** 「1通目が実際に届いたか」を返す口がまだ無い
 * （要件 §6-1 は `messages_log` の `succeeded` を見ると決めているが、
 * 画面から引ける口が用意されていない）。
 * 数を作らず、確かめられないことをそのまま言う。
 */
function firstMessageStep(input: GettingStartedInput): StepResult {
  const allowed = !isViewer(input.role)
  return {
    key: 'firstMessage',
    ordinal: '6',
    title: '最初の1通を受け取る',
    sub: '自分のLINEで受け取って確かめる',
    state: allowed ? 'unknown' : 'forbidden',
    condition: '友だち追加時の配信かシナリオの1通目が、実際に1件届いている',
    next: allowed
      ? '届いたかどうかを数える口がまだありません。QRを読んで自分を友だちに追加するか、テスト受信者へ送って、受信箱で確かめてください。'
      : 'QRを読んで自分を友だちに追加するか、テスト受信者へ送ります。',
    action: allowed ? { label: 'テストを送る', href: '/chats' } : null,
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
 * 初期セット（段2）は口に無いのでここでは含めない。ダッシュボードの帯は
 * この5段のまま数える。はじめの設定の画面で `insertFeatureSet` を足す。
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
    if (!server) return { ...base, state: 'unknown', action: null, blockedReason: '状態を取得できませんでした' }

    const state = server.state
    const nextByState: Record<StepKey, Partial<Record<StepState, string>>> = {
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
    const labels: Record<StepKey, string> = {
      accounts: state === 'done' ? '接続の確認を見る' : 'LINEアカウントを開く',
      featureSet: '使う機能を選ぶ',
      attributes: '友だちの分け方へ',
      friendAdd: '友だち追加時の配信へ',
      scenario: state === 'todo' ? 'レシピから作る' : 'シナリオ配信へ',
      firstMessage: 'テストを送る',
    }
    let href: string | null = server.href
    // まだ無いものを作りに行く行き先は、口の保存先ではなく作る画面にする。
    if (base.key === 'scenario' && state === 'todo') href = '/recipes'
    // テスト送信は受信箱で行う（口の権限表 `message.test.send` の持ち場）。
    if (base.key === 'firstMessage') href = '/chats'
    const action = href && state !== 'forbidden' ? { label: labels[base.key], href } : null

    return {
      ...base,
      state,
      next: nextByState[base.key][state] ?? server.reason ?? '状態を確認してください。',
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
    lines.push(`「${step.title}」は、いまの仕組みでは自動で確かめられません。${step.next}`)
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
