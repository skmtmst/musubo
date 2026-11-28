import { escapeHtml } from '../lib/html-escape.js';
/** LIFF の共通入口でログイン・UUID 発行・友だち確認を済ませてから各画面へ渡す。ref は流入元、redirect は結び付け後の移動先、page は予約・フォーム・アフィリエイト・ウェビナー・会員画面を選ぶ。 */

import { initBooking } from './booking.js';
import {applyCustomerLook} from './customer-look.js';
import { initForm } from './form.js';
import { safeRedirectTarget, attributedRedirectTarget } from '../lib/safe-redirect.js';
import { restoreLiffStateInCurrentUrl } from './liff-query.js';
import { customerMessage } from './customer-message.js';

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string; statusMessage?: string }>;
  getIDToken(): string | null;
  getAccessToken(): string | null;
  getDecodedIDToken(): { sub: string; name?: string; email?: string; picture?: string } | null;
  getFriendship(): Promise<{ friendFlag: boolean }>;
  isInClient(): boolean;
  closeWindow(): void;
  logout(): void;
};

// LINE はクエリを liff.state に入れるため、経路や LIFF ID を判定する前に window.location.search へ戻す。
restoreLiffStateInCurrentUrl();

// 接続先を正しく選ぶため、URL の liffId を環境変数より優先する。
function detectLiffId(): string {
  const fromParam = new URLSearchParams(window.location.search).get('liffId');
  if (fromParam) return fromParam;
  return import.meta.env?.VITE_LIFF_ID || '';
}
const LIFF_ID = detectLiffId();
if (!LIFF_ID) {
  throw new Error('LIFF ID not found. Set ?liffId= in LIFF endpoint URL or VITE_LIFF_ID env.');
}
const UUID_STORAGE_KEY = 'lh_uuid';
// 複数アカウントに対応するため、Bot の基本 ID は liff.init 後に API から解決する。
let BOT_BASIC_ID = '';
let signedRedirectTarget: string | null = null;

function apiCall(path: string, options?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function getPage(): string | null {
  const path = window.location.pathname.replace(/^\/+/, '');
  if (path === 'book') return 'book';
  if (path === 'booking' || path === 'booking/history') return 'salon-book';
  if (/^restaurant\/reserve\/[^/]+$/.test(path)) return 'restaurant';
  if (path === 'restaurant/menu') return 'restaurant-menu';
  const params = new URLSearchParams(window.location.search);
  return params.get('page');
}

function getRedirectUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  // 直接作られた LIFF URL はサーバーのコールバックを通らないため、クライアントでも移動先を検査し、任意サイトへの転送や javascript: を防ぐ。
  return safeRedirectTarget(params.get('redirect'), window.location.origin) || signedRedirectTarget;
}

function getRef(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('ref');
}

