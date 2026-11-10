// Protected commands: a session never runs one of these without the person's
// approval from the pane, whatever its permission mode says. The defaults are
// generic; `<busDir>/rules.json` adds to them or replaces them:
//
// { "replaceDefaults": false,
//   "rules": [{ "label": "restart", "pattern": "\\bpm2\\s+restart\\b" }],
//   "critical": ["jellyfin", "homeassistant"],
//   "tierModels": { "light": "Haiku · low" } }

import { HIDDEN, laterUse } from './request'

export type Rule = { label: string; re: RegExp }

const D = (label: string, pattern: string): Rule => ({ label, re: new RegExp(pattern, 'i') })

export const DEFAULT_RULES: readonly Rule[] = [
  // merges and pushes to the main line
  D('merge', String.raw`\bgh\s+pr\s+merge\b`),
  D('merge', String.raw`\bgit\s+merge(?![-\w])`),
  D('merge', String.raw`\bgit\s+push\b[^|;&]*[\s:+](main|master)(?=$|[\s;&|"'])`),
  D('merge', String.raw`\bgit\s+push\b[^|;&]*(--force\b|\s-f\b)`),
  // deploys and releases
  D('deploy', String.raw`\b(vercel|netlify)\b[^|;&]*--prod\b`),
  D('deploy', String.raw`\bfly(ctl)?\s+deploy\b`),
  D('deploy', String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(deploy|release|publish)\b`),
  D('deploy', String.raw`\bnpm\s+publish\b`),
  D('deploy', String.raw`\bkubectl\s+(apply|delete|rollout|scale)\b`),
  D('deploy', String.raw`\bhelm\s+(install|upgrade|uninstall|rollback)\b`),
  D('deploy', String.raw`\bterraform\s+(apply|destroy)\b`),
  D('deploy', String.raw`\bgh\s+release\s+create\b`),
  D('deploy', String.raw`\bdocker\s+push\b`),
  // restarts and stops of running services
  D('restart', String.raw`\bdocker\s+(container\s+)?(restart|stop|kill|rm)\b`),
  D('restart', String.raw`\bdocker[\s-]compose\b[^|;&]*\b(restart|stop|down|up|kill|rm)\b`),
  D('restart', String.raw`\bsystemctl\s+(restart|stop|reload|reboot|poweroff)\b`),
  D('restart', String.raw`\bservice\s+\S+\s+(restart|stop|reload)\b`),
  D('restart', String.raw`\b(reboot|shutdown|poweroff)\b`),
  D('restart', String.raw`\bha\s+(core|host|supervisor)\s+(restart|reboot|update|stop)\b`),
  D('restart', String.raw`\bpct\s+(reboot|stop|shutdown)\b|\bqm\s+(reboot|stop|shutdown|reset)\b`),
]

export type RulesFile = {
  replaceDefaults?: boolean
  rules?: { label?: string; pattern?: string }[]
  critical?: string[]
  /** Model labels per savvy tier, when your savvy agents run other models: { "light": "Haiku · low" }. */
  tierModels?: Record<string, string>
  /** A session's hat by a word of its name, `{ "planora": "crown" }`; see HAT_NAMES in crab.ts. */
  hats?: Record<string, string>
}

export const compileRules = (file: RulesFile | null): { rules: Rule[]; critical: string[] } => {
  const own: Rule[] = []
  for (const r of file?.rules ?? []) {
    if (!r.pattern) continue
    try {
      own.push({ label: r.label || 'custom', re: new RegExp(r.pattern, 'i') })
    } catch {
      // a pattern that does not compile is skipped, never fatal
    }
  }
  const rules = file?.replaceDefaults ? own : [...DEFAULT_RULES, ...own]
  const critical = (file?.critical ?? []).filter(s => typeof s === 'string' && s.trim()).map(s => s.toLowerCase())
  return { rules, critical }
}

// What a rule is matched against. The whole text of a command, unless every part of it is certain: then
// the text a program only stores or prints (a here-doc body going to cat or a message, a quoted string
// given to echo, `git commit -m`, grep) is blanked, so a command that only *mentions* a protected one
// raises no card. Used to decide matching only: the card shows the command as written. Anything not
// certain returns null and the rule sees the raw text, as before:
// - the text has a hidden character, a curly quote, a CR, a backtick, `$'`, `$(` or `${` (but for the
//   one `git commit -m "$(cat <<'EOF'` form), a here-string, process substitution, a line continuation,
//   a backslash before a quote or a metacharacter, a comment, a subshell or a brace, `eval`, a shell or
//   interpreter given a code string (`bash -c`, `python -c`, `node -e`, `pwsh -Command`), a descriptor
//   or pipe set up for later (`exec 3>`, mkfifo, coproc), or a /dev or /proc target;
// - a quote is left open, a here-doc has no end line or two openers share a line;
// - an unquoted here-doc body expands `$( )`;
// - a here-doc goes to anything but cat or tee (to a file of a plain data type that nothing later runs)
//   or a git / gh message command; a quoted string is given to anything but the commands below, or its
//   step is piped on, or writes to a file (`echo '…' | bash`, `echo '…' > s.sh; bash s.sh`).
const OPAQUE: RegExp[] = [
  HIDDEN,
  /[‘-‟]/,
  /<<<|`|\$'|\\["']|@["']|[<>]\(/,
  /(?:^|[^\w-])eval(?![\w-])/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|fish|csh|pwsh|powershell|cmd|py(?:thon[\d.]*)?|node(?:js)?|deno|ruby|perl|php)(?:\.exe)?[ \t]+(?:-[A-Za-z]*[ce][A-Za-z]*|\/[ck])(?![\w-])/i,
  /(?:^|[;&|(\n])[ \t]*(?:exec[ \t]+\d*[<>]|mkfifo\b|mknod\b|coproc\b)/,
  /\/(?:dev|proc)\/(?!null\b)/,
]

type Step = { start: number; end: number; quotes: [number, number][]; isPiped: boolean; hasWrite: boolean }

/**
 * `text` split at `;`, `&`, `&&`, `||`, `|` and newlines outside quotes, each step with its quoted spans
 * (the text between the quotes), whether a `|` takes its output on and whether it writes a file. `q` is
 * the quote left open at the end (`q0` is the one open at the start). `null` where reading is not certain.
 */
const scan = (text: string, q0 = ''): { steps: Step[]; q: string } | null => {
  const steps: Step[] = []
  let q = q0
  let start = 0
  let qs = 0
  let quotes: [number, number][] = []
  let hasWrite = false
  const close = (end: number, isPiped: boolean) => {
    steps.push({ start, end, quotes, isPiped, hasWrite })
    quotes = []
    hasWrite = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    const next = text[i + 1] ?? ''
    if (q) {
      if (q === '"' && c === '\\') i++
      else if (c === q) {
        quotes.push([qs, i])
        q = ''
      } else if (q === '"' && c === '$' && (next === '(' || next === '{')) return null
      continue
    }
    if (c === '\\') {
      if (!next || /[;&|<>()$'"#{}\s]/.test(next) && next !== ' ') return null
      i++
    } else if (c === "'" || c === '"') {
      q = c
      qs = i + 1
    } else if ((c === '$' && (next === '(' || next === '{')) || '(){}'.includes(c)) return null
    else if (c === '#' && /^[\s;&|<]?$/.test(text[i - 1] ?? '')) return null
    else if (c === '>') {
      if (next !== '&' && !/^>?[ \t]*\/dev\/null(?![\w-])/.test(text.slice(i + 1))) hasWrite = true
    } else if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || next === '>')) continue
    else if (c === '\n' || c === ';' || c === '&' || c === '|') {
      const at = i
      const isPiped = c === '|' && next !== '|'
      if ((c === '&' || c === '|') && next === c) i++
      close(at, isPiped)
      start = i + 1
    }
  }
  close(text.length, false)
  return { steps, q }
}

// Steps that only print or store the text they are given. rg is left out of the quoted-string rule when it has --pre (it runs that).
const DATA_STEP = /^(?:echo|printf|e?grep|fgrep|rg|git[ \t]+(?:commit|tag|notes|log)|gh[ \t]+(?:pr|issue)[ \t]+(?:create|comment|edit|review|close|reopen))(?=[ \t]|$)/

/** `text` with the quoted strings of data steps blanked (same length: positions and separators stay). */
const blankQuoted = (text: string): string => {
  const sc = scan(text)
  if (!sc || sc.q) return text
  let out = text
  for (const s of sc.steps) {
    const step = text.slice(s.start, s.end).trim()
    if (s.isPiped || s.hasWrite || !DATA_STEP.test(step) || (/^rg\b/.test(step) && /--pre\b/.test(step))) continue
    for (const [a, b] of s.quotes) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, ' ') + out.slice(b)
  }
  return out
}

const DOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2(?=[ \t;&|<>)]|$)/
const FILE = String.raw`[\w@%+=:,./-]+`
const CAT = new RegExp(String.raw`^cat(?:[ \t]+-[A-Za-z]*)*(?:[ \t]*>{1,2}[ \t]*(${FILE}))?$`)
const TEE = new RegExp(String.raw`^tee(?:[ \t]+-[A-Za-z]+)*(?:[ \t]+(${FILE}))?$`)
const AFTER = new RegExp(String.raw`^[ \t]*(?:>{1,2}[ \t]*(${FILE}))?[ \t]*$`)
const MSG_CMD = String.raw`(?:git[ \t]+(?:commit|tag|notes)|gh[ \t]+(?:pr|issue)[ \t]+(?:create|comment|edit|review))`
// A git / gh command whose here-doc is its message (`git commit -F - <<'EOF'`).
const MSG = new RegExp(String.raw`^${MSG_CMD}(?:[ \t]+[^\s;&|<>()'"$\\\`#]+)*$`)
// The start of `git commit -m "$(cat <<'EOF'`: plain words and complete quoted strings, then the string the substitution is in.
const SUBST = new RegExp(String.raw`^(?:[^"'$\`\\<>()#\n]*(?:&&|;)[ \t]*)?${MSG_CMD}(?:[ \t]+(?:'[^'\n]*'|"[^"$\`\\\n]*"|[^\s"'$\`\\;&|<>()#]+))*[ \t]+"$`)
// A file a here-doc may be stored in without it being code (what a plain-text file is for; others may be run).
const DATA_FILE = /\.(?:md|markdown|txt|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|log|html?|css|xml|svg|sql|diff|patch|rst|tsx?)$/i

/**
 * `cmd` without the body of each here-doc that goes to a command that only stores or prints it, read line
 * by line with the quote state carried, so a quote opened before a here-doc cannot make a body of what is
 * code. `null` where not certain.
 */
const maskDocs = (cmd: string): string | null => {
  const lines = cmd.split('\n')
  const out: string[] = []
  let q = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    const opens = line.match(/<</g)?.length ?? 0
    if (!opens) {
      const sc = scan(line, q)
      if (!sc) return null
      q = sc.q
      continue
    }
    const m = opens === 1 && !q ? DOC.exec(line) : null
    if (!m) return null
    const word = m[3] ?? ''
    const end = lines.findIndex((l, j) => j > i && (m[1] ? l.replace(/^\t+/, '') : l) === word)
    if (end < 0) return null
    // An unquoted word: the shell runs each `$( )` in the body as it reads it.
    if (!m[2] && /\$[({]/.test(lines.slice(i + 1, end).join('\n'))) return null
    const head = line.slice(0, m.index)
    const after = line.slice((m.index ?? 0) + m[0].length)
    const rest = lines.slice(end + 1)
    const isPiped = /^[ \t]*(\||&&)/.test(rest[0] ?? '')
    let isData = false
    let qAfter = ''
    const sub = /^(.*?)\$\([ \t]*cat[ \t]*$/.exec(head)
    if (sub) {
      // `git commit -m "$(cat <<'EOF'`: the body is the text of a string given to a message command.
      const pre = scan(sub[1] ?? '', q)
      isData = !!pre && pre.q === '"' && SUBST.test(sub[1] ?? '') && !after.trim() && /^\)"/.test(rest[0] ?? '')
      qAfter = '"'
    } else {
      const sc = scan(head, q)
      const last = sc && !sc.q ? sc.steps.at(-1) : undefined
      const step = last ? head.slice(last.start, last.end).trim() : ''
      const af = AFTER.exec(after)
      const store = CAT.exec(step) ?? TEE.exec(step)
      if (store && af && !(store[1] && af[1])) {
        const file = store[1] ?? af[1]
        isData = file ? DATA_FILE.test(file) && !Object.keys(laterUse(`${after}\n${rest.join('\n')}`, file.split('/').pop() ?? '')).length : !isPiped
      } else isData = !!last && MSG.test(step) && !after.trim() && !isPiped
    }
    if (isData) {
      q = qAfter
      i = end - 1
    } else {
      const sc = scan(line, q)
      if (!sc) return null
      q = sc.q
    }
  }
  return q ? null : out.join('\n')
}

/** The text the rules match: the command with what a program only stores or prints blanked; null where that is not certain. */
export const dataMask = (cmd: string): string | null => {
  if (OPAQUE.some(re => re.test(cmd))) return null
  const docs = cmd.includes('<<') ? maskDocs(cmd) : cmd
  if (docs === null) return null
  return docs.includes('<<') ? docs : blankQuoted(docs)
}

export const matchRule = (rules: readonly Rule[], command: string): Rule | undefined => {
  const text = dataMask(command) ?? command
  return rules.find(r => r.re.test(text))
}

export const criticalIn = (critical: readonly string[], command: string): string | undefined => {
  const low = command.toLowerCase()
  return critical.find(name => low.includes(name))
}
