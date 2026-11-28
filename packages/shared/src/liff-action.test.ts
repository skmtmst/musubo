import { describe, expect, it } from 'vitest';
import { collectLiffActionLocators, hqLiffActionFromLocator, hqLiffActionLocator, liffActionFromUrl, liffActionUrl, replaceLiffActionLocators, restaurantMenuLiffToken, restaurantMenuLiffUrl, type LiffAction } from './liff-action.js';
import { composeHqMessageCard, parseHqMessageCard } from './hq-message-card.js';
import { convertBroadcastAsset, validateAssetPayload } from './broadcast-asset-conversion.js';

export const actions: LiffAction[] = [
  { kind: 'booking' }, { kind: 'booking', menuId: 'menu-1' }, { kind: 'booking_history' },
  { kind: 'form', formId: 'form-1' }, { kind: 'visit_stamp' }, { kind: 'visit_stamp', cardId: 'card-1' },
];
describe('押したらの共通URL', () => {
  it('料理メニューのURLは有効なLIFFと店舗トークンだけを読み戻し、統括の配布用リンクにはしない', () => {
    const url = restaurantMenuLiffUrl({ liffId: 'shop-liff', token: 'store-1' });
    expect(url).toBe('https://liff.line.me/shop-liff/?page=restaurant-menu&token=store-1');
    expect(restaurantMenuLiffToken(url, 'shop-liff')).toBe('store-1');
    expect(restaurantMenuLiffToken(url, 'other')).toBeNull();
    expect(restaurantMenuLiffToken(url.replace('liff.line.me', 'unrelated.test'))).toBeNull();
    expect(restaurantMenuLiffToken(url.replace('store-1', 'invalid%26token'))).toBeNull();
    expect(liffActionFromUrl(url)).toBeNull();
  });

  it('管理画面の選択途中のフォームだけ空IDを許し、送信用の既定では拒否する', () => {
    const draft = liffActionUrl({ liffId: 'store', kind: 'form', formId: '', allowEmptyForm: true });
    expect(liffActionFromUrl(draft, { allowEmptyForm: true })).toEqual({ kind: 'form', formId: '' });
    expect(liffActionFromUrl(draft)).toBeNull();
    expect(() => liffActionUrl({ liffId: 'store', kind: 'form', formId: '' })).toThrow();
  });
  it.each(['menu_id=menu-1', 'menu=menu-1', 'menu_id=menu-1&menu=old', 'menuId=menu-1'])('予約メニューの旧URLも読み、menu_idを優先する: %s', query => {
    expect(liffActionFromUrl(`https://liff.line.me/store/?page=salon-book&${query}`)).toEqual({ kind: 'booking', menuId: 'menu-1' });
  });
  it.each(actions)('作成・読み戻し・統括の仮URL: %j', action => {
    const url = liffActionUrl({ liffId: '1234-abc', ...action });
    expect(liffActionFromUrl(url)).toEqual(action);
    expect(hqLiffActionFromLocator(hqLiffActionLocator(action))).toEqual(action);
  });
  it('回答フォームは直接開く形で作り、旧2形式も読む', () => {
    expect(liffActionUrl({ liffId: 'id', kind: 'form', formId: 'f' })).toBe('https://liff.line.me/id/?page=form&id=f');
    for (const url of ['https://liff.line.me/id?form=f', 'https://liff.line.me/id/?page=form&id=f']) expect(liffActionFromUrl(url)).toEqual({ kind: 'form', formId: 'f' });
    expect(hqLiffActionFromLocator('https://hq.invalid/form/f')).toEqual({ kind: 'form', formId: 'f' });
  });
  it.each(['https://example.com/?page=form&id=f', 'http://liff.line.me/id?page=salon-book', 'https://liff.line.me.evil/id?page=salon-book', 'https://liff.line.me/id/?page=form', 'https://liff.line.me/id/extra?page=salon-book', 'https://u:p@liff.line.me/id?page=salon-book', 'https://liff.line.me/id?page=form&id=a%26b'])('外部・不完全なURLは分類しない: %s', url => expect(liffActionFromUrl(url)).toBeNull());
  it('LIFF未設定と不正な選択先でURLを作らない', () => {
    expect(() => liffActionUrl({ liffId: '', kind: 'booking' })).toThrow();
    expect(() => liffActionUrl({ liffId: 'id', kind: 'booking', menuId: 'm&admin=1' })).toThrow();
    expect(() => liffActionUrl({ liffId: 'id', kind: 'form', formId: '' })).toThrow();
  });
  it('URI欄だけ置き換え、本文やメッセージはそのまま', () => {
    const uri = hqLiffActionLocator({ kind: 'booking' });
    const value = { messageContent: JSON.stringify({ body: { text: uri }, action: { type: 'uri', uri }, message: { type: 'message', text: uri } }) };
    expect([...collectLiffActionLocators(value)]).toEqual([[uri, { kind: 'booking' }]]);
    const result = JSON.parse(replaceLiffActionLocators(value, { [uri]: 'https://liff.line.me/store/?page=salon-book' }).messageContent);
    expect(result.action.uri).toContain('/store/');
    expect(result.body.text).toBe(uri); expect(result.message.text).toBe(uri);
  });
});

