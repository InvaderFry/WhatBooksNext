import { ONE_SITTING_MINUTES, READ_NEXT_PAGE } from '../config.ts';
import { MODES, pool, runMode, type ModeId } from './modes.ts';
import {
  completeness,
  fitOf,
  ineligibleBecause,
  onePerSeries,
  onePerWork,
  shows,
  topicsOf,
  type RankItem,
  type Situation,
} from './recommend.ts';

/**
 * "Why isn't this book shown?" (feature review, step 5). Pure: for one book and the current What
 * next choices, it walks the same steps the list is built from (eligibility, one per book, the
 * filters, one per series, Complete stories only, then the mode's own rule) and says which one
 * keeps the book out. It never loosens anything; each reason names the change that would let the
 * book in, so the owner decides.
 */

/** A one-tap way past a reason: change a What next choice, or open another book. */
export type WhyFix =
  | { kind: 'choice'; key: string; value: string; label: string }
  | { kind: 'item'; id: string; label: string };

export interface WhyReason {
  text: string;
  fix?: WhyFix;
}

export interface WhyNot {
  id: string;
  title: string;
  mode: ModeId;
  /** Where it is in this list (1-based), or null when it isn't in it. */
  position: number | null;
  /** In the list, but under "might fit": the length is only an estimate. */
  mightFit: boolean;
  /** Why it isn't shown: every filter that applies, or the first rule further down. */
  reasons: WhyReason[];
}

const KIND_TEXT: Record<string, string> = {
  fiction: 'fiction',
  nonfiction: 'nonfiction',
  self_help: 'self-help',
  tech: 'a tech book',
  comic: 'a comic',
  manga: 'manga',
};
const SHOW_TEXT = { books: 'Books', tech: 'Tech', comics: 'Comics and manga', all: 'All' };

const INELIGIBLE_TEXT: Record<string, string> = {
  'read elsewhere, not owned':
    'It’s a reading-history entry (read elsewhere, not owned), so it’s never recommended.',
  hidden: 'You hid it. Hidden books are never recommended; you can show it again on its page.',
  'marked Never': 'You marked it Never. You can change that on its page.',
  'did not finish': 'You marked it “Did not finish”. You can change its progress on its page.',
  finished: 'You’ve finished it.',
  'read in a collection': 'You’ve read it in a collection you finished.',
  'every issue in it read': 'You’ve read every issue it collects.',
};

const label = (i: RankItem) => i.displayTitle ?? i.title;
/** " (vol. 2)", unless the title already says its number ("Copperline #2"). */
const unitText = (i: RankItem) => {
  const l = i.series?.label;
  if (!l) return '';
  if (new RegExp(`(#|vol\\.?\\s*)${l.replace('.', '\\.')}\\b`, 'i').test(label(i))) return '';
  return ` (${i.series!.unit === 'issue' ? '#' : 'vol. '}${l})`;
};

