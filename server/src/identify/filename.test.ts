import { describe, expect, it } from 'vitest';
import { compareKeyFor, parseFilename, titleCompareKey } from './filename.ts';
import { displayTitle } from './items.ts';

// Fixture names are invented look-alikes of real patterns (PLAN.md §5, §11.1). The owner's real
// filenames live in fixtures/private/ and never in this file.

const v = <T>(p?: { value: T }) => p?.value;

describe('filename parser — plan fixtures (§11.1)', () => {
  it('splits a run-together name into words', () => {
    expect(v(parseFilename('boatofamillionyears.epub').title)).toBe('boat of a million years');
  });

  it('reads series, volume and subtitle from a Humble-style slug', () => {
    const p = parseFilename('shadowservice_vol1_darkarts.pdf');
    expect(v(p.series)).toBe('shadow service');
    expect(v(p.volume)).toBe('1');
    expect(v(p.subtitle)).toBe('dark arts');
  });

  it('reads series, issue and year from a scene-style comic name, dropping release tags', () => {
    const p = parseFilename('Saga 001 (2012) (Digital) (Zone-Empire).cbz');
    expect(v(p.series)).toBe('Saga');
    expect(v(p.issue)).toBe('1');
    expect(v(p.year)).toBe(2012);
    expect(p.tags).toEqual(expect.arrayContaining(['Digital', 'Zone-Empire']));
  });

  it('reads a manga volume marker', () => {
    const p = parseFilename('Berserk v01 (2003).cbz');
    expect(v(p.series)).toBe('Berserk');
    expect(v(p.volume)).toBe('1');
    expect(v(p.year)).toBe(2003);
  });

  it('reads "Book Two" after a name as volume 2 of that series, spelled or not', () => {
    for (const name of [
      'Lanternfall Book Two.pdf',
      'Lanternfall - Book 2.pdf',
      'Lanternfall, Book Two - The Ash Road.epub',
    ]) {
      const p = parseFilename(name);
      expect(v(p.series)).toBe('Lanternfall');
      expect(v(p.volume)).toBe('2');
    }
    expect(v(parseFilename('Lanternfall, Book Two - The Ash Road.epub').subtitle)).toBe(
      'The Ash Road',
    );
  });

  it('leaves titles that only contain the word "book" alone', () => {
    for (const name of ['The Book of Small Fires.epub', 'The Book Two.epub', 'Book Two.epub']) {
      expect(parseFilename(name).series).toBeUndefined();
    }
  });

  it('keeps both readings of "Title - Author", likelier first', () => {
    const p = parseFilename('Clean Code - Robert C. Martin.pdf');
    expect(p.authorTitle?.[0]).toEqual({ title: 'Clean Code', author: 'Robert C. Martin' });
    expect(p.authorTitle?.[1]).toEqual({ title: 'Robert C. Martin', author: 'Clean Code' });
  });

  it('records an HD quality tag and leaves it out of the name', () => {
    const p = parseFilename('saga_vol1_hd.cbz');
    expect(v(p.series)).toBe('saga');
    expect(v(p.volume)).toBe('1');
    expect(p.quality).toBe('HD');
  });
});

