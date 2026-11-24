// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** For each current path, the path before the patch whose content it carries (moves only). */
  readonly movedFrom = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Move the content at oldP to newP (oldP exists in the tree as the edits left it). */
  move(oldP: string, newP: string): void {
    const content = this.get(oldP);
    const from = this.movedFrom.get(oldP) ?? oldP;
    if (from !== newP) this.movedFrom.set(newP, from);
    this.movedFrom.delete(oldP);
    this.now.set(newP, content);
    this.now.set(oldP, null);
  }
  /** Delete the file at p. */
  remove(p: string): void {
    this.movedFrom.delete(p);
    this.now.set(p, null);
  }
  /** Create the file at p with fresh content (not a move). */
  create(p: string, text: string): void {
    this.movedFrom.delete(p);
    this.now.set(p, text);
  }
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function fileParts(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinParts(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One line as a tier reads it (SPEC.md section 5): tier 0 exact, tier 1 trailing spaces/tabs off, tier 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in F at a tier; occurrences may overlap. */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > F.length) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(F[i + k]!, tier) !== nO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in F, with its positions; null when it occurs at no tier. */
function findTier(O: string[], F: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, F, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`; for end-of-file chunks only ones ending at the last line. */
function findTierFrom(
  O: string[],
  F: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(O, F, t).filter((p) => p >= from);
    if (eof) occ = occ.filter((p) => p + O.length === F.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is; -1 when there is none. */
function findAnchor(lines: string[], from: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === a) return i;
    }
  }
  return -1;
}

function indentOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * The lines N writes over a match at pos: a context line is written as the file's own matched line
 * (nFromO[i] names its index in O), every other line of N is re-indented at tier 2 and written as it is else.
 */
function buildNew(
  F: string[],
  pos: number,
  O: string[],
  N: string[],
  nFromO: (number | null)[],
  tier: number,
): string[] {
  const out: string[] = [];
  const P = O.length > 0 ? indentOf(O[0]!) : '';
  const Fp = pos < F.length ? indentOf(F[pos]!) : '';
  for (let i = 0; i < N.length; i++) {
    const oi = nFromO[i];
    if (oi !== null && oi !== undefined) {
      out.push(F[pos + oi]!);
    } else if (tier === 2) {
      const line = N[i]!;
      if (line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(Fp + line.slice(P.length));
      else out.push(line);
    } else {
      out.push(N[i]!);
    }
  }
  return out;
}

/** Split hunk/chunk body items into O lines, N lines and, for each N line, its index in O when it is a context line. */
function splitON(items: { kind: 'ctx' | 'old' | 'new'; text: string }[]): {
  O: string[];
  N: string[];
  nFromO: (number | null)[];
} {
  const O: string[] = [];
  const N: string[] = [];
  const nFromO: (number | null)[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      O.push(it.text);
      N.push(it.text);
      nFromO.push(oi);
      oi++;
    } else if (it.kind === 'old') {
      O.push(it.text);
      oi++;
    } else {
      N.push(it.text);
      nFromO.push(null);
    }
  }
  return { O, N, nFromO };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: its A and its body items; `bs` says a `\` line follows the item. */
interface Hunk {
  a: number;
  items: { kind: 'ctx' | 'old' | 'new'; text: string; bs: boolean }[];
}

/** Whether a `\` line follows the hunk's last context-or-new line (cp) and its last new line (plus). */
function hunkBs(h: Hunk): { cp: boolean; plus: boolean } {
  let cp = false;
  let plus = false;
  for (const it of h.items) {
    if (it.kind === 'ctx' || it.kind === 'new') cp = it.bs;
    if (it.kind === 'new') plus = it.bs;
  }
  return { cp, plus };
}

/** Parse a unified diff patch (SPEC.md section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Section {
    oldP: string | null | undefined;
    newP: string | null | undefined;
    diffOld: string | undefined;
    diffNew: string | undefined;
    renameOld: string | undefined;
    renameNew: string | undefined;
    createFlag: boolean;
    deleteFlag: boolean;
    hasPair: boolean;
    hunks: Hunk[];
  }
  const sections: Section[] = [];
  let cur: Section | null = null;
  const startSection = (): Section => {
    const s: Section = {
      oldP: undefined,
      newP: undefined,
      diffOld: undefined,
      diffNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      createFlag: false,
      deleteFlag: false,
      hasPair: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => stripAB(line.slice(4).split('\t')[0]!.trim());
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l.trimEnd());
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      let s: Section;
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) s = cur;
      else s = startSection();
      const op = headerPath(l);
      const np = headerPath(lines[i + 1]!);
      s.oldP = op === '/dev/null' ? null : op;
      s.newP = np === '/dev/null' ? null : np;
      s.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const items: Hunk['items'] = [];
      let j = i + 1;
      let lastWasItem = false;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          const kind = b === '' || b.startsWith(' ') ? 'ctx' : b.startsWith('-') ? 'old' : 'new';
          items.push({ kind, text: b === '' ? '' : b.slice(1), bs: false });
          lastWasItem = true;
          j++;
        } else if (b.startsWith('\\')) {
          if (lastWasItem && items.length > 0) items[items.length - 1]!.bs = true;
          lastWasItem = false;
          j++;
        } else break;
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && !last.bs) items.pop();
        else break;
      }
      cur.hunks.push({ a, items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('+++ ')) {
        const p = headerPath(l);
        cur.newP = p === '/dev/null' ? null : p;
        i++;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice('rename from '.length).split('\t')[0]!.trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice('rename to '.length).split('\t')[0]!.trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.createFlag = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deleteFlag = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    edits.push(makeUnifiedEdit(s, strict));
  }
  return edits;
}

function makeUnifiedEdit(
  s: {
    oldP: string | null | undefined;
    newP: string | null | undefined;
    diffOld: string | undefined;
    diffNew: string | undefined;
    renameOld: string | undefined;
    renameNew: string | undefined;
    createFlag: boolean;
    deleteFlag: boolean;
    hunks: Hunk[];
  },
  strict: boolean,
): Edit {
  const oldRaw = s.oldP !== undefined ? s.oldP : s.renameOld !== undefined ? s.renameOld : s.diffOld;
  const newRaw = s.newP !== undefined ? s.newP : s.renameNew !== undefined ? s.renameNew : s.diffNew;
  const oldPath = oldRaw === undefined ? '' : oldRaw;
  const newPath = newRaw === undefined ? '' : newRaw;
  const isCreate = oldPath === null || s.createFlag;
  const isDelete = !isCreate && (newPath === null || s.deleteFlag);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree) => {
    if (typeof oldPath === 'string' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (typeof newPath === 'string' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let bsAfterLastPlus = false;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            plus.push(it.text);
            bsAfterLastPlus = it.bs;
          }
        }
      }
      const content = plus.length === 0 ? '' : plus.join('\n') + (bsAfterLastPlus ? '' : '\n');
      tree.create(newPath, content);
      return;
    }
    if (isDelete) {
      if (tree.get(oldPath as string) === null) throw new Fail('missing', oldPath as string);
      tree.remove(oldPath as string);
      return;
    }
    const op = oldPath as string;
    if (tree.get(op) === null) throw new Fail('missing', op);
    if (isMove && tree.get(newPath as string) !== null) throw new Fail('exists', newPath as string);
    let parts = fileParts(tree.get(op)!);
    let d = 0;
    for (const h of s.hunks) {
      const { O, N, nFromO } = splitON(h.items);
      const bs = hunkBs(h);
      if (O.length === 0) {
        const insertPos = Math.max(0, Math.min(h.a + d, parts.lines.length));
        const atEnd = insertPos === parts.lines.length;
        const newLines = buildNew(parts.lines, insertPos, O, N, nFromO, 0);
        parts = {
          ...parts,
          lines: [...parts.lines.slice(0, insertPos), ...newLines, ...parts.lines.slice(insertPos)],
          final: atEnd ? !bs.cp : parts.final,
        };
        d += N.length;
        continue;
      }
      const found = findTier(O, parts.lines, strict);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const pos = best;
      const newLines = buildNew(parts.lines, pos, O, N, nFromO, found.tier);
      const atEnd = pos + O.length === parts.lines.length;
      parts = {
        ...parts,
        lines: [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + O.length)],
        final: atEnd ? !bs.cp : parts.final,
      };
      d += N.length - O.length;
    }
    const out = joinParts(parts.lines, parts.br, parts.final);
    if (isMove) {
      tree.move(op, newPath as string);
      tree.now.set(newPath as string, out);
    } else {
      tree.now.set(op, out);
    }
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const O = lines.slice(s + 1, eq);
    const N = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, O, N, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function makeSREdit(path: string, O: string[], N: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (O.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.create(path, N.length === 0 ? '' : N.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const parts = fileParts(text);
    const found = findTier(O, parts.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const nFromO: (number | null)[] = N.map(() => null);
    const newLines = buildNew(parts.lines, pos, O, N, nFromO, found.tier);
    const out = [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + O.length)];
    tree.now.set(path, joinParts(out, parts.br, parts.final));
  };
}

/** Parse a V4A patch (SPEC.md section 8) into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const l = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i + 1;
    i++;
    const body: { text: string; no: number }[] = [];
    while (i < last) {
      const m = lines[i]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      body.push({ text: m, no: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    edits.push(makeV4aEdit(kind, path, body, startLine, strict));
  }
  return edits;
}

function makeV4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  body: { text: string; no: number }[],
  sectionLine: number,
  strict: boolean,
): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const b of body) {
      if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
      else if (b.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${b.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.create(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const b of body) {
      if (!blank(b.text)) throw new Exit2(`error: parse ${b.no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.remove(path);
    };
  }
  interface VChunk {
    anchor: string | null;
    eof: boolean;
    items: { kind: 'ctx' | 'old' | 'new'; text: string }[];
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < body.length && body[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = body[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let open: VChunk | null = null;
  let seenChunk = false;
  while (idx < body.length) {
    const { text, no } = body[idx]!;
    if (text.startsWith('@@')) {
      const a = text.slice(2).trim();
      open = { anchor: a === '' ? null : a, eof: false, items: [] };
      chunks.push(open);
      seenChunk = true;
      idx++;
    } else if (text === '*** End of File') {
      if (open === null) throw new Exit2(`error: parse ${no}`);
      open.eof = true;
      open = null;
      idx++;
    } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (open === null) {
        if (seenChunk) throw new Exit2(`error: parse ${no}`);
        open = { anchor: null, eof: false, items: [] };
        chunks.push(open);
        seenChunk = true;
      }
      const k = text === '' ? 'ctx' : text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'old' : 'new';
      open.items.push({ kind: k, text: text === '' ? '' : text.slice(1) });
      idx++;
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let parts = fileParts(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(parts.lines, cursor, ch.anchor, strict);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const { O, N, nFromO } = splitON(ch.items);
      if (O.length === 0) {
        const insertPos = ch.eof ? parts.lines.length : cursor;
        const newLines = buildNew(parts.lines, insertPos, O, N, nFromO, 0);
        parts = {
          ...parts,
          lines: [...parts.lines.slice(0, insertPos), ...newLines, ...parts.lines.slice(insertPos)],
        };
        cursor = insertPos + N.length;
        continue;
      }
      const found = findTierFrom(O, parts.lines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const newLines = buildNew(parts.lines, pos, O, N, nFromO, found.tier);
      parts = {
        ...parts,
        lines: [...parts.lines.slice(0, pos), ...newLines, ...parts.lines.slice(pos + O.length)],
      };
      cursor = pos + N.length;
    }
    const out = joinParts(parts.lines, parts.br, parts.final);
    if (moveTo !== null) {
      tree.move(path, moveTo);
      tree.now.set(moveTo, out);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (now === null) {
      let suppressed = false;
      for (const [q, from] of tree.movedFrom) {
        if (from === p && tree.now.get(q) !== null && tree.original(q) === null) {
          suppressed = true;
          break;
        }
      }
      if (!suppressed) rows.push(`D ${p}`);
    } else {
      const from = tree.movedFrom.get(p);
      if (
        from !== undefined &&
        from !== p &&
        tree.original(from) !== null &&
        tree.original(p) === null &&
        tree.now.get(from) === null
      ) {
        rows.push(`R ${from} -> ${p}`);
      } else {
        rows.push(`${was === null ? 'A' : 'M'} ${p}`);
      }
    }
  }
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
