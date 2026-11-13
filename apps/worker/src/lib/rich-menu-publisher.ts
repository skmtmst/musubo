import { tracedFetch as fetch, logger } from '@line-crm/shared/server';
// Rich menu publish flow — D1 ドラフトを LINE Messaging API に冪等に反映する。
//
// LINE API は richmenu の更新ができず、作成のみ。なので alias を経由して
// 「同一 alias を別 richmenu に張替」という間接参照で更新を実現する。
//
// 流れ (各 page につき):
//   1. POST /v2/bot/richmenu                  → 新 richmenuId 取得
//   2. POST /v2/bot/richmenu/{id}/content     ← R2 から画像 stream
//   3. alias upsert (DELETE → POST)
//   4. 旧 richmenu があれば DELETE
// 最後に isDefaultForAll なら 1 ページ目を全友だち default に。

import { buildTapPostbackData } from './rich-menu-tap.js';
import { RICH_MENU_DIMENSIONS, RICH_MENU_MAX_PAGES, richMenuUriError, liffActionUrl, type LiffAction } from '@line-crm/shared';


export type Bounds = { x: number; y: number; width: number; height: number };

export type ActionType =
  | 'uri'
  | 'message'
  | 'postback'
  | 'richmenuswitch'
  | 'datetimepicker'
  | 'clipboard';

/**
 * 運用者から見た「何をするボタンか」。
 *
 * LINE が持てる action は上の4つだけなので、「電話をかける」「テンプレートを送る」
 * 「回答フォームを開く」はここで受けて、publish のときに4つのどれかへ変換する。
 * 未設定 (null) の area は、この仕組みが入る前に作られたもの。今までどおり
 * actionType と actionData をそのまま LINE に渡す。
 */
export type AreaIntent =
  | 'url'
  | 'tel'
  | 'text'
  | 'template'
  | 'booking'
  | 'booking_history'
  | 'visit_stamp'
  | 'form'
  | 'switch'
  | 'postback'
  | 'datetime'
  | 'clipboard';

export type AreaInput = {
  id?: string;
  bounds: Bounds;
  actionType: ActionType;
  actionData: Record<string, unknown>;
  intent?: AreaIntent | null;
  /** 管理用のボタン名。エラー文で「どのボタンか」を示すのに使う。 */
  label?: string | null;
  /** 押されたときに付けるタグ。あると postback 経由になる。 */
  tagIds?: string[];
  /** 押されたときに足すスコア。あると postback 経由になる。 */
  scoreChange?: number | null;
  templateId?: string | null;
  formId?: string | null;
  /** intent='url' で計測リンクを選んだ場合の、解決済み URL。 */
  trackedLinkUrl?: string | null;
};

export type PageInput = {
  id: string;
  orderIndex: number;
  name: string;
  imageR2Key: string | null;
  imageContentType: string | null;
  lineRichMenuId: string | null;
  areas: AreaInput[];
};

export type GroupInput = {
  id: string;
  size: 'large' | 'compact';
  chatBarText: string;
  isDefaultForAll: boolean;
  /**
   * V8「トークを開いたとき メニューを開いておく」。LINE の rich menu payload
   * `selected` にそのまま出る。未指定（古い呼び出し・既存行）は false、
   * つまり従来どおり「閉じておく」。
   */
  defaultOpen?: boolean;
  pages: PageInput[];
  /**
   * 「回答フォームを開く」ボタンの飛び先。アカウントの LIFF URL を渡す。
   * これが無いと intent='form' のボタンは publish できない (どこへ飛ばせばいいか
   * 決められないため)。
   */
  formBaseUrl?: string | null;
};

/**
 * 長いLINE処理の途中で「まだ自分が担当か」を確かめる合図。
 *
 * 1回のpublishは、ページ数ぶんの作成・画像upload・alias切替・旧削除で
 * 何分もかかる。その間ずっとleaseを延ばさないと、本人が動いている最中に
 * 期限切れで別の実行に回収される。外部呼び出しの直前ごとにこれを呼び、
 * 失権していたら投げてもらう。
 */
export type PublishHeartbeat = () => Promise<void>;

/** leaseを失ったので、この実行は続けてはいけない。 */
export class PublishLeaseLostError extends Error {
  constructor(message = 'publish lease lost') {
    super(message);
    this.name = 'PublishLeaseLostError';
  }
}

export class RichMenuValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RichMenuValidationError';
  }
}

export interface LineRichMenuClient {
  createRichMenu(payload: unknown): Promise<{ richMenuId: string }>;
  /**
   * O(公開前の確認): LINE の Validate rich menu object API。
   * 作らずに形だけ見てもらう。自前検査では気づけない不備を止める。
   */
  validateRichMenu(payload: unknown): Promise<void>;
  /** 手動公開の途中でWorkerが止まっても、決定的なnameから作成済みshellを回収する。 */
  listRichMenus(): Promise<Array<{ richMenuId: string; name: string | null }>>;
  uploadRichMenuImage(richMenuId: string, image: Uint8Array, contentType: string): Promise<void>;
  deleteRichMenuAlias(aliasId: string): Promise<void>;
  createRichMenuAlias(aliasId: string, richMenuId: string): Promise<void>;
  /** 既存 alias は切れ目なく更新し、存在しない場合だけ新規作成する。 */
  upsertRichMenuAlias(aliasId: string, richMenuId: string): Promise<void>;
  deleteRichMenu(richMenuId: string): Promise<void>;
  setDefaultRichMenu(richMenuId: string): Promise<void>;
  // LINE 側のアカウント全体デフォルトを解除する。冪等 — 設定がなくてもエラーにしない実装にする。
  clearDefaultRichMenu(): Promise<void>;
  // LINE 側の現在のアカウント全体デフォルト richMenuId を返す。設定なしなら null。
  getCurrentDefaultRichMenuId(): Promise<string | null>;
  // bulk link: 指定 richMenuId を userIds (最大 500 件 / リクエスト) に link。
  // 500 超は呼出側で chunk して順次呼ぶ。
  linkRichMenuBulk(richMenuId: string, userIds: string[]): Promise<void>;
  // ----- : 本人LINEへのテスト適用で使う個人宛て操作（必要な経路だけが使う任意口） -----
  linkRichMenuToUser?(userId: string, richMenuId: string): Promise<void>;
  unlinkRichMenuFromUser?(userId: string): Promise<void>;
  /** その人に今出ている richMenuId。未設定なら null。 */
  getRichMenuIdOfUser?(userId: string): Promise<string | null>;
  /** alias → richMenuId の現在割当一覧。テスト用 alias の掃除に使う。 */
  listRichMenuAliases?(): Promise<Array<{ richMenuAliasId: string; richMenuId: string }>>;
}

