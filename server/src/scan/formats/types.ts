/** What the deep pass learns from a file's contents (PLAN.md §10). Facts, never owner data. */
export interface EmbeddedMetadata {
  title?: string;
  creators?: { name: string; role?: string }[];
  language?: string;
  publisher?: string;
  /** As written in the file: often the edition's date, not first publication. */
  date?: string;
  /** EPUB identifiers (strong evidence), e.g. { scheme: 'isbn', value: '9780000000000' }. */
  identifiers?: { scheme: string; value: string }[];
  /** ISBNs found in a PDF's first pages: candidates only, never accepted alone (§10). */
  isbnCandidates?: string[];
  subjects?: string[];
  description?: string;
  series?: string;
  seriesIndex?: string;
  /** ComicInfo.xml fields (§10). */
  comic?: {
    series?: string;
    number?: string;
    volume?: string;
    title?: string;
    year?: string;
    writer?: string;
    penciller?: string;
    publisher?: string;
    genre?: string;
    manga?: 'yes' | 'yes_rtl' | 'no';
    pageCount?: number;
  };
}

export type PdfType = 'comic' | 'text' | 'scanned' | 'uncertain';

export interface PdfTypeResult {
  type: PdfType;
  /** Plain-language evidence shown with the type (§10), e.g. "6 of 8 sampled pages are text". */
  evidence: string;
  sampled: number;
  textPages: number;
  imagePages: number;
  colourImagePages: number;
  portraitPages: number;
}

export interface MetaResult {
  metadata: EmbeddedMetadata;
  wordCount: number | null;
  pageCount: number | null;
  pdfType?: PdfTypeResult;
  /** A .zip/.rar that turned out not to be a comic (§9.1): dropped from the library. */
  notComic?: string;
}

export type Problem = 'corrupt' | 'limit' | 'timeout' | 'not_comic' | 'too_large' | 'encrypted';
