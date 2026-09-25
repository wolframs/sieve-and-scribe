#!/usr/bin/env node
/**
 * Merge the algorithmic clusters with the LLM taxonomy into the extension asset.
 *
 * Inputs:
 *   clusters.json     — from cluster.mjs
 *   taxonomy-*.jsonl  — LLM classification of the top cluster heads:
 *                       {id, cat, concept, akin?, gender?} per line
 * Output:
 *   tag-semantics.json — shipped in the extension's public/ dir:
 *     v          asset version
 *     categories category name list
 *     cat        head id -> category index
 *     heads      member tag id -> cluster head id (variant clusters only)
 *     related    head id -> semantically related head ids (same concept, akin links,
 *                gendered variants), popularity-ordered
 *
 * Usage: node build-asset.mjs <clusters.json> <out.json> <taxonomy-1.jsonl> [more.jsonl...]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [clustersPath, outPath, ...taxonomyPaths] = process.argv.slice(2);
if (!clustersPath || !outPath || !taxonomyPaths.length) {
  console.error('usage: node build-asset.mjs <clusters.json> <out.json> <taxonomy.jsonl...>');
  process.exit(1);
}

const clusters = JSON.parse(readFileSync(clustersPath, 'utf8'));
const rankOf = new Map();
for (const c of clusters) rankOf.set(c.head.id, c.head.rank ?? Infinity);

const rows = [];
let badLines = 0;
for (const p of taxonomyPaths) {
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t);
      if (typeof row.id === 'number' && typeof row.concept === 'string') rows.push(row);
      else badLines++;
    } catch {
      badLines++;
    }
  }
}
console.log(`taxonomy rows: ${rows.length} (${badLines} bad lines skipped)`);

// Consistency correction: if a tag's own name is a concept that OTHER rows point at
// (e.g. the "dress" tag itself got bucketed as "clothing" while 30 rows use concept
// "dress"), the literal name wins and the agent's broader bucket demotes to akin.
const nameOf = new Map();
for (const c of clusters) nameOf.set(c.head.id, c.head.name.trim().toLowerCase().replace(/[_\s]+/g, ' '));
const conceptCounts = new Map();
for (const row of rows) {
  const c = row.concept.trim().toLowerCase();
  conceptCounts.set(c, (conceptCounts.get(c) ?? 0) + 1);
}
let corrected = 0;
for (const row of rows) {
  const n = nameOf.get(row.id);
  const c = row.concept.trim().toLowerCase();
  if (n && n !== c && (conceptCounts.get(n) ?? 0) >= 2) {
    if (!row.akin) row.akin = c;
    row.concept = n;
    corrected++;
  }
}
console.log(`name-is-concept corrections: ${corrected}`);

const CATEGORIES = [
  'person', 'body', 'face', 'hair', 'expression', 'pose', 'action', 'garment',
  'accessory', 'footwear', 'setting', 'nature', 'architecture', 'object', 'animal',
  'creature', 'vehicle', 'food', 'style', 'medium', 'franchise', 'character',
  'quality', 'composition', 'lighting', 'color', 'nsfw', 'meta', 'other',
];
const catIdx = new Map(CATEGORIES.map((c, i) => [c, i]));

// concept -> head ids (popularity-ordered later)
const byConcept = new Map();
// concept -> akin concept edges (both directions collected)
const akinEdges = new Map();
const rowById = new Map();
for (const row of rows) {
  rowById.set(row.id, row);
  const concept = row.concept.trim().toLowerCase();
  if (!concept) continue;
  let list = byConcept.get(concept);
  if (!list) byConcept.set(concept, (list = []));
  list.push(row.id);
  if (row.akin && typeof row.akin === 'string') {
    const akin = row.akin.trim().toLowerCase();
    if (akin && akin !== concept) {
      let set = akinEdges.get(concept);
      if (!set) akinEdges.set(concept, (set = new Set()));
      set.add(akin);
      let back = akinEdges.get(akin);
      if (!back) akinEdges.set(akin, (back = new Set()));
      back.add(concept);
    }
  }
}
for (const list of byConcept.values()) {
  list.sort((a, b) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity));
}

// Head-noun containment: agents weren't perfectly consistent about concept granularity
// ("wedding dress" vs "dress"), so link a multi-word concept to its final-noun concept
// both ways. This is what ties dress <-> wedding dress <-> sundress together.
const byTailNoun = new Map(); // tail noun -> multi-word concepts ending in it
for (const concept of byConcept.keys()) {
  const words = concept.split(' ');
  if (words.length < 2) continue;
  const tail = words[words.length - 1];
  if (!byConcept.has(tail)) continue;
  let list = byTailNoun.get(tail);
  if (!list) byTailNoun.set(tail, (list = []));
  list.push(concept);
}

const RELATED_CAP = 10;
const related = {};
for (const row of rows) {
  const concept = row.concept.trim().toLowerCase();
  const out = [];
  const push = (id) => {
    if (id !== row.id && !out.includes(id) && out.length < RELATED_CAP) out.push(id);
  };
  for (const id of byConcept.get(concept) ?? []) push(id); // same core concept (incl. gendered variants)
  // Head-noun family: "dress" pulls in "wedding dress"/"sundress"-style concepts and
  // vice versa — BEFORE generic akin links, which tend to be broad ("clothing").
  const tail = concept.split(' ').pop();
  if (tail !== concept && byConcept.has(tail)) {
    for (const id of byConcept.get(tail).slice(0, 3)) push(id);
  }
  for (const sibling of (byTailNoun.get(concept) ?? []).slice(0, 6)) {
    push((byConcept.get(sibling) ?? [])[0]);
  }
  for (const akin of akinEdges.get(concept) ?? []) {
    for (const id of (byConcept.get(akin) ?? []).slice(0, 2)) push(id);
  }
  if (out.length) related[row.id] = out;
}

const cat = {};
for (const row of rows) {
  const i = catIdx.get(String(row.cat ?? '').trim().toLowerCase());
  if (i !== undefined) cat[row.id] = i;
}

const heads = {};
for (const c of clusters) {
  for (const m of c.members) heads[m.id] = c.head.id;
}

const asset = { v: 1, categories: CATEGORIES, cat, heads, related };
writeFileSync(outPath, JSON.stringify(asset));
const kb = Math.round(Buffer.byteLength(JSON.stringify(asset)) / 1024);
console.log(
  `wrote ${outPath} (${kb} KB): ${Object.keys(cat).length} categorized, ` +
    `${Object.keys(heads).length} variant links, ${Object.keys(related).length} related sets`
);