function getSavedUuid(): string | null {
  try {
    return localStorage.getItem(UUID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveUuid(uuid: string): void {
  try {
    localStorage.setItem(UUID_STORAGE_KEY, uuid);
  } catch {
    // silent fail
  }
}



// ─── UI States ──────────────────────────────────────────

function showFriendAdd(profile: { displayName: string; pictureUrl?: string }) {
  const returnUrl = window.location.href;
  const container = document.getElementById('app')!;
  const friendAddUrl = BOT_BASIC_ID
    ? `https://line.me/R/ti/p/${BOT_BASIC_ID}`
    : '#';

  container.innerHTML = `
    <div class="card">
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">まずは友だち追加をお願いします</p>
      <a href="${friendAddUrl}" class="add-friend-btn" id="addFriendBtn">
        友だち追加して始める
      </a>
      <p class="sub-message">追加後、この画面に戻ってきてください</p>
    </div>
  `;

  // 友だち追加後に戻ってきたら自動で再チェック
  // 一度発火したら listener を外して、ユーザーが LIFF をフォアグラウンド復帰するたびに
  // 送信後のアプリ切り替えで再発火しても、同じ push を二度実行しない。
  let formLinkSent = false;
  let checking = false;
  const onVisibilityChange = async () => {
    if (document.visibilityState !== 'visible' || checking) return;
    checking = true;
    try {
      const { friendFlag } = await liff.getFriendship();
      if (!friendFlag) return;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // 入口と引数を追加前のまま戻す。各画面の読み出しは通常の入口に任せる。
      window.history.replaceState(window.history.state, '', returnUrl);

      // 初回の友だち追加前は行が存在しない場合があるため、友だち確認後にも結び付けを試し、ref/ig/iga/igan の帰属を保存する。
      try {
        const idToken = liff.getIDToken();
        if (idToken) {
          const fp = await liff.getProfile();
          const params = new URLSearchParams(window.location.search);
          const res = await apiCall('/api/liff/link', {
            method: 'POST',
            body: JSON.stringify({
              idToken,
              displayName: fp.displayName,
              existingUuid: getSavedUuid(),
              ref: getRef() || undefined,
              ig: params.get('ig') || undefined,
              iga: params.get('iga') || undefined,
              igan: params.get('igan') || undefined,
              crossAccountToken: params.get('crossAccountToken') || undefined,
            }),
          });
          if (res.ok) {
            const data = await res.json() as { success: boolean; data?: { userId?: string } };
            if (data?.data?.userId) saveUuid(data.data.userId);
          }
        }
      } catch { /* best-effort */ }

      // 友だち追加を挟んでもフォーム案内を失わないよう、form 指定を引き継ぐ。
      const formParam = new URLSearchParams(window.location.search).get('form');
      if (formParam && !formLinkSent) {
        formLinkSent = true;
        try {
          const fp = await liff.getProfile();
          const idToken = liff.getIDToken();
          const params = new URLSearchParams(window.location.search);
          await apiCall('/api/liff/send-form-link', {
            method: 'POST',
            body: JSON.stringify({
              lineUserId: fp.userId,
              formId: formParam,
              idToken: idToken || '',
              ref: params.get('ref') || '',
              gate: params.get('gate') || '',
              xh: params.get('xh') || '',
              ig: params.get('ig') || '',
              iga: params.get('iga') || '',
              igan: params.get('igan') || '',
            }),
          });
        } catch { /* best-effort */ }
      }
      if (getPage() || new URLSearchParams(window.location.search).get('couponRef')) await openPage();
      else showCompletion(profile, false);
    } catch (err) {
      showError(customerMessage(err, '画面を開けませんでした。LINE から、もう一度開いてください。'));
    } finally {
      checking = false;
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function showCompletion(profile: { displayName: string; pictureUrl?: string }, isRecovery: boolean) {
  const container = document.getElementById('app')!;
  const ref = getRef();
  container.innerHTML = `
    <div class="card">
      <div class="check-icon">${isRecovery ? '🔄' : '✓'}</div>
      <h2>${isRecovery ? 'おかえりなさい！' : '登録完了！'}</h2>
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">
        ${isRecovery
          ? '以前のアカウント情報を引き継ぎました。'
          : 'ありがとうございます！これからお役立ち情報をお届けします。'
        }
        <br>このページは閉じて大丈夫です。
      </p>
      ${ref ? `<p class="ref-badge">${escapeHtml(ref)}</p>` : ''}
    </div>
  `;

  // 2秒後にトーク画面に遷移（BOT_BASIC_ID が設定されている場合のみ）
  if (BOT_BASIC_ID) {
    setTimeout(() => {
      window.location.href = `https://line.me/R/oaMessage/${BOT_BASIC_ID}/`;
    }, 2000);
  }
}

function showError(message: string) {
  const container = document.getElementById('app')!;
  container.innerHTML = `
    <div class="card">
      <h2>エラー</h2>
      <p class="error">${escapeHtml(message)}</p>
    </div>
  `;
}

// ─── Core Flow ──────────────────────────────────────────

async function linkAndAddFlow() {
  const redirectUrl = getRedirectUrl();
  const ref = getRef();

  try {
    const existingUuid = getSavedUuid();


    const [profile, rawIdToken, friendship] = await Promise.all([
      liff.getProfile(),
      Promise.resolve(liff.getIDToken()),
      liff.getFriendship(),
    ]);

    // 1. UUID linking (always, regardless of friendship)
    const linkParams = new URLSearchParams(window.location.search);
    const linkPromise = apiCall('/api/liff/link', {
      method: 'POST',
      body: JSON.stringify({
        idToken: rawIdToken,
        displayName: profile.displayName,
        existingUuid: existingUuid,
        ref: ref,
        ig: linkParams.get('ig') || '',
        iga: linkParams.get('iga') || '',
        igan: linkParams.get('igan') || '',
      }),
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) {
          saveUuid(data.data.userId);
        }
      }
      return res;
    }).catch(() => {
      // Silent fail — UUID linking is best-effort
    });


    if (ref) {
      apiCall('/api/affiliates/click', {
        method: 'POST',
        body: JSON.stringify({ code: ref, url: window.location.href }),
      }).catch(() => {});
    }


    if (redirectUrl) {
      await Promise.race([
        linkPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      let identityToken = '';
      const target = new URL(redirectUrl, window.location.origin);
      if (target.origin === window.location.origin && target.pathname.startsWith('/t/') && rawIdToken) {
        try {
          const response = await apiCall('/api/liff/tracked-link-identity', {
            method: 'POST', body: JSON.stringify({ linkId: decodeURIComponent(target.pathname.slice(3)), idToken: rawIdToken }),
          });
          const result = await response.json() as { data?: { token?: string } };
          if (response.ok) identityToken = result.data?.token || '';
        } catch { /* 本人を確認できなくても匿名でリンク先を開く。 */ }
      }
      window.location.href = attributedRedirectTarget(redirectUrl, window.location.origin, identityToken);
      return;
    }

    // 結び付けの完了前に後続処理を始めない。
    await linkPromise;


    if (!friendship.friendFlag) {

      showFriendAdd(profile);
    } else {

      const formParam = new URLSearchParams(window.location.search).get('form');
      if (formParam) {

        try {
          const idToken = liff.getIDToken();
          const params = new URLSearchParams(window.location.search);
          await apiCall('/api/liff/send-form-link', {
            method: 'POST',
            body: JSON.stringify({
              lineUserId: profile.userId,
              formId: formParam,
              idToken: idToken || '',
              ref: ref || '',
              gate: params.get('gate') || '',
              xh: params.get('xh') || '',
              ig: params.get('ig') || '',
              iga: params.get('iga') || '',
              igan: params.get('igan') || '',
            }),
          });
        } catch { /* best-effort */ }
        showCompletion(profile, !!existingUuid);
      } else {
        showCompletion(profile, !!existingUuid);
      }
    }

  } catch (err) {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    } else {
      showError(customerMessage(err, 'うまくいきませんでした。時間をおいて、もう一度お試しください。'));
    }
  }
}

// ─── Salon Booking (React, dynamic-imported) ─────────────

export async function initRestaurantForm(): Promise<void> { await initSalonBooking('form'); }

async function initSalonBooking(page: 'salon-book' | 'visit-stamps' | 'entry-coupon' | 'restaurant' | 'restaurant-menu' | 'form' = 'salon-book'): Promise<void> {
  // 既存 linkAndAddFlow と同じ初期化シーケンスを踏む:
  //   ① profile + idToken + friendFlag を並列取得
  //   ② /api/liff/link で UUID 確定 (ref/ig 含む) — booking エンドポイントが
  //      id_token verify で friend を引くために friends 行が必要
  //   ③ ref があれば /api/affiliates/click で流入計測
  //   ④ 未友達なら showFriendAdd (friend-add gate)。友達追加後に同じ URL に
  //      戻ってくれば再度ここを通って React mount に進む
  //   ⑤ 友達なら React チャンクを動的 import して mount
  const [profile, idToken, friendship] = await Promise.all([
    liff.getProfile(),
    Promise.resolve(liff.getIDToken()),
    liff.getFriendship(),
  ]);
  if (!idToken) {
    showError('LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。');
    return;
  }

  const existingUuid = getSavedUuid();
  const ref = getRef();
  const bookingParams = new URLSearchParams(window.location.search);
  const ig = bookingParams.get('ig');
  const iga = bookingParams.get('iga');
  const igan = bookingParams.get('igan');

  // ② Silent UUID linking (fire-and-forget; booking API は id_token verify で
  //    認証するので待つ必要はない)。
  const linked = apiCall('/api/liff/link', {
    method: 'POST',
    body: JSON.stringify({
      idToken,
      displayName: profile.displayName,
      existingUuid,
      ref: ref || undefined,
      ig: ig || undefined,
      iga: iga || undefined,
      igan: igan || undefined,
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) saveUuid(data.data.userId);
      }
      return res.ok;
    })
    .catch(() => false);

  // ③ Affiliate click 計測 (linkAndAddFlow と同等)。
  if (ref) {
    apiCall('/api/affiliates/click', {
      method: 'POST',
      body: JSON.stringify({ code: ref, url: window.location.href }),
    }).catch(() => {
      /* silent */
    });
  }

  // ④ 未友達なら friend-add UI に流す。booking API は friends.is_following = 1
  //    を要求するので、ここを skip すると最終的に cannot_book / friend_not_found
  //    で詰む。
  if (!friendship.friendFlag) {
    showFriendAdd(profile);
    return;
  }

  // ⑤ React + Tailwind チャンクを動的 import → 既存 LIFF 利用者には load されない。
  const container = document.getElementById('app');
  if (!container) {
    showError('mount target #app が見つかりません');
    return;
  }
  if (page === 'restaurant' || page === 'restaurant-menu' || page === 'form') {
    if (!await linked) { showError('画面を開けませんでした。もう一度お試しください。'); return; }
    const { mountRestaurant } = await import('./restaurant/main.js');
    mountRestaurant(container,{liffId:LIFF_ID,lineUserId:profile.userId,idToken,sdk:liff},page);
    return;
  }
  if (page === 'entry-coupon') {
    if (!await linked) { showError('クーポンを開けませんでした。時間をおいて、もう一度開いてください。'); return; }
    const { mountEntryRouteCoupon } = await import('./entry-route-coupon/main.js');
    mountEntryRouteCoupon(container, { liffId: LIFF_ID, lineUserId: profile.userId, idToken });
    return;
  }
  if (page === 'visit-stamps') {
    if (!await linked) {
      showError('来店スタンプを開けませんでした。時間をおいて、もう一度開いてください。');
      return;
    }
    const { mountVisitStamps } = await import('./visit-stamps/main.js');
    mountVisitStamps(container, { liffId: LIFF_ID, lineUserId: profile.userId, idToken });
    return;
  }
  const { mountSalonBooking } = await import('./salon-booking/main.js');
  mountSalonBooking(container, {
    liffId: LIFF_ID,
    lineUserId: profile.userId,
    idToken,
    sdk: liff,
  });
}

// ─── Event Booking (React, dynamic-imported) ─────────────

async function initEventBooking(initialKind: 'detail' | 'history'): Promise<void> {
  // salon-booking と同じ初期化シーケンス: profile/idToken/friendship 取得、
  // 未友達なら friend-add gate、友達なら React mount。
  const [profile, idToken, friendship] = await Promise.all([
    liff.getProfile(),
    Promise.resolve(liff.getIDToken()),
    liff.getFriendship(),
  ]);
  if (!idToken) {
    showError('LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。');
    return;
  }

  const existingUuid = getSavedUuid();
  const ref = getRef();
  const eventParams = new URLSearchParams(window.location.search);

  // 結び付けの失敗だけでは画面表示を止めない。
  apiCall('/api/liff/link', {
    method: 'POST',
    body: JSON.stringify({
      idToken,
      displayName: profile.displayName,
      existingUuid,
      ref: ref || undefined,
      ig: eventParams.get('ig') || undefined,
      iga: eventParams.get('iga') || undefined,
      igan: eventParams.get('igan') || undefined,
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) saveUuid(data.data.userId);
      }
    })
    .catch(() => {
      /* silent */
    });

  if (!friendship.friendFlag) {
    showFriendAdd(profile);
    return;
  }

  const container = document.getElementById('app');
  if (!container) {
    showError('mount target #app が見つかりません');
    return;
  }
  const params = new URLSearchParams(window.location.search);
  const eventId = params.get('id') ?? '';
  if (initialKind === 'detail' && !eventId) {
    showError('id クエリパラメータが必要です（?page=event&id=<eventId>）');
    return;
  }
  const { mountEventBooking } = await import('./event-booking/main.js');
  const ctx = { liffId: LIFF_ID, lineUserId: profile.userId, idToken };
  const initial = initialKind === 'detail'
    ? { kind: 'detail' as const, eventId }
    : { kind: 'history' as const };
  mountEventBooking(container, ctx, initial);
}

// ─── Auto-webinar (React, dynamic-imported) ──────────────

async function initWebinar(): Promise<void> {
  // event-booking と同じ初期化シーケンス: profile/idToken/friendship 取得、
  // 未友達なら friend-add gate、友達なら React mount。
  const [profile, idToken, friendship] = await Promise.all([
    liff.getProfile(),
    Promise.resolve(liff.getIDToken()),
    liff.getFriendship(),
  ]);
  if (!idToken) {
    showError('LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。');
    return;
  }

  const existingUuid = getSavedUuid();
  const ref = getRef();
  const wbParams = new URLSearchParams(window.location.search);

  // UUID linking (best-effort) — 視聴 API は friends 行を要求するので、
  // 初見ユーザーでも friend-add gate 通過後に行が存在するようにする。
  apiCall('/api/liff/link', {
    method: 'POST',
    body: JSON.stringify({
      idToken,
      displayName: profile.displayName,
      existingUuid,
      ref: ref || undefined,
    }),
  })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) saveUuid(data.data.userId);
      }
    })
    .catch(() => {
      /* silent */
    });

  if (!friendship.friendFlag) {
    showFriendAdd(profile);
    return;
  }

  const container = document.getElementById('app');
  if (!container) {
    showError('mount target #app が見つかりません');
    return;
  }
  const slug = wbParams.get('slug') ?? '';
  if (!slug) {
    showError('slug クエリパラメータが必要です（?page=webinar&slug=<slug>）');
    return;
  }
  const { mountWebinar } = await import('./webinar/main.js');
  mountWebinar(container, { liffId: LIFF_ID, lineUserId: profile.userId, idToken }, slug);
}

async function initResearch(): Promise<void> {
  const [profile, friendship] = await Promise.all([liff.getProfile(), liff.getFriendship()]);
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('LINE から、もう一度開いてください');
  if (!friendship.friendFlag) { showFriendAdd(profile); return; }
  const linked = await apiCall('/api/liff/link', { method: 'POST', body: JSON.stringify({ idToken, displayName: profile.displayName, existingUuid: getSavedUuid(), ref: getRef() || undefined }) });
  if (!linked.ok) throw new Error('LINE から、もう一度開いてください');
  const container = document.getElementById('app');
  const researchId = new URLSearchParams(window.location.search).get('researchId');
  if (!container || !researchId) throw new Error('回答画面が見つかりませんでした');
  const { mountResearch } = await import('../../../liff/src/research-entry.js');
  await mountResearch(container, { liffId: LIFF_ID, lineUserId: profile.userId, idToken }, researchId);
}

// ─── Affiliate self-serve (React, dynamic-imported) ──────

async function initAffiliate(): Promise<void> {
  // salon-booking と同じ初期化シーケンス: profile/accessToken/friendship を
  // 取得し、未友達なら friend-add gate、友達なら React mount。
  //
  // booking 系は id_token で verify するが、affiliate API は LINE access token
  // (liff.getAccessToken) を /oauth2/v2.1/verify + /v2/profile で検証するため
  // ここでは accessToken を取り出して mount context に渡す。
  const [profile, accessToken, friendship] = await Promise.all([
    liff.getProfile(),
    Promise.resolve(liff.getAccessToken()),
    liff.getFriendship(),
  ]);
  if (!accessToken) {
    showError('LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。');
    return;
  }

  const existingUuid = getSavedUuid();
  const ref = getRef();
  const affParams = new URLSearchParams(window.location.search);

  const crossAccountToken = affParams.get('crossAccountToken');
  let confirmedCrossAccount = false;
  if (crossAccountToken && friendship.friendFlag) {
    try { confirmedCrossAccount = window.confirm('この公式アカウントと、先ほど開いたアカウントのお客さま情報・マイルを結び付けますか？'); } catch { /* Confirmation unavailable: keep identities separate. */ }
  }

  // Wallet取得より先にUUID連携を確定する。初回表示でここを待たないと、
  // 未登録アカウント用の署名付きリンクを生成できず、別財布になる余地がある。
  try {
    const res = await apiCall('/api/liff/link', {
      method: 'POST',
      body: JSON.stringify({
        idToken: liff.getIDToken(),
        displayName: profile.displayName,
        existingUuid,
        ref: ref || undefined,
        ig: affParams.get('ig') || undefined,
        iga: affParams.get('iga') || undefined,
        igan: affParams.get('igan') || undefined,
        crossAccountToken: confirmedCrossAccount ? crossAccountToken : undefined,
        confirmCrossAccountLink: confirmedCrossAccount || undefined,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { success: boolean; data?: { userId?: string } };
      if (data?.data?.userId) saveUuid(data.data.userId);
    }
  } catch {
    // 友だち追加前はfriends行がまだ無い場合がある。追加後の復帰処理で再試行する。
  }

  // 未友達なら friend-add UI に流す。affiliate API は friends 行 (=友だち) を
  // 要求するので、ここを skip すると /affiliate/me が friend_not_found で詰む。
  if (!friendship.friendFlag) {
    showFriendAdd(profile);
    return;
  }

  const container = document.getElementById('app');
  if (!container) {
    showError('mount target #app が見つかりません');
    return;
  }
  const { mountAffiliate } = await import('./affiliate/main.js');
  mountAffiliate(container, {
    liffId: LIFF_ID,
    lineUserId: profile.userId,
    lineAccessToken: accessToken,
    idToken: liff.getIDToken() ?? undefined,
  });
}

// ─── NEN member portal (React, dynamic-imported) ─────────

async function initNenMember(): Promise<void> {
  const [profile, idToken, friendship] = await Promise.all([
    liff.getProfile(), Promise.resolve(liff.getIDToken()), liff.getFriendship(),
  ]);
  if (!idToken) {
    showError('LINE 認証情報の取得に失敗しました。LINE アプリ内で再度開いてください。');
    return;
  }
  await apiCall('/api/liff/link', {
    method: 'POST',
    body: JSON.stringify({ idToken, displayName: profile.displayName, existingUuid: getSavedUuid() }),
  }).catch(() => undefined);
  if (!friendship.friendFlag) { showFriendAdd(profile); return; }
  const container = document.getElementById('app');
  if (!container) { showError('mount target #app が見つかりません'); return; }
  const { mountNenMember } = await import('./nen-member/main.js');
  mountNenMember(container, { liffId: LIFF_ID, lineUserId: profile.userId, idToken });
}

// ─── Entry Point ────────────────────────────────────────

// 外部ブラウザでは SDK が保存済みの id_token を返し続けるため、1時間の有効期限を超えたトークンを再認証する。LINE アプリ内では起動ごとに新しい値になる。
function isIdTokenStale(idToken: string | null): boolean {
  if (!idToken) return true;
  try {
    const payloadB64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(payloadB64)) as { exp?: number };
    // 処理中の失効も避けるため、期限まで60秒未満なら古いトークンと扱う。
    return typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

const RELOGIN_GUARD_KEY = 'lh_relogin_at';

function forceReloginForStaleToken(): boolean {
  if (liff.isInClient()) return false;
  if (!isIdTokenStale(liff.getIDToken())) return false;
  // 時計のずれやログイン取消で無限に再認証しないよう、直近1分で認証を往復していればそのまま進める。
  let lastAttempt = 0;
  try {
    lastAttempt = Number(sessionStorage.getItem(RELOGIN_GUARD_KEY) || 0);
  } catch { /* sessionStorage unavailable — still attempt a single redirect */ }
  if (Date.now() - lastAttempt < 60_000) return false;
  try {
    sessionStorage.setItem(RELOGIN_GUARD_KEY, String(Date.now()));
  } catch { /* ignore */ }
  try {
    liff.logout();
  } catch { /* ignore — login below still re-issues tokens */ }
  liff.login({ redirectUri: window.location.href });
  return true;
}

async function openPage(): Promise<void> {
    const page = getPage();
    if (new URLSearchParams(window.location.search).get('couponRef')) {
      await initSalonBooking('entry-coupon');
    } else if (page === 'book') {
      await initBooking();
    } else if (page === 'restaurant' || page === 'restaurant-menu') {
      await initSalonBooking(page);
    } else if (page === 'salon-book') {
      await initSalonBooking();
    } else if (page === 'visit-stamps') {
      await initSalonBooking('visit-stamps');
    } else if (page === 'event') {
      await initEventBooking('detail');
    } else if (page === 'event-me') {
      await initEventBooking('history');
    } else if (page === 'webinar') {
      await initWebinar();
    } else if (page === 'research') {
      await initResearch();
    } else if (page === 'affiliate') {
      await initAffiliate();
    } else if (page === 'nen-member') {
      await initNenMember();
    } else if (page === 'form') {
      await initForm(new URLSearchParams(window.location.search).get('id'), initRestaurantForm);
    } else if (!page) {
      await linkAndAddFlow();
    } else {
      await linkAndAddFlow();
    }
}

async function main() {
  try {
    await liff.init({ liffId: LIFF_ID });

    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return;
    }

    if (forceReloginForStaleToken()) return;

    // 複数アカウントに対応するため、Bot の基本 ID を API で解決する。
    applyCustomerLook(undefined);
    try {
      const redirectParams = new URLSearchParams(window.location.search);
      const configQuery = new URLSearchParams({ liffId: LIFF_ID, redirect: redirectParams.get('redirect') || '', redirectProof: redirectParams.get('redirectProof') || '' });
      const configRes = await fetch(`/api/liff/config?${configQuery}`);
      const configJson = await configRes.json() as { success: boolean; data?: { botBasicId?: string; customerLook?: unknown; redirectTarget?: string | null } };
      if (configJson.success && configJson.data?.customerLook) applyCustomerLook(configJson.data.customerLook);
      if (configJson.success) signedRedirectTarget = configJson.data?.redirectTarget || null;
      if (configJson.success && configJson.data?.botBasicId) {
        BOT_BASIC_ID = configJson.data.botBasicId;
      }
    } catch {
      // fallback: BOT_BASIC_ID remains empty, friend-add URL won't auto-redirect
    }

    await openPage();
  } catch (err) {
    showError(customerMessage(err, '画面を開けませんでした。LINE から、もう一度開いてください。'));
  }
}

main();
