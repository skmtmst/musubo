import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENU_SECTIONS } from '@/lib/menu';

/** V8の部品の正本の並びと、承認済み追加項目・行き先を守る。
 * 2026-10-11 司令塔: 予約はコンテンツの直後。N-411の権限は別の動きの試験で守る。
 */

const SIDEBAR = join(dirname(fileURLToPath(import.meta.url)), 'sidebar.tsx');
/**
 * 項目そのものは `src/lib/menu.ts` に置いてある。サイドバーと機能設定が
 * 同じ一覧を読むようにしたので、区分と項目はそちらを見る。
 */
const MENU = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'menu.ts');
const MENU_START = 'export const MENU_SECTIONS: MenuSection[] = [';
const MENU_END = '/** 区分の目印から中身を引く。 */';

/** Pencil V8の並びと、承認済み追加機能を含めた区分と項目。 */
const DESIGN: Array<{ section: string | null; items: string[] }> = [
  // 毎日開く4項目は、先頭の「メイン」区分にまとめる。
  { section: 'メイン', items: ['ダッシュボード', '受信箱', '友だち', 'タグ'] },
  {
    section: '配信',
    items: [
      'シナリオ配信',
      '一斉配信',
      'リマインダ',
      '自動応答',
      '友だち追加時',
      'ウェビナー',
    ],
  },
  // テンプレート・リッチメニュー・回答フォームは「作って置いておくもの」。
  // 配信や分析ではなく、ここにまとまる。
  // 「コンテンツ」1項目に画像と共通情報のタブを詰めていたが、Lステップは
  // コンテンツ区分の下に「共通情報」「登録メディア一覧」の2項目を並べる。
  // 同じ画面の中で切り替えるより、サイドバーから直接行けるほうが近い。
  {
    section: 'コンテンツ',
    items: ['テンプレート', 'リッチメニュー', '回答フォーム', '共通情報', '登録メディア一覧'],
  },
  // 2026-10-03（N-411 #866）: 「自分の勤務」は staff 専用。予約スタッフと
  // 紐づいたログインユーザーのシフト・休憩・外部連携の入口。
  // 2026-10-07（提案 E-7・オーナー）: 来店スタンプは飲食店もサロンも使うので「予約」の組に足す。
  { section: '予約', items: ['予約管理', '予約設定', 'イベント予約', '来店スタンプ', '自分の勤務'] },
  {
    section: '成果と分析',
    items: ['成果とアフィリエイト', 'マイル', '流入と計測', 'コンバージョン', '分析'],
  },
  { section: '自動化', items: ['オートメーション', '外部連携'] },
  // 2026-09-16（Masato の決定）: 専用機能は「会員／投稿／NEN配信」。写真審査は「投稿」に改名。
  // EC連携は「ECとLINEをつなぐ配管の点検口」なので「設定」へ移した。
  // 2026-09-16 採用（★管理画面 37-3／37-4）: 会員の次に「マイペット」「健康日記」。
  { section: '専用機能', items: ['会員', 'マイペット', '健康日記', '投稿', 'NEN配信'] },
  // D-3: 店舗の追加・設定・一覧は統括へ集約し、店舗側の重複導線を戻さない。
  // LINEアカウントの横断管理は統括側に置き、店舗の設定には出さない。
  { section: '設定', items: ['はじめの設定', 'プール管理', 'ユーザー管理', '機能設定', '営業時間', '運用状態', 'EC連携'] },
  {
    section: '飲食店向け（テスト）',
    items: [
      '予約台帳', '座席・卓管理',
      '予約枠・在庫', 'メニュー管理', 'デリバリー受注', 'Googleビジネス', 'LINE来店フォロー',
    ],
  },
];

/** menu.ts の MENU_SECTIONS から、区分と項目を順序どおりに読む。 */
function readSidebar(): Array<{ section: string | null; items: string[] }> {
  return MENU_SECTIONS.map(section => ({ section: section.label, items: section.items.map(item => item.label) }));
}