describe('filename parser — patterns from the M0 probe (invented names)', () => {
  it('reads "V2 14" as series volume 2, issue 14 — not a book volume', () => {
    const p = parseFilename('Copperline V2 14.cbr');
    expect(v(p.seriesVolume)).toBe('2');
    expect(v(p.issue)).toBe('14');
    expect(p.volume).toBeUndefined();
  });

  it('treats the "Vol. 3" in an issue file as a hint about its trade, not its own volume', () => {
    const p = parseFilename('Copperline 012 Vol. 3 Low Tide, May 2, 2006.cbr');
    expect(v(p.issue)).toBe('12');
    expect(p.volume).toBeUndefined();
    expect(p.tradeHint).toEqual({ volume: '3', title: 'Low Tide' });
    expect(v(p.year)).toBe(2006);
  });

  it('reads "#7" as an issue', () => {
    expect(v(parseFilename('Copperline #7.pdf').issue)).toBe('7');
  });

  it('reads a zero-padded two-digit issue, but leaves a number in a title alone', () => {
    expect(v(parseFilename('Lanternfish 05.cbr').issue)).toBe('5');
    expect(parseFilename('Catch 22.epub').issue).toBeUndefined();
  });

  it('reads a year joined to a series name as the start year', () => {
    const p = parseFilename('ironharbor1994_issue2.pdf');
    expect(v(p.series)).toBe('iron harbor');
    expect(v(p.startYear)).toBe(1994);
    expect(v(p.issue)).toBe('2');
  });

  it('strips size tags and Humble ids, and never uses the id as a date', () => {
    const p = parseFilename('quietgardens_vol1_optimized_1400000000.pdf');
    expect(v(p.series)).toBe('quiet gardens');
    expect(p.tags).toEqual(expect.arrayContaining(['optimized', 'humble-id 1400000000']));
    expect(p.year).toBeUndefined();
  });

  it('reads edition numbers from words and digits', () => {
    expect(parseFilename('pythonrecipes_fourthedition.pdf').editionNumber).toBe(4);
    expect(parseFilename('gardeningbasics_3rdedition.pdf').editionNumber).toBe(3);
    expect(parseFilename('bigideas30thanniversaryedition.pdf').editionNote).toBe(
      '30th anniversary edition',
    );
    expect(parseFilename('bigideas30thanniversaryedition.pdf').editionNumber).toBeUndefined();
  });

  it('moves a trailing "the" to the front', () => {
    expect(v(parseFilename('artofwaitingthe.epub').title)).toBe('the art of waiting');
  });

  it('strips a download-duplicate suffix', () => {
    const p = parseFilename('fieldnotes(1).epub');
    expect(v(p.title)).toBe('field notes');
    expect(p.tags).toContain('duplicate(1)');
  });

  it('reads issue words in their several forms', () => {
    expect(v(parseFilename('starlanterns_issue_2.pdf').issue)).toBe('2');
    expect(v(parseFilename('starlanterns_freeissue1.pdf').issue)).toBe('1');
    expect(v(parseFilename('starlanterns_issue0.pdf').issue)).toBe('0');
    expect(v(parseFilename('starlanterns_special_1.epub').issue)).toBe('Special 1');
  });

  it('reads "vol1_5" as volume 1.5 and "book2" as volume 2', () => {
    expect(v(parseFilename('glasscity_vol1_5.epub').volume)).toBe('1.5');
    expect(v(parseFilename('glasscity_book2.pdf').volume)).toBe('2');
  });

  it('treats hyphens as spaces in hyphenated names', () => {
    const p = parseFilename('The-Tin-Orchard-124.cbz');
    expect(v(p.series)).toBe('The Tin Orchard');
    expect(v(p.issue)).toBe('124');
  });

  it('strips a "-high" suffix', () => {
    const p = parseFilename('tinycomics-volume0-high.pdf');
    expect(v(p.volume)).toBe('0');
    expect(p.tags).toContain('high');
  });
});

describe('name comparison', () => {
  it('ignores a leading or trailing article when comparing titles', () => {
    expect(titleCompareKey('boatofamillionyears')).toBe(
      titleCompareKey('The Boat of a Million Years'),
    );
    expect(titleCompareKey('art of waiting the')).toBe(titleCompareKey('The Art of Waiting'));
    expect(titleCompareKey('theboatofamillionyears')).toBe('boatofamillionyears');
  });

  it('gives an HD and a standard version the same comparison key', () => {
    expect(compareKeyFor('saga_vol1_hd.cbz')).toBe(compareKeyFor('saga_vol1.cbz'));
    expect(compareKeyFor('Saga 001 HD.cbz')).toBe(compareKeyFor('Saga 001.cbz'));
  });

  it('gives EPUB and PDF of one book the same key, and different books different keys', () => {
    expect(compareKeyFor('mapmaking.epub')).toBe(compareKeyFor('mapmaking.pdf'));
    expect(compareKeyFor('mapmaking_vol1.pdf')).not.toBe(compareKeyFor('mapmaking_vol2.pdf'));
  });

  it('ignores size tags, Humble ids and download duplicates in the key', () => {
    expect(compareKeyFor('quietgardens_optimized_1400000000.pdf')).toBe(
      compareKeyFor('quietgardens.epub'),
    );
    expect(compareKeyFor('fieldnotes (1).pdf')).toBe(compareKeyFor('fieldnotes.epub'));
  });
});

