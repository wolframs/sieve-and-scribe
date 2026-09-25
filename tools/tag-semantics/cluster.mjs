#!/usr/bin/env node
/**
 * Algorithmic pre-clustering of the CivitAI tag corpus.
 *
 * Input:  corpus.json — [{ id, name, rank }] dumped from the extension's IndexedDB
 *         (rank = "Most Models" popularity order; lower is more popular).
 * Output: clusters.json — surface-form clusters: for each canonical head tag, the
 *         quasi-duplicate members (case/punctuation/underscore variants, plural forms,
 *         token permutations, 1–2-edit typos). This collapses the uncurated typo swamp
 *         BEFORE any LLM pass, so semantic taxonomy work only sees ~unique concepts.
 *
 * Usage: node cluster.mjs <corpus.json> <clusters.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [corpusPath, outPath] = process.argv.slice(2);
if (!corpusPath || !outPath) {
  console.error('usage: node cluster.mjs <corpus.json> <clusters.json>');
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
console.log(`corpus: ${corpus.length} tags`);

// --- normalization ---

const norm = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');

/** Aggressive fold for identity clustering: strip decoration, collapse separators. */
const fold = (s) =>
  norm(s)
    .replace(/[.,;:!?*#'"´`’|~^°§\\/()[\]{}<>+=%&@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(^| )the /g, '$1')
    .trim();

const IRREGULAR_PLURALS = {
  women: 'woman', men: 'man', children: 'child', people: 'person', feet: 'foot',
  teeth: 'tooth', mice: 'mouse', geese: 'goose', wolves: 'wolf', elves: 'elf',
  knives: 'knife', wives: 'wife', leaves: 'leaf', thieves: 'thief', scarves: 'scarf',
};

/** Naive singular fold — good enough for tag vocabulary. */
function singular(word) {
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses') || word.endsWith('shes') || word.endsWith('ches') || word.endsWith('xes'))
    return word.slice(0, -2);
  if (word.endsWith('ss')) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

const singularized = (s) => fold(s).split(' ').map(singular).join(' ');
const tokenSorted = (s) => singularized(s).split(' ').sort().join(' ');

// --- pass 1: identity clustering on progressively looser keys ---

// Sort by popularity so cluster heads are always the most popular surface form.
const tags = [...corpus].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

/** union-find over tag ids */
const parent = new Map();
const find = (x) => {
  let r = x;
  while (parent.get(r) !== r) r = parent.get(r);
  let c = x;
  while (parent.get(c) !== c) {
    const next = parent.get(c);
    parent.set(c, r);
    c = next;
  }
  return r;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent.set(rb, ra); // a's root (more popular, processed first) wins
};
for (const t of tags) parent.set(t.id, t.id);

const keyIndexes = [new Map(), new Map(), new Map()]; // fold, singular, tokenSort
const keyFns = [fold, singularized, tokenSorted];
for (const t of tags) {
  for (let k = 0; k < keyFns.length; k++) {
    const key = keyFns[k](t.name);
    if (!key || key.length < 2) continue;
    const existing = keyIndexes[k].get(key);
    if (existing === undefined) keyIndexes[k].set(key, t.id);
    else union(existing, t.id);
  }
}

// --- pass 2: typo clustering (bounded edit distance to a cluster head) ---

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prevPrev[j - 2] + 1);
      }
      row.push(best);
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

// Head registry after pass 1, bucketed for cheap candidate lookup.
const headOf = new Map(); // rootId -> head tag (most popular member)
for (const t of tags) {
  const r = find(t.id);
  if (!headOf.has(r)) headOf.set(r, t);
}
const buckets = new Map(); // bucket key -> [head folded string, rootId][]
const bucketKeys = (s) => {
  // length-banded first-two-chars buckets; also a first-char-only band to catch
  // second-char typos.
  const keys = [];
  const l = Math.round(s.length / 2);
  keys.push(`${s.slice(0, 2)}|${l}`);
  keys.push(`${s[0]}|${l}`);
  return keys;
};
const headEntries = [...headOf.entries()].map(([root, t]) => ({ root, t, f: fold(t.name) }));
for (const h of headEntries) {
  for (const k of bucketKeys(h.f)) {
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(h);
  }
}

// Typo pass: merge an UNPOPULAR head into a clearly popular near-neighbour. Guards
// mirror the extension's live variant scan, plus union-find hygiene so distance-1
// chains can't compound (anime <- anima <- animal <- …):
//  - only junk-tier tags (rank > 25k) can be claimed as typos — popular near-neighbours
//    are real, distinct words;
//  - typos keep the first letter (or transpose the first two);
//  - both sides must still be live cluster roots (buckets are built once, pre-merge).
const TYPO_MIN_RANK = 25000;
let typoMerges = 0;
for (const h of headEntries) {
  if (h.f.length < 5) continue; // too short to typo-match safely
  if ((h.t.rank ?? Infinity) <= TYPO_MIN_RANK) continue; // popular tags are not typos
  if (find(h.t.id) !== h.root) continue; // already merged into someone else
  const max = h.f.length <= 8 ? 1 : 2;
  const seenCand = new Set();
  let best = null;
  for (const k of bucketKeys(h.f)) {
    for (const cand of buckets.get(k) ?? []) {
      if (cand.root === h.root || seenCand.has(cand.root)) continue;
      seenCand.add(cand.root);
      if (find(cand.t.id) !== cand.root) continue; // stale (merged) head — no chaining
      if (cand.f.length < 5) continue;
      const candRank = cand.t.rank ?? Infinity;
      if (candRank > TYPO_MIN_RANK / 2) continue; // target must be clearly established
      if (!(cand.f[0] === h.f[0] || (cand.f[1] === h.f[0] && cand.f[0] === h.f[1]))) continue;
      const d = editDistanceAtMost(h.f, cand.f, max);
      if (d <= max && (!best || d < best.d || (d === best.d && candRank < (best.cand.t.rank ?? Infinity)))) {
        best = { cand, d };
      }
    }
  }
  if (best) {
    union(best.cand.t.id, h.t.id);
    typoMerges++;
  }
}

// --- emit ---

const clusters = new Map();
for (const t of tags) {
  const r = find(t.id);
  let c = clusters.get(r);
  if (!c) clusters.set(r, (c = []));
  c.push(t);
}
const out = [...clusters.values()]
  .map((members) => ({
    head: members[0], // most popular (tags sorted by rank)
    members: members.slice(1),
  }))
  .sort((a, b) => (a.head.rank ?? Infinity) - (b.head.rank ?? Infinity));

const multi = out.filter((c) => c.members.length > 0);
console.log(`clusters: ${out.length} (${multi.length} with variants, ${typoMerges} typo merges)`);
console.log(
  'sample:',
  multi
    .slice(0, 8)
    .map((c) => `${c.head.name} <= [${c.members.slice(0, 4).map((m) => m.name).join(', ')}]`)
    .join('\n        ')
);
writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath}`);
