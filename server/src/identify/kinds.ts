/**
 * Kind and reference guesses (PLAN.md §8). Inferred from source subjects, AniList (manga),
 * known tech publishers and title words. Every guess is reviewable and overridable; the owner's
 * override always wins (it lives in user_item). Pure.
 */

/** Publishers whose books are almost all technical (§8). Compared without punctuation. */
const TECH_PUBLISHERS = [
  'oreilly',
  'nostarch',
  'manning',
  'packt',
  'pragmatic',
  'apress',
  'addisonwesley',
  'wrox',
  'sitepoint',
  'leanpub',
  'artima',
  'sams',
];

const RULES: { kind: string; re: RegExp }[] = [
  {
    kind: 'tech',
    re: /\b(computer|computing|programming|software|python|javascript|typescript|java|rust|golang|kotlin|c\+\+|databases?|sql|machine learning|deep learning|data science|algorithms?|linux|unix|devops|web development|networking|cybersecurity|information technology)\b/i,
  },
  {
    kind: 'self_help',
    re: /\b(self-help|self help|personal development|self-improvement|motivation(al)?|success|habits?|productivity|happiness|mindfulness|self-actualization)\b/i,
  },
  { kind: 'comic', re: /\b(comics?|graphic novels?|comic books?)\b/i },
  {
    kind: 'nonfiction',
    re: /\b(non-?fiction|history|biography|autobiography|memoir|essays|philosophy|politics|economics|psychology|science|sociology|travel|journalism|true crime)\b/i,
  },
  {
    // "Nonfiction" contains "fiction": the negative lookbehind keeps it out.
    kind: 'fiction',
    re: /(?<!non-?)\b(fiction|novels?|fantasy|science fiction|romance|mystery|mysteries|thrillers?|horror|detective)\b/i,
  },
];

export interface KindEvidence {
  subjects: string[];
  /** AniList format (MANGA, ONE_SHOT, NOVEL) and country, when an AniList match exists. */
  anilist?: { format?: string; country?: string };
  publisher?: string | null;
}

/** A kind from source evidence, or null when nothing says. Never from the title alone. */
export function kindFromEvidence(e: KindEvidence): { kind: string; why: string } | null {
  if (e.anilist && e.anilist.format !== 'NOVEL')
    return { kind: 'manga', why: 'AniList lists it as manga' };
  const pub = (e.publisher ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (pub && TECH_PUBLISHERS.some((p) => pub.includes(p)))
    return { kind: 'tech', why: 'published by a technical publisher' };
  const votes = new Map<string, number>();
  for (const s of e.subjects) {
    for (const r of RULES) {
      if (r.re.test(s)) {
        votes.set(r.kind, (votes.get(r.kind) ?? 0) + 1);
        break; // the first (most specific) rule a subject matches is the one that counts
      }
    }
  }
  let best: string | null = null;
  let n = 0;
  for (const r of RULES) {
    const v = votes.get(r.kind) ?? 0;
    if (v > n) {
      best = r.kind;
      n = v;
    }
  }
  return best ? { kind: best, why: 'from its subjects' } : null;
}

/** Title words that suggest a reference book (§8): "Cookbook", "Handbook", "Reference", "Rulebook". */
const REFERENCE_WORDS =
  /(cookbook|handbook|\breference\b|rulebook|\bdictionary\b|\bencyclop(a)?edia\b|\bcheat ?sheets?\b)/i;

export function looksLikeReference(title: string): boolean {
  return REFERENCE_WORDS.test(title);
}
