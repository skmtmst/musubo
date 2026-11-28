import type { Message } from '@line-crm/line-sdk';
import { broadcastButtonsFlex, normalizeStoreInterpolations, convertBroadcastAsset, isBroadcastAssetKind, splitBroadcastText, validateFlexMessage, validateImagemapMessage } from '@line-crm/shared';
import { autoTrackContent } from '../../services/auto-track.js';
import { buildMessage } from '../../services/line-message.js';
import {
  assertNoUnresolvedBroadcastVariables,
  getUnsupportedBroadcastVariables,
  hasRecipientVariables,
  renderBroadcastMessageContent,
  type BroadcastRenderContext,
} from '../../services/render-message.js';
import { addMessageVariation } from '../../services/stealth.js';

// LINE Messaging API が1回の送信リクエストで受け付ける上限。
// UIだけ上限を変えると、保存できても実送信で落ちるのでWorkerを正本にする。
export const MAX_BROADCAST_MESSAGES = 5;

const SUPPORTED_TYPES = new Set([
  'text', 'image', 'imagemap', 'flex', 'location', 'video', 'audio', 'sticker', 'carousel',
  // 配信用素材（カルーセル・リッチ・クーポン・リサーチ）は、画面の保存と
  // 同じ変換（`@line-crm/shared`）で LINE の種別に直してから送る。
  // 画面では通るのに送信で断られる形にしない。
  'rich_message', 'rich_video', 'card_message', 'coupon', 'research',
]);

export interface BroadcastMessagePart {
  id: string;
  messageType: string;
  messageContent: string;
  altText?: string;
}

type StoredBubble = {
  id?: unknown;
  type?: unknown;
  content?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('messageBubbles content must be an object');
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`messageBubbles ${field} is required`);
  }
  return value;
}

function jsonObject(value: string, field: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    throw new Error(`messageBubbles ${field} must be valid JSON`);
  }
}

function contentForBubble(type: string, value: unknown): string {
  const content = record(value);
  if (type === 'imagemap') return typeof content.text === 'string' ? content.text : JSON.stringify(content);
  if (type === 'text') return nonEmptyString(content.text, 'text');
  if (type === 'image' || type === 'video') {
    /*
     * LINE は画像・動画とそのプレビュー画像を https の URL でしか受けない。
     * 空や http のまま保存すると、送る時点で LINE に断られるか、
     * 中身の JSON が文字のまま届く。保存・配信前検査の時点で人の言葉で止める。
     */
    const what = type === 'video' ? '動画' : '画像';
    const original = typeof content.originalContentUrl === 'string' ? content.originalContentUrl.trim() : '';
    const preview = typeof content.previewImageUrl === 'string' ? content.previewImageUrl.trim() : '';
    if (!original) throw new Error(`${what}のファイルをアップロードしてください`);
    if (!original.toLowerCase().startsWith('https://')) throw new Error(`${what}のURLは https:// から始めてください`);
    if (!preview) throw new Error(`${what}のプレビュー画像のURLを入れてください（JPEG・PNG、1MBまで）`);
    if (!preview.toLowerCase().startsWith('https://')) throw new Error(`${what}のプレビュー画像のURLは https:// から始めてください`);
    return JSON.stringify(content);
  }
  if (type === 'flex') {
    const flexJson = nonEmptyString(content.flexJson, 'flexJson');
    const parsed = jsonObject(flexJson, 'flexJson');
    /*
     * `{}` のような「JSON としては正しいが中身が無い」も送る前（保存・
     * 配信前検査・送信）に止める。送れるのはバブルかカルーセルだけ。
     */
    if (parsed.type !== 'bubble' && parsed.type !== 'carousel') {
      throw new Error('Flexはバブルかカルーセルの形にしてください');
    }
    const error = validateFlexMessage(parsed);
    if (error) throw new Error(error);
    return flexJson;
  }
  if (type === 'carousel') {
    const columnsJson = nonEmptyString(content.columnsJson, 'columnsJson');
    let columns: unknown;
    try { columns = JSON.parse(columnsJson); } catch { /* handled below */ }
    if (!Array.isArray(columns) || columns.length === 0) {
      throw new Error('messageBubbles columnsJson must be a non-empty JSON array');
    }
    // `[{}]` のような「配列だが中身が空」も止める。選んだテンプレートの
    // 中身は必ず 1 枚以上のパネル（キーを持つ object）のはず。
    const broken = columns.some((column) =>
      !column || typeof column !== 'object' || Array.isArray(column) || Object.keys(column).length === 0,
    );
    if (broken) {
      throw new Error('カルーセルの中身を確認してください。空のパネルがあります');
    }
    return columnsJson;
  }

  const state = record(content.state);
  if (type === 'location') {
    const location = record(state.location);
    if ((typeof location.latitude !== 'string' && typeof location.latitude !== 'number')
      || (typeof location.longitude !== 'string' && typeof location.longitude !== 'number')
      || String(location.latitude).trim() === '' || String(location.longitude).trim() === '') {
      throw new Error('messageBubbles location coordinates are required');
    }
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('messageBubbles location coordinates are required');
    }
    // 監査 : 地図上に無い数字を完成扱いにしない。画面の検査とそろえる。
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error('位置情報の緯度は-90〜90、経度は-180〜180で入力してください');
    }
    return JSON.stringify({
      title: typeof location.title === 'string' && location.title.trim() ? location.title.trim() : '場所',
      address: typeof location.address === 'string' ? location.address.trim() : '',
      latitude,
      longitude,
    });
  }
  if (type === 'audio') {
    const audio = record(state.audio);
    const durationSeconds = Number(audio.duration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('messageBubbles audio duration is required');
    }
    /*
     * LINE は https で公開された音声しか受けない。not-a-url のような値は
     * 保存できても送信で断られるので、保存・配信前検査の時点で止める。
     */
    const audioUrl = nonEmptyString(audio.originalContentUrl, 'audio originalContentUrl');
    if (!audioUrl.toLowerCase().startsWith('https://')) {
      throw new Error('音声のURLは https:// から始めてください');
    }
    return JSON.stringify({
      originalContentUrl: audioUrl,
      duration: Math.round(durationSeconds * 1000),
    });
  }
  if (type === 'sticker') {
    const sticker = record(state.sticker);
    const packageId = nonEmptyString(sticker.packageId, 'sticker packageId');
    const stickerId = nonEmptyString(sticker.stickerId, 'sticker stickerId');
    /*
     * LINE の番号はどちらも数字だけ。not-a-package のような文字は
     * 保存できても送信で断られるので、保存・配信前検査の時点で止める。
     */
    if (!/^\d+$/.test(packageId) || !/^\d+$/.test(stickerId)) {
      throw new Error('スタンプの番号が正しくありません。一覧から選び直してください');
    }
    return JSON.stringify({ packageId, stickerId });
  }
  throw new Error(`Unsupported broadcast bubble type: ${type}`);
}

