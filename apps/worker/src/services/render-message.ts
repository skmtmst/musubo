/*
 * 一斉配信の本文の差し込みを置き換える。
 *
 * LINE 側の textV2.substitution はメンションと絵文字しか置き換えられない
 * ので、送る前にこちらで置き換えてから渡す。
 *
 * どの差し込みを置き換えられるか・どれが相手ごとに変わるかは
 * `@line-crm/shared` に置いてある。画面と同じものを見ないと、
 * 画面では入れられるのに配信時刻になって初めて弾かれる、という壊れ方をする。
 */
import {
  normalizeStoreInterpolations,
  findUnsupportedInterpolations,
  listInterpolations,
  needsPerRecipientDelivery,
} from '@line-crm/shared';
import { expandDateVariables } from './interpolation-date.js';

export function getBroadcastVariables(content: string): string[] {
  return listInterpolations(content);
}

export function getUnsupportedBroadcastVariables(content: string): string[] {
  return findUnsupportedInterpolations(content);
}

/** 1人ずつ送らないといけないか（相手ごとに変わる差し込みがあるか）。 */
export function hasRecipientVariables(content: string): boolean {
  return needsPerRecipientDelivery(content);
}

export interface BroadcastRenderContext {
  accountName?: string | null;
  liffId?: string | null;
  displayName?: string | null;
  /** 友だち情報欄。field_key => 値 */
  fields?: Record<string, string>;
  /** 共通情報。var_key => 値 */
  vars?: Record<string, string>;
  /** 配信日の起点。省略したら「いま」。 */
  deliveredAt?: Date;
}

export function renderMessageContent(
  content: string,
  liffIdOrContext: string | null | BroadcastRenderContext,
): string {
  const context: BroadcastRenderContext = typeof liffIdOrContext === 'object'
    ? liffIdOrContext ?? {}
    : { liffId: liffIdOrContext };

  /*
   * 日付を先に置き換える。
   *
   * 後にすると、友だち情報欄に入っていた値が偶然 `{{date}}` の形をして
   * いた場合に二重に置き換わる。利用者の入力値は差し込みとして再解釈しない。
   */
  let result = expandDateVariables(normalizeStoreInterpolations(content), context.deliveredAt ?? new Date());

  // 差し込み値を再び差し込みとして扱わない。店名・共通情報の文字はそのまま届ける。
  result = result.replace(/\{\{\s*(liff_id|name|account\.name|field\.[a-z][a-z0-9_]*|var\.[a-z][a-z0-9_]*)\s*\}\}/g, (original,key:string)=>{
    if(key==='liff_id')return context.liffId||original;
    if(key==='name')return context.displayName||original;
    if(key==='account.name')return context.accountName??original;
    if(key.startsWith('field.'))return context.fields?context.fields[key.slice(6)]??'':original;
    const value=context.vars?.[key.slice(4)];
    if(['var.store_phone','var.reservation_url'].includes(key)&&!value?.trim())return original;
    return context.vars?value??'':original;
  });

  return result;
}

function renderJsonValue(value: unknown, context: BroadcastRenderContext): unknown {
  if (typeof value === 'string') return renderMessageContent(value, context);
  if (Array.isArray(value)) return value.map((item) => renderJsonValue(item, context));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        renderMessageContent(key, context),
        renderJsonValue(item, context),
      ]),
    );
  }
  return value;
}

/** Flex は解析した文字列値を置換して再直列化し、引用符・バックスラッシュ・改行で JSON を壊さない。通常の文は指定した変数以外を変えない。 */
export function renderBroadcastMessageContent(
  messageType: string,
  content: string,
  context: BroadcastRenderContext,
): string {
  if (['flex','imagemap','rich_message','coupon','card_message','research'].includes(messageType)) {
    const parsed = JSON.parse(content) as unknown;
    return JSON.stringify(renderJsonValue(parsed, context));
  }
  // カルーセルも中身は JSON。名前の " で壊れて文字のまま届かないよう、同じく
  // 値ごとに置き換える。読めない中身は今までどおり文字として置き換える。
  if (messageType === 'carousel') {
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return renderMessageContent(content, context); }
    return JSON.stringify(renderJsonValue(parsed, context));
  }
  return renderMessageContent(content, context);
}

export function assertNoUnresolvedBroadcastVariables(content: string): void {
  const unresolved = getBroadcastVariables(content);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved broadcast variables: ${unresolved.map((v) => `{{${v}}}`).join(', ')}`);
  }
}
