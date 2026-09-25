import type { FeedTag, TagMode } from './civitai-feed-tags';

export interface FeedTagExpression {
  groups: FeedTag[][];
  negatives: FeedTag[];
  mode: TagMode;
}

const term = (tag: FeedTag) => `${JSON.stringify(tag.name)} [#${tag.id}]`;

export function formatFeedTagExpression(value: FeedTagExpression): string {
  const connector = value.mode === 'all' ? ' AND ' : ' OR ';
  const positive = value.groups.map((group) => `(${group.map(term).join(' OR ')})`).join(connector);
  const negative = value.negatives.length
    ? `NOT (${value.negatives.map(term).join(' OR ')})`
    : '';
  return positive && negative ? `${positive} AND ${negative}` : positive || negative;
}

function splitTerms(source: string): string[] {
  const terms: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === '\\' && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (!quoted && source.slice(index).match(/^\s+OR\s+/i)) {
      const match = source.slice(index).match(/^\s+OR\s+/i)![0];
      terms.push(source.slice(start, index).trim());
      index += match.length - 1;
      start = index + 1;
    }
  }
  if (quoted) throw new Error('Unclosed quoted tag name');
  terms.push(source.slice(start).trim());
  return terms.filter(Boolean);
}

function parseTerm(source: string): FeedTag {
  const match = source.match(/^("(?:\\.|[^"\\])*"|.*?)\s+(?:\[#(\d+)\]|#(\d+))$/);
  if (!match) throw new Error(`Expected a tag name followed by [#id]: ${source}`);
  const id = Number(match[2] ?? match[3]);
  let name = match[1].trim();
  if (name.startsWith('"')) {
    try { name = JSON.parse(name) as string; }
    catch { throw new Error(`Invalid quoted tag name: ${match[1]}`); }
  }
  if (!name || !Number.isSafeInteger(id) || id <= 0) throw new Error(`Invalid tag: ${source}`);
  return { id, name };
}

function parseTerms(source: string): FeedTag[] {
  const tags = splitTerms(source).map(parseTerm);
  if (!tags.length) throw new Error('A group cannot be empty');
  const seen = new Set<number>();
  return tags.filter((tag) => !seen.has(tag.id) && seen.add(tag.id));
}

function readGroups(source: string): { groups: FeedTag[][]; connectors: TagMode[] } {
  const groups: FeedTag[][] = [];
  const connectors: TagMode[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '(') throw new Error('Wrap each positive group in parentheses');
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = cursor + 1; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) escaped = false;
      else if (char === '\\' && quoted) escaped = true;
      else if (char === '"') quoted = !quoted;
      else if (char === ')' && !quoted) { end = index; break; }
    }
    if (end < 0) throw new Error('Unclosed group parenthesis');
    groups.push(parseTerms(source.slice(cursor + 1, end)));
    cursor = end + 1;
    const rest = source.slice(cursor);
    if (!rest.trim()) break;
    const connector = rest.match(/^\s+(AND|OR)\s+/i);
    if (!connector) throw new Error('Separate groups with AND or OR');
    connectors.push(connector[1].toLocaleUpperCase() === 'AND' ? 'all' : 'any');
    cursor += connector[0].length;
  }
  if (new Set(connectors).size > 1) throw new Error('Use one connector between positive groups');
  return { groups, connectors };
}

export function parseFeedTagExpression(source: string): FeedTagExpression {
  const input = source.trim();
  if (!input) throw new Error('Enter an expression first');
  let positive = input;
  let negatives: FeedTag[] = [];
  const notIndex = input.search(/(?:^|\s+AND\s+)NOT\s*\(/i);
  if (notIndex >= 0) {
    const notSource = input.slice(notIndex).replace(/^\s*AND\s+/i, '');
    const match = notSource.match(/^NOT\s*\(([\s\S]*)\)\s*$/i);
    if (!match) throw new Error('Write exclusions as NOT (tag OR tag)');
    negatives = parseTerms(match[1]);
    positive = input.slice(0, notIndex).trim();
  }
  const parsed = positive ? readGroups(positive) : { groups: [], connectors: [] as TagMode[] };
  if (!parsed.groups.length && !negatives.length) throw new Error('Expression has no tags');
  const occupied = new Set<number>();
  const groups = parsed.groups.map((group) => group.filter((tag) => {
    if (occupied.has(tag.id)) return false;
    occupied.add(tag.id);
    return true;
  })).filter((group) => group.length);
  negatives = negatives.filter((tag) => {
    if (occupied.has(tag.id)) return false;
    occupied.add(tag.id);
    return true;
  });
  return { groups, negatives, mode: parsed.connectors[0] ?? 'all' };
}
