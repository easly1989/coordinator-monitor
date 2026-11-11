// The bus folder (`~/.claude/coordinator-monitor`, or the `busDir` option) is written by the mod alone: answers
// would let a session grant itself anything, rules.json or a status file loosen the rules or pose as another
// session. Reading it is harmless. A file tool is judged by its target path, so the mod's own source and docs
// stay editable; a shell command is judged by the words the shell reads from it, not by how it is written.

import { unquote } from './rules'

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

export type BusCall = { tool: string; input?: unknown; isReadOnly?: boolean }

// Every way to say the home folder, then one separator and one case.
const HOME = /\$\{home\}|\$home(?![\w])|\$env:(?:userprofile|home)(?![\w])|\$\{env:(?:userprofile|home)\}|%userprofile%|(?<=^|[\s;&|('"=:])~(?=$|[\s/'"])/g
const clean = (text: string, home: string): string => {
  let s = text.toLowerCase().replace(/\\/g, '/').replace(HOME, () => home).replace(/\/+/g, '/').replace(/\/\.(?=\/)/g, '')
  // `a/b/../c` is `a/c`.
  for (let n = 0; n < 8 && s.includes('/..'); n++) s = s.replace(/\/(?!\.\.(?:\/|$))[^/\s]+\/\.\.(?=\/|$)/g, '')
  return s
}

// A `.claude` path whose next segment (or the `.claude` itself) is a glob, a variable or a substitution: the
// name it stands for is not in the text. `cd` into `.claude` and then a word that starts like the folder.
const GLOB_NEXT = /\.claude\/[^\s/]*[*?[$`{]/
const GLOB_DOT = /\/\.[^\s/]*[*?[$`{][^\s/]*\//
const CD_THEN = /(?:^|[\s;&|(])(?:cd|pushd|sl|set-location|push-location)\s+(?:-\S+\s+)*[^\s;&|]*\.claude\/?(?=[\s;&|)]|$)[\s\S]*(?:^|[\s;&|('"=])(?:\.{1,2}\/)?coordinator/
const JOINED = /join-path|\[io\.path\]::combine/

/** True when a call that is not read-only writes the bus folder `base`. `home` is the person's home folder. */
export const touchesBus = (e: BusCall, base: string, home: string): boolean => {
  if (e.isReadOnly) return false
  const h = home.toLowerCase()
  const b = clean(base, h)
  const names = (s: string) => s.includes('.claude/coordinator-monitor') || (!!b && s.includes(b))
  const i = (e.input ?? {}) as Record<string, unknown>
  if (!SHELL_TOOLS.has(e.tool) || typeof i.command !== 'string') {
    const target = i.file_path ?? i.notebook_path ?? i
    return names(clean(typeof target === 'string' ? target : JSON.stringify(target), h))
  }
  const ps = e.tool === 'PowerShell'
  // PowerShell joins two strings with `+`: 'coord' + 'inator-monitor'.
  const raw = ps ? i.command.replace(/(['"])\s*\+\s*\1/g, '') : i.command
  // The text, its words with the quotes and escapes gone, and the same where a backslash was a path separator.
  return [raw, unquote(raw, ps), unquote(raw.replace(/\\/g, '/'), ps)].some(t => {
    const s = clean(t, h)
    return names(s) || GLOB_NEXT.test(s) || GLOB_DOT.test(s) || CD_THEN.test(s) || (ps && JOINED.test(s) && s.includes('.claude') && s.includes('coordinator'))
  })
}
