import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { registerHooks } from 'node:module';

// The renderer modules import their stylesheets for the bundler; Node can't load .css, so the
// unit-level import stubs them — same convention as pipeline-card.test.ts.
registerHooks({
  load: (url, context, nextLoad) =>
    url.endsWith('.css') ? { format: 'module', source: 'export {};', shortCircuit: true } : nextLoad(url, context),
});
const { Empty } = await import('../src/renderer/components');
const { plural, UI_LOCALE } = await import('../src/renderer/format');
const { chatDay, chatTime } = await import('../src/renderer/office-chat');

type Elementish = { props?: { className?: string; children?: unknown } };
const findClass = (node: unknown, cls: string): Elementish | null => {
  if (!node || typeof node !== 'object') return null;
  const el = node as Elementish;
  if (el.props?.className === cls) return el;
  const kids = el.props?.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = findClass(kid, cls);
    if (hit) return hit;
  }
  return null;
};
const HANGUL = /[ᄀ-힯]/;
const stubIcon = () => null;

test('plural renders a bare singular for 1 and the plural form otherwise', () => {
  assert.equal(plural(1, 'event'), '1 event');
  assert.equal(plural(0, 'event'), '0 events');
  assert.equal(plural(3, 'event'), '3 events');
  assert.equal(plural(1, 'recorded entry', 'recorded entries'), '1 recorded entry');
  assert.equal(plural(2, 'recorded entry', 'recorded entries'), '2 recorded entries');
});

test('chat timestamps render in the fixed UI locale, never the host locale', () => {
  // The mixed-locale regression this pins: a ko-KR host rendered 오전/오후 beside English copy.
  assert.equal(UI_LOCALE, 'en-US');
  const t = chatTime('2026-09-30T04:45:00Z');
  assert.match(t, /\d{1,2}:\d{2}\s?[AP]M/);
  assert.doesNotMatch(t, HANGUL);
  assert.equal(chatDay(new Date().toISOString()), 'Today');
  const d = chatDay('2020-01-15T12:00:00Z');
  assert.match(d, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.doesNotMatch(d, HANGUL);
});

test('Empty keeps the contract: icon, title, one-line value, action — hint and secondary additive', () => {
  const el = Empty({
    icon: stubIcon,
    title: 'A cabinet for your evidence',
    description: 'Import references or results.',
    action: createElement('button', { className: 'primary' }, 'Import references'),
  });
  assert.equal((el as Elementish).props?.className, 'empty-state');
  assert.ok(findClass(el, 'empty-icon'));
  assert.ok(findClass(el, 'empty-actions') === null, 'no actions wrapper without a secondary affordance');
  assert.ok(findClass(el, 'empty-hint') === null, 'no hint line without a hint');
});

test('Empty stacks primary and secondary affordances and renders the hint line', () => {
  const el = Empty({
    icon: stubIcon,
    title: 'No loaded records match these filters',
    description: 'Widen the filters, or load older events.',
    action: createElement('button', { className: 'secondary' }, 'Clear filters'),
    secondary: createElement('button', { className: 'secondary' }, 'Load older events'),
    hint: 'Only the loaded records are searched.',
  });
  const actions = findClass(el, 'empty-actions');
  assert.ok(actions, 'secondary affordance wraps both actions');
  const kids = actions!.props!.children as unknown[];
  assert.equal(kids.length, 2);
  const hint = findClass(el, 'empty-hint');
  assert.equal(hint?.props?.children, 'Only the loaded records are searched.');
});
