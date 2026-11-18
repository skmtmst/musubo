import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('然・マイページの配色と写真', () => {
  it('uses variables for the order palette', () => {
    expect(styles).toContain('--order-accent: var(--photo-accent);');
    const ordersView = main.slice(main.indexOf('function OrdersView'), main.indexOf('const yen'));
    const orderClasses = new Set([...ordersView.matchAll(/className="([^"]+)"/g)]
      .flatMap(([, names]) => names.split(/\s+/))
      .filter(name => /^nm-(?:portal-orders-page|order-|subscription-)/.test(name)));
    const orderRules = [...styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selector]) => [...selector.matchAll(/\.([\w-]+)/g)].some(([, name]) => orderClasses.has(name)));
    const orderStyles = orderRules.map(([, , body]) => body).join('\n');
    expect(orderStyles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