const buttons = [
  { action: 'url' as const, value: 'https://example.com' }, { action: 'message' as const, value: '予約したい' },
  { action: 'booking' as const, value: 'menu-1' }, { action: 'form' as const, value: 'form-1' },
  { action: 'booking_history' as const, value: '' }, { action: 'visit_stamp' as const, value: 'card-1' },
];
it.each(buttons)('統括カードは6つを保存しLINE用に組み立てる: %j', button => {
  const card = parseHqMessageCard({ format: 'flex', title: '案内', body: '本文', buttons: [{ id: 'one', label: '開く', ...button }] });
  const result = JSON.parse(composeHqMessageCard(card, 'id').messageContent).footer.contents[0].action;
  expect(result.type).toBe(button.action === 'message' ? 'message' : 'uri');
  if (!['url', 'message'].includes(button.action)) expect(hqLiffActionFromLocator(result.uri)?.kind).toBe(button.action);
});

it.each(['https://example.com', ...actions.map(action => liffActionUrl({ liffId: 'store', ...action }))])('リッチメッセージはURL・LIFFを保存し送信できる: %s', uri => {
  const payload = { imageUrl: 'https://example.com/image', baseUrl: 'https://example.com/map', baseSize: { width: 1040, height: 1040 }, tapAreas: [{ x: 0, y: 0, width: 100, height: 100, actionType: 'uri', uri }] };
  expect(validateAssetPayload('rich_message', payload)).toBeNull();
  const converted = convertBroadcastAsset('rich_message', '案内', payload);
  expect(converted.ok).toBe(true);
  if (converted.ok) expect(JSON.parse(converted.message.messageContent).actions[0]).toMatchObject({ type: 'uri', linkUri: uri });
});
it('リッチメッセージのmessageは通り、postbackは保存・送信とも拒否する', () => {
  const payload = { imageUrl: 'https://example.com/image', baseUrl: 'https://example.com/map', baseSize: { width: 1040, height: 1040 }, tapAreas: [{ x: 0, y: 0, width: 100, height: 100, actionType: 'message', text: '予約したい' }] };
  expect(validateAssetPayload('rich_message', payload)).toBeNull();
  expect(convertBroadcastAsset('rich_message', '案内', payload).ok).toBe(true);
  const invalid = { ...payload, tapAreas: [{ ...payload.tapAreas[0], actionType: 'postback', data: 'action' }] };
  expect(validateAssetPayload('rich_message', invalid)).toContain('postback');
  expect(convertBroadcastAsset('rich_message', '案内', invalid)).toMatchObject({ ok: false, error: expect.stringContaining('postback') });
});

it.each(['https://example.com', ...actions.map(action => liffActionUrl({ liffId: 'store', ...action }))])('カルーセル素材もURL・LIFFの動きを保存して送る: %s', actionUrl => {
  const payload = { cards: [{ title: '案内', description: '本文', actionUrl }] };
  expect(validateAssetPayload('card_message', payload)).toBeNull();
  const result = convertBroadcastAsset('card_message', '案内', payload);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(result.message.messageContent)[0].actions[0]).toMatchObject({ type: 'uri', uri: actionUrl });
});
it('カルーセル素材は短い文章を送れる', () => {
  const payload = { cards: [{ title: '案内', description: '本文', actionType: 'message', actionText: '予約したい' }] };
  expect(validateAssetPayload('card_message', payload)).toBeNull();
  const result = convertBroadcastAsset('card_message', '案内', payload);
  expect(result.ok).toBe(true);
  if (result.ok) expect(JSON.parse(result.message.messageContent)[0].actions[0]).toMatchObject({ type: 'message', text: '予約したい' });
  expect(convertBroadcastAsset('card_message', '案内', { cards: [{ ...payload.cards[0], actionText: 'x'.repeat(301) }] }).ok).toBe(false);
});
