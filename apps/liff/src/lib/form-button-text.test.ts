import { describe, expect, it } from 'vitest';
import { normalizeFormTheme } from '@line-crm/shared';
import { submitButtonText } from './form-button-text.js';

/**
 * 回答フォームの送信ボタンの描画の契約 (m11c)。
 *
 * 大学生向けの言い換え: ボタンの「地の色と文字色の組み合わせ」が、
 * 実際に目で読めることを数字 (コントラスト) で確かめる試験。
 * 文面を読むだけの試験と違い、ここでは文字色を決める関数を動かして
 * 地の色とのコントラストを計算する。
 */

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(left: string, right: string): number {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('送信ボタンは緑の地に白い文字 (既定・設計 4-form)', () => {
  it('色を決めていないときは白 (on-accent)', () => {
    const theme = normalizeFormTheme(undefined);
    expect(theme.main).toBe('#008f3d');
    expect(submitButtonText(theme, false)).toBe('#ffffff');
  });

});

describe('色を決めているときは読める方を自動で選ぶ (4.5 以上)', () => {
  it('薄い緑には白を置かず、暗い文字で 4.5 以上', () => {
    const theme = normalizeFormTheme({ main: '#06c755', text: '#1d1d1f' });
    const text = submitButtonText(theme, true);
    expect(text).not.toBe('#ffffff');
    expect(contrastRatio(theme.main, text)).toBeGreaterThanOrEqual(4.5);
  });

  it('濃い緑には白で 4.5 以上', () => {
    const theme = normalizeFormTheme({ main: '#087a3e', text: '#1d1d1f' });
    const text = submitButtonText(theme, true);
    expect(text).toBe('#ffffff');
    expect(contrastRatio(theme.main, text)).toBeGreaterThanOrEqual(4.5);
  });

  it('既定と同じ緑を明示したときは自動選択 (読める方で 4.5 以上)', () => {
    const theme = normalizeFormTheme({ main: '#008f3d' });
    const text = submitButtonText(theme, true);
    expect(contrastRatio(theme.main, text)).toBeGreaterThanOrEqual(4.5);
  });
});
