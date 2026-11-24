/**
 * The Snowball French stemmer, ported by hand from `algorithms/french.sbl` of the Snowball project
 * (https://snowballstem.org/algorithms/french/stemmer.html, Snowball 3.x: elisions, -oux, the "ni" RV exception).
 *
 * Copyright (c) 2001, Dr Martin Porter; Copyright (c) 2004-2005, Richard Boulton; Copyright (c) 2013, Yoshiki
 * Shibukawa; Copyright (c) 2006-2025, Olly Betts. Snowball is released under the 3-clause BSD licence: redistribution
 * and use in source and binary forms, with or without modification, are permitted provided that the copyright notice,
 * this list of conditions and the disclaimer are retained; the names of the copyright holders may not be used to
 * endorse derived products without permission. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 *
 * `test/lib/french-stemmer.test.ts` checks this port against Snowball's own French vocabulary and output.
 * Input: one lowercase word (NFC). Output: its stem, lowercase.
 */

const VOWELS = "aeiouyâàëéêèïîôûù";
const isV = (c: string | undefined): boolean => c !== undefined && VOWELS.includes(c);

const OUX = "bhjlnp";
const KEEP_WITH_S = "aiouès";

/** The longest of `list` that `w` ends with, starting at or after `min`. */
function longest(w: string, list: readonly string[], min = 0): string | undefined {
  let best: string | undefined;
  for (const s of list) {
    if (w.length - s.length >= min && w.endsWith(s) && (best === undefined || s.length > best.length)) best = s;
  }
  return best;
}

const S1_R2 = ["ance", "iqUe", "isme", "able", "iste", "eux", "ances", "iqUes", "ismes", "ables", "istes"];
const S1_ATION = ["atrice", "ateur", "ation", "atrices", "ateurs", "ations"];
const S1 = [
  ...S1_R2, ...S1_ATION, "logie", "logies", "usion", "ution", "usions", "utions", "ence", "ences", "ement", "ements",
  "ité", "ités", "if", "ive", "ifs", "ives", "eaux", "aux", "oux", "euse", "euses", "issement", "issements",
  "amment", "emment", "ment", "ments",
];
const I_VERB = [
  "îmes", "ît", "îtes", "i", "ie", "ies", "ir", "ira", "irai", "iraIent", "irais", "irait", "iras", "irent", "irez",
  "iriez", "irions", "irons", "iront", "is", "issaIent", "issais", "issait", "issant", "issante", "issantes",
  "issants", "isse", "issent", "isses", "issez", "issiez", "issions", "issons", "it",
];
const VERB_DELETE = [
  "é", "ée", "ées", "és", "èrent", "er", "era", "erai", "eraIent", "erais", "erait", "eras", "erez", "eriez",
  "erions", "erons", "eront", "ez", "iez", "eais",
];
const VERB_A = [
  "âmes", "ât", "âtes", "a", "ai", "aIent", "ait", "ant", "ante", "antes", "ants", "as", "asse", "assent", "asses",
  "assiez", "assions",
];
const VERB_AIS = ["ais", "aise", "aises"];
const VERB = ["ions", ...VERB_DELETE, ...VERB_A, ...VERB_AIS];
const RESIDUAL = ["ion", "ier", "ière", "Ier", "Ière", "e"];
const UNDOUBLE = ["enn", "onn", "ett", "ell", "eill"];

function prelude(word: string): string {
  let w = word;
  // Snowball's `repeat goto`: after a change, the same position is tested again.
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const n = w[i + 1];
    const before = w;
    if (isV(c) && (n === "u" || n === "i") && isV(w[i + 2])) {
      w = w.slice(0, i + 1) + n.toUpperCase() + w.slice(i + 2);
    } else if (isV(c) && n === "y") {
      w = w.slice(0, i + 1) + "Y" + w.slice(i + 2);
    } else if (c === "ë") {
      w = w.slice(0, i) + "He" + w.slice(i + 1);
    } else if (c === "ï") {
      w = w.slice(0, i) + "Hi" + w.slice(i + 1);
    } else if (c === "y" && isV(n)) {
      w = w.slice(0, i) + "Y" + w.slice(i + 1);
    } else if (c === "q" && n === "u") {
      w = w.slice(0, i + 1) + "U" + w.slice(i + 2);
    }
    if (w !== before) i--;
  }
  return w;
}

function regions(w: string): { pV: number; p1: number; p2: number } {
  const len = w.length;
  let pV = len;
  if (len >= 3 && isV(w[0]) && isV(w[1])) {
    pV = 3;
  } else if (w.startsWith("par") || w.startsWith("col") || w.startsWith("tap")) {
    pV = 3;
  } else if (w.startsWith("ni") && isV(w[2])) {
    pV = 3;
  } else {
    for (let i = 1; i < len; i++) {
      if (isV(w[i])) {
        pV = i + 1;
        break;
      }
    }
  }
  const after = (from: number): number => {
    let i = from;
    while (i < len && !isV(w[i])) i++;
    while (i < len && isV(w[i])) i++;
    return i < len ? i + 1 : len;
  };
  const p1 = after(0);
  const p2 = p1 < len ? after(p1) : len;
  return { pV, p1, p2 };
}