function parseStoredBroadcastMessageParts(input: {
  messageType: string;
  messageContent: string;
  messageBubblesJson?: string | null;
  messageBubbles?: unknown;
  messageOptions?: unknown;
  messageOptionsJson?: string | null;
  altText?: string | null;
}): BroadcastMessagePart[] {
  let bubbles: unknown = input.messageBubbles;
  if (bubbles === undefined && input.messageBubblesJson) {
    try { bubbles = JSON.parse(input.messageBubblesJson); } catch {
      throw new Error('message_bubbles_json must be valid JSON');
    }
  }
  if (bubbles === undefined || bubbles === null) {
    return [{
      id: 'legacy-1',
      messageType: input.messageType,
      messageContent: input.messageContent,
      altText: input.altText ?? undefined,
    }];
  }
  if (!Array.isArray(bubbles) || bubbles.length < 1 || bubbles.length > MAX_BROADCAST_MESSAGES) {
    throw new Error(`messageBubbles must contain 1 to ${MAX_BROADCAST_MESSAGES} items`);
  }
  return bubbles.map((item, index) => {
    const bubble = item as StoredBubble;
    const type = typeof bubble?.type === 'string' ? bubble.type : '';
    if (!SUPPORTED_TYPES.has(type)) throw new Error(`Unsupported broadcast bubble type: ${type || '(missing)'}`);
    const id = typeof bubble.id === 'string' && bubble.id ? bubble.id : `bubble-${index + 1}`;
    /*
     * 配信用素材は、画面の保存（1吹き出し）と同じ変換で LINE の種別に直す。
     * 直せない素材は、送信の直前で利用者への直し方とともに止める。
     * 中身の JSON を本文に落とさない。
     */
    if (type === 'rich_video') {
      const content = record(bubble.content);
      const error = validateImagemapMessage(content);
      if (error || !content.video) throw new Error(error || 'リッチビデオのテンプレートを選んでください');
      return { id, messageType: 'imagemap', messageContent: JSON.stringify(content), altText: String(content.altText ?? '') };
    }
    if (isBroadcastAssetKind(type)) {
      const content = record(bubble.content);
      const converted = convertBroadcastAsset(
        type,
        typeof content.assetName === 'string' ? content.assetName : '',
        content,
      );
      if (!converted.ok) throw new Error(converted.error);
      return {
        id,
        messageType: converted.message.messageType,
        messageContent: converted.message.messageContent,
        altText: input.altText ?? converted.message.altText,
      };
    }
    return {
      id,
      messageType: type,
      messageContent: contentForBubble(type, bubble.content),
      altText: input.altText ?? undefined,
    };
  });
}