/** 仕様 §2 の「項目 → ルート」。写真審査だけ仕様書の誤りを直してある。 */
const ROUTES: Record<string, string> = {
  ダッシュボード: '/',
  受信箱: '/chats',
  友だち: '/friends',
  タグ: '/tags',
  シナリオ配信: '/scenarios',
  一斉配信: '/broadcasts',
  テンプレート: '/templates',
  リマインダ: '/reminders',
  自動応答: '/auto-replies',
  友だち追加時: '/friend-add-settings',
  リッチメニュー: '/rich-menus',
  ウェビナー: '/webinars',
  共通情報: '/contents/vars',
  登録メディア一覧: '/contents',
  成果とアフィリエイト: '/affiliates?tab=affiliates',
  回答フォーム: '/form-submissions',
  マイル: '/mileage',
  流入と計測: '/inflow-links',
  コンバージョン: '/affiliates?tab=points',
  分析: '/analytics',
  オートメーション: '/automations',
  外部連携: '/webhooks',
  予約管理: '/booking/bookings',
  予約設定: '/booking/menus',
  イベント予約: '/events',
  来店スタンプ: '/visit-stamps',
  自分の勤務: '/booking/staff/shifts',
  会員: '/nen/members',
  マイペット: '/nen/pets',
  健康日記: '/nen/health',
  NEN配信: '/nen-campaigns',
  // 仕様書 §2 は /health と書いているが、/health は「BAN検知ダッシュボード」。
  // 写真審査（いまの名前は「投稿」）の画面は /nen-members。§3-1 が BAN検知を「運用状態」へ
  // 統合すると書いているので、そちらに合わせている。
  投稿: '/nen-members',
  EC連携: '/ec-commerce',
  はじめの設定: '/getting-started',
  プール管理: '/pools',
  ユーザー管理: '/staff',
  機能設定: '/settings',
  営業時間: '/settings/google-hours',
  運用状態: '/emergency',
  予約台帳: '/restaurant-test/reservations',
  '座席・卓管理': '/restaurant-test/tables',
  '予約枠・在庫': '/restaurant-test/inventory',
  メニュー管理: '/restaurant-test/menu',
  デリバリー受注: '/restaurant-test/delivery',
  'Googleビジネス': '/restaurant-test/google',
  LINE来店フォロー: '/restaurant-test/line-followup',
};