export interface R2Like {
  get(key: string): Promise<{ body: Uint8Array | ReadableStream } | null>;
}

/**
 * LINE Messaging API を直接叩く client。route の createLineClient と
 * 予約実行の createScheduleLineClient と同じ口・同じ形。
 * 毎日の自動照合など、group を持たない経路が使う。
 */
export function createLineApiClient(channelAccessToken: string): LineRichMenuClient {
  const auth = `Bearer ${channelAccessToken}`;
  const check = async (res: Response, name: string) => {
    if (res.ok) return res;
    const detail = `LINE ${name} failed: ${res.status} ${await res.text()}`;
    if (name === 'validateRichMenu' && res.status === 400) throw new RichMenuValidationError(detail);
    throw new Error(detail);
  };
  return {
    async createRichMenu(payload) {
      const res = await check(await fetch('https://api.line.me/v2/bot/richmenu', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }), 'createRichMenu');
      return res.json() as Promise<{ richMenuId: string }>;
    },
    async validateRichMenu(payload) {
      await check(await fetch('https://api.line.me/v2/bot/richmenu/validate', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }), 'validateRichMenu');
    },
    async listRichMenus() {
      const res = await check(await fetch('https://api.line.me/v2/bot/richmenu/list', {
        headers: { Authorization: auth },
      }), 'listRichMenus');
      const body = await res.json() as { richmenus?: Array<{ richMenuId?: string; name?: string }> };
      return (body.richmenus ?? []).flatMap((menu) => (
        typeof menu.richMenuId === 'string'
          ? [{ richMenuId: menu.richMenuId, name: typeof menu.name === 'string' ? menu.name : null }]
          : []
      ));
    },
    async uploadRichMenuImage(richMenuId, image, contentType) {
      await check(await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': contentType },
        body: image,
      }), 'uploadRichMenuImage');
    },
    async deleteRichMenuAlias(aliasId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenuAlias failed: ${res.status} ${await res.text()}`);
      }
    },
    async createRichMenuAlias(aliasId, richMenuId) {
      await check(await fetch('https://api.line.me/v2/bot/richmenu/alias', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
      }), 'createRichMenuAlias');
    },
    async upsertRichMenuAlias(aliasId, richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId }),
      });
      if (res.ok) return;
      if (res.status === 404) {
        await check(await fetch('https://api.line.me/v2/bot/richmenu/alias', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
        }), 'createRichMenuAlias');
        return;
      }
      throw new Error(`LINE updateRichMenuAlias failed: ${res.status} ${await res.text()}`);
    },
    async deleteRichMenu(richMenuId) {
      const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE deleteRichMenu failed: ${res.status} ${await res.text()}`);
      }
    },
    async setDefaultRichMenu(richMenuId) {
      await check(await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
        method: 'POST',
        headers: { Authorization: auth },
      }), 'setDefaultRichMenu');
    },
    async clearDefaultRichMenu() {
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`LINE clearDefaultRichMenu failed: ${res.status} ${await res.text()}`);
      }
    },
    async getCurrentDefaultRichMenuId() {
      const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
        method: 'GET',
        headers: { Authorization: auth },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`LINE getCurrentDefaultRichMenu failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as { richMenuId?: string };
      return body.richMenuId ?? null;
    },
    async linkRichMenuBulk(richMenuId, userIds) {
      await check(await fetch('https://api.line.me/v2/bot/richmenu/bulk/link', {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId, userIds }),
      }), 'linkRichMenuBulk');
    },
  };
}

export function buildAliasId(groupId: string, orderIndex: number): string {
  return `lhx-${groupId.slice(0, 8)}-${orderIndex}`;
}

export function resolveSwitcherActions(pages: PageInput[], groupId: string): PageInput[] {
  const aliasByPageId = new Map(pages.map((p) => [p.id, buildAliasId(groupId, p.orderIndex)]));
  return pages.map((page) => ({
    ...page,
    areas: page.areas.map((area) => {
      if (area.actionType !== 'richmenuswitch') return area;
      const targetPageId = area.actionData.targetPageId as string | undefined;
      if (!targetPageId) {
        throw new RichMenuValidationError(`ページ「${page.name}」の切替ボタンに遷移先が設定されていません`);
      }
      const alias = aliasByPageId.get(targetPageId);
      if (!alias) {
        throw new RichMenuValidationError(
          `切替ボタンの遷移先ページ ${targetPageId} がこのグループにありません`,
        );
      }
      const inner = `switch-to-${targetPageId}`;
      return {
        ...area,
        actionData: {
          richMenuAliasId: alias,
          // intent が付いている area は、押されたことをこちらで受け取れるように
          // 目印を足す。旧データ (intent なし) は今までどおりの data のまま。
          data: area.intent && area.id ? buildTapPostbackData(area.id, inner) : inner,
        },
      };
    }),
  }));
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * LINE API を呼ぶ前に、アクションの必須値を検証する。
 *
 * エディタのテンプレート領域は空の message action で作られるため、未設定のまま
 * publish すると LINE API が 400 を返す。外部 API を呼ぶ前に、管理画面で修正可能な
 * 日本語メッセージとして返す。
 */
function limited(value: string, max: number): boolean {
  return [...value].length <= max;
}

/** 日時を選ぶボタンの種類と、LINE が受け付ける値の形。 */
const DATETIME_MODE_LABEL = { date: '日付', time: '時刻', datetime: '日時' } as const;

function isDatetimepickerValue(mode: keyof typeof DATETIME_MODE_LABEL, value: string): boolean {
  if (mode === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (mode === 'time') return /^\d{2}:\d{2}$/.test(value);
  return /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}$/.test(value);
}

/**
 * intent が設定された area の検証。運用者が画面で直せる言葉で返す。
 */
function validateAreaByIntent(area: AreaInput, prefix: string, group: GroupInput): void {
  const data = area.actionData ?? {};
  switch (area.intent) {
    case 'tel': {
      const raw = String(data.tel ?? data.uri ?? '');
      if (!requiredString(raw)) {
        throw new RichMenuValidationError(`${prefix}: 電話番号を入力してください`);
      }
      if (!/[0-9]/.test(raw)) {
        throw new RichMenuValidationError(`${prefix}: 電話番号に数字が入っていません`);
      }
      return;
    }
    case 'booking':
    case 'booking_history':
    case 'visit_stamp':
    case 'form': {
      const formId = area.formId ?? String(data.formId ?? '');
      if (area.intent === 'form' && !requiredString(formId)) {
        throw new RichMenuValidationError(`${prefix}: 開く回答フォームを選んでください`);
      }
      if (!requiredString(group.formBaseUrl ?? '')) {
        throw new RichMenuValidationError(`${prefix}: このLINEアカウントにLIFFが設定されていないため、この画面を開くボタンは使えません`);
      }
      try { buildAreaLiffUri(area, group.formBaseUrl!); }
      catch { throw new RichMenuValidationError(`${prefix}: LIFFまたは開くメニュー・カードの指定を確認してください`); }
      return;
    }
    case 'template': {
      if (!requiredString(area.templateId ?? '')) {
        throw new RichMenuValidationError(`${prefix}: 送るテンプレートを選んでください`);
      }
      return;
    }
    case 'url': {
      const uri = area.trackedLinkUrl ?? String(data.uri ?? '');
      if (!requiredString(uri)) {
        throw new RichMenuValidationError(`${prefix}: URLを入力してください`);
      }
      if (!limited(uri, 1000)) {
        throw new RichMenuValidationError(`${prefix}: URLは1000文字以内にしてください`);
      }
      // 計測リンクはこちらが生成したURLなので飛ばす。手入力の飛び先は
      // URIの形と許可schemeを確かめ、LINEへ届いて初めて失敗する事故を防ぐ。
      if (!area.trackedLinkUrl) {
        const uriError = richMenuUriError(uri);
        if (uriError) {
          throw new RichMenuValidationError(`${prefix}: ${uriError}`);
        }
      }
      return;
    }
    case 'text': {
      const text = String(data.text ?? '');
      if (!requiredString(text)) {
        throw new RichMenuValidationError(`${prefix}: 送信テキストを入力してください`);
      }
      if (!limited(text, 300)) {
        throw new RichMenuValidationError(`${prefix}: 送信テキストは300文字以内にしてください`);
      }
      return;
    }
    case 'switch': {
      if (!requiredString(data.richMenuAliasId) || !requiredString(data.data)) {
        throw new RichMenuValidationError(`${prefix}: 遷移先ページを選択してください`);
      }
      return;
    }
    case 'postback': {
      const inner = String(data.data ?? '');
      if (!requiredString(inner)) {
        throw new RichMenuValidationError(`${prefix}: postback dataを入力してください`);
      }
      if (!limited(inner, 200)) {
        // 目印 (rma=<id>) を足した後に LINE の 300 文字上限へ収める必要がある。
        throw new RichMenuValidationError(`${prefix}: postback dataは200文字以内にしてください`);
      }
      const displayText = data.displayText;
      if (typeof displayText === 'string' && !limited(displayText, 300)) {
        throw new RichMenuValidationError(`${prefix}: displayTextは300文字以内にしてください`);
      }
      return;
    }
    case 'datetime': {
      const mode = String(data.mode ?? '');
      if (mode !== 'date' && mode !== 'time' && mode !== 'datetime') {
        throw new RichMenuValidationError(`${prefix}: 日時の種類（日付・時刻・日時）を選んでください`);
      }
      const initial = String(data.initial ?? '');
      const max = String(data.max ?? '');
      const min = String(data.min ?? '');
      for (const [name, value, label] of [
        ['initial', initial, 'はじめの値'],
        ['max', max, 'いちばん後の値'],
        ['min', min, 'いちばん前の値'],
      ] as const) {
        if (value !== '' && !isDatetimepickerValue(mode, value)) {
          throw new RichMenuValidationError(`${prefix}: ${label}が「${DATETIME_MODE_LABEL[mode]}」の形ではありません`);
        }
        void name;
      }
      return;
    }
    case 'clipboard': {
      const text = String(data.text ?? '');
      if (!requiredString(text)) {
        throw new RichMenuValidationError(`${prefix}: コピーする文字を入力してください`);
      }
      if (!limited(text, 1000)) {
        throw new RichMenuValidationError(`${prefix}: コピーする文字は1000文字以内にしてください`);
      }
      return;
    }
    default:
      // intent は DB の TEXT 列で、保存時の型とずれた値が残ることがある。
      // 知らない種類は action を組み立てられないので LINE を呼ぶ前に止める。
      throw new RichMenuValidationError(`${prefix}: ボタンの種類を確認できません`);
  }
}

export function validateRichMenuGroupForPublish(group: GroupInput): void {
  // O(公開前の確認): ページは10まで。11以上は保存口でも止めるが、
  // 予約スナップショットの復元値にも掛かるよう公開前にも見る。
  if (group.pages.length > RICH_MENU_MAX_PAGES) {
    throw new RichMenuValidationError(
      `ページは${RICH_MENU_MAX_PAGES}までです（今は${group.pages.length}ページあります）。まとめられるページを1つにしてください`,
    );
  }
  //  「ページを切り替える」だけのボタンは、押しても別ページが
  // 出るだけで、押すと何か起きる行き先にはならない。到達可能な行き先として数えない。
  let destinationCount = 0;
  for (const page of group.pages) {
    for (let i = 0; i < page.areas.length; i++) {
      const area = page.areas[i];
      const label = area.label?.trim();
      const prefix = label
        ? `ページ「${page.name}」の「${label}」`
        : `ページ「${page.name}」のタップ領域${i + 1}`;

      //  ボタン名は端末の読み上げ(アクセシビリティ)にも使うため
      // 必須・20字以内。既存行や DB 直接更新を通った値もここで止める。
      if (!label) {
        throw new RichMenuValidationError(`${prefix}: ボタン名（読み上げラベル）を入力してください`);
      }
      if (!limited(label, 20)) {
        throw new RichMenuValidationError(`${prefix}: ボタン名（読み上げラベル）は20文字以内にしてください`);
      }

      // intent がある area は intent で見る。無いものは今までどおり actionType で見る。
      if (area.intent) {
        validateAreaByIntent(area, prefix, group);
      } else if (area.actionType === 'message') {
        const text = area.actionData.text;
        if (!requiredString(text)) {
          throw new RichMenuValidationError(`${prefix}: 送信テキストを入力してください`);
        }
        if ([...text].length > 300) {
          throw new RichMenuValidationError(`${prefix}: 送信テキストは300文字以内にしてください`);
        }
      } else if (area.actionType === 'uri') {
        const uri = area.actionData.uri;
        if (!requiredString(uri)) {
          throw new RichMenuValidationError(`${prefix}: URLを入力してください`);
        }
        if ([...uri].length > 1000) {
          throw new RichMenuValidationError(`${prefix}: URLは1000文字以内にしてください`);
        }
        // intent なしの古いボタンにも同じ検査を掛ける。
        const uriError = richMenuUriError(String(uri));
        if (uriError) {
          throw new RichMenuValidationError(`${prefix}: ${uriError}`);
        }
      } else if (area.actionType === 'postback') {
        const data = area.actionData.data;
        if (!requiredString(data)) {
          throw new RichMenuValidationError(`${prefix}: postback dataを入力してください`);
        }
        if ([...data].length > 300) {
          throw new RichMenuValidationError(`${prefix}: postback dataは300文字以内にしてください`);
        }
        const displayText = area.actionData.displayText;
        if (typeof displayText === 'string' && [...displayText].length > 300) {
          throw new RichMenuValidationError(`${prefix}: displayTextは300文字以内にしてください`);
        }
      } else if (area.actionType === 'richmenuswitch') {
        if (!requiredString(area.actionData.richMenuAliasId) || !requiredString(area.actionData.data)) {
          throw new RichMenuValidationError(`${prefix}: 遷移先ページを選択してください`);
        }
      } else {
        // action_type は CHECK 制約で4種に限定されるが、検証関数は
        // 予約スナップショットの復元値にも掛かるため、知らない種類は止める。
        throw new RichMenuValidationError(`${prefix}: ボタンの動作（${area.actionType}）には対応していません`);
      }

      const isSwitch = area.intent ? area.intent === 'switch' : area.actionType === 'richmenuswitch';
      if (!isSwitch) destinationCount += 1;
    }
  }
  if (destinationCount === 0) {
    throw new RichMenuValidationError(
      '公開するには、ページ切替以外の行き先（URLを開く・テキストを送るなど）を持つボタンを1つ以上設定してください',
    );
  }
}

/**
 * O(公開前の確認): 公開する形のまま、全ページを LINE の検査 API に通す。
 * 自前の検査（必須・文字数・領域数）を通っていても、LINE 側の決まりに
 * 触れる形はここで止める。作らずに見るだけなので、下書きもLINEも変えない。
 */
export function buildLineRichMenuPayload(
  group: GroupInput,
  page: PageInput,
): Record<string, unknown> {
  const dimensions = RICH_MENU_DIMENSIONS[group.size];
  return {
    size: dimensions,
    selected: group.defaultOpen === true,
    name: page.name,
    chatBarText: group.chatBarText,
    areas: page.areas.map((a) => ({
      bounds: a.bounds,
      action: toLineAction(a, group),
    })),
  };
}

export async function validateRichMenuPagesWithLine(
  group: GroupInput,
  line: LineRichMenuClient,
): Promise<void> {
  const resolvedPages = resolveSwitcherActions(group.pages, group.id);
  const ordered = [...resolvedPages].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const page of ordered) {
    try {
      await line.validateRichMenu(buildLineRichMenuPayload({ ...group, pages: resolvedPages }, page));
    } catch (error) {
      // 下書きの不備（LINE の 400）だけ日本語の直し文にする。
      // 通信障害などはそのまま投げて、呼び出し側で 500 にする。
      if (!(error instanceof RichMenuValidationError)) throw error;
      const detail = error.message;
      throw new RichMenuValidationError(
        `ページ「${page.name}」がLINEの検査を通りませんでした。領域の位置やボタンの内容を見直してください（${detail}）`,
      );
    }
  }
}

/** 押されたときに、こちら側で何かする設定が入っているか。 */
export function hasTapSideEffects(area: AreaInput): boolean {
  if ((area.tagIds?.length ?? 0) > 0) return true;
  if (typeof area.actionData?.scenarioId === 'string' && area.actionData.scenarioId.length > 0) return true;
  return typeof area.scoreChange === 'number' && area.scoreChange !== 0;
}

/** 「電話をかける」の入力を tel: の形に整える。 */
export function normalizeTelUri(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('tel:')) return trimmed;
  // ハイフンや括弧は落とす。先頭の + は国番号なので残す。
  return `tel:${trimmed.replace(/[^0-9+]/g, '')}`;
}

/** 「回答フォームを開く」の飛び先を組み立てる。 */
export function buildFormUri(base: string, formId: string): string {
  return buildAreaLiffUri({ bounds: { x: 0, y: 0, width: 1, height: 1 }, actionType: 'uri', intent: 'form', formId, actionData: {} }, base);
}

function buildAreaLiffUri(area: AreaInput, base: string): string {
  const url = new URL(base);
  if (url.origin !== 'https://liff.line.me' || url.username || url.password || !/^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) throw new Error('INVALID_LIFF');
  const data = area.actionData;
  const spec: LiffAction = area.intent === 'form' ? { kind: 'form', formId: area.formId ?? String(data.formId ?? '') }
    : area.intent === 'booking' ? { kind: 'booking', ...(data.menuId ? { menuId: String(data.menuId) } : {}) }
    : area.intent === 'visit_stamp' ? { kind: 'visit_stamp', ...(data.cardId ? { cardId: String(data.cardId) } : {}) }
    : { kind: 'booking_history' };
  return liffActionUrl({ liffId: url.pathname.replace(/\//g, ''), ...spec });
}

function toLineAction(area: AreaInput, group: GroupInput): Record<string, unknown> {
  const data = area.actionData ?? {};
  const intent = area.intent ?? null;

  // intent が無いのは、この仕組みが入る前に作られた area。挙動を変えない。
  if (!intent) {
    const action: Record<string, unknown> = { type: area.actionType, ...data };
    // displayText は任意項目。エディタの初期値 "" を LINE に送らない。
    if (action.displayText === '') delete action.displayText;
    return action;
  }

  const areaId = area.id ?? '';

  switch (intent) {
    case 'tel':
      return { type: 'uri', uri: normalizeTelUri(String(data.tel ?? data.uri ?? '')) };

    case 'form':
    case 'booking':
    case 'booking_history':
    case 'visit_stamp':
      return { type: 'uri', uri: buildAreaLiffUri(area, group.formBaseUrl ?? '') };

    case 'url':
      // 計測リンクを選んでいればそちらを開く。クリック数もタグ付けも、
      // 計測リンク側の仕組みがそのまま面倒を見てくれる。
      return { type: 'uri', uri: area.trackedLinkUrl ?? String(data.uri ?? '') };

    case 'template': {
      const action: Record<string, unknown> = {
        type: 'postback',
        data: buildTapPostbackData(areaId),
      };
      if (typeof data.displayText === 'string' && data.displayText !== '') {
        action.displayText = data.displayText;
      }
      return action;
    }

    case 'text': {
      const text = String(data.text ?? '');
      if (!hasTapSideEffects(area)) {
        // 何もしないならメッセージ送信のまま。トークの見え方がいちばん自然。
        return { type: 'message', text };
      }
      // タグやスコアを付けるには、押されたことがこちらに届かないといけない。
      // postback に displayText を添えると、トークの見え方はメッセージ送信と
      // ほぼ同じまま、押されたことを受け取れる。
      return {
        type: 'postback',
        data: buildTapPostbackData(areaId, text),
        displayText: text,
      };
    }

    case 'switch':
      // data は resolveSwitcherActions が解決済み。
      return { type: 'richmenuswitch', ...data };

    case 'postback': {
      const inner = String(data.data ?? '');
      const action: Record<string, unknown> = {
        type: 'postback',
        data: areaId ? buildTapPostbackData(areaId, inner) : inner,
      };
      if (typeof data.displayText === 'string' && data.displayText !== '') {
        action.displayText = data.displayText;
      }
      return action;
    }

    case 'datetime': {
      // 選んだ日時は postback で届く。ボタンの目印を data に載せると、
      // 押されたことがこちらに届き、タグ付けや集計の対象になる。
      const action: Record<string, unknown> = {
        type: 'datetimepicker',
        data: areaId ? buildTapPostbackData(areaId) : '',
        mode: String(data.mode ?? 'datetime'),
      };
      for (const key of ['initial', 'max', 'min'] as const) {
        const value = data[key];
        if (typeof value === 'string' && value !== '') action[key] = value;
      }
      return action;
    }

    case 'clipboard': {
      // コピーは端末の中で完結し、押されたことはこちらに届かない。
      return { type: 'clipboard', text: String(data.text ?? '') };
    }
  }
}

export type PublishResult = {
  pages: { pageId: string; newRichMenuId: string }[];
};

async function readR2Object(r2: R2Like, key: string): Promise<Uint8Array> {
  const obj = await r2.get(key);
  if (!obj) throw new Error(`R2 image missing: ${key}`);
  if (obj.body instanceof Uint8Array) return obj.body;
  return new Uint8Array(await new Response(obj.body).arrayBuffer());
}

// =============================================================================
// 部分的な公開を防ぐため、create/upload → DB journal 確定 →
// alias/default切替 → 旧メニュー削除へ分ける。journal確定前の失敗は、まだliveで
// ない新メニューを消すだけで既存alias/defaultを変えない。切替途中の失敗は、
// 保存した切替前LINE状態へ補償で戻す。予約実行が journal を挟むために使う。
// 手動公開は従来どおり publishRichMenuGroup 一括版を使う。
// =============================================================================

/** 作ったばかりでまだliveでない新メニュー。 */
export type RichMenuShell = {
  pageId: string;
  orderIndex: number;
  newRichMenuId: string;
};

export type RichMenuShellCreationOptions = {
  /** すでにjournalまたはLINE名照合で回収済みのshell。画像は安全に再uploadする。 */
  existingShells?: RichMenuShell[];
  /** create直後にjournalへ確定する。ここが失敗したshellだけを補償削除する。 */
  onShellCreated?: (shell: RichMenuShell) => Promise<void>;
  /** 手動公開ではrequest/pageを含む決定名を使い、DB未記録時にもLINEから回収できる。 */
  shellName?: (page: PageInput) => string;
};

/** 切替前のLINE状態。切替失敗の補償でここへ戻す。 */
export type PreSwitchLiveState = {
  oldIds: Array<{ pageId: string; orderIndex: number; lineRichMenuId: string | null }>;
  /** 切替前に読んだ実default。読めなかった場合は null。 */
  previousDefaultId: string | null;
};

/**
 * 第一段: 全ページを作成し、全画像を upload する。
 * ここが完走するまで alias は触らない。失敗時は作った分を消して投げる。
 */
export async function createRichMenuShells(
  group: GroupInput,
  line: LineRichMenuClient,
  r2: R2Like,
  heartbeat?: PublishHeartbeat,
  options?: RichMenuShellCreationOptions,
): Promise<{ shells: RichMenuShell[]; pages: PageInput[] }> {
  const resolvedPages = resolveSwitcherActions(group.pages, group.id);
  resolvedPages.sort((a, b) => a.orderIndex - b.orderIndex);
  validateRichMenuGroupForPublish({ ...group, pages: resolvedPages });

  const existingByPage = new Map((options?.existingShells ?? []).map((shell) => [shell.pageId, shell]));
  if (existingByPage.size !== (options?.existingShells ?? []).length) {
    throw new Error('rich menu shell journal has duplicate pages');
  }
  if ([...existingByPage.keys()].some((pageId) => !resolvedPages.some((page) => page.id === pageId))) {
    throw new Error('rich menu shell journal does not match pages');
  }
  const shells: RichMenuShell[] = [...existingByPage.values()];
  const unjournaledShellIds: string[] = [];

  // LINE 側へ変更を加える前に、全ページの画像が読めることを確認する。
  // 2ページ目の画像不備で1ページ目だけ公開される事故を防ぐ。
  const imageBytes = new Map<string, Uint8Array>();
  for (const page of resolvedPages) {
    if (!page.imageR2Key || !page.imageContentType) {
      throw new Error(`page ${page.id} (${page.name}) has no image`);
    }
    imageBytes.set(page.id, await readR2Object(r2, page.imageR2Key));
  }

  try {
    for (const page of resolvedPages) {
      await heartbeat?.();
      const existing = existingByPage.get(page.id);
      if (existing) {
        // uploadは同じIDへ安全に再実行できる。前回がcreate直後に止まった場合も
        // ここで画像を完成させ、LINE menuを作り直さない。
        await line.uploadRichMenuImage(
          existing.newRichMenuId,
          imageBytes.get(page.id)!,
          page.imageContentType!,
        );
        continue;
      }
      // 検査（validateRichMenuPagesWithLine）と同じ組み立てで作る。
      // 検査を通った形と作る形がずれないようにする。
      const created = await line.createRichMenu({
        ...buildLineRichMenuPayload(group, page),
        name: options?.shellName?.(page) ?? `${group.id.slice(0, 8)} - ${page.name}`,
      });
      const shell = { pageId: page.id, orderIndex: page.orderIndex, newRichMenuId: created.richMenuId };
      shells.push(shell);
      unjournaledShellIds.push(shell.newRichMenuId);
      // DBに書けないときは、作成済みLINE menuの決定名から次回回収できる。
      // 書けたものは途中失敗でも消さず、同じIDへのuploadから再開する。
      if (options?.onShellCreated) {
        await options.onShellCreated(shell);
        const journaledAt = unjournaledShellIds.indexOf(shell.newRichMenuId);
        if (journaledAt >= 0) unjournaledShellIds.splice(journaledAt, 1);
      }
      await heartbeat?.();
      await line.uploadRichMenuImage(
        created.richMenuId,
        imageBytes.get(page.id)!,
        page.imageContentType!,
      );
    }
  } catch (error) {
    await deleteRichMenuShells(
      line,
      unjournaledShellIds,
    );
    throw error;
  }
  return { shells, pages: resolvedPages };
}

/**
 * 第二段: alias を新メニューへ切替え、default を設定/解除する。
 * 失敗時は投げるだけで補償しない。呼び出し側が journal を消してから
 * restorePreSwitchLive で戻し、deleteRichMenuShells で片付ける順番を守る。
 * (journalを残したまま新メニューを消すと、再試行が消えたIDへ切替えて壊す)
 */
export async function switchRichMenuLive(
  line: LineRichMenuClient,
  group: GroupInput,
  shells: RichMenuShell[],
  heartbeat?: PublishHeartbeat,
): Promise<void> {
  const ordered = [...shells].sort((a, b) => a.orderIndex - b.orderIndex);
  for (const shell of ordered) {
    await heartbeat?.();
    await line.upsertRichMenuAlias(
      buildAliasId(group.id, shell.orderIndex),
      shell.newRichMenuId,
    );
  }

  if (group.isDefaultForAll && shells.length > 0) {
    // orderIndex順に並べた先頭を default にする。
    const first = [...shells].sort((a, b) => a.orderIndex - b.orderIndex)[0];
    await heartbeat?.();
    await line.setDefaultRichMenu(first.newRichMenuId);
    return;
  }

  if (!group.isDefaultForAll) {
    await heartbeat?.();
    // ベストエフォート: この group の richmenu が現在 LINE の default なら外す。
    // 別 group の default まで壊さないよう、自分のIDに当たるときだけ解除する。
    try {
      const currentDefault = await line.getCurrentDefaultRichMenuId();
      if (currentDefault) {
        const ownIds = new Set<string>();
        for (const p of group.pages) {
          if (p.lineRichMenuId) ownIds.add(p.lineRichMenuId);
        }
        for (const shell of shells) ownIds.add(shell.newRichMenuId);
        if (ownIds.has(currentDefault)) {
          await line.clearDefaultRichMenu();
        }
      }
    } catch (e) {
      logger.warn("rich_menu_publisher.clear_switched_default_failed");
    }
  }
}

/**
 * 切替失敗の補償: alias を旧IDへ戻す。default は restorePreSwitchDefault で別に戻す。
 * 決して投げない(元の失敗を隠さない)。戻せなかった pageId の集合を返す。
 * 戻せなかったページの新メニューは消してはいけない
 * (alias が新IDを指したままリンク切れになるほうが危険なため)。
 */
export async function restorePreSwitchLive(
  line: LineRichMenuClient,
  groupId: string,
  prev: PreSwitchLiveState,
): Promise<Set<string>> {
  const unrestored = new Set<string>();
  for (const old of [...prev.oldIds].reverse()) {
    const aliasId = buildAliasId(groupId, old.orderIndex);
    try {
      if (old.lineRichMenuId) {
        await line.upsertRichMenuAlias(aliasId, old.lineRichMenuId);
      } else {
        await line.deleteRichMenuAlias(aliasId);
      }
    } catch (e) {
      logger.warn("rich_menu_publisher.restore_live_menu_failed");
      unrestored.add(old.pageId);
    }
  }
  return unrestored;
}

/**
 * default 復元の結果。呼び出し側は「戻し切れていない新メニューを消さない」
 * ためにこれを見る。復元できたかどうかを飲み込むと、default が新メニューを
 * 指したまま後片付けでその新メニューを消し、公開中の表示が消える。
 */
export type DefaultRestoreOutcome =
  /** 現 default は今回の新メニューではない。こちらは何も触っていない。 */
  | { state: 'untouched' }
  /** 切替前の値へ戻した(または解除した)。 */
  | { state: 'restored' }
  /**
   * 戻せなかった。retainedId は default が指したままの新メニューID。
   * default を読めなかった場合は null で、どれが指されているか分からない。
   */
  | { state: 'failed'; retainedId: string | null };

/**
 * 切替前の default へ戻す。現在の default が今回作った新メニューのときだけ
 * 戻す/外す(その間に外から変わっていたら触らない)。
 * 決して投げない。戻せたかどうかは戻り値で伝える(飲み込まない)。
 */
export async function restorePreSwitchDefault(
  line: LineRichMenuClient,
  prev: PreSwitchLiveState,
  newIds: string[],
): Promise<DefaultRestoreOutcome> {
  let current: string | null;
  try {
    current = await line.getCurrentDefaultRichMenuId();
  } catch (e) {
    // 読めない = 新メニューを指したままかもしれない。どれかも分からないので、
    // 新メニューは1つも消さない(消すと default がリンク切れになる)。
    logger.warn("rich_menu_publisher.restore_default_menu_failed");
    return { state: 'failed', retainedId: null };
  }
  if (!current || !newIds.includes(current)) return { state: 'untouched' };
  try {
    if (prev.previousDefaultId) {
      await line.setDefaultRichMenu(prev.previousDefaultId);
    } else {
      await line.clearDefaultRichMenu();
    }
    return { state: 'restored' };
  } catch (e) {
    logger.warn("rich_menu_publisher.restore_default_menu_failed");
    return { state: 'failed', retainedId: current };
  }
}

/**
 * 補償のあとで消してよい新メニューID。
 * - alias を旧へ戻せなかったページの新メニューは消さない(alias がリンク切れになる)
 * - default 復元が終わっていない新メニューも消さない(全友だちの表示が消える)
 * - default をそもそも読めなかったときは、どれが指されているか分からないので1つも消さない
 */
export function deletableAfterCompensation(
  shells: Array<{ pageId: string; newRichMenuId: string }>,
  unrestoredPageIds: Set<string>,
  defaultOutcome: DefaultRestoreOutcome,
): string[] {
  if (defaultOutcome.state === 'failed' && !defaultOutcome.retainedId) return [];
  const retained =
    defaultOutcome.state === 'failed' && defaultOutcome.retainedId
      ? new Set([defaultOutcome.retainedId])
      : new Set<string>();
  return shells
    .filter((shell) => !unrestoredPageIds.has(shell.pageId) && !retained.has(shell.newRichMenuId))
    .map((shell) => shell.newRichMenuId);
}

/** 新メニュー/旧メニューの削除。404は許容し、失敗は飲み込む(後片付け用)。 */
export async function deleteRichMenuShells(
  line: LineRichMenuClient,
  richMenuIds: string[],
): Promise<void> {
  for (const id of richMenuIds) {
    if (!id) continue;
    try {
      await line.deleteRichMenu(id);
    } catch {
      // 後片付けの失敗は元のエラーを隠さない。残留は次回の清掃対象。
    }
  }
}

export async function publishRichMenuGroup(
  group: GroupInput,
  line: LineRichMenuClient,
  r2: R2Like,
  heartbeat?: PublishHeartbeat,
): Promise<PublishResult> {
  // 一括版(手動公開用)。段階関数と同じ実装を使い、journalは挟まない。
  // 予約実行は段階関数を直接呼び、createと切替の間にjournalを確定する。
  const { shells, pages: resolvedPages } = await createRichMenuShells(group, line, r2, heartbeat);
  const results = shells.map((shell) => ({ pageId: shell.pageId, newRichMenuId: shell.newRichMenuId }));
  const prev: PreSwitchLiveState = {
    oldIds: resolvedPages.map((page) => ({
      pageId: page.id,
      orderIndex: page.orderIndex,
      lineRichMenuId: page.lineRichMenuId,
    })),
    previousDefaultId: null,
  };
  try {
    prev.previousDefaultId = await line.getCurrentDefaultRichMenuId();
  } catch {
    // 読めなくても切替は続ける。補償のdefault復元だけ弱くなる。
    prev.previousDefaultId = null;
  }

  try {
    await switchRichMenuLive(line, group, shells, heartbeat);
  } catch (error) {
    const unrestored = await restorePreSwitchLive(line, group.id, prev);
    const defaultOutcome = await restorePreSwitchDefault(
      line,
      prev,
      shells.map((shell) => shell.newRichMenuId),
    );
    // default を戻し切れていない新メニューは消さない(消すと全友だちの表示が消える)。
    await deleteRichMenuShells(line, deletableAfterCompensation(shells, unrestored, defaultOutcome));
    throw error;
  }

  // 公開切替がすべて終わってから旧メニューを削除する。
  await heartbeat?.();
  await deleteRichMenuShells(
    line,
    prev.oldIds.filter((old) => old.lineRichMenuId).map((old) => old.lineRichMenuId as string),
  );

  return { pages: results };
}

/**
 * LINE bulk link API は 1 リクエスト最大 500 ユーザー。500 超は分割。
 * 全 chunk 完走で resolve。途中失敗時は throw (呼出側で部分成功は扱わない)。
 * 多重リクエスト時の rate limit 配慮として chunk 間で意図的なスリープは入れない —
 * LINE 側は基本 200 RPS まで許容する想定 (Worker の単発処理なので重複もない)。
 */
export async function linkRichMenuBulkChunked(
  line: LineRichMenuClient,
  richMenuId: string,
  userIds: string[],
  onChunkLinked?: (userIds: string[], chunkIndex: number) => Promise<void>,
): Promise<{ chunks: number; total: number }> {
  const CHUNK = 500;
  const total = userIds.length;
  if (total === 0) return { chunks: 0, total: 0 };
  let chunks = 0;
  for (let i = 0; i < total; i += CHUNK) {
    const slice = userIds.slice(i, i + CHUNK);
    await line.linkRichMenuBulk(richMenuId, slice);
    await onChunkLinked?.(slice, chunks);
    chunks++;
  }
  return { chunks, total };
}

export type UnpublishResult = {
  pages: { pageId: string; clearedRichMenuId: string | null }[];
  warnings: string[];
};

/**
 * Group を LINE 上から完全に解除する (DB は markRichMenuGroupUnpublished で別途更新)。
 *   1. 各 page の alias を delete (404 無視 — 既に消えてる場合)
 *   2. 各 page の richmenu を delete (404 無視)
 *   3. 現 default が own group の richmenu なら default unlink
 *
 * 削除は 404 を許容することで複数回呼ばれても安全 (idempotent)。
 * alias / richmenu の削除が1件でも失敗 (5xx 等) したら、処理を
 * 続けたうえで最後に throw する。失敗を warnings に退避して成功扱いに
 * すると、DB は draft 確定なのに LINE 上にメニューが残り、画面は
 * 「取り下げ済み」に見えてしまう。route 側は throw を受けて 500・run 失敗・
 * lease 解放にし、group は published のまま残して再試行できるようにする。
 */
export async function unpublishRichMenuGroup(
  group: GroupInput,
  line: LineRichMenuClient,
  heartbeat?: PublishHeartbeat,
): Promise<UnpublishResult> {
  const warnings: string[] = [];
  const pages: UnpublishResult['pages'] = [];
  const failures: string[] = [];

  for (const page of group.pages) {
    // 外部呼び出しの前に担当を確かめる。失権していたら投げて止める
    // (warnings へ落とすと、失権に気づかないまま成功応答してしまう)。
    await heartbeat?.();
    // alias 削除
    const aliasId = buildAliasId(group.id, page.orderIndex);
    try {
      await line.deleteRichMenuAlias(aliasId);
    } catch (e) {
      const detail = `delete alias ${aliasId} failed: ${e instanceof Error ? e.message : String(e)}`;
      warnings.push(detail);
      failures.push(detail);
    }
    // richmenu 削除
    if (page.lineRichMenuId) {
      await heartbeat?.();
      try {
        await line.deleteRichMenu(page.lineRichMenuId);
      } catch (e) {
        const detail = `delete richmenu ${page.lineRichMenuId} failed: ${e instanceof Error ? e.message : String(e)}`;
        warnings.push(detail);
        failures.push(detail);
      }
    }
    pages.push({ pageId: page.id, clearedRichMenuId: page.lineRichMenuId });
  }

  await heartbeat?.();
  // default が own group のものなら unlink。ベストエフォート (失敗しても unpublish 全体は成功扱い)。
  try {
    const currentDefault = await line.getCurrentDefaultRichMenuId();
    if (currentDefault) {
      const ownIds = new Set<string>();
      for (const p of group.pages) {
        if (p.lineRichMenuId) ownIds.add(p.lineRichMenuId);
      }
      if (ownIds.has(currentDefault)) {
        await heartbeat?.();
        await line.clearDefaultRichMenu();
      }
    }
  } catch (e) {
    if (e instanceof PublishLeaseLostError) throw e;
    warnings.push(
      `default lookup/clear failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      'LINE上のメニューの削除に失敗しました。メニューがLINE上に残っています。'
      + '最新の状態を確認して、もう一度取り下げてください。',
    );
  }
  return { pages, warnings };
}
