// Refs look like "data/copy.json#hero.words[2]" or "content/about.md#body".
// Paths are the same dotted/bracketed form the content loader produces.

export function splitRef(ref) {
  const i = ref.indexOf("#");
  if (i < 0) throw new Error(`bad ref: ${ref}`);
  return { file: ref.slice(0, i), path: ref.slice(i + 1) };
}

export function parsePath(p) {
  const tokens = [];
  const re = /\[(\d+)\]|([^.[\]]+)/g;
  let m;
  while ((m = re.exec(p))) tokens.push(m[1] !== undefined ? Number(m[1]) : m[2]);
  return tokens;
}

export function getIn(obj, tokens) {
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

export function setIn(obj, tokens, value) {
  if (!tokens.length) throw new Error("cannot set the root");
  const parent = getIn(obj, tokens.slice(0, -1));
  if (parent == null || typeof parent !== "object") throw new Error(`no container at ${tokens.slice(0, -1).join(".")}`);
  parent[tokens[tokens.length - 1]] = value;
}
