import { describe, it, expect } from 'vitest';
import { storedRedirectTarget, safeRedirectTarget, attributedRedirectTarget } from './safe-redirect';

describe('storedRedirectTarget', () => {
  it('allows http(s) absolute URLs (tracked-link / marketing destinations are intentional)', () => {
    expect(storedRedirectTarget('https://example.com/lp')).toBe('https://example.com/lp');
    expect(storedRedirectTarget('http://example.com')).toBe('http://example.com');
  });

  it('allows root-relative paths', () => {
    expect(storedRedirectTarget('/thanks')).toBe('/thanks');
    expect(storedRedirectTarget('/r/abc?x=1')).toBe('/r/abc?x=1');
  });

  it('allows non-dangerous app/deep-link schemes (funnels must not break)', () => {
    expect(storedRedirectTarget('line://ti/p/@abc')).toBe('line://ti/p/@abc');
    expect(storedRedirectTarget('tel:08000005678')).toBe('tel:08000005678');
    expect(storedRedirectTarget('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(storedRedirectTarget('myapp://open/path')).toBe('myapp://open/path');
  });

  it('rejects dangerous schemes', () => {
    expect(storedRedirectTarget('javascript:alert(1)')).toBeNull();
    expect(storedRedirectTarget('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(storedRedirectTarget('vbscript:msgbox(1)')).toBeNull();
    expect(storedRedirectTarget('file:///etc/passwd')).toBeNull();
  });

  it('rejects protocol-relative URLs (ambiguous scheme)', () => {
    expect(storedRedirectTarget('//evil.com')).toBeNull();
    expect(storedRedirectTarget('//evil.com/path')).toBeNull();
  });

  it('rejects backslash protocol-relative bypass (browsers normalize \\ to /)', () => {
    expect(storedRedirectTarget('/\\evil.com')).toBeNull();
    expect(storedRedirectTarget('/\\/evil.com')).toBeNull();
    expect(storedRedirectTarget('\\\\evil.com')).toBeNull();
  });

  it('rejects targets containing control characters', () => {
    expect(storedRedirectTarget('/path\nSet-Cookie: x')).toBeNull();
    expect(storedRedirectTarget('/foo\tbar')).toBeNull();
    expect(storedRedirectTarget('https://example.com/\r\nevil')).toBeNull();
  });

  it('rejects empty / malformed input', () => {
    expect(storedRedirectTarget('')).toBeNull();
    expect(storedRedirectTarget('not a url')).toBeNull();
    expect(storedRedirectTarget('   ')).toBeNull();
  });

  it('tolerates leading/trailing whitespace around an otherwise valid target', () => {
    expect(storedRedirectTarget('  https://example.com  ')).toBe('https://example.com');
  });
});


describe('untrusted redirect targets', () => {
  it.each(['https://evil.example/t/x', 'http://evil.example', 'line://x', 'tel:1', 'mailto:a@b', '//evil.example', '/\\evil.example', '/%09/evil.example'])('F4/F9/F25: rejects %s', value => {
    expect(safeRedirectTarget(value, 'https://worker.test')).toBeNull();
  });
  it('keeps same-origin tracking and completion links', () => {
    expect(safeRedirectTarget('https://worker.test/t/abc', 'https://worker.test')).toBe('/t/abc');
    expect(safeRedirectTarget('/thanks')).toBe('/thanks');
  });
});


it('F9: LINE identity never leaves the Worker origin or appears on non-tracking paths', () => {
  const external = 'https://evil.example/t/x';
  expect(attributedRedirectTarget(external, 'https://worker.test', 'Uprivate')).toBe(external);
  expect(attributedRedirectTarget('/thanks?next=/t/x', 'https://worker.test', 'Uprivate')).toBe('/thanks?next=/t/x');
  expect(attributedRedirectTarget('/t/x?other=1#fragment', 'https://worker.test', 'Uprivate')).toBe('https://worker.test/t/x?other=1&identity=Uprivate#fragment');
});

it('marks a failed LIFF identification attempt without raw IDs so the redirect can finish anonymously', () => {
  expect(attributedRedirectTarget('/t/x?f=raw&lu=raw', 'https://worker.test', '')).toBe('https://worker.test/t/x?identity=');
});
