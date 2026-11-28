/** LINE に送る4つの画面への動き。選択先のIDは店に属するものを渡す。 */
export type LiffAction =
  | { kind: 'booking'; menuId?: string }
  | { kind: 'booking_history' }
  | { kind: 'form'; formId: string }
  | { kind: 'visit_stamp'; cardId?: string };

export function isLiffActionKind(kind: unknown): kind is LiffAction['kind'] {
  return ['booking', 'booking_history', 'form', 'visit_stamp'].includes(String(kind));
}

function identifier(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('INVALID_LIFF_ACTION_ID');
  return id;
}
function actionQuery(action: LiffAction, allowEmptyForm = false): URLSearchParams {
  const params = new URLSearchParams();
  switch (action.kind) {
    case 'booking':
      params.set('page', 'salon-book');
      if (action.menuId) params.set('menu_id', identifier(action.menuId));
      break;
    case 'booking_history': params.set('page', 'salon-book'); params.set('view', 'history'); break;
    case 'form': params.set('page', 'form'); params.set('id', allowEmptyForm && !action.formId ? '' : identifier(action.formId)); break;
    case 'visit_stamp':
      params.set('page', 'visit-stamps');
      if (action.cardId) params.set('card', identifier(action.cardId));
      break;
    default: throw new Error('INVALID_LIFF_ACTION_KIND');
  }
  return params;
}

/** allowEmptyForm は管理画面で選択途中の値を持つためだけに使う。送信時は省略する。 */
export function liffActionUrl(input: LiffAction & { liffId: string; allowEmptyForm?: boolean }): string {
  return `https://liff.line.me/${identifier(input.liffId)}/?${actionQuery(input, input.allowEmptyForm)}`;
}

/** 店舗の予約リンクと同じトークンを使う、店舗専用の料理メニュー。 */
export function restaurantMenuLiffUrl(input: { liffId: string; token: string }): string {
  const query = new URLSearchParams({ page: 'restaurant-menu', token: identifier(input.token) });
  return `https://liff.line.me/${identifier(input.liffId)}/?${query}`;
}

export function restaurantMenuLiffToken(value: string, liffId?: string): string | null {
  try {
    const url = new URL(value.trim());
    const path = /^\/([A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
    if (url.origin !== 'https://liff.line.me' || url.username || url.password || !path
      || (liffId !== undefined && path[1] !== liffId) || url.searchParams.get('page') !== 'restaurant-menu') return null;
    return identifier(url.searchParams.get('token') ?? '');
  } catch { return null; }
}

function fromQuery(params: URLSearchParams, allowEmptyForm = false): LiffAction | null {
  const page = params.get('page');
  const formId = page === 'form' ? params.get('id') : !page ? params.get('form') : null;
  if (formId) return { kind: 'form', formId: identifier(formId) };
  if (page === 'form' && allowEmptyForm) return { kind: 'form', formId: '' };
  if (page === 'salon-book') {
    if (params.get('view') === 'history') return { kind: 'booking_history' };
    const menuId = params.get('menu_id') ?? params.get('menu') ?? params.get('menuId');
    return { kind: 'booking', ...(menuId ? { menuId: identifier(menuId) } : {}) };
  }
  if (page === 'visit-stamps') {
    const cardId = params.get('card') ?? params.get('cardId');
    return { kind: 'visit_stamp', ...(cardId ? { cardId: identifier(cardId) } : {}) };
  }
  return null;
}

/** LIFF以外・不完全なURLは null。旧 ?form=ID も読む。 */
export function liffActionFromUrl(value: string, options: { allowEmptyForm?: boolean } = {}): LiffAction | null {
  try {
    const url = new URL(value.trim());
    if (url.origin !== 'https://liff.line.me' || url.username || url.password || !/^\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) return null;
    return fromQuery(url.searchParams, options.allowEmptyForm);
  } catch { return null; }
}

/** 統括に保存する仮URL。配布時に店のLIFF・選択先へ置き換える。 */
export function hqLiffActionLocator(action: LiffAction): string {
  return `https://hq.invalid/liff?${actionQuery(action)}`;
}
export function hqLiffActionFromLocator(value: string): LiffAction | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://hq.invalid' || url.username || url.password) return null;
    if (url.pathname === '/liff') return fromQuery(url.searchParams);
    const form = /^\/form\/([^/]+)$/.exec(url.pathname);
    return form ? { kind: 'form', formId: identifier(decodeURIComponent(form[1])) } : null;
  } catch { return null; }
}

/** JSON中のリンク欄だけを集める。本文に書いたURLは変更しない。 */
export function collectLiffActionLocators(value: unknown): Map<string, LiffAction> {
  const result = new Map<string, LiffAction>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if ((['uri', 'linkUri', 'actionUrl'].includes(key) || (key === 'value' && (item as Record<string, unknown>).actionType === 'uri')) && typeof child === 'string') {
        const action = hqLiffActionFromLocator(child) ?? liffActionFromUrl(child);
        if (action) result.set(child, action);
        else if (child.startsWith('https://hq.invalid/')) throw new Error('INVALID_LIFF_ACTION_LOCATOR');
      } else if (['messageContent', 'payload_json'].includes(key) && typeof child === 'string') {
        try { visit(JSON.parse(child)); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      } else visit(child);
    }
  };
  visit(value);
  return result;
}

/** リンク欄だけ置き換え、同じURLが本文・ラベルにあっても残す。 */
export function replaceLiffActionLocators<T>(value: T, targets: Readonly<Record<string, string>>): T {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if ((['uri', 'linkUri', 'actionUrl'].includes(key) || (key === 'value' && (item as Record<string, unknown>).actionType === 'uri')) && typeof child === 'string') {
        return [key, targets[child] ?? child];
      }
      if (key === 'messageContent' && typeof child === 'string') {
        try { return [key, JSON.stringify(visit(JSON.parse(child)))]; }
        catch { return [key, child]; }
      }
      return [key, visit(child)];
    }));
  };
  return visit(value) as T;
}
