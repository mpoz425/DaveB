// Text normalization used on both sides of the match.
// strict: whitespace only. loose: also folds typographic characters that
// generators commonly transform (smart quotes, dashes, ellipses).

export function strict(s) {
  return String(s)
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function loose(s) {
  return strict(s)
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2012\u2015]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ ]+/g, " ")
    .trim();
}

export function caseless(s) {
  return loose(s).toLowerCase();
}

// Reduce Markdown to the plain text a renderer would produce, roughly.
export function stripMarkdown(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1");
}

export function words(s) {
  return caseless(stripMarkdown(s)).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w.length > 1);
}

export function looksLikeMarkdown(s) {
  return /\[[^\]]+\]\([^)]+\)|(^|\n)\s*([-*+]|\d+\.|#{1,6})\s|\*\*|`|\n\n/.test(String(s));
}
