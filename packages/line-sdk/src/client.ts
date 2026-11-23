import type {
  BroadcastRequest,
  FlexContainer,
  Message,
  MulticastRequest,
  PushMessageRequest,
  ReplyMessageRequest,
  RichMenuObject,
  UserProfile,
} from './types.js';
import { logger, traceRequestInit, tracedFetch } from '@line-crm/shared/server';

const LINE_API_BASE = 'https://api.line.me';

/** Single-attempt seam. The Worker owns timeout, durable budget and retry scheduling. */
export type LineTransport = (url: string, init: RequestInit) => Promise<Response>;
export interface LineClientOptions { transport?: LineTransport }

/** Safe to record: excludes upstream body, status text, URL and credentials. */
export class LineApiError extends Error {
  readonly retryAfter: string | null;
  constructor(public readonly status: number, retryAfter: string | null) {
    super(`LINE API error: ${status}`);
    this.name = 'LineApiError';
    const value = retryAfter?.trim();
    this.retryAfter = value && /^\d+(\.\d+)?$/.test(value)
      ? String(Math.min(Number(value), 9_007_199_254_740))
      : value && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
        && Number.isFinite(Date.parse(value)) ? value : null;
  }
}

export interface FollowersInsight {
  status: string;
  followers?: number;
  targetedReaches?: number;
  blocks?: number;
}

export interface FollowerIdsPage {
  userIds: string[];
  next?: string;
}

export class LineClient {
  private readonly transport: LineTransport;
  constructor(private readonly channelAccessToken: string, options: LineClientOptions = {}) {
    this.transport = options.transport ?? ((url, init) => tracedFetch(url, init));
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const transport = this.transport;
    const started = Date.now();
    logger.info('line.request.started');
    try {
      const response = await transport(url, traceRequestInit(url, { ...init, redirect: 'manual' })!);
      logger.info('line.request.finished', { status: response.status, durationMs: Date.now() - started });
      return response;
    } catch {
      logger.warn('line.request.failed', { durationMs: Date.now() - started });
      throw new Error('LINE API network error');
    }
  }

  private fail(response: Response): never {
    void response.body?.cancel().catch(() => {});
    throw new LineApiError(response.status, response.headers.get('retry-after'));
  }

  // ─── Core request helper ──────────────────────────────────────────────────

  async request(
    method: string,
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<{ data: unknown; headers: Headers }> {
    const url = `${LINE_API_BASE}${path}`;

    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
        ...requestHeaders,
      },
    };

    if (method !== 'GET' && method !== 'DELETE' && body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await this.fetch(url, options);

    // LINE returns 409 when a request with the same X-Line-Retry-Key was
    // already accepted. For a caller retrying the exact same operation this
    // is a successful idempotent outcome, not a delivery failure.
    if (res.status === 409 && new Headers(requestHeaders).get('X-Line-Retry-Key')?.trim()
      && method.toUpperCase() === 'POST' && /^\/v2\/bot\/message\/(push|multicast|broadcast|narrowcast)$/.test(path)) {
      void res.body?.cancel().catch(() => {});
      return { data: { retryAccepted: true }, headers: res.headers };
    }

    if (!res.ok) this.fail(res);

    // Some endpoints (e.g. push, reply) return an empty body with 200.
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      try { data = await res.json(); }
      catch { throw new Error('LINE API invalid response'); }
    } else {
      data = undefined;
    }

