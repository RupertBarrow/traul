import { stemFrench } from "./french-stemmer";

/**
 * The French keyword index: text -> French stems, for `messages_fr_fts`.
 *
 * Each word is stemmed twice, as written and without its accents, so that a query typed without accents
 * ("impayees") still meets the stems of accented text ("impayées"). Stems are stored without accents; the FTS5
 * tokenizer (`unicode61 remove_diacritics 2`) folds case and any accent left.
 *
 * Bump FRENCH_INDEX_VERSION whenever the output of frenchStems changes: the index is then rebuilt.
 */
export const FRENCH_INDEX_VERSION = "1";

const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;
const stripAccents = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");

function words(text: string): string[] {
  const folded = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/[’ʼ]/g, "'");
  return folded.match(WORD) ?? [];
}

const ELISION = /^(?:[cdjlmnstz]|qu)$/;

/** A word's parts: an elided article or pronoun ("l'", "qu'") is dropped, other apostrophes split the word. */
function parts(word: string): string[] {
  const [head, ...rest] = word.split("'");
  return rest.length > 0 && ELISION.test(head) ? rest : [head, ...rest];
}

/** The distinct stems of one part, without accents. */
function stemsOf(part: string): string[] {
  const out: string[] = [];
  for (const s of [stemFrench(part), stemFrench(stripAccents(part))]) {
    const plain = stripAccents(s);
    if (!out.includes(plain)) out.push(plain);
  }
  return out;
}

/** The text stored in the French index for `text`: its stems, space-separated. */
export function frenchStems(text: string): string {
  return words(text).flatMap(parts).flatMap(stemsOf).join(" ");
}

/** A MATCH expression for the French index: every word must match, through any of its stems. */
export function frenchMatchQuery(raw: string): string {
  const groups = words(raw)
    .flatMap(parts)
    .map((w) => {
      const stems = stemsOf(w).map((s) => `"${s}"`);
      return stems.length > 1 ? `(${stems.join(" OR ")})` : stems[0];
    });
  return groups.length > 0 ? groups.join(" AND ") : '""';
}
