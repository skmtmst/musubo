import { connect } from 'cloudflare:sockets';
import { assertQaOutboundAllowed } from './staging-qa-safety.js';
import PostalMime, { type Address } from 'postal-mime';
import { NEN_FROM_NAME } from './mail-from-name.js';
import { storeSupportEmail } from './support-email-store.js';

const CONNECTION_TIMEOUT_MS = 15_000;
const MAX_EMAIL_BYTES = 10 * 1024 * 1024;
const INITIAL_IMPORT_LIMIT = 100;

type XServerMailEnv = {
  DB: D1Database;
  CONTACT_EMAIL?: string;
  XSERVER_MAIL_HOST?: string;
  XSERVER_MAIL_USER?: string;
  XSERVER_MAIL_PASSWORD?: string;
};

type SendMailInput = {
  to: string;
  from: string;
  subject: string;
  body: string;
  html?: string;
  /** 差出人の表示名。省略時は 然-NEN- の窓口名。 */
  fromName?: string;
  inReplyTo?: string;
  references?: string;
};

function requireConfig(env: XServerMailEnv): { host: string; user: string; password: string } {
  if (!env.XSERVER_MAIL_HOST || !env.XSERVER_MAIL_USER || !env.XSERVER_MAIL_PASSWORD) {
    throw new Error('XSERVER_MAIL_NOT_CONFIGURED');
  }
  return { host: env.XSERVER_MAIL_HOST, user: env.XSERVER_MAIL_USER, password: env.XSERVER_MAIL_PASSWORD };
}