    return { data, headers: res.headers };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserProfile> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/profile/${encodeURIComponent(userId)}`,
    );
    return data as UserProfile;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  async pushMessage(
    to: string,
    messages: Message[],
    retryKey?: string,
    customAggregationUnits?: string[],
  ): Promise<unknown> {
    const body: PushMessageRequest = { to, messages, customAggregationUnits };
    const { data } = await this.request(
      'POST',
      '/v2/bot/message/push',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return data;
  }

  /**
   * pushMessage と同じ送信を行い、監査画面に残せる LINE の要求IDも返す。
   *
   * 既存の pushMessage は戻り値をそのまま使う呼び出しがあるため変更しない。
   * 要求IDが応答に無い場合は null のまま返し、代わりの値を作らない。
   */
  async pushMessageWithRequestId(
    to: string,
    messages: Message[],
    retryKey?: string,
    customAggregationUnits?: string[],
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: PushMessageRequest = { to, messages, customAggregationUnits };
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/push',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return {
      data,
      // Retry-Keyの409は、最初に受理した要求IDを別ヘッダーで返す。
      // 突き合わせに使うのは元の受理結果のため、accepted を優先する。
      requestId: headers.get('x-line-accepted-request-id') ?? headers.get('x-line-request-id'),
    };
  }

  async multicast(
    to: string[],
    messages: Message[],
    customAggregationUnits?: string[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: Record<string, unknown> = { to, messages };
    if (customAggregationUnits) {
      body.customAggregationUnits = customAggregationUnits;
    }
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/multicast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-accepted-request-id') ?? headers.get('x-line-request-id') };
  }

  async broadcast(
    messages: Message[],
    retryKey?: string,
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: BroadcastRequest = { messages };
    const { data, headers } = await this.request(
      'POST',
      '/v2/bot/message/broadcast',
      body,
      retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
    );
    return { data, requestId: headers.get('x-line-accepted-request-id') ?? headers.get('x-line-request-id') };
  }

  async replyMessage(
    replyToken: string,
    messages: Message[],
  ): Promise<unknown> {
    return (await this.replyMessageWithRequestId(replyToken, messages)).data;
  }

  /** 返信がLINEに受理された証拠として、応答ヘッダーの要求IDも返す。 */
  async replyMessageWithRequestId(
    replyToken: string,
    messages: Message[],
  ): Promise<{ data: unknown; requestId: string | null }> {
    const body: ReplyMessageRequest = { replyToken, messages };
    const { data, headers } = await this.request('POST', '/v2/bot/message/reply', body);
    return { data, requestId: headers.get('x-line-request-id') };
  }

  // ─── Rich Menu ────────────────────────────────────────────────────────────

  async getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }> {
    const { data } = await this.request('GET', '/v2/bot/richmenu/list');
    return data as { richmenus: RichMenuObject[] };
  }

  async createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }> {
    const { data } = await this.request('POST', '/v2/bot/richmenu', menu);
    return data as { richMenuId: string };
  }

  async deleteRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async setDefaultRichMenu(richMenuId: string): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async linkRichMenuToUser(
    userId: string,
    richMenuId: string,
  ): Promise<unknown> {
    const { data } = await this.request(
      'POST',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
    );
    return data;
  }

  async unlinkRichMenuFromUser(userId: string): Promise<unknown> {
    const { data } = await this.request(
      'DELETE',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data;
  }

  async getRichMenuIdOfUser(userId: string): Promise<{ richMenuId: string }> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`,
    );
    return data as { richMenuId: string };
  }

  async getDefaultRichMenuId(): Promise<string | null> {
    const url = `${LINE_API_BASE}/v2/bot/user/all/richmenu`;
    const res = await this.fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
    });
    if (res.status === 404) { void res.body?.cancel().catch(() => {}); return null; }
    if (!res.ok) this.fail(res);
    let data: { richMenuId: string };
    try { data = (await res.json()) as { richMenuId: string }; }
    catch { throw new Error('LINE API invalid response'); }
    return data.richMenuId;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async pushTextMessage(to: string, text: string): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'text', text }]);
  }

  async pushFlexMessage(
    to: string,
    altText: string,
    contents: FlexContainer,
  ): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'flex', altText, contents }]);
  }

  async pushImageMessage(
    to: string,
    originalContentUrl: string,
    previewImageUrl: string,
  ): Promise<unknown> {
    return this.pushMessage(to, [{ type: 'image', originalContentUrl, previewImageUrl }]);
  }

  // ─── Rich Menu Image Upload ─────────────────────────────────────────────

  /** Upload image to a rich menu. Accepts PNG/JPEG binary (ArrayBuffer or Uint8Array). */
  async uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType: 'image/png' | 'image/jpeg' = 'image/png',
  ): Promise<void> {
    const url = `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.channelAccessToken}`,
      },
      body: imageData,
    });
    if (!res.ok) this.fail(res);
    void res.body?.cancel().catch(() => {});
  }

  // ─── Insight API ─────────────────────────────────────────────────────────

  /**
   * Get user interaction statistics for a broadcast message.
   * Data becomes available ~3 days after sending.
   * GET only — no messages are sent.
   */
  async getMessageEventInsight(requestId: string): Promise<unknown> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event?requestId=${encodeURIComponent(requestId)}`,
    );
    return data;
  }

  /**
   * Get statistics per unit for multicast messages.
   * GET only — no messages are sent.
   */
  async getUnitInsight(
    customAggregationUnit: string,
    from: string,
    to: string,
  ): Promise<unknown> {
    const params = new URLSearchParams({ customAggregationUnit, from, to });
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/message/event/aggregation?${params.toString()}`,
    );
    return data;
  }

  /**
   * Get the number of followers for a LINE Official Account on a given date.
   * GET only — no messages are sent.
   */
  async getFollowersInsight(date: string): Promise<FollowersInsight> {
    const { data } = await this.request(
      'GET',
      `/v2/bot/insight/followers?date=${encodeURIComponent(date)}`,
    );
    return data as FollowersInsight;
  }

  /**
   * Get one page of users who currently follow the LINE Official Account.
   * Verified/premium accounts only. Pass the returned `next` value as
   * `start` until `next` is absent to retrieve the full audience.
   */
  async getFollowerIds(
    limit = 1000,
    start?: string,
  ): Promise<FollowerIdsPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (start) params.set('start', start);
    const { data } = await this.request(
      'GET',
      `/v2/bot/followers/ids?${params.toString()}`,
    );
    return data as FollowerIdsPage;
  }
}
