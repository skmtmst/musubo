import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, phoneProblem } from './phone.js';

describe('国内電話番号の入力と読取り', () => {
  it.each(['090-0000-5678', ' ０９０－００００－５６７８ ', '090 0000 5678', '（０９０）００００ー５６７８'])('区切りと全角を受ける: %s', input => {
    expect(phoneProblem(input)).toBe('');
    expect(normalizePhone(input)).toBe('09000005678');
  });
  it('固定電話と任意欄の空を受ける', () => {
    expect(phoneProblem('03-0000-5678')).toBe('');
    expect(normalizePhone('03-0000-5678')).toBe('0300005678');
    expect(phoneProblem('　 ')).toBe('');
    expect(normalizePhone('　 ')).toBe('');
  });
  it.each(['1234567890', '090123456', '090123456789', '+819012345678', '090abc12345678', '090/1234/5678', '⓪⑨⓪⓪⓪⓪⓪⑤⑥⑦⑧', '𝟘𝟡𝟘𝟘𝟘𝟘𝟘𝟝𝟞𝟟𝟠', '---', ' '.repeat(50) + '09000005678'])('誤入力を数字の削り取りで通さない: %s', input => {
    expect(phoneProblem(input)).not.toBe('');
  });
  it('過去の区切りつきデータも数字だけの値も同じように伏せる', () => {
    expect(maskPhone('０９０－００００－５６７８')).toBe('090-****-5678');
    expect(maskPhone('09000005678')).toBe('090-****-5678');
    expect(maskPhone('03-0000-5678')).toBe('03-****-5678');
    expect(maskPhone('invalid private text')).toBe('****');
    expect(maskPhone(null)).toBe('');
  });
});