function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), CONNECTION_TIMEOUT_MS);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function concat(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

class MailSocket {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(private readonly socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  private async fill(): Promise<void> {
    const result = await timeout(this.reader.read(), 'MAIL_READ');
    if (result.done) throw new Error('MAIL_CONNECTION_CLOSED');
    this.buffer = concat(this.buffer, result.value);
  }

  async readLine(): Promise<string> {
    while (true) {
      for (let index = 0; index < this.buffer.length - 1; index++) {
        if (this.buffer[index] === 13 && this.buffer[index + 1] === 10) {
          const line = this.decoder.decode(this.buffer.slice(0, index));
          this.buffer = this.buffer.slice(index + 2);
          return line;
        }
      }
      if (this.buffer.length > 1024 * 1024) throw new Error('MAIL_LINE_TOO_LARGE');
      await this.fill();
    }
  }

  async readExact(size: number): Promise<Uint8Array<ArrayBufferLike>> {
    if (size > MAX_EMAIL_BYTES) throw new Error('MAIL_TOO_LARGE');
    while (this.buffer.length < size) await this.fill();
    const value = this.buffer.slice(0, size);
    this.buffer = this.buffer.slice(size);
    return value;
  }

  async write(value: string | Uint8Array): Promise<void> {
    const bytes = typeof value === 'string' ? this.encoder.encode(value) : value;
    await timeout(this.writer.write(bytes), 'MAIL_WRITE');
  }

  close(): void {
    try { this.socket.close(); } catch { /* already closed */ }
  }

  releaseForStartTls(): Socket {
    this.reader.releaseLock();
    this.writer.releaseLock();
    return this.socket;
  }
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class ImapClient {
  private tagNumber = 0;
  constructor(private readonly transport: MailSocket) {}

  async greeting(): Promise<void> {
    const line = await this.transport.readLine();
    if (!line.startsWith('* OK')) throw new Error(`IMAP_GREETING_FAILED:${line.slice(0, 120)}`);
  }

  private nextTag(): string {
    this.tagNumber += 1;
    return `N${String(this.tagNumber).padStart(4, '0')}`;
  }

  async command(command: string): Promise<string[]> {
    const tag = this.nextTag();
    await this.transport.write(`${tag} ${command}\r\n`);
    const lines: string[] = [];
    while (true) {
      const line = await this.transport.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error(`IMAP_COMMAND_FAILED:${line.slice(0, 200)}`);
        return lines;
      }
      lines.push(line);
    }
  }

  async fetchRaw(uid: number): Promise<Uint8Array> {
    const tag = this.nextTag();
    await this.transport.write(`${tag} UID FETCH ${uid} (UID RFC822.SIZE BODY.PEEK[])\r\n`);
    let raw: Uint8Array | null = null;
    while (true) {
      const line = await this.transport.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`) || !raw) throw new Error(`IMAP_FETCH_FAILED:${line.slice(0, 200)}`);
        return raw;
      }
      const literal = /\{(\d+)\}$/.exec(line);
      if (literal) raw = await this.transport.readExact(Number(literal[1]));
    }
  }
}

async function connectImapStartTls(host: string): Promise<MailSocket> {
  assertQaOutboundAllowed();
  const plain = new MailSocket(connect(
    { hostname: host, port: 143 },
    { secureTransport: 'starttls', allowHalfOpen: false },
  ));
  try {
    const imap = new ImapClient(plain);
    await imap.greeting();
    await imap.command('STARTTLS');
    return new MailSocket(plain.releaseForStartTls().startTls());
  } catch (error) {
    plain.close();
    throw error;
  }
}

function mailbox(address: Address | undefined): { name: string | null; email: string } | null {
  if (!address || !('address' in address) || !address.address) return null;
  return { name: address.name?.trim() || null, email: address.address.trim().toLowerCase() };
}

export async function syncXServerSupportMailbox(
  env: XServerMailEnv,
): Promise<{ imported: number; duplicate: number; checked: number }> {
  const config = requireConfig(env);
  const mailboxKey = (env.CONTACT_EMAIL || config.user).toLowerCase();
  const transport = await connectImapStartTls(config.host);
  try {
    const imap = new ImapClient(transport);
    await imap.command(`LOGIN ${quoteImap(config.user)} ${quoteImap(config.password)}`);
    const selectLines = await imap.command('SELECT INBOX');
    const uidValidity = selectLines.map((line) => /\[UIDVALIDITY (\d+)\]/i.exec(line)?.[1]).find(Boolean) || null;
    const state = await env.DB.prepare(
      'SELECT uid_validity, last_uid FROM support_email_sync_state WHERE mailbox = ?',
    ).bind(mailboxKey).first<{ uid_validity: string | null; last_uid: number }>();
    const lastUid = state?.uid_validity === uidValidity ? state.last_uid : 0;
    const searchLines = await imap.command(lastUid > 0 ? `UID SEARCH UID ${lastUid + 1}:*` : 'UID SEARCH ALL');
    let uids = searchLines
      .filter((line) => line.startsWith('* SEARCH'))
      .flatMap((line) => line.slice('* SEARCH'.length).trim().split(/\s+/))
      .map(Number)
      .filter((uid) => Number.isSafeInteger(uid) && uid > lastUid)
      .sort((a, b) => a - b);
    if (!state && uids.length > INITIAL_IMPORT_LIMIT) uids = uids.slice(-INITIAL_IMPORT_LIMIT);

    let imported = 0;
    let duplicate = 0;
    for (const uid of uids) {
      const raw = await imap.fetchRaw(uid);
      const parsed = await PostalMime.parse(raw, {
        attachmentEncoding: 'arraybuffer', maxNestingDepth: 20, maxHeadersSize: 256 * 1024,
      });
      const replyTo = Array.isArray(parsed.replyTo) ? mailbox(parsed.replyTo[0]) : mailbox(parsed.replyTo);
      const from = mailbox(parsed.from);
      const sender = replyTo || from;
      if (!sender) throw new Error(`IMAP_INVALID_SENDER:${uid}`);
      const result = await storeSupportEmail(env, {
        customerEmail: sender.email,
        customerName: from?.name,
        subject: parsed.subject,
        bodyText: parsed.text,
        bodyHtml: parsed.html,
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      });
      if (result.duplicate) duplicate += 1;
      else imported += 1;
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO support_email_sync_state
         (mailbox, uid_validity, last_uid, last_checked_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(mailbox) DO UPDATE SET uid_validity=excluded.uid_validity,
           last_uid=excluded.last_uid, last_checked_at=excluded.last_checked_at,
           last_error=NULL, updated_at=excluded.updated_at`,
      ).bind(mailboxKey, uidValidity, uid, now, now).run();
    }

    if (uids.length === 0) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO support_email_sync_state
         (mailbox, uid_validity, last_uid, last_checked_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(mailbox) DO UPDATE SET uid_validity=excluded.uid_validity,
           last_checked_at=excluded.last_checked_at, last_error=NULL, updated_at=excluded.updated_at`,
      ).bind(mailboxKey, uidValidity, lastUid, now, now).run();
    }
    await imap.command('LOGOUT').catch(() => []);
    return { imported, duplicate, checked: uids.length };
  } catch (error) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO support_email_sync_state
       (mailbox, last_uid, last_checked_at, last_error, updated_at)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(mailbox) DO UPDATE SET last_checked_at=excluded.last_checked_at,
         last_error=excluded.last_error, updated_at=excluded.updated_at`,
    ).bind(mailboxKey, now, String(error).slice(0, 500), now).run().catch(() => undefined);
    throw error;
  } finally {
    transport.close();
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function foldBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') || '';
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

async function smtpResponse(transport: MailSocket, expected: number): Promise<void> {
  const lines: string[] = [];
  let code = '';
  while (true) {
    const line = await transport.readLine();
    lines.push(line);
    if (!code) code = line.slice(0, 3);
    if (line.startsWith(`${code} `)) break;
  }
  if (Number(code) !== expected) throw new Error(`SMTP_${expected}_FAILED:${lines.join(' | ').slice(0, 300)}`);
}

async function smtpCommand(transport: MailSocket, command: string, expected: number): Promise<void> {
  await transport.write(`${command}\r\n`);
  await smtpResponse(transport, expected);
}

export async function sendXServerMail(env: XServerMailEnv, input: SendMailInput): Promise<string> {
  assertQaOutboundAllowed();
  const config = requireConfig(env);
  const plain = new MailSocket(connect(
    { hostname: config.host, port: 587 },
    { secureTransport: 'starttls', allowHalfOpen: false },
  ));
  const messageId = `<${crypto.randomUUID()}@nen-petfood.com>`;
  let transport = plain;
  try {
    await smtpResponse(plain, 220);
    await smtpCommand(plain, 'EHLO worker.nen-petfood.com', 250);
    await smtpCommand(plain, 'STARTTLS', 220);
    transport = new MailSocket(plain.releaseForStartTls().startTls());
    await smtpCommand(transport, 'EHLO worker.nen-petfood.com', 250);
    await smtpCommand(transport, 'AUTH LOGIN', 334);
    await smtpCommand(transport, encodeBase64(config.user), 334);
    await smtpCommand(transport, encodeBase64(config.password), 235);
    await smtpCommand(transport, `MAIL FROM:<${safeHeader(input.from)}>`, 250);
    await smtpCommand(transport, `RCPT TO:<${safeHeader(input.to)}>`, 250);
    await smtpCommand(transport, 'DATA', 354);
    const headers = [
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      `From: =?UTF-8?B?${encodeBase64(safeHeader(input.fromName || NEN_FROM_NAME))}?= <${safeHeader(input.from)}>`,
      `To: <${safeHeader(input.to)}>`,
      `Reply-To: <${safeHeader(input.from)}>`,
      `Subject: =?UTF-8?B?${encodeBase64(safeHeader(input.subject))}?=`,
      ...(input.inReplyTo ? [`In-Reply-To: ${safeHeader(input.inReplyTo)}`] : []),
      ...(input.references ? [`References: ${safeHeader(input.references)}`] : []),
      'MIME-Version: 1.0',
      ...(input.html
        ? [`Content-Type: multipart/alternative; boundary="${messageId.slice(1, -1)}"`]
        : ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64']),
    ];
    const boundary = messageId.slice(1, -1);
    const content = input.html
      ? [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', foldBase64(encodeBase64(input.body)),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', foldBase64(encodeBase64(input.html)),
        `--${boundary}--`, ''].join('\r\n')
      : `${foldBase64(encodeBase64(input.body))}\r\n`;
    await transport.write(`${headers.join('\r\n')}\r\n\r\n${content}.\r\n`);
    await smtpResponse(transport, 250);
    await smtpCommand(transport, 'QUIT', 221).catch(() => undefined);
    return messageId;
  } finally {
    transport.close();
  }
}
