import { describe, expect, it } from 'vitest';
import { describeString, maskUrl, safeKey } from '../../tools/store-collector/probe/mask.ts';
import { outline, type OutlineNode } from '../../tools/store-collector/probe/outline.ts';
import { Probe } from '../../tools/store-collector/probe/report.ts';
import { parseBody, render, shapeOf } from '../../tools/store-collector/probe/skeleton.ts';

/**
 * The look-around script (store purchases plan, Stage 2) reports a store page's structure so an
 * adapter can be written. These tests feed it invented answers full of titles, IDs and an email,
 * and check none of them reaches the report.
 */

const OWN = ['google.com', 'googleapis.com'];
const SECRETS = [
  'The Ember Orchard',
  'Nell Varga',
  'INVENTED0001',
  'inv3nted-vol-0001',
  'someone@example.invalid',
  '9780000000017',
];

/** An invented Google-style batch answer: positional arrays, with JSON inside a string. */
const BATCH =
  ")]}'\n\n123\n" +
  JSON.stringify([
    [
      'wrb.fr',
      'InvRpc',
      JSON.stringify([
        [
          ['inv3nted-vol-0001', ['The Ember Orchard', ['Nell Varga']], 'PURCHASE_TYPE_OWNED', 0.4],
          ['inv3nted-vol-0002', ['Tidewright', ['Osric Lane']], 'PURCHASE_TYPE_SAMPLE', 0],
        ],
        'next-token-INVENTED0001',
      ]),
      null,
      null,
      null,
      'generic',
    ],
  ]) +
  '\n';

describe('the look-around script’s privacy rules', () => {
  it('shows label words and UPPER_SNAKE labels, and only describes anything else', () => {
    expect(describeString('PURCHASE', OWN)).toBe('"PURCHASE"');
    expect(describeString('PURCHASE_TYPE_SAMPLE', OWN)).toBe('"PURCHASE_TYPE_SAMPLE"');
    expect(describeString('The Ember Orchard', OWN)).toBe('text(10–50)');
    expect(describeString('INVENTED0001', OWN)).toBe('id-like(12)');
    expect(describeString('9780000000017', OWN)).toBe('digits(13)');
    expect(describeString('someone@example.invalid', OWN)).toBe('text(10–50)');
    expect(describeString('2026-11-11T12:00:00Z', OWN)).toBe('date text');
  });

  it('shows URL patterns, not IDs, slugs or query values', () => {
    expect(
      maskUrl('https://play.google.com/books/reader?id=inv3nted-vol-0001&hl=en&rpcids=InvRpc', OWN),
    ).toBe('play.google.com/books/reader?id=…&hl=…&rpcids=InvRpc');
    expect(maskUrl('https://www.kobo.com/us/en/ebook/the-ember-orchard-1234', OWN)).toBe(
      'other host (kobo.com)/us/en/ebook/:id',
    );
    expect(maskUrl('https://www.kobo.com/us/en/ebook/the-ember-orchard', ['kobo.com'])).toBe(
      'www.kobo.com/us/en/ebook/:slug',
    );
    expect(safeKey('INVENTED0001')).toBe(false);
    expect(safeKey('someone@example.invalid')).toBe(false);
    expect(safeKey('originType')).toBe(true);
  });

  it('reads Google batch answers, keeps positions, and looks inside JSON in strings', () => {
    const [data] = parseBody(BATCH);
    const text = render(shapeOf(data, OWN));
    expect(text).toContain('"PURCHASE_TYPE_OWNED" | "PURCHASE_TYPE_SAMPLE"');
    expect(text).toContain('json text:');
    expect(text).toMatch(/\[0\] id-like\(17\)/);
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it('writes a report of requests, embedded data and repeated elements with no titles, IDs or emails', () => {
    const p = new Probe(OWN);
    p.add({
      method: 'POST',
      url: 'https://play.google.com/_/BooksUi/data/batchexecute?rpcids=InvRpc&f.sid=123456',
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: BATCH,
    });
    p.add({
      method: 'GET',
      url: 'https://www.googleapis.com/books/v1/volumes/inv3nted-vol-0001',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'inv3nted-vol-0001', volumeInfo: { title: 'The Ember Orchard' } }),
    });
    p.addEmbedded('window.__NUXT__', {
      user: { email: 'someone@example.invalid' },
      ['someone@example.invalid']: { name: 'Nell Varga' },
      library: [{ title: 'The Ember Orchard', isbn: '9780000000017' }],
    });
    const text = p.report({
      page: 'https://play.google.com/books?id=INVENTED0001',
      browser: 'Invented Browser 1',
      date: '2026-11-11T12:00:00Z',
      dom: [
        {
          sig: 'div.book-card',
          count: 155,
          attrs: ['data-id'],
          link: maskUrl('https://play.google.com/books/reader?id=inv3nted-vol-0001', OWN),
          hasImage: true,
        },
      ],
      earlier: [maskUrl('https://play.google.com/books/library?id=INVENTED0001', OWN)],
    });
    expect(text).toContain('POST play.google.com/_/BooksUi/data/batchexecute?rpcids=InvRpc&:key=…');
    expect(text).toContain('GET www.googleapis.com/books/v1/volumes/:id');
    expect(text).toContain('volumeInfo: {');
    expect(text).toContain('<id-like keys>');
    expect(text).toContain('div.book-card ×155');
    for (const s of SECRETS) expect(text).not.toContain(s);
  });

  it('outlines one card: classes, attribute shapes and label words, never titles or IDs', () => {
    const el = (
      tag: string,
      classes: string[],
      attrs: Record<string, string> = {},
      text = '',
      children: OutlineNode[] = [],
    ): OutlineNode => ({
      tag,
      classes,
      attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      text,
      children,
    });
    const card = el(
      'li',
      ['item-wrapper', 'book'],
      {
        'data-track-info': JSON.stringify({
          productId: 'inv3nted-0001-0002',
          title: 'The Ember Orchard',
          isPreview: false,
          productType: 'BOOK_PURCHASED',
        }),
      },
      '',
      [
        el(
          'a',
          ['title'],
          { href: 'https://www.kobo.com/us/en/ebook/the-ember-orchard' },
          'The Ember Orchard',
        ),
        el('span', ['badge'], {}, 'Preview'),
        el('span', ['progress'], {}, '45%'),
        el('a', ['author'], { 'aria-label': 'Nell Varga' }, 'Nell Varga'),
      ],
    );
    const text = outline(card, ['kobo.com']);
    expect(text).toContain('li.item-wrapper.book');
    expect(text).toContain('data-track-info (JSON):');
    expect(text).toContain('isPreview: true/false');
    expect(text).toContain('"BOOK_PURCHASED"');
    expect(text).toContain('href=www.kobo.com/us/en/ebook/:slug');
    expect(text).toContain('text: "Preview"');
    expect(text).toContain('text: percent text');
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain('the-ember-orchard');
  });

  it('never lists the same shape twice when answers repeat', () => {
    const many = Array.from({ length: 12 }, () => ({ path: JSON.stringify([{ x: 1, y: 2 }]) }));
    const text = render(shapeOf(many, OWN));
    expect(text.match(/json text:/g)).toHaveLength(1);
  });
});