describe("display titles for patterns found in the owner's first scan (invented names)", () => {
  const title = (n: string) => displayTitle(parseFilename(n));

  it('reads "Series - 12" as volume 12, never as a book titled "12"', () => {
    expect(title('Starfall Academy Manga - 12 [grp].zip')).toBe('Starfall Academy Manga Vol. 12');
    expect(title('Starfall Academy Manga - 01 [grp].zip')).toBe('Starfall Academy Manga Vol. 1');
  });

  it('keeps the subtitle of "Series - Subtitle" comics instead of dropping it', () => {
    expect(title('Copperline - Winter Special.cbr')).toBe('Copperline: Winter Special');
    expect(title('Copperline - The Long Night (Kman).cbz')).toBe('Copperline: The Long Night');
    expect(title('tinycomics_-_attack_of_the_paper_moths-high.pdf')).toBe(
      'Tinycomics: Attack of the Paper Moths',
    );
  });

  it('drops a trailing author name only when it looks like one', () => {
    expect(title('Widget Patterns - Ada Q. Quillfeather.pdf')).toBe('Widget Patterns');
    expect(title('salt_road_songs_-_mirela_vasquezhollow.epub')).toBe('Salt Road Songs');
    // A rare word on the left doesn't make it an author: the usual order is "Title - Author".
    expect(title('Widget Patterns - Ada Quill.pdf')).not.toBe('Ada Quill');
    expect(title('QUILLFEATHER Ada - The Widget Way.pdf')).toBe('The Widget Way');
  });

  it('treats tag words in the middle of an underscored name as title words', () => {
    expect(compareKeyFor('road_to_low_orbit.epub')).not.toBe(compareKeyFor('road_to_orbit.pdf'));
    expect(title('road_to_high_ground.epub')).toMatch(/High Ground/);
    // ...but a run of tags at the end is stripped, however many there are
    expect(compareKeyFor('lanternfish_vol1_hd_1400000000.pdf')).toBe(
      compareKeyFor('lanternfish_vol1.epub'),
    );
  });

  it('strips a trailing size tag after a space the same way for titles and grouping', () => {
    expect(compareKeyFor('Map Making optimized.pdf')).toBe(compareKeyFor('Map Making.epub'));
    expect(compareKeyFor('Map Making downsampled.pdf')).toBe(compareKeyFor('Map Making.epub'));
    expect(title('Map Making optimized.pdf')).toBe('Map Making');
    expect(title('Going Digital.epub')).toBe('Going Digital');
    expect(compareKeyFor('Going Digital.epub')).not.toBe(compareKeyFor('Going.pdf'));
  });

  it('keeps title words that look like tags: "The High Road" is not "The Road" in HD', () => {
    expect(compareKeyFor('The High Road.epub')).not.toBe(compareKeyFor('The Road.pdf'));
    expect(title('Digital Widgetry.epub')).toBe('Digital Widgetry');
    expect(title('Aim High.epub')).toBe('Aim High');
    expect(compareKeyFor('lanternfish_vol1_optimized.pdf')).toBe(
      compareKeyFor('lanternfish_vol1.epub'),
    );
    expect(compareKeyFor('Book (HQ).pdf')).toBe(compareKeyFor('Book.epub'));
  });

  it('reads "Series 01 - Subtitle" as a volume with its subtitle', () => {
    expect(title('Lanternfish 02 - Lanternfish vs. the Tide (2005) (grp).cbz')).toBe(
      'Lanternfish Vol. 2: Lanternfish vs. the Tide',
    );
  });

  it('reads a two-digit number on a comic archive as an issue', () => {
    expect(title('The Tin Orchard 10.cbr')).toBe('The Tin Orchard #10');
    expect(title('Catch 22.epub')).toBe('Catch 22');
  });

  it('treats a bare year as a year, not an issue number', () => {
    const p = parseFilename('Copperline - The Movie Summer 1990 (grp).cbr');
    expect(p.issue).toBeUndefined();
    expect(p.year?.value).toBe(1990);
  });

  it("keeps an issue file's subtitle", () => {
    expect(title('Copperline v1 04b - Paper Moth 01.cbr')).toBe('Copperline v1 #4b: Paper Moth 01');
  });

  it('strips -low, -high_definition, dashed Humble ids and a trailing _new', () => {
    expect(title('tinycomics-volume0-low.pdf')).toBe('Tiny Comics Vol. 0');
    expect(parseFilename('quietgardens-high_definition-1400000000.pdf').quality).toBe('HD');
    const p = parseFilename('pythonrecipes_new.epub');
    expect(displayTitle(p)).toBe('Python Recipes');
    expect(p.editionNote).toBe('new edition');
  });
});

describe('word splitting of names the dictionary lacks', () => {
  it('keeps a name whole instead of splitting off a single letter', () => {
    expect(parseFilename('pickleandmorty_vol2.pdf').series?.value).toBe('pickle and morty');
  });
});
