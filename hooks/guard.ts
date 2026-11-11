// The bus folder (`~/.claude/coordinator-monitor`, or the `busDir` option) is written by the mod alone: answers
// would let a session grant itself anything, rules.json or a status file loosen the rules or pose as another
// session. Reading it is harmless. A file tool is judged by its target path, so the mod's own source and docs
// stay editable; a shell command is judged by the words the shell reads from it, not by how it is written.

import { afterRule, dataMask, unquote } from './rules'

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export type BusCall = { tool: string; input?: unknown; isReadOnly?: boolean }

// Every way to say the home folder, then one separator and one case.
const HOME = /\$\{home\}|\$home(?![\w])|\$env:(?:userprofile|home)(?![\w])|\$\{env:(?:userprofile|home)\}|%userprofile%|(?<=^|[\s;&|('"=:])~(?=$|[\s/'"])/g
// A device prefix (`\.\C:\`, `\?\C:\`, `\?\UNC\host\`) and an administrative share (`\localhost\C$\`) name the same
// drive: they are dropped at the start of a word, in `/` spelling.
const DEVICE = /(?<=^|[\s;&|('"=])\/\/[.?]\/(?:unc\/[^/\s]+\/)?/g
const ADMIN = /(?<=^|[\s;&|('"=])(?:\/\/[^/\s]+\/)?([a-z])\$\//g
const drive = (s: string): string => s.replace(DEVICE, '').replace(ADMIN, '$1:/')

const clean = (text: string, home: string): string => {
  let s = drive(text.toLowerCase().replace(/\\/g, '/').replace(HOME, () => home))
    .replace(/\/+/g, '/')
    .replace(/\/\.(?=\/|[\s'";&|)]|$)/g, '')
  // Windows drops the dots at the end of a segment (`.claude./x` is `.claude/x`) and an alternate data stream
  // (`.claude::$INDEX_ALLOCATION/x` is `.claude/x`).
  s = s.replace(/(?<=[^/\s.])\.+(?=\/|$)/g, '').replace(/(?<=[^/\s:]{2})(?::[^/\s:]*)+(?=\/|$)/g, '')
  // `a/b/../c` is `a/c`.
  for (let n = 0; n < 8 && s.includes('/..'); n++) s = s.replace(/\/(?!\.\.(?:\/|$))[^/\s]+\/\.\.(?=\/|$)/g, '')
  return s
}

// The folder `.claude` by name, or by its 8.3 name `CLAUDE~1`, as a whole path segment.
const DSEG = /(?<![\w.-])(?:\.claude|claude~\d+)(?![\w.-])/
const D_EXACT = /^(?:\.claude|claude~\d+)$/
const NAMES = /(?:\.claude|claude~\d+)\/(?:coordinator-monitor|coordi~\d)/
const CD_HEAD = /(?:^|[\s;&|(])(?:cd|pushd|sl|set-location|push-location)\s+/g
const CD_OPT = /-\S*\s+/y
const CD_TARGET = /[^\s;&|]*/y
const CD_STEP = /^\s*(?:cd|pushd|sl|set-location|push-location)(?:\s|$)/i
const BUS_ENTRY = /\/coordinator-monitor\/(?:answers|sessions|rules\.json|queues\.json)(?=\/|$)/
const JOINED = /join-path|\[io\.path\]::combine/
// A link that can make the folder reachable under another name: a junction, a symlink or a hard link.
const LINK = /\bmklink\b|\bfsutil\s+hardlink\b|createsymboliclink|(?:^|[\s;&|(])ln(?:\.exe)?\s/
const LINK_ITEM = afterRule('link', String.raw`(?:\bnew-item\b|(?:^|[\s;&|(])ni(?=\s))`, /-(?:item)?type\s+['"]?(?:junction|symboliclink|hardlink)/)
const isLink = (s: string): boolean => LINK.test(s) || LINK_ITEM.re.test(s)
// What a `cd` into the folder may be followed by: a word that starts like the folder's name (`CM/rules.json`,
// `>CM/x`, `./CM*`).
const AFTER_CD = /(?:^|[\s;&|('"=<>])(?:\.{1,2}\/)?coordi(?:nator(?:-(?:monitor|[^\s/]*[*?[{$`])?)?(?=[\s/'";&|)*?[{$`]|$)|~\d)/
// A command that puts files in a folder: copy, move, extract, link. Its destination is its last word, the word a
// destination flag takes (`-C dir`, `-d dir`, `-t dir`, `-o dir`, `--directory`, `-Destination`), and for the
// Windows ones every word (their switches look like paths).
const COPY = new Set(['cp', 'mv', 'install', 'rsync', 'ln', 'ditto', 'scp', 'tar', 'bsdtar', 'unzip', '7z', '7za', '7zr', 'copy', 'xcopy', 'robocopy', 'move', 'copy-item', 'move-item', 'cpi', 'mi', 'expand-archive'])
const EVERY_WORD = new Set(['copy', 'xcopy', 'robocopy', 'move'])
const DEST_FLAG = /^--?(?:directory|target-directory|destination(?:path)?|dest|dp|[cdto])$/
const DEST_GLUED = /^-[cdto]([^-].*)$/
// An extended glob (`@(a|b)`, `*(x)`, `+(x)`, `?(x)`, `!(x)`) may match anything.
const EXTGLOB = /[@*+?!]\([^\s)]*\)?/g
const WORDS = /[\s;&|('")=]+/
const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1).replace(/\.exe$/, '')
const hasCopy = (s: string): boolean => s.split(WORDS).some(w => COPY.has(base(w)))

// Matching a glob needs no regex (a regex built from the text can be made to take seconds): `*` any run, `?` one
// character, `[a-c]` / `[!x]` a class. A class with a POSIX name inside matches anything.
const tokens = (p: string): string[] | null => {
  const out: string[] = []
  for (let n = 0; n < p.length; n++) {
    if (p[n] === '[') {
      const e = p.indexOf(']', n + 2)
      if (e < 0) return null
      out.push(p.slice(n, e + 1))
      n = e
    } else out.push(p[n] ?? '')
  }
  return out
}
const one = (tok: string, ch: string): boolean => {
  if (tok === '?') return true
  if (tok.length < 2 || tok[0] !== '[') return tok === ch
  let body = tok.slice(1, -1)
  const neg = body[0] === '!' || body[0] === '^'
  if (neg) body = body.slice(1)
  if (body.includes('[')) return true
  let hit = false
  for (let n = 0; n < body.length; n++) {
    if (body[n + 1] === '-' && n + 2 < body.length) {
      if (ch >= (body[n] ?? '') && ch <= (body[n + 2] ?? '')) hit = true
      n += 2
    } else if (body[n] === ch) hit = true
  }
  return hit !== neg
}
const wild = (p: string[], text: string): boolean => {
  let i = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    const tok = p[i]
    if (tok === '*') {
      star = i++
      mark = t
    } else if (tok !== undefined && one(tok, text[t] ?? '')) {
      i++
      t++
    } else if (star >= 0) {
      i = star + 1
      t = ++mark
    } else return false
  }
  while (p[i] === '*') i++
  return i === p.length
}

/** `{a,b}` expanded, at most 64 words; null when a brace is left open or there are more. */
const expand = (s: string, left = { n: 64 }): string[] | null => {
  const a = s.indexOf('{')
  if (a < 0) return [s]
  let depth = 0
  let end = -1
  const cuts = [a]
  for (let n = a; n < s.length && end < 0; n++) {
    const c = s[n]
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) end = n
    else if (c === ',' && depth === 1) cuts.push(n)
  }
  if (end < 0) return null
  const rest = expand(s.slice(end + 1), left)
  if (!rest) return null
  const out: string[] = []
  for (const alt of cuts.length > 1 ? cuts.map((x, k) => s.slice(x + 1, cuts[k + 1] ?? end)) : [s.slice(a, end + 1)]) {
    const mid = cuts.length > 1 ? expand(alt, left) : [alt]
    if (!mid) return null
    for (const m of mid)
      for (const r of rest) {
        if (--left.n < 0) return null
        out.push(s.slice(0, a) + m + r)
      }
  }
  return out
}

/**
 * A path segment that a shell or Windows could read as `.claude` (or `CLAUDE~1`): a glob, a class, a brace or a
 * variable in a segment that starts with a dot, holds `claud`, or opens with `[` or `{`. A segment is read one
 * piece at a time: nothing here backtracks.
 */
const couldBeD = (seg: string): boolean => {
  if (!/[*?[{$`]/.test(seg) || !(seg.startsWith('.') || seg.includes('claud') || /^[[{]/.test(seg))) return false
  if (/[$`]/.test(seg) || seg.length > 256) return true
  // A brace sequence (`{a..z}`) and a PowerShell format slot (`{0}`) stand for any text.
  const words = expand(seg.replace(/\{[^{},]*\.\.[^{},]*\}|\{\d+\}/g, '*'))
  return !words || words.some(w => {
    const t = tokens(w)
    return !t || wild(t, '.claude') || wild(t, 'claude~1')
  })
}

// A word that names the folder through a glob, a class, a brace, a variable or a substitution: `.cl[^x]ude/`,
// `{.,}claude/`, `.claude/c*`. The segment must be followed by another one, so `ls .*/` and a URL stay quiet.
const globHits = (s: string): boolean => {
  for (const word of s.split(/[\s;&|('"=]+/)) {
    const parts = word.split('/')
    for (let k = 0; k < parts.length - 1; k++) {
      const seg = parts[k] ?? ''
      const next = parts[k + 1] ?? ''
      if (!next) continue
      if (D_EXACT.test(seg) && /[*?[{$`]/.test(next)) return true
      if (couldBeD(seg)) return true
    }
  }
  return false
}

// Any path segment of any word, the last one too, that could be the folder: where a link points.
const anyD = (s: string): boolean => s.split(WORDS).some(word => word.split('/').some(couldBeD))

/** The real folder behind a path: the deepest part that exists is resolved (8.3 names, junctions, symlinks), the rest is kept. */
const realOf = (segs: string[]): string => {
  let fs: { realpathSync: { native: (p: string) => string } } | undefined
  try {
    fs = (globalThis as { process?: { getBuiltinModule?: (n: string) => unknown } }).process?.getBuiltinModule?.('node:fs') as typeof fs
  } catch {
    // no file system to ask: the path as written is all there is
  }
  for (let k = segs.length; fs && k > 0; k--) {
    try {
      const head = fs.realpathSync.native(segs.slice(0, k).join('\\') + (k === 1 ? '\\' : ''))
      return [head.replace(/\\/g, '/').replace(/\/+$/, ''), ...segs.slice(k)].join('/').toLowerCase()
    } catch {
      // does not exist: try its parent
    }
  }
  return segs.join('/').toLowerCase()
}

/** A path as Windows reads it: `..` collapsed whatever the names hold, no trailing dots or spaces, no stream suffix. */
const segments = (path: string, home: string): string[] => {
  const segs: string[] = []
  const p = drive(path.toLowerCase().replace(HOME, () => home).replace(/\\/g, '/')).replace(/^\/([a-z])\//, '$1:/')
  for (const [n, seg] of p.split('/').entries()) {
    if (seg === '..') segs.length > 1 && segs.pop()
    else if (seg && seg !== '.') {
      const s = n === 0 && /^[a-z]:$/.test(seg) ? seg : seg.replace(/:.*$/, '').replace(/[. ]+$/, '')
      if (s) segs.push(s)
    }
  }
  return segs
}

/** A word that names the folder itself or, through a glob, a brace or a variable, could (`..` collapsed). */
const isD = (word: string, home: string): boolean => {
  if (word.length > 1024) return true
  // The folder's name has a dot, or is spelt with a `~`, a glob, a brace, a variable or a substitution.
  if (!/[.~*?[{$%`(@!+]/.test(word)) return false
  const segs = segments(word.replace(/['"]/g, ''), home)
  const last = segs[segs.length - 1] ?? ''
  return D_EXACT.test(last) || couldBeD(last)
}

/**
 * A `cd` into the folder followed by a word that starts like the bus folder's name or by a copy, move, extract or
 * link. Only the first such `cd` is read to the end of the text (every later one's rest is part of it), so the
 * time is linear.
 */
const cdThen = (s: string, home: string): boolean => {
  CD_HEAD.lastIndex = 0
  for (let m = CD_HEAD.exec(s); m; m = CD_HEAD.exec(s)) {
    let at = m.index + m[0].length
    CD_OPT.lastIndex = at
    while (CD_OPT.test(s)) at = CD_OPT.lastIndex
    CD_TARGET.lastIndex = at
    const target = CD_TARGET.exec(s)?.[0] ?? ''
    if (!isD(target, home)) continue
    const rest = s.slice(at + target.length)
    return AFTER_CD.test(rest) || hasCopy(rest)
  }
  return false
}

/** A copy, move, extract or link whose destination could be the folder. */
const destHit = (s: string, home: string): boolean => {
  for (const step of s.split(/[;&|\n]+/)) {
    const words = step.split(WORDS)
    const at = words.findIndex(w => COPY.has(base(w)))
    if (at < 0) continue
    const args = words.slice(at + 1).filter(Boolean)
    const dests = EVERY_WORD.has(base(words[at] ?? '')) ? args : [args.filter(w => !w.startsWith('-')).pop() ?? '']
    args.forEach((w, k) => {
      if (DEST_FLAG.test(w)) dests.push(args[k + 1] ?? '')
      const glued = DEST_GLUED.exec(w)?.[1]
      if (glued) dests.push(glued.replace(/^~(?=\/|$)/, home))
    })
    if (dests.some(d => d && isD(d, home))) return true
  }
  return false
}

/** True when a call that is not read-only writes the bus folder `base`. `home` is the person's home folder. */
export const touchesBus = (e: BusCall, base: string, home: string): boolean => {
  if (e.isReadOnly) return false
  const h = home.toLowerCase()
  const b = clean(base, h)
  const names = (s: string) => NAMES.test(s) || (!!b && s.includes(b))
  const i = (e.input ?? {}) as Record<string, unknown>
  if (!SHELL_TOOLS.has(e.tool) || typeof i.command !== 'string') {
    const target = i.file_path ?? i.notebook_path ?? i
    const text = typeof target === 'string' ? target : JSON.stringify(target)
    const c = clean(text, h)
    // The bus folder's own entries under a folder of that name, whatever the path before it: a junction to `.claude`
    // makes the same folder appear elsewhere, and a host with no way to resolve a path still sees the entry.
    if (names(c) || BUS_ENTRY.test(c)) return true
    if (typeof target !== 'string') return false
    // The path as the file system reads it: aliases (`COORDI~1`, `a b/..`, `.claude./`, a stream, a junction) resolved.
    const own = segments(base, h)
    const mine = segments(target, h)
    const under = (x: string[], y: string[]) => y.length > 0 && y.every((s, n) => x[n] === s)
    return under(mine, own) || (() => {
      const real = realOf(mine)
      const root = realOf(own)
      return real === root || real.startsWith(`${root}/`)
    })()
  }
  const ps = e.tool === 'PowerShell'
  // PowerShell joins two strings with `+`: 'coord' + 'inator-monitor', in any mix of quotes.
  const raw = ps ? i.command.replace(/(['"])\s*\+\s*['"]/g, '') : i.command
  // The text, its words with the quotes and escapes gone, and the same where a backslash was a path separator.
  const check = (text: string): boolean =>
    [...new Set([text, unquote(text, ps), unquote(text.replace(/\\/g, '/'), ps)])].some(t => {
      const s = clean(t, h)
      const x = s.replace(EXTGLOB, '*')
      return (
        names(s) ||
        (ps && JOINED.test(s) && s.includes('.claude') && s.includes('coordinator')) ||
        (x === s ? [s] : [s, x]).some(v => globHits(v) || cdThen(v, h) || (isLink(v) && (DSEG.test(v) || anyD(v))) || destHit(v, h))
      )
    })
  // Text only mentions the folder when every step prints or stores nothing (`git commit -m "…~/.claude/coordinator-monitor"`):
  // then only a `cd` is judged, for it moves the shell into the folder whatever it is quoted with.
  if (!ps && !i.command.includes('<<') && dataMask(i.command) !== null) {
    const cds = i.command.split(/[;&|\n]+/).filter(x => CD_STEP.test(x))
    return cds.length > 0 && check(cds.join(';'))
  }
  return check(raw)
}
