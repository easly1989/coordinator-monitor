// The bus folder (`~/.claude/coordinator-monitor`, or the `busDir` option) is written by the mod alone: answers
// would let a session grant itself anything, rules.json or a status file loosen the rules or pose as another
// session. Reading it is harmless. A file tool is judged by its target path, so the mod's own source and docs
// stay editable; a shell command is judged by the words the shell reads from it, not by how it is written.

import { dataMask, unquote } from './rules'

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export type BusCall = { tool: string; input?: unknown; isReadOnly?: boolean }

// Every way to say the home folder, then one separator and one case.
const HOME = /\$\{home\}|\$home(?![\w])|\$env:(?:userprofile|home)(?![\w])|\$\{env:(?:userprofile|home)\}|%userprofile%|(?<=^|[\s;&|('"=:])~(?=$|[\s/'"])/g
const clean = (text: string, home: string): string => {
  let s = text.toLowerCase().replace(/\\/g, '/').replace(HOME, () => home).replace(/\/+/g, '/').replace(/\/\.(?=\/)/g, '')
  // Windows drops the dots at the end of a segment (`.claude./x` is `.claude/x`) and an alternate data stream
  // (`.claude::$INDEX_ALLOCATION/x` is `.claude/x`).
  s = s.replace(/(?<=[^/\s.])\.+(?=\/|$)/g, '').replace(/(?<=[^/\s:]{2})(?::[^/\s:]*)+(?=\/|$)/g, '')
  // `a/b/../c` is `a/c`.
  for (let n = 0; n < 8 && s.includes('/..'); n++) s = s.replace(/\/(?!\.\.(?:\/|$))[^/\s]+\/\.\.(?=\/|$)/g, '')
  return s
}

// A `.claude` path whose next segment (or the `.claude` itself) is a glob, a variable or a substitution: the
// name it stands for is not in the text. `cd` into `.claude` and then a word that starts like the folder.
const GLOB_NEXT = /\.claude\/[^\s/]*[*?[$`{]/
// A dot segment that holds a glob character is read as a glob: `.cl*`, `.claud[e]`. A variable, a substitution
// or a brace in it (`.$x`, `.{claude,x}`) is a name that is not in the text.
const GLOB_DOT = /(?:^|[\s/;&|('"=])(\.[^\s/]*[*?[$`{][^\s/]*)\//g
// A brace or a glob in the segment with `claud` in it: `{.,}claude/`, `.claud[e]/`.
const GLOB_WORD = /[^\s/]*[{[*?][^\s/]*claud[^\s/]*\/|[^\s/]*claud[^\s/]*[{[*?][^\s/]*\//
// The 8.3 name of the folder, `COORDI~1`.
const SHORT = /\.claude\/coordi~\d/
// `cd` into `.claude`, then a word in command position or an argument that starts like the folder's name.
const CD_THEN = /(?:^|[\s;&|(])(?:cd|pushd|sl|set-location|push-location)\s+(?:-\S+\s+)*[^\s;&|]*\.claude\/?(?=[\s;&|)]|$)[\s\S]*(?:^|[\s;&|('"=])(?:\.{1,2}\/)?coordi(?:nator(?:-(?:monitor|[^\s/]*[*?[{$`])?)?(?=[\s/'";&|)*?[{$`]|$)|~\d)/
const BUS_ENTRY = /\/coordinator-monitor\/(?:answers|sessions|rules\.json|queues\.json)(?=\/|$)/
const JOINED =/join-path|\[io\.path\]::combine/
// A link that can make the folder reachable under another name: a junction, a symlink or a hard link.
const LINK = /\bmklink\b|\bfsutil\s+hardlink\b|createsymboliclink|new-item\b[^;&|]*-(?:item)?type\s+['"]?(?:junction|symboliclink|hardlink)|(?:^|[\s;&|(])ln(?:\.exe)?\s/

const globMatches = (seg: string): boolean => {
  if (/[$`{]/.test(seg)) return true
  try {
    const re = seg.replace(/[.+^$(){}|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^')
    return new RegExp(`^${re}$`).test('.claude')
  } catch {
    return true
  }
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
  const p = path.toLowerCase().replace(HOME, () => home).replace(/\\/g, '/').replace(/^\/([a-z])\//, '$1:/')
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
  const names = (s: string) => s.includes('.claude/coordinator-monitor') || SHORT.test(s) || (!!b && s.includes(b))
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
  // Text only mentions the folder when every step prints or stores nothing (`git commit -m "…~/.claude/coordinator-monitor"`).
  if (!ps && !i.command.includes('<<') && dataMask(i.command) !== null) return false
  // PowerShell joins two strings with `+`: 'coord' + 'inator-monitor', in any mix of quotes.
  const raw = ps ? i.command.replace(/(['"])\s*\+\s*['"]/g, '') : i.command
  // The text, its words with the quotes and escapes gone, and the same where a backslash was a path separator.
  return [raw, unquote(raw, ps), unquote(raw.replace(/\\/g, '/'), ps)].some(t => {
    const s = clean(t, h)
    return (
      names(s) ||
      GLOB_NEXT.test(s) ||
      [...s.matchAll(GLOB_DOT)].some(m => globMatches(m[1] ?? '')) ||
      GLOB_WORD.test(s) ||
      CD_THEN.test(s) ||
      (LINK.test(s) && s.includes('claud')) ||
      (ps && JOINED.test(s) && s.includes('.claude') && s.includes('coordinator'))
    )
  })
}