/** The stem of one lowercase French word. */
export function stemFrench(word: string): string {
  let w = word;
  const el = /^(?:[cdjlmnstz]|qu)'/.exec(w);
  if (el && w.length > el[0].length) w = w.slice(el[0].length);
  w = prelude(w);
  const { pV, p1, p2 } = regions(w);

  const cut = (at: number) => {
    w = w.slice(0, at);
  };
  const put = (at: number, s: string) => {
    w = w.slice(0, at) + s;
  };
  const ends = (at: number, s: string) => at - s.length >= 0 && w.slice(at - s.length, at) === s;

  const standard = (): boolean => {
    const m = longest(w, S1);
    if (m === undefined) return false;
    const b = w.length - m.length;
    if (S1_R2.includes(m)) {
      if (p2 > b) return false;
      cut(b);
      return true;
    }
    if (S1_ATION.includes(m)) {
      if (p2 > b) return false;
      cut(b);
      if (ends(b, "ic")) {
        if (p2 <= b - 2) cut(b - 2);
        else put(b - 2, "iqU");
      }
      return true;
    }
    switch (m) {
      case "logie":
      case "logies":
        if (p2 > b) return false;
        put(b, "log");
        return true;
      case "usion":
      case "ution":
      case "usions":
      case "utions":
        if (p2 > b) return false;
        put(b, "u");
        return true;
      case "ence":
      case "ences":
        if (p2 > b) return false;
        put(b, "ent");
        return true;
      case "ement":
      case "ements": {
        if (pV > b) return false;
        cut(b);
        const s = longest(w, ["iv", "eus", "abl", "iqU", "ièr", "Ièr"]);
        if (s !== undefined) {
          const c = b - s.length;
          if (s === "iv") {
            if (p2 <= c) {
              cut(c);
              if (ends(c, "at") && p2 <= c - 2) cut(c - 2);
            }
          } else if (s === "eus") {
            if (p2 <= c) cut(c);
            else if (p1 <= c) put(c, "eux");
          } else if (s === "abl" || s === "iqU") {
            if (p2 <= c) cut(c);
          } else if (pV <= c) {
            put(c, "i");
          }
        }
        return true;
      }
      case "ité":
      case "ités": {
        if (p2 > b) return false;
        cut(b);
        const s = longest(w, ["abil", "ic", "iv"]);
        if (s !== undefined) {
          const c = b - s.length;
          if (s === "abil") {
            if (p2 <= c) cut(c);
            else put(c, "abl");
          } else if (s === "ic") {
            if (p2 <= c) cut(c);
            else put(c, "iqU");
          } else if (p2 <= c) {
            cut(c);
          }
        }
        return true;
      }
      case "if":
      case "ive":
      case "ifs":
      case "ives":
        if (p2 > b) return false;
        cut(b);
        if (ends(b, "at") && p2 <= b - 2) {
          cut(b - 2);
          if (ends(b - 2, "ic")) {
            if (p2 <= b - 4) cut(b - 4);
            else put(b - 4, "iqU");
          }
        }
        return true;
      case "eaux":
        put(b, "eau");
        return true;
      case "aux":
        if (p1 > b) return false;
        put(b, "al");
        return true;
      case "oux":
        if (!OUX.includes(w[b - 1] ?? "\0")) return false;
        put(b, "ou");
        return true;
      case "euse":
      case "euses":
        if (p2 <= b) cut(b);
        else if (p1 <= b) put(b, "eux");
        else return false;
        return true;
      case "issement":
      case "issements":
        if (p1 > b || b === 0 || isV(w[b - 1])) return false;
        cut(b);
        return true;
      case "amment":
        if (pV <= b) put(b, "ant");
        return false; // Snowball's fail(): the verb steps still run
      case "emment":
        if (pV <= b) put(b, "ent");
        return false;
      default: // ment, ments
        if (b > 0 && isV(w[b - 1]) && pV <= b - 1) cut(b);
        return false;
    }
  };

  const iVerb = (): boolean => {
    const m = longest(w, I_VERB, pV);
    if (m === undefined) return false;
    const b = w.length - m.length;
    const c = w[b - 1];
    if (b - 1 < pV || c === "H" || isV(c)) return false;
    cut(b);
    return true;
  };

  const verb = (): boolean => {
    const m = longest(w, VERB, pV);
    if (m === undefined) return false;
    const b = w.length - m.length;
    if (m === "ions") {
      if (p2 > b) return false;
      cut(b);
    } else if (VERB_DELETE.includes(m)) {
      cut(b);
    } else if (VERB_A.includes(m)) {
      cut(b > 0 && w[b - 1] === "e" && pV <= b - 1 ? b - 1 : b);
    } else {
      if ((ends(b, "al") && b === 3) || ends(b, "auv") || ends(b, "épl")) return false;
      cut(b);
    }
    return true;
  };

  const residual = (): void => {
    const n = w.length;
    if (n >= 2 && w[n - 1] === "s" && (ends(n - 1, "Hi") || !KEEP_WITH_S.includes(w[n - 2]))) cut(n - 1);
    const m = longest(w, RESIDUAL, pV);
    if (m === undefined) return;
    const b = w.length - m.length;
    if (m === "ion") {
      if (p2 <= b && b - 1 >= pV && (w[b - 1] === "s" || w[b - 1] === "t")) cut(b);
    } else if (m === "e") {
      cut(b);
    } else {
      put(b, "i");
    }
  };

  if (standard() || iVerb() || verb()) {
    if (w.endsWith("Y")) put(w.length - 1, "i");
    else if (w.endsWith("ç")) put(w.length - 1, "c");
  } else {
    residual();
  }

  if (UNDOUBLE.some((s) => w.endsWith(s))) cut(w.length - 1);

  let i = w.length - 1;
  while (i >= 0 && !isV(w[i])) i--;
  if (i < w.length - 1 && i >= 0 && (w[i] === "é" || w[i] === "è")) w = w.slice(0, i) + "e" + w.slice(i + 1);

  return w
    .replace(/He/g, "ë")
    .replace(/Hi/g, "ï")
    .replace(/H/g, "")
    .replace(/I/g, "i")
    .replace(/U/g, "u")
    .replace(/Y/g, "y");
}