describe('サイドバーが V8の共通メニューの契約と一致する', () => {
  const actual = readSidebar();

  it('区分の数と並びが設計どおり', () => {
    expect(actual.map((s) => s.section)).toEqual(DESIGN.map((s) => s.section));
  });

  it.each(DESIGN.map((s, i) => [s.section ?? '(見出しなし)', i] as const))(
    '区分「%s」の項目と並びが設計どおり',
    (_label, index) => {
      expect(actual[index]?.items).toEqual(DESIGN[index].items);
    },
  );

  it('項目の総数が設計どおり（46）', () => {
    // 設計に無いものを足すと、ここで気づける。
    // 統括一覧を独立した /hq へ移し、店舗側は飲食店向け9項目を維持する。
    // 2026-09-04: 「設定」区分の先頭に「はじめの設定」（要件 管理画面-34 §5-2）と
    // 「LINEアカウント」（要件 管理画面-33 §5-3）を足して 43。
    // 2026-09-16: 専用機能に「会員」（★管理画面 37-1）を足して 44。
    // 2026-09-21: 「設定」に「プール管理」（multi_store_hierarchy の受け口、#860）を足して 45。
    // 2026-10-03: 「予約」に staff 専用の「自分の勤務」（N-411 #866）を足して 46。
    // 2026-09-16 採用: 「マイペット」「健康日記」（★管理画面 37-3／37-4）を足して 48。
    const total = actual.reduce((sum, s) => sum + s.items.length, 0);
    // 2026-10-07 提案 E-7: 「予約」の組に「来店スタンプ」を足して 49。
    // 2026-10-09 承認（デリバリー受注_v02.pen）: 「飲食店向け（テスト）」に
    // 「デリバリー受注」を足して 50。その後 LINE通知を共通設定から隠して 49。
    // 重複する店舗ダッシュボード・組織と権限・承認の流れを外し、横断管理を統括へ集約して 45。
    expect(total).toBe(46);
  });

  it('項目の行き先が仕様どおり', () => {
    const actual = Object.fromEntries(MENU_SECTIONS.flatMap(section => section.items.map(item => [item.label, item.href])));
    expect(actual).toEqual(ROUTES);
  });

  it('同じ画面を2か所から出していない', () => {
    // 同じ行き先が2つの区分にあると、いまどこにいるのかが分からなくなる。
    const source = readFileSync(MENU, 'utf8');
    const body = source.slice(source.indexOf(MENU_START), source.indexOf(MENU_END));
    const hrefs = [...body.matchAll(/\{\s*href:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(hrefs.length).toBe(new Set(hrefs).size);
  });
});

describe('レスポンシブのメニュー名を維持する', () => {
  const source = readFileSync(SIDEBAR, 'utf8');

  it('ドロワーと常時表示で同じ中身を出す', () => {
    // 別のマークアップを2つ持つと、片方だけ直す事故が起きる。
    expect(source).toContain('{sidebarContent(true)}');
    expect(source).toContain('{sidebarContent(false)}');
  });

  it('どの幅でも区分名・項目名・件数を隠さない', () => {
    /*
     * もとは「展開しているときだけ名前を出す」書き方（expanded ? ... :
     * 'hidden xl:...'）が残っていることを見ていた。64px のアイコンレールが
     * あり、その幅では名前を隠す必要があったため。
     *
     * レールをやめて 1280px 未満はドロワーだけにしたので、隠す幅が無くなった。
     * 書き方ではなく「隠していないこと」を見る。ここに 'hidden xl:inline' が
     * 戻ってきたら、また名前の読めない幅ができたということ。
     */
    expect(source).not.toContain("'hidden xl:inline'");
    expect(source).not.toContain("'hidden xl:block'");
    expect(source).not.toContain("'hidden xl:inline-flex'");
  });

  it('アイコンだけの帯を作らない', () => {
    // w-16 の常時表示は、絵しか出ない帯。何の項目かを覚えている人しか使えない。
    expect(source).not.toContain('w-16 xl:w-64');
  });

  it('ドロワーに管理メニューの見出しがある', () => {
    expect(source).toContain('管理メニュー');
    expect(source).toContain('aria-label="管理メニュー"');
  });

  it('先頭は会社名とバージョン。アカウント切替はトップバーへ移した', () => {
    // 2026-08-26 にアカウント切替・名前・権限・ログアウトをトップバーへ移した。
    // ここに残すと二重に出る（`docs/v8-design-rules.md` §5）。
    expect(source).toContain('SidebarIdentity');
    expect(source).not.toContain('AccountSwitcher');
    expect(source).not.toContain('countryFlag');
  });

  it('下端に名前・権限・ログアウトを置かない', () => {
    // コメントには残るので、実際に描く要素と処理で見る。
    // `lh_staff_role` はメニューの出し分けに要るので、ここでは見ない。
    expect(source).not.toContain('<span>ログアウト</span>');
    expect(source).not.toContain('auth/logout');
    expect(source).not.toContain('clearAdminSession');
  });

  it('PCの先頭はV5どおりLINEアカウント切替から始まる', () => {
    expect(source).toContain('null');
    expect(source).not.toContain('PCの先頭はアカウント切替ではなく');
  });
});

/*
 * V8 殻合わせ（絵 zUg8S・Yw24X）：左メニューの1行は 36px（上下の余白
 * なし・真ん中寄せ）で押しやすくする。組の中の間は 2px。
 * 畳んだ形は別の指定（40px）のまま。低い画面は nav だけ縦に送る。
 */
describe('V8 左メニューの1行は36px（殻合わせ）', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sidebar.module.css'), 'utf8');

  it('.item は高さ36・上下余白0（V8）', () => {
    expect(css).toMatch(/:root \.item \{[^}]*height:\s*36px/s);
    expect(css).toMatch(/:root \.item \{[^}]*padding-top:\s*0/s);
    expect(css).toMatch(/:root \.item \{[^}]*padding-bottom:\s*0/s);
  });

  it('.section の間は 2px（V8）', () => {
    expect(css).toMatch(/:root \.section \{[^}]*gap:\s*2px/s);
  });

  it('畳んだ形は40pxのまま・低い画面は nav だけ縦に送る', () => {
    expect(css).toMatch(/:root \.desktop\[data-collapsed\] \.item \{[^}]*height:\s*40px/s);
    expect(css).toMatch(/\.nav \{[^}]*overflow-y:\s*auto/s);
  });
});