export function whyNot(all: RankItem[], s: Situation, mode: ModeId, id: string): WhyNot | null {
  const i = all.find((x) => x.id === id);
  if (!i) return null;
  const out: WhyNot = { id, title: label(i), mode, position: null, mightFit: false, reasons: [] };
  const say = (text: string, fix?: WhyFix) => out.reasons.push(fix ? { text, fix } : { text });

  // 1. Eligibility is absolute: nothing else matters until it changes.
  const inel = ineligibleBecause(i);
  if (inel) {
    say(INELIGIBLE_TEXT[inel] ?? `It isn’t recommended: ${inel}.`, {
      kind: 'item',
      id: i.id,
      label: 'Open its page',
    });
    return out;
  }

  // 2. One card per book: another entry matched to the same online record is offered instead.
  const { kept } = onePerWork(all.filter((x) => ineligibleBecause(x) === null));
  if (!kept.some((x) => x.id === i.id)) {
    const twin = kept.find((x) => x.work && x.work === i.work);
    say(
      twin
        ? `Another entry, “${label(twin)}”, looks like the same book (same online match), so only one is offered. Needs review lists the pair.`
        : 'Another entry looks like the same book, so only one is offered. Needs review lists the pair.',
      twin ? { kind: 'item', id: twin.id, label: `Open “${label(twin)}”` } : undefined,
    );
    return out;
  }

  // 3. The page's filters: every one that applies, each with its own way out.
  const stillRelevant = mode === 'still_relevant';
  const sit: Situation = stillRelevant
    ? { ...s, show: 'all', completeOnly: false, topic: null }
    : s;
  const reference = stillRelevant || s.mood === 'skim' || !!s.topic;
  if (i.isReference && !reference)
    say(
      'It’s kept as a reference book. Reference books show up in Mood → Skim, when you pick a topic, and in Still relevant?.',
      { kind: 'choice', key: 'm', value: 'still_relevant', label: 'Show Still relevant?' },
    );
  if (s.exclude.has(i.id))
    say(
      'You said you’re not in the mood for it (“Not this, because…”). That lasts until this browser tab closes.',
    );
  if (!shows(i, sit.show))
    say(
      `“What kind?” is set to ${SHOW_TEXT[sit.show ?? 'all']}, and this is ${KIND_TEXT[i.kind ?? ''] ?? 'of unknown kind'}.`,
      { kind: 'choice', key: 'show', value: '', label: 'Show all kinds' },
    );
  if (sit.readyToRead && !i.availability.readyToRead)
    say(
      `“Ready to read only” is on, and it isn’t ready${i.availability.label ? ` (${i.availability.label})` : ''}.`,
      { kind: 'choice', key: 'ready', value: '', label: 'Include books that aren’t ready' },
    );
  if (sit.topic && topicsOf(i, [sit.topic]).length === 0)
    say(`It isn’t about the topic “${sit.topic}”.`, {
      kind: 'choice',
      key: 'topic',
      value: '',
      label: 'Any topic',
    });
  if (out.reasons.length > 0) return out;

  // 4. One per series: only the next installment of a series is offered (not in Still relevant?).
  if (!stillRelevant && i.series && i.series.position !== null) {
    const filtered = pool(all, { ...sit, completeOnly: false }, { reference, series: false }).items;
    const offered = onePerSeries(filtered, all).find((x) => x.series?.key === i.series!.key);
    if (offered && offered.id !== i.id) {
      say(
        `One book per series is offered at a time, and “${label(offered)}”${unitText(offered)} comes first in ${i.series.name}.`,
        { kind: 'item', id: offered.id, label: `Open “${label(offered)}”` },
      );
      return out;
    }
  }

  // 5. Complete stories only.
  if (sit.completeOnly && mode !== 'continue' && !stillRelevant) {
    const c = completeness(i, all);
    if (!c.ok) {
      say(`“Complete stories only” is on, and ${c.text}.`, {
        kind: 'choice',
        key: 'complete',
        value: '',
        label: 'Include unfinished series',
      });
      return out;
    }
  }

  // 6. The mode's own list: where it is, or the mode's rule.
  const r = runMode(mode, all, s, { offset: 0, limit: 100_000, previous: [] });
  const at = r.cards.findIndex((c) => c.id === i.id);
  if (at >= 0 && mode !== 'surprise') {
    out.position = at + 1;
    if (at >= READ_NEXT_PAGE)
      say(
        `It’s number ${at + 1} in this list. The first ${READ_NEXT_PAGE} are shown; press “Show more” to reach it.`,
      );
    return out;
  }
  if (r.mightFit.some((c) => c.id === i.id)) {
    out.mightFit = true;
    say('It’s under “might fit”: its length is only an estimate, so it may not fit the time.');
    return out;
  }
  const info = MODES.find((m) => m.id === mode)!;
  if (mode === 'surprise') {
    say(
      'Surprise me shows one book at a time, picked at random from your top 50. Reroll for another, or use Read next to see the ranked list.',
      { kind: 'choice', key: 'm', value: '', label: 'Show Read next' },
    );
    return out;
  }
  const blendedMode = mode === 'read_next' || mode === 'mood' || mode === 'one_sitting';
  if (blendedMode) {
    const budget = mode === 'one_sitting' ? (s.budget ?? ONE_SITTING_MINUTES) : s.budget;
    const finishing = mode === 'one_sitting' || s.mode === 'finish_within';
    const fit = fitOf(i.duration, { budget, mode: finishing ? 'finish_within' : s.mode });
    if (finishing && fit === 'unknown')
      say(
        'Its length isn’t known, so the app can’t tell whether you’d finish it in the time chosen.',
        mode === 'one_sitting'
          ? { kind: 'choice', key: 'm', value: '', label: 'Show Read next' }
          : { kind: 'choice', key: 'mode', value: '', label: 'Read for that long instead' },
      );
    else if (finishing && fit === 'too_long')
      say(
        'It’s too long to finish in the time chosen.',
        mode === 'one_sitting'
          ? { kind: 'choice', key: 'm', value: '', label: 'Show Read next' }
          : { kind: 'choice', key: 'time', value: '', label: 'Any length' },
      );
    else say('It isn’t in this list with these choices.');
    return out;
  }
  say(`It isn’t in ${info.label}. That list’s rule: ${info.description}`, {
    kind: 'choice',
    key: 'm',
    value: '',
    label: 'Show Read next',
  });
  return out;
}
