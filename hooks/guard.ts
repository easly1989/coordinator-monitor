// The bus folder (`~/.claude/coordinator-monitor`, or the `busDir` option) is written by the mod alone: answers
// would let a session grant itself anything, rules.json or a status file loosen the rules or pose as another
// session. Reading it is harmless. A file tool is judged by its target path, so the mod's own source and docs
// stay editable; a shell command is judged by the words the shell reads from it, not by how it is written.

import { dataMask, unquote } from './rules'

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
// `cd` into `.claude`, then a word in command position or an argument that starts like the folder's name.
const CD_THEN = /(?:^|[\s;&|(])(?:cd|pushd|sl|set-location|push-location)\s+(?:-\S+\s+)*[^\s;&|]*(?:\.claude|claude~\d+)\/?(?=[\s;&|)]|$)[\s\S]*(?:^|[\s;&|('"=])(?:\.{1,2}\/)?coordi(?:nator(?:-(?:monitor|[^\s/]*[*?[{$`])?)?(?=[\s/'";&|)*?[{$`]|$)|~\d)/
const CD_STEP = /^\s*(?:cd|pushd|sl|set-location|push-location)(?:\s|$)/i
const BUS_ENTRY = /\/coordinator-monitor\/(?:answers|sessions|rules\.json|queues\.json)(?=\/|$)/
const JOINED = /join-path|\[io\.path\]::combine/
// A link that can make the folder reachable under another name: a junction, a symlink or a hard link.
const LINK = /\bmklink\b|\bfsutil\s+hardlink\b|createsymboliclink|new-item\b[^;&|]*-(?:item)?type\s+['"]?(?:junction|symboliclink|hardlink)|(?:^|[\s;&|(])ln(?:\.exe)?\s/

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
  if (/[$`]/.test(seg)) return true
  const words = expand(seg)
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
    [text, unquote(text, ps), unquote(text.replace(/\\/g, '/'), ps)].some(t => {
      const s = clean(t, h)
      return (
        names(s) ||
        globHits(s) ||
        CD_THEN.test(s) ||
        (LINK.test(s) && DSEG.test(s)) ||
        (ps && JOINED.test(s) && s.includes('.claude') && s.includes('coordinator'))
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
