import { describe, expect, it } from 'vitest';
import { item, page, rated, series, situation } from '../testing/rank.ts';
import { runMode } from './modes.ts';
import type { RankItem } from './recommend.ts';
import {
  evidenceOf,
  genresOf,
  learnTaste,
  tasteFor,
  tasteSummary,
  type TasteInput,
} from './taste.ts';
import { tasteFrom } from './tune.ts';

/** Invented history: n books by different authors with these subjects and this outcome. */
function history(
  n: number,
  subjects: string[],
  user: Partial<RankItem['user']>,
  over: Partial<RankItem> = {},
): RankItem[] {
  return Array.from({ length: n }, () => item({ subjects, user, ...over }));
}

const toInput = (i: RankItem): TasteInput => ({
  id: i.id,
  kind: i.kind,
  creators: i.creators,
  subjects: i.subjects,
  publisher: i.publisher,
  seriesKey: i.series?.key ?? null,
  historyOnly: i.historyOnly,
  progress: i.user.progress,
  dnfReason: i.user.dnfReason,
  rating: i.user.rating,
});

describe('taste learning (§13.11)', () => {
  it('splits source subjects into genres and drops words that only say "a book"', () => {
    expect(genresOf(['Fiction, fantasy, epic', 'Large type books', 'Science fiction'])).toEqual([
      'fantasy',
      'epic',
      'science fiction',
    ]);
  });

  it('is inert below 10 outcomes: it changes nothing', () => {
    const past = history(9, ['Fantasy'], { progress: 'finished', rating: 10 });
    const m = tasteFrom(past, 'normal');
    expect(m.active).toBe(false);
    const fantasy = item({ subjects: ['Fantasy'] });
    expect(tasteFor(fantasy, m)).toEqual({ score: 0.5, reason: null });
  });

  it('caps one series at 2 outcomes, so 30 issues of one comic don’t switch it on', () => {
    const run = Array.from({ length: 30 }, (_, k) =>
      item({
        kind: 'comic',
        subjects: ['Superheroes'],
        series: series('one-run', k + 1, { unit: 'issue' }),
        user: { progress: 'finished', rating: 9 },
      }),
    );
    const m = learnTaste(run.map(toInput));
    expect(m.outcomes).toBe(2);
    expect(m.active).toBe(false);
  });

  it('needs at least 3 different authors or series, not ten books by one author', () => {
    const one = history(
      12,
      ['Fantasy'],
      { progress: 'finished', rating: 9 },
      {
        creators: [{ name: 'Invented Single Author' }],
      },
    );
    expect(tasteFrom(one, 'normal')).toMatchObject({ outcomes: 12, groups: 1, active: false });
  });

  it('switches on above the threshold and visibly shifts results toward what you rate highly', () => {
    const loved = history(6, ['Fantasy'], { progress: 'finished', rating: 10 });
    const meh = history(6, ['Romance'], { progress: 'finished', rating: 4 });
    const fantasy = item({ subjects: ['Fantasy'], community: rated(70) });
    const romance = item({ subjects: ['Romance'], community: rated(72) });
    const all = [...loved, ...meh, fantasy, romance];

    const off = runMode('read_next', all, situation({ taste: tasteFrom(all, 'off') }), page);
    expect(off.cards.map((c) => c.id)).toEqual([romance.id, fantasy.id]);

    const taste = tasteFrom(all, 'normal');
    expect(taste.active).toBe(true);
    const on = runMode('read_next', all, situation({ taste }), page);
    expect(on.cards.map((c) => c.id)).toEqual([fantasy.id, romance.id]);
    expect(on.cards[0]!.reasons).toContain('You rate fantasy highly');
    expect(on.cards[0]!.components.taste).toBeGreaterThan(0.5);
    expect(on.cards[1]!.components.taste).toBeLessThan(0.5);

    const summary = tasteSummary(taste);
    expect(summary.likes[0]!.text).toBe('You rate fantasy highly');
    expect(summary.dislikes.map((d) => d.label)).toContain('romance');
  });

  it('treats finishing as engagement, weaker than a rating, and imported history weaker still', () => {
    const [own] = history(1, ['Horror'], { progress: 'finished' });
    const [imported] = history(1, ['Horror'], { progress: 'finished' }, { historyOnly: true });
    const [ratedOne] = history(1, ['Horror'], { progress: 'finished', rating: 8 });
    const w = (i: RankItem) => evidenceOf(toInput(i))!.weight;
    expect(w(ratedOne!)).toBeGreaterThan(w(own!));
    expect(w(own!)).toBeGreaterThan(w(imported!));
    expect(evidenceOf(toInput(own!))!.value).toBeGreaterThan(0);
  });

  it('never says “Not for me” about books that were only finished below the average', () => {
    const all = [
      ...history(6, ['Fantasy'], { progress: 'finished', rating: 10 }),
      ...history(6, ['Mystery'], { progress: 'finished' }),
    ];
    const s = tasteSummary(tasteFrom(all, 'normal'));
    const mystery = s.dislikes.find((d) => d.label === 'mystery')!;
    expect(mystery.text).toBe('Below your average: mystery');
    expect(s.dislikes.map((d) => d.text).join(' ')).not.toMatch(/Not for me/);
  });

  it('says “Not for me” and “rate lower” only when that is what the books show', () => {
    const all = [
      ...history(6, ['Fantasy'], { progress: 'finished', rating: 9 }),
      ...history(3, ['Westerns'], { progress: 'dnf', dnfReason: 'not_for_me' }),
      ...history(3, ['Poetry'], { progress: 'finished', rating: 3 }),
    ];
    const s = tasteSummary(tasteFrom(all, 'normal'));
    const text = (label: string) => s.dislikes.find((d) => d.label === label)?.text;
    expect(text('westerns')).toBe('You stopped westerns as “Not for me”');
    expect(text('poetry')).toBe('You rate poetry lower than your other books');
  });

  it('says “highly” only when the owner’s ratings really are high', () => {
    // A strict rater: 6s and 7s for science fiction stand out against 2s and 3s elsewhere.
    const strict = [
      ...history(6, ['Science fiction'], { progress: 'finished', rating: 7 }),
      ...history(6, ['Romance'], { progress: 'finished', rating: 2 }),
    ];
    const sf = tasteSummary(tasteFrom(strict, 'normal')).likes.find(
      (l) => l.label === 'science fiction',
    )!;
    expect(sf.meanRating).toBe(7);
    expect(sf.text).toBe('You rate science fiction above your other books');
    // A generous one: the same books rated 9 are rated highly.
    const generous = [
      ...history(6, ['Science fiction'], { progress: 'finished', rating: 9 }),
      ...history(6, ['Romance'], { progress: 'finished', rating: 6 }),
    ];
    expect(
      tasteSummary(tasteFrom(generous, 'normal')).likes.find((l) => l.label === 'science fiction')!
        .text,
    ).toBe('You rate science fiction highly');
  });

  it('learns only "Not for me" as dislike among unrated DNFs', () => {
    const notForMe = learnTaste(
      history(2, ['Westerns'], { progress: 'dnf', dnfReason: 'not_for_me' }).map(toInput),
    );
    const tooHard = learnTaste(
      history(2, ['Westerns'], { progress: 'dnf', dnfReason: 'too_difficult' }).map(toInput),
    );
    expect(notForMe.signals.size).toBeGreaterThan(0);
    expect(tooHard.signals.size).toBe(0);
  });

  it('learns comic artists apart from writers', () => {
    const comics = Array.from({ length: 12 }, (_, k) =>
      item({
        kind: 'comic',
        creators: [
          { name: `Invented Writer ${k}`, role: 'Writer' },
          { name: k < 6 ? 'Invented Penciller' : `Other Artist ${k}`, role: 'Penciller' },
        ],
        user: { progress: 'finished', rating: k < 6 ? 10 : 5 },
      }),
    );
    const m = tasteFrom(comics, 'normal');
    expect(m.signals.get('artist:invented penciller')?.affinity).toBeGreaterThan(0.15);
    const next = item({
      kind: 'comic',
      creators: [{ name: 'Invented Penciller', role: 'Penciller' }],
    });
    expect(tasteFor(next, m).reason).toBe('You rate comics drawn by Invented Penciller highly');
  });

  it('turns stronger with High and does nothing with Off', () => {
    const all = [
      ...history(6, ['Mystery'], { progress: 'finished', rating: 10 }),
      ...history(6, ['Poetry'], { progress: 'finished', rating: 3 }),
    ];
    const mystery = item({ subjects: ['Mystery'] });
    const low = tasteFor(mystery, tasteFrom(all, 'low')).score;
    const normal = tasteFor(mystery, tasteFrom(all, 'normal')).score;
    const high = tasteFor(mystery, tasteFrom(all, 'high')).score;
    expect(low).toBeLessThan(normal);
    expect(normal).toBeLessThan(high);
    expect(tasteFor(mystery, tasteFrom(all, 'off')).score).toBe(0.5);
  });
});