/** 保存・配信・テスト送信は、分割後と追加ボタンを含めて5通を数える。 */
export function parseBroadcastMessageParts(input: Parameters<typeof parseStoredBroadcastMessageParts>[0]): BroadcastMessagePart[] {
  const parts = parseStoredBroadcastMessageParts(input).flatMap(part => part.messageType === 'text'
    ? splitBroadcastText(part.messageContent).map((messageContent,index) => ({ ...part, id: index === 0 ? part.id : `${part.id}-${index}`, messageContent }))
    : [part]);
  let options = input.messageOptions as { buttons?: Array<{ label: string; value: string; type?: string }> } | undefined;
  if (options === undefined && input.messageOptionsJson) options = JSON.parse(input.messageOptionsJson);
  if (options?.buttons?.length) {
    parts.push({ id: 'message-buttons', messageType: 'flex', altText: 'ボタン', messageContent: JSON.stringify(broadcastButtonsFlex(options.buttons)) });
  }
  if (parts.length > MAX_BROADCAST_MESSAGES) throw new Error('文章の自動分割とボタンを合わせて5通までです。本文や吹き出しを減らしてください');
  for (const part of parts) {
    if (part.messageType === 'flex' || part.messageType === 'imagemap') {
      const error = (part.messageType === 'flex' ? validateFlexMessage : validateImagemapMessage)(JSON.parse(part.messageContent));
      if (error) throw new Error(error);
    }
  }
  return parts.map(p=>({...p,messageContent:normalizeStoreInterpolations(p.messageContent)}));
}

export function combinedMessageContent(parts: BroadcastMessagePart[]): string {
  return parts.map((part) => part.messageContent).join('\n');
}

export function unsupportedMessageVariables(parts: BroadcastMessagePart[]): string[] {
  return [...new Set(parts.flatMap((part) => getUnsupportedBroadcastVariables(part.messageContent)))];
}

export function hasRecipientVariablesInParts(parts: BroadcastMessagePart[]): boolean {
  return parts.some((part) => hasRecipientVariables(part.messageContent));
}

export async function autoTrackMessageParts(
  db: D1Database,
  parts: BroadcastMessagePart[],
  workerUrl: string | undefined,
  lineAccountId: string | null,
  trackLinks: boolean,
  broadcastId?: string | null,
): Promise<BroadcastMessagePart[]> {
  if (!workerUrl || !trackLinks) return parts;
  return Promise.all(parts.map(async (part) => {
    const tracked = await autoTrackContent(db, part.messageType, part.messageContent, workerUrl, {
      lineAccountId,
      broadcastId,
    });
    return { ...part, messageType: tracked.messageType, messageContent: tracked.content };
  }));
}

export function renderMessageParts(
  parts: BroadcastMessagePart[],
  context: BroadcastRenderContext,
): BroadcastMessagePart[] {
  const rendered = parts.flatMap(part => {
    const messageContent = renderBroadcastMessageContent(part.messageType, part.messageContent, context);
    return part.messageType === 'text' ? splitBroadcastText(messageContent).map(content => ({ ...part, messageContent: content })) : [{ ...part, messageContent }];
  });
  if (rendered.length > 5) throw new Error('差し込み後の文章が5通を超えています');
  return rendered;
}

export function assertMessagePartsResolved(parts: BroadcastMessagePart[]): void {
  for (const part of parts) assertNoUnresolvedBroadcastVariables(part.messageContent);
}

export function buildMessages(parts: BroadcastMessagePart[]): Message[] {
  return parts.map((part) => buildMessage(part.messageType, part.messageContent, part.altText));
}

export function addTestLabel(parts: BroadcastMessagePart[]): BroadcastMessagePart[] {
  const firstText = parts.findIndex((part) => part.messageType === 'text');
  if (firstText < 0) return parts;
  return parts.map((part, index) => index === firstText
    ? { ...part, messageContent: `【テスト配信】\n${part.messageContent}` }
    : part);
}

export function varyTextMessages(messages: Message[], batchIndex: number, totalBatches: number): Message[] {
  if (totalBatches <= 1) return messages;
  const firstText = messages.findIndex((message) => message.type === 'text');
  if (firstText < 0) return messages;
  return messages.map((message, index) => index === firstText && message.type === 'text'
    ? { ...message, text: addMessageVariation(message.text, batchIndex) }
    : message);
}
