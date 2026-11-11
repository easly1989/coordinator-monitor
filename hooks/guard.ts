// The bus folder (`~/.claude/coordinator-monitor`, or the `busDir` option) is written by the mod alone: answers
// would let a session grant itself anything, rules.json or a status file loosen the rules or pose as another
// session. Reading it is harmless. A file tool is judged by its target path, so the mod's own source and docs
// stay editable; a shell command is judged by the words the shell reads from it, not by how it is written.

import { afterRule, dataMask, unquote } from './rules'

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export type BusCall = { tool: string; input?: unknown; isReadOnly?: boolean }

// Every way to say the home folder, then one separator and one case.
const HOME = /\$\{home\}|\$home(?![\w])|\$env:(?:userprofile|home)(?![\w])|\$\{env:(?:userprofile|home)\}|%userprofile%|(?<=^|[\s;&|('"=:<>])~(?=$|[\s/'";&|)])/g
// A device prefix (`\.\C:\`, `\?\C:\`, `\?\UNC\host\`) and an administrative share (`\localhost\C$\`) name the same
// drive: they are dropped at the start of a word, in `/` spelling.
const DEVICE = /(?<=^|[\s;&|('"=])\/\/[.?]\/(?:unc\/[^/\s]+\/)?/g
const ADMIN = /(?<=^|[\s;&|('"=])(?:\/\/[^/\s]+\/)?([a-z])\$\//g
// A regex runs over a long text only when the text has what it needs: home expands to 14 characters per `~`.
const drive = (s: string): string => {
  const d = s.includes('//') ? s.replace(DEVICE, '') : s
  return d.includes('$/') ? d.replace(ADMIN, '$1:/') : d
}

// `a/b/../c` is `a/c`, at any depth. A name may hold spaces, and the text does not say where a name starts, so it is
// read twice: a name ends at a quote, a separator or an operator (`spaces`), or also at a space.
const collapse = (s: string, spaces: boolean): string => {
  if (!s.includes('..')) return s
  const edge = (c: string): boolean => /['";&|<>=()]/.test(c) || (!spaces && /\s/.test(c))
  const out: string[] = []
  for (const piece of s.split('/')) {
    const top = out[out.length - 1]
    if (top === undefined || piece !== '..') {
      out.push(piece)
      continue
    }
    let k = top.length
    while (k > 0 && !edge(top[k - 1] ?? '')) k--
    const name = top.slice(k)
    if (!name || name === '..') {
      out.push(piece)
      continue
    }
    out.pop()
    const keep = top.slice(0, k) + piece.slice(2)
    if (keep) out.push(keep)
  }
  return out.join('/')
}

/** The text as the file system reads it, in two views: names end at a space or an operator, or only at an operator. */
const clean = (text: string, home: string): [string, string] => {
  const s = drive(
    text
      .toLowerCase()
      // `-Path:value` is `-Path value`.
      .replace(/(?<=^|[\s;&|(])(-[a-z]+):(?=\S)/g, '$1 ')
      .replace(/\\/g, '/')
      .replace(HOME, () => home),
  )
    .replace(/\/+/g, '/')
    .replace(/\/\.(?=\/|[\s'";&|)]|$)/g, '')
  // Windows drops the dots at the end of a segment (`.claude./x` is `.claude/x`) and an alternate data stream
  // (`.claude::$INDEX_ALLOCATION/x` is `.claude/x`); `$(:)` is no stream.
  // A blank at the end of a segment is dropped too, but only in the view that reads names with blanks in them.
  // A drive (`>>D:/bus`, `--target-directory=D:/bus`) is a letter that starts a word, then a bare colon: it stays.
  const bare = (t: string): string => streams(t.includes('.') ? t.replace(/(?<=[^/\s.])\.+(?=\/|$)/g, '') : t)
  const blanks = s.includes('claude') ? s.replace(/(?<=claude(?:~\d)?) +(?=\/)/g, '') : s
  const pre = bare(s)
  const plain = collapse(pre, false)
  // The second view differs only where a blank ends a name or `..` is collapsed: otherwise it is the first.
  return [plain, blanks === s && !pre.includes('..') ? plain : collapse(blanks === s ? pre : bare(blanks), true)]
}

/**
 * Drops the stream suffixes: a run of `:name` after two characters that are no separator, ending at a `/` or at the
 * end of the text (a lone `:` after a letter that starts a word is a drive and stays). One pass, a run is measured
 * once: a regex that backtracks over the run from every colon is quadratic.
 */
const streams = (s: string): string => {
  const lead = /[/\s:($'"\]]/
  const stop = /[/\s()'",\]]/
  let out = ''
  let last = 0
  let end = -1
  let ok = false
  for (let p = s.indexOf(':'); p >= 0; p = s.indexOf(':', p + 1)) {
    if (p < 2 || lead.test(s[p - 1] ?? '') || lead.test(s[p - 2] ?? '')) continue
    if (p >= end) {
      end = p + 1
      while (end < s.length && !stop.test(s[end] ?? '')) end++
      ok = end === s.length || s[end] === '/'
    }
    if (!ok) continue
    out += s.slice(last, p) + (end === p + 1 && /[a-z]/.test(s[p - 1] ?? '') && !/[\w.~-]/.test(s[p - 2] ?? '') ? ':' : '')
    last = end
    p = end - 1
  }
  return out + s.slice(last)
}

// The folder `.claude` by name, or by its 8.3 name `CLAUDE~1`, as a whole path segment.
const DSEG = /(?<![\w.-])(?:\.claude|claude~\d+)(?![\w.-])/
const D_EXACT = /^(?:\.claude|claude~\d+)$/
const NAMES = /(?:\.claude|claude~\d+)\/(?:coordinator-monitor|coordi~\d)/
const CD_HEAD = /(?:^|[\s;&|(])(?:cd|chdir|pushd|sl|set-location|push-location)\s+/g
const CD_OPT = /(?:-[\w-]*(?=\s)|\/d(?=\s))\s+/y
const CD_TARGET = /[^\s;&|]*/y
const CD_STEP = /^\s*(?:cd|chdir|pushd|sl|set-location|push-location)(?:\s|$)/i
const BUS_ENTRY = /\/coordinator-monitor\/(?:answers|sessions|rules\.json|queues\.json)(?=\/|$)/
const JOINED = /join-path|path\]::(?:combine|join)/
// A path built from pieces at run time: `-join`, or `+` between two terms.
const DYNAMIC = /-join(?![\w-])|\+/
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
// A PowerShell parameter may be cut to any prefix that no other one shares (`-Destin`, `-DestinationPa`): any prefix
// of `-DestinationPath` names the destination here, `-d` included.
const PS_COPY = new Set(['copy-item', 'move-item', 'cpi', 'mi', 'expand-archive'])
const destFlag = (cmd: string, w: string): boolean => DEST_FLAG.test(w) || (PS_COPY.has(cmd) && /^-[a-z]+$/.test(w) && 'destinationpath'.startsWith(w.slice(1)))
const EXTRACT_DIR = /extracttodirectory$/
// An extended glob (`@(a|b)`, `*(x)`, `+(x)`, `?(x)`, `!(x)`) may match anything.
const EXTGLOB = /[@*+?!]\([^\s)]*\)?/g
const WORDS = /[\s;&|('")=]+/
const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1).replace(/\.exe$/, '')
// A step that only prints or tests: it writes nothing unless it redirects or runs a substitution.
const READ = new Set(['ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'stat', 'wc', 'grep', 'rg', 'tree', 'du', 'pwd', 'echo', 'printf', 'test', '[', '[[', 'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'test-path', 'select-string', 'sls'])
// `tree -o file` writes the file.
const readOnly = (step: string): boolean => {
  const words = step.split(WORDS).filter(Boolean)
  const cmd = base(words[0] ?? '')
  return !/[>`]|\$\(|<\(/.test(step) && READ.has(cmd) && !(cmd === 'tree' && words.some(w => /^-[a-z]*o/.test(w) || w.startsWith('--output')))
}
// After a `cd` into the `.claude` folder: a word whose first part, through a glob, a class or a brace, could be the bus folder.
const globbed = (step: string): boolean =>
  step.split(WORDS).some(w => {
    const seg = w.replace(/^\d?[<>]+/, '').replace(/^\.\//, '').split('/')[0] ?? ''
    return /[*?[{]/.test(seg) && globs(seg, CM_NAMES)
  })

// Matching a glob needs no regex (a regex built from the text can be made to take seconds): `*` any run, `?` one
// character, `[a-c]` / `[!x]` a class. A class with a POSIX name inside matches anything.
const tokens = (p: string): string[] => {
  const out: string[] = []
  for (let n = 0; n < p.length; n++) {
    if (p[n] === '[') {
      const e = p.indexOf(']', n + 2)
      if (e < 0) {
        // An empty `[]` (jq `.a[]`) is two plain characters; a class left open stands for any text after it
        // (`d["m"]` is cut at its quotes into `d[`: no name starts with `d`; `.cl[a` is `.cl*`).
        if (p[n + 1] === ']') {
          out.push('[')
          continue
        }
        out.push('*')
        break
      }
      // A long class is read as `?` (any one character): it may match more than it says, never less.
      out.push(e - n > 32 ? '?' : p.slice(n, e + 1))
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
const SUB = '\u0001'
const D_NAMES = ['.claude', 'claude~1']
const CM_NAMES = ['coordinator-monitor', 'coordi~1']
/** A segment with a glob, a class or a brace that could spell one of `names`. */
// The work one call may spend reading globs, in characters read; past it every glob is a hit (denied, never allowed).
let work = 0
const BUDGET = 400_000
const globs = (seg: string, names: string[]): boolean => {
  // A long word is not read (the brace regex below backtracks on one): it is a hit.
  if (seg.length > 256 || (work += seg.length) > BUDGET) return true
  // A brace sequence (`{a..z}`) and a PowerShell format slot (`{0}`) stand for any text.
  const left = { n: 64 }
  const words = expand(seg.replace(/\{[^{},]*\.\.[^{},]*\}|\{\d+\}/g, '*'), left)
  // A brace left open is plain text (`awk '{print'`) unless it holds a piece of a name (`{.claude/coord,x}`
  // cut at its slash); more than 64 words is a hit.
  if (!words) return left.n < 0 || /claud|coord|\{\./.test(seg)
  return words.some(w => {
    const t = tokens(w)
    // A match costs up to a name's length for each token.
    return (work += t.length * 20) > BUDGET || names.some(n => wild(t, n))
  })
}
const couldBeD = (seg: string): boolean => {
  // A substitution stands for any text: in a segment of its own it is judged by the one after it.
  if (seg.includes(SUB)) return seg.length > 1 && (/^[.\u0001]/.test(seg) || seg.includes('claud'))
  if (!/[*?[{$`]/.test(seg) || !(seg.startsWith('.') || seg.includes('claud') || /^[[{]/.test(seg))) return false
  if (seg.length > 256) return true
  // A variable or a command substitution stands for any text, like `*`.
  return globs(seg.replace(/\$(?:\{[^}]*\}?|[\w?@*#!$-]*)|`[^`]*`?/g, '*'), D_NAMES)
}

// A word that names the folder through a glob, a class, a brace, a variable or a substitution: `.cl[^x]ude/`,
// `{.,}claude/`, `.claude/c*`. The segment must be followed by another one, so `ls .*/` and a URL stay quiet.
const subs = (s: string): string => {
  let out = ''
  let at = 0
  for (let k = s.indexOf('$('); k >= 0; k = s.indexOf('$(', at)) {
    let depth = 0
    let end = -1
    for (let n = k + 1; n < s.length && end < 0; n++) {
      if (s[n] === '(') depth++
      else if (s[n] === ')' && --depth === 0) end = n
    }
    if (end < 0) break
    out += s.slice(at, k) + SUB
    at = end + 1
  }
  return out + s.slice(at)
}

const globHits = (s: string): boolean => {
  for (const word of subs(s).split(/[\s;&|'")=]+|(?<!\$)\(/)) {
    const parts = word.split('/')
    for (let k = 0; k < parts.length - 1; k++) {
      const seg = parts[k] ?? ''
      const next = parts[k + 1] ?? ''
      if (!next) continue
      if (D_EXACT.test(seg) && /[*?[{$`\u0001]/.test(next)) return true
      if (seg === SUB && next.startsWith('coordi')) return true
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

const under = (x: string[], y: string[]): boolean => y.length > 0 && y.every((s, n) => x[n] === s)

/**
 * A path that is the bus folder's base or one of its ancestors (the home folder, a drive, `/`): a tree extracted or
 * copied there overwrites the folder. A relative path is read from `cwd`, when there is one.
 */
const above = (word: string, own: string[], home: string, cwd = ''): boolean => {
  const w = word.replace(/['"]/g, '')
  if (!w || w.length > 1024) return false
  const abs = /^(?:[a-z]:|\/)/.test(w)
  if (!abs && !cwd) return false
  const segs = segments(abs ? w : `${cwd}/${w}`, home)
  return segs.length === 0 ? abs : under(own, segs)
}

type Step = { cmd: string; args: string[]; dests: string[]; flagged: boolean }

/** The copy, move, extract or link steps of a text, each with the words that could be its destination. */
const copySteps = (s: string, home: string): Step[] => {
  const out: Step[] = []
  for (const step of s.split(/[;&|\n]+/)) {
    const words = step.split(WORDS)
    // `python -m zipfile -e <zip> <dest>`, and `-m tarfile -e <tar> [<dest>]` (the current folder when none).
    const py = words.findIndex((w, k) => (w === 'zipfile' || w === 'tarfile') && words[k - 1] === '-m')
    if (py > 0 && /^(?:-e|--extract)$/.test(words[py + 1] ?? '')) {
      const dest = words[py + 3]
      out.push({ cmd: 'pyextract', args: words.slice(py + 1).filter(Boolean), dests: [dest || '.'], flagged: !!dest })
      continue
    }
    const at = words.findIndex(w => COPY.has(base(w)) || EXTRACT_DIR.test(w))
    if (at < 0) continue
    // `[IO.Compression.ZipFile]::ExtractToDirectory(src, dest)`: every argument after the first.
    if (EXTRACT_DIR.test(words[at] ?? '')) {
      const args = words.slice(at + 1).flatMap(w => w.split(',')).filter(Boolean)
      out.push({ cmd: 'extracttodirectory', args, dests: args.slice(1), flagged: true })
      continue
    }
    const cmd = base(words[at] ?? '')
    const args = words.slice(at + 1).filter(Boolean)
    const dests = EVERY_WORD.has(cmd) ? [...args] : [args.filter(w => !w.startsWith('-')).pop() ?? '']
    let flagged = false
    args.forEach((w, k) => {
      // `unzip -o` is "overwrite": only `-d` names its folder.
      if (cmd === 'unzip' && !w.startsWith('-d')) return
      if (destFlag(cmd, w)) {
        dests.push(args[k + 1] ?? '')
        flagged = true
      }
      const glued = DEST_GLUED.exec(w)?.[1]
      if (glued) {
        dests.push(glued.replace(/^~(?=\/|$)/, home))
        flagged = true
      }
    })
    out.push({ cmd, args, dests, flagged })
  }
  return out
}

// An extract puts a tree in its destination folder: the current one when none is named.
const EXTRACT = new Set(['tar', 'bsdtar', 'unzip', '7z', '7za', '7zr', 'expand-archive', 'pyextract', 'extracttodirectory'])
const bulk = (cmd: string, args: string[]): boolean => {
  if (cmd === 'pyextract' || cmd === 'extracttodirectory') return true
  if (cmd === 'tar' || cmd === 'bsdtar') return args.some(w => /^-[a-z]*x[a-z]*$/.test(w) || w === '--extract' || w === '--get') || /^[a-z]*x[a-z]*$/.test(args[0] ?? '')
  if (/^7z[ar]?$/.test(cmd)) return /^[xe]$/.test(args[0] ?? '')
  if (cmd === 'cp' || cmd === 'copy-item' || cmd === 'cpi') return args.some(w => (/^-[a-z]{1,3}$/.test(w) && /[ra]/.test(w)) || w === '--recursive' || w === '--archive' || w.startsWith('-rec'))
  return cmd === 'unzip' || cmd === 'rsync' || cmd === 'ditto' || cmd === 'expand-archive'
}

// A step that only reads the current folder into an archive: its `.` and `*` are sources. Its output file is still
// judged like any word.
const makes = (cmd: string, args: string[]): boolean => {
  if (cmd === 'zip' || cmd === 'compress-archive') return true
  if (cmd === 'tar' || cmd === 'bsdtar') return !bulk(cmd, args) && (args.includes('--create') || args.some(w => /^-[a-z]*c[a-z]*$/.test(w)) || /^[a-z]*c[a-z]*$/.test(args[0] ?? ''))
  return /^7z[ar]?$/.test(cmd) && /^[au]$/.test(args[0] ?? '')
}
const MAKERS = /^(?:tar|bsdtar|zip|compress-archive|7z[ar]?)$/
const made = (step: string): boolean => {
  const words = step.split(WORDS).filter(Boolean)
  const at = words.findIndex(w => MAKERS.test(base(w)))
  return at >= 0 && makes(base(words[at] ?? ''), words.slice(at + 1))
}
// The current folder as a destination: `.`, `..`, or a word that names the working folder at run time.
const here = (d: string): boolean => /^\.{1,2}\/?$/.test(d) || /[$`]|^pwd$|^~[+-]$/.test(d)
// A step puts files in the current folder: an extract with no folder of its own, or any copy whose destination is it.
const lands = ({ cmd, dests, flagged }: Step): boolean => dests.some(here) || (EXTRACT.has(cmd) && !flagged)

/**
 * A `cd` into the folder followed by a word that starts like the bus folder's name or by a copy, move, extract or
 * link; a `cd` into the base or one of its ancestors followed by a tree copied or extracted into the current folder.
 * Only the first `cd` of the second kind is read to the end of the text, so the time is linear.
 */
const cdThen = (s: string, home: string, own: string[]): boolean => {
  let seen = false
  CD_HEAD.lastIndex = 0
  for (let m = CD_HEAD.exec(s); m; m = CD_HEAD.exec(s)) {
    let at = m.index + m[0].length
    CD_OPT.lastIndex = at
    while (CD_OPT.test(s)) at = CD_OPT.lastIndex
    CD_TARGET.lastIndex = at
    const target = CD_TARGET.exec(s)?.[0] ?? ''
    if (isD(target, home)) {
      const rest = s.slice(at + target.length)
      return rest.split(/[;&|\n]+/).some(st => !readOnly(st) && (v => AFTER_CD.test(v) || globbed(v))(made(st) ? st.split(WORDS).filter(w => !/^(?:\.\/?|\*|\.\/\*)$/.test(w)).join(' ') : st)) || copySteps(rest, home).some(st => !makes(st.cmd, st.args) && lands(st))
    }
    if (seen || !above(target, own, home)) continue
    seen = true
    const cwd = target.replace(/['"]/g, '')
    if (copySteps(s.slice(at + target.length), home).some(st => bulk(st.cmd, st.args) && (st.dests.some(d => above(d, own, home, cwd)) || (EXTRACT.has(st.cmd) && !st.flagged)))) return true
  }
  return false
}

/** A copy, move, extract or link whose destination could be the folder, or a tree copied or extracted over its parent. */
const destHit = (s: string, home: string, own: string[]): boolean =>
  copySteps(s, home).some(({ cmd, args, dests }) => {
    // `bulk` reads every word of the step: once per step, not once per destination.
    const tree = bulk(cmd, args)
    return dests.some(d => d && (isD(d, home) || (tree && above(d, own, home))))
  })

/** A PowerShell command with the strings that `+` joins run together: `'a' + <#c#> ('b')` is `'a` `b'`. */
const plus = (cmd: string): string => {
  let text = ''
  let at = 0
  // A block comment is a blank (one in a string is text, so the command is judged with it as well); an unterminated one
  // is left alone (each search starts after the last, so it is one pass).
  for (let a = cmd.indexOf('<#'); a >= 0; a = cmd.indexOf('<#', at)) {
    const end = cmd.indexOf('#>', a + 2)
    if (end < 0) break
    text += cmd.slice(at, a) + ' '
    at = end + 2
  }
  return (text + cmd.slice(at)).replace(/`\r?\n/g, ' ').replace(/(['"])[\s)]*\+[\s(]*['"]/g, '')
}

/**
 * The text inside the quotes of a PowerShell command, run together with whatever stands between the strings dropped:
 * `('~/.cl' + $null + [string]'aude/x')` is `~/.claude/x`. Read as PowerShell reads quotes (`''` and `""` are a quote,
 * a backtick escapes, curly quotes are quotes). With `comments` a `<# #>` and a `# …` line are skipped; without, they
 * are text, so a quote in a comment cannot pair the others up the wrong way in both readings.
 */
const strings = (command: string, comments: boolean): string => {
  const cmd = command.replace(/[‘-‛]/g, "'").replace(/[“-„]/g, '"')
  let out = ''
  let q = ''
  for (let k = 0; k < cmd.length; k++) {
    const c = cmd[k] ?? ''
    if (q) {
      if (c === q) {
        if (cmd[k + 1] === q) {
          out += c
          k++
        } else q = ''
      } else if (q === '"' && c === '`') k++
      else out += c
    } else if (c === "'" || c === '"') q = c
    else if (c === '`') k++
    else if (comments && c === '<' && cmd[k + 1] === '#') {
      const end = cmd.indexOf('#>', k + 2)
      if (end >= 0) k = end + 1
    } else if (comments && c === '#' && (k === 0 || /[\s;|&(]/.test(cmd[k - 1] ?? ''))) {
      const nl = cmd.indexOf('\n', k)
      k = nl < 0 ? cmd.length : nl
    }
  }
  return out
}

/** True when a call that is not read-only writes the bus folder `base`. `home` is the person's home folder. */
export const touchesBus = (e: BusCall, base: string, home: string): boolean => {
  if (e.isReadOnly) return false
  const h = home.toLowerCase()
  const [b] = clean(base, h)
  // A drive also reads `/d/…` (MSYS, `/mnt/d/…`).
  const bm = b.replace(/^([a-z]):\//, '/$1/')
  const names = (s: string) => NAMES.test(s) || (!!b && (s.includes(b) || s.includes(bm)))
  // The floor: the text as written, with one separator and one case, no other reading. Whatever the file system makes
  // of `..`, a dot, a colon or a name with odd characters in it, a text that holds the folder's path stays a hit.
  const flat = (s: string) => names(s.toLowerCase().replace(/[\\/]+/g, '/'))
  const i =(e.input ?? {}) as Record<string, unknown>
  if (!SHELL_TOOLS.has(e.tool) || typeof i.command !== 'string') {
    const target = i.file_path ?? i.notebook_path ?? i
    if (typeof target === 'string' && (target.length > 1024 || target.split(/[\\/]/).length > 64)) return true
    const text = typeof target === 'string' ? target : JSON.stringify(target)
    const [c] = clean(text, h)
    // The bus folder's own entries under a folder of that name, whatever the path before it: a junction to `.claude`
    // makes the same folder appear elsewhere, and a host with no way to resolve a path still sees the entry.
    if (names(c) || BUS_ENTRY.test(c) || flat(text)) return true
    if (typeof target !== 'string') return false
    // The path as the file system reads it: aliases (`COORDI~1`, `a b/..`, `.claude./`, a stream, a junction) resolved.
    const own = segments(base, h)
    const mine = segments(target, h)
    // Too long, or too many parts, to be a real path: refused before the file system is asked about each part.
    if (mine.length > 64 || mine.join('/').length > 1024) return true
    return under(mine, own) || (() => {
      const real = realOf(mine)
      const root = realOf(own)
      return real === root || real.startsWith(`${root}/`)
    })()
  }
  const ps = e.tool === 'PowerShell'
  // PowerShell joins two strings with `+`: 'coord' + 'inator-monitor', in any mix of quotes, with a comment, a
  // continuation line or a closing parenthesis between the pieces.
  const raw = ps ? i.command.replace(/(['"])\s*\+\s*['"]/g, '') : i.command
  const joined = ps ? plus(i.command) : raw
  // The text, its words with the quotes and escapes gone, and the same where a backslash was a path separator.
  const own = segments(base, h)
  work = 0
  // A path built from pieces (`Join-Path`, `-join`, `+`, `Combine`): the pieces name the folder, or are joined at run
  // time and could. A step that holds the folder's name and a word that could be the bus folder's name is a hit.
  // A piece that is the folder `.claude` or a start of it, or could be one through a glob.
  const dish = (seg: string): boolean => couldBeD(seg) || /^claude~\d$/.test(seg)
  const pieced = (s: string): boolean =>
    ps &&
    (JOINED.test(s) || DYNAMIC.test(s)) &&
    ((JOINED.test(s) && s.includes('.claude') && s.includes('coordinator')) ||
      s.split(/[;\n]/).some(st => {
        const joins = JOINED.test(st)
        if (!joins && !DYNAMIC.test(st)) return false
        const segs = st.split(/[\s;&|('")=,]+/).flatMap(w => w.split('/')).filter(Boolean)
        // Joined at run time with a piece that could be the folder (a glob, `CLAUDE~1`). A name split across strings is
        // read from the strings alone (`strings`).
        if (joins && DYNAMIC.test(st) && segs.some(dish)) return true
        return (
          (/\.claude|claude~\d/.test(st) || segs.some(couldBeD)) &&
          segs.some(seg => CM_NAMES.some(n => n.startsWith(seg)) || (/[*?[{]/.test(seg) && globs(seg, CM_NAMES)))
        )
      }))
  // Each distinct text is judged once.
  const judged = new Set<string>()
  const judge = (s: string): boolean => {
    if (judged.has(s)) return false
    judged.add(s)
    const x = s.replace(EXTGLOB, '*')
    return (
      names(s) ||
      pieced(s) ||
      (x === s ? [s] : [s, x]).some(v => globHits(v) || cdThen(v, h, own) || (isLink(v) && (DSEG.test(v) || anyD(v))) || destHit(v, h, own))
    )
  }
  // Home is 14 characters or more for each `~`: a text that would grow by more than 64 KB is not read (denied).
  const grows = (t: string): boolean => h.length * (t.toLowerCase().match(HOME)?.length ?? 0) > 65536
  const check = (text: string): boolean =>
    [...new Set([text, unquote(text, ps), unquote(text.replace(/\\/g, '/'), ps)])].some(t => {
      if (flat(t) || grows(t)) return true
      const [s, sp] = clean(t, h)
      return judge(s) || (sp !== s && judge(sp))
    })
  // Text only mentions the folder when every step prints or stores nothing (`git commit -m "…~/.claude/coordinator-monitor"`):
  // then only a `cd` is judged, for it moves the shell into the folder whatever it is quoted with.
  if (!ps && !i.command.includes('<<') && dataMask(i.command) !== null) {
    const cds = i.command.split(/[;&|\n]+/).filter(x => CD_STEP.test(x))
    return cds.length > 0 && check(cds.join(';'))
  }
  if (check(raw) || (joined !== raw && check(joined))) return true
  // A name split across strings that `-join` or `+` run together, with anything between them: the strings alone, run
  // together, are judged. With a `Join-Path` the pieces are path parts, so a `.claude` and a bus folder name in them are a hit.
  const low = i.command.toLowerCase()
  if (!ps || !DYNAMIC.test(low)) return false
  const path = JOINED.test(low)
  return (low.includes('#') ? [strings(i.command, true), strings(i.command, false)] : [strings(i.command, true)]).some(v => {
    if (check(v)) return true
    const [s] = clean(v, h)
    return path && /\.claude|claude~\d/.test(s)
  })
}
