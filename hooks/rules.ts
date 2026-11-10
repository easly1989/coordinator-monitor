// Protected commands: a session never runs one of these without the person's
// approval from the pane, whatever its permission mode says. The defaults are
// generic; `<busDir>/rules.json` adds to them or replaces them:
//
// { "replaceDefaults": false,
//   "rules": [{ "label": "restart", "pattern": "\\bpm2\\s+restart\\b" }],
//   "critical": ["jellyfin", "homeassistant"],
//   "tierModels": { "light": "Haiku · low" } }

import { HIDDEN } from './request'

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

// What a rule is matched against. The whole text of a command, unless EVERY step of it is on a short
// allowlist of steps that cannot run what they are given (cd, echo, grep, git add / status / diff /
// commit, gh pr / issue create / comment / edit, a here-doc stored to cat or tee): then the text those only
// store or print (a here-doc body, a quoted string) is blanked, so a command that only *mentions* a
// protected one raises no card. Used to decide matching only: the card shows the command as written.
// Anything else returns null and the rule sees the raw text, as before:
// - any step that is not on the list, a pipe or a variable as a command included (`… | sh`, `$c`, cp, mv,
//   npm, bun, make, `git log`, `git notes`, `printf`, whose `-v` evaluates an array subscript), or on it
//   with a flag that is not (`--output=`) or one written in quotes (`git commit '-m' …`: a quoted word of a
//   flag's shape, `-v` or `--pre=sh`, leaves the whole text unmasked unless it is the value of `-m`, `--body`…);
// - a step that writes a file with `>`; a here-doc body that goes anywhere but a .md or .txt file or stdout;
// - the text has a hidden character, a curly quote, a CR, a backtick, `$'`, `$(` or `${` (but for the
//   one `git commit -m "$(cat <<'EOF'` form), a here-string, process substitution, a line continuation,
//   a backslash before a quote or a metacharacter, a comment, a subshell or a brace, `eval`, a shell or
//   interpreter given a code string (`bash -c`, `python -c`, `node -e`, `pwsh -Command`), a descriptor
//   or pipe set up for later (`exec 3>`, mkfifo, coproc), or a /dev or /proc target;
// - a quote is left open, a here-doc has no end line or two openers share a line, or an unquoted here-doc
//   body expands `$( )`.
// PowerShell text is never masked: there `echo` is Write-Output and `iex` runs what it printed.
const OPAQUE: RegExp[] = [
  HIDDEN,
  /[‘-‟]/,
  /<<<|`|\$'|\\["']|@["']|[<>]\(/,
  /(?:^|[^\w-])eval(?![\w-])/i,
  /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|ksh|fish|csh|pwsh|powershell|cmd|py(?:thon[\d.]*)?|node(?:js)?|deno|ruby|perl|php)(?:\.exe)?[ \t]+(?:-[A-Za-z]*[ce][A-Za-z]*|\/[ck])(?![\w-])/i,
  /(?:^|[;&|(\n])[ \t]*(?:exec[ \t]+\d*[<>]|mkfifo\b|mknod\b|coproc\b)/,
  /\/(?:dev|proc)\/(?!null\b)/,
]

type Step = { start: number; end: number; quotes: [number, number][]; hasWrite: boolean }

/**
 * `text` split at `;`, `&`, `&&`, `||`, `|` and newlines outside quotes, each step with its quoted spans
 * (the text between the quotes) and whether it writes a file. `q` is the quote left open at the end (`q0`
 * is the one open at the start). `null` where reading is not certain.
 */
const scan = (text: string, q0 = ''): { steps: Step[]; q: string } | null => {
  const steps: Step[] = []
  let q = q0
  let start = 0
  let qs = 0
  let quotes: [number, number][] = []
  let hasWrite = false
  const close = (end: number) => {
    steps.push({ start, end, quotes, hasWrite })
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
      if ((c === '&' || c === '|') && next === c) i++
      close(at)
      start = i + 1
    }
  }
  close(text.length)
  return { steps, q }
}

// The steps that cannot run what they are given. A word is plain (no `$`, quote or leading `-`) or a quoted
// string, which is shaped to '' before the test; a flag must be named.
const W = String.raw`[^\s;&|<>()'"$\\\`#-][^\s;&|<>()'"$\\\`#]*`
const A = String.raw`(?:${W}|''|"")`
const inert = (head: string, flags = '') => new RegExp(String.raw`^${head}(?:[ \t]+(?:${flags ? `${flags}|` : ''}${A}))*$`)
const INERT: RegExp[] = [
  inert('cd'),
  inert('echo', '-[neE]+'),
  inert('(?:grep|egrep|fgrep)', '-[A-Za-z]+'),
  inert(String.raw`git[ \t]+add`, '-A|-u|-p|-N|-v|--all|--update|--patch|--verbose|--'),
  inert(String.raw`git[ \t]+status`, '-s|-b|--short|--branch|--porcelain|--'),
  inert(String.raw`git[ \t]+diff`, '--stat|--staged|--cached|--name-only|--name-status|--shortstat|--'),
  inert(String.raw`git[ \t]+commit`, '-m|-F|-a|-s|-q|-am|--allow-empty|--amend|--no-edit|--no-verify|--signoff|--all|--quiet|-'),
  inert(
    String.raw`gh[ \t]+(?:pr[ \t]+(?:create|comment|edit|review)|issue[ \t]+(?:create|comment|edit))`,
    '--title|-t|--body|-b|--base|-B|--head|-H|--draft|-d|--label|-l|--assignee|-a|--reviewer|-r|--milestone|-m|--repo|-R|--approve|--comment|--request-changes|--fill|--body-file|-F|-',
  ),
]

/** The step's text with each quoted string (quotes included) shaped to ''. */
const shape = (text: string, s: Step): string => {
  let t = text.slice(s.start, s.end)
  for (const [a, b] of [...s.quotes].reverse()) t = t.slice(0, a - 1 - s.start) + "''" + t.slice(b + 1 - s.start)
  return t.trim()
}

const DOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2(?=[ \t;&|<>)]|$)/
const FILE = String.raw`[\w@%+=:,./-]+`
const CAT = new RegExp(String.raw`^cat(?:[ \t]+-[A-Za-z]*)*(?:[ \t]*>{1,2}[ \t]*(${FILE}))?$`)
const TEE = new RegExp(String.raw`^tee(?:[ \t]+-[A-Za-z]+)*(?:[ \t]+(${FILE}))?$`)
const AFTER = new RegExp(String.raw`^[ \t]*(?:>{1,2}[ \t]*(${FILE}))?[ \t]*$`)
const MSG_CMD = String.raw`(?:git[ \t]+commit|gh[ \t]+(?:pr|issue)[ \t]+(?:create|comment|edit|review))`
// A git / gh command whose here-doc is its message (`git commit -F - <<'EOF'`).
const MSG = new RegExp(String.raw`^${MSG_CMD}(?:[ \t]+[^\s;&|<>()'"$\\\`#]+)*$`)
// The start of `git commit -m "$(cat <<'EOF'`: plain words and complete quoted strings, then the string the substitution is in.
const SUBST = new RegExp(String.raw`^(?:[^"'$\`\\<>()#\n]*(?:&&|;)[ \t]*)?${MSG_CMD}(?:[ \t]+(?:'[^'\n]*'|"[^"$\`\\\n]*"|[^\s"'$\`\\;&|<>()#]+))*[ \t]+"$`)
// The only files a here-doc is stored in without being taken for code (anything else may be run by a tool: a script, a test, package.json, a config).
const DATA_FILE = /\.(?:md|markdown|txt)$/i

/**
 * `cmd` without each here-doc that goes to cat or tee (a .md or .txt file, or stdout) or is a git / gh message
 * (the opener's own step is dropped, a message's is kept to be checked), read line by line with the quote
 * state carried, so a quote opened before a here-doc cannot make a body of what is code. `null` where a
 * here-doc is anything else, or where not certain.
 */
const withoutDocs = (cmd: string): string | null => {
  if (!cmd.includes('<<')) return cmd
  const lines = cmd.split('\n')
  const out: string[] = []
  let q = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const opens = line.match(/<</g)?.length ?? 0
    if (!opens) {
      const sc = scan(line, q)
      if (!sc) return null
      q = sc.q
      out.push(line)
      continue
    }
    const m = opens === 1 && !q ? DOC.exec(line) : null
    if (!m) return null
    const word = m[3] ?? ''
    // Inside `$( )` bash also ends the body at a line that only starts with the word (`EOF)`, `EOF ;`): a line
    // that starts with it but is not exactly it, is not read.
    const strip = (l: string) => (m[1] ? l.replace(/^\t+/, '') : l)
    const end = lines.findIndex((l, j) => j > i && strip(l).startsWith(word))
    if (end < 0 || strip(lines[end] ?? '') !== word) return null
    // An unquoted word: the shell runs each `$( )` in the body as it reads it, a backslash-newline can hide
    // the `(` from a look at the text, and one in the end word ends the body early.
    if (!m[2] && /\$[({]|\\$/m.test(lines.slice(i + 1, end).join('\n'))) return null
    const head = line.slice(0, m.index)
    const after = line.slice((m.index ?? 0) + m[0].length)
    const sub = /^(.*?)\$\([ \t]*cat[ \t]*$/.exec(head)
    if (sub) {
      // `git commit -m "$(cat <<'EOF'`: the body is the text of a string given to a message command.
      const pre = scan(sub[1] ?? '', q)
      const next = lines[end + 1] ?? ''
      if (!(pre && pre.q === '"' && SUBST.test(sub[1] ?? '') && !after.trim() && /^\)"/.test(next))) return null
      out.push(sub[1] ?? '')
      lines[end + 1] = next.slice(1)
      q = '"'
    } else {
      const sc = scan(head, q)
      const last = sc && !sc.q ? sc.steps.at(-1) : undefined
      if (!last) return null
      const step = head.slice(last.start, last.end).trim()
      const af = AFTER.exec(after)
      const store = CAT.exec(step) ?? TEE.exec(step)
      if (store && af && !(store[1] && af[1])) {
        const file = store[1] ?? af[1]
        if (file && !DATA_FILE.test(file)) return null
        out.push(head.slice(0, last.start))
      } else if (MSG.test(step) && !after.trim()) out.push(head)
      else return null
    }
    i = end
  }
  return q ? null : out.join('\n')
}

// A flag written in quotes (`grep '--pre=sh' …`) is hidden by the shaped text, so a quoted word of a flag's shape
// (`-v`, `--pre=sh`: no space) leaves the text unmasked, unless it is the value of a git commit / gh flag that
// takes one (`git commit -m '-fix'`): there it is a message, and a plain mention of `- item` or `-fix` stays quiet.
const FLAG_SHAPE = /^--?[A-Za-z]\S*$/
const VALUE_STEP = /^(?:git[ \t]+commit|gh[ \t])/
const VALUE_FLAG = /(?:^|[ \t])(?:-m|-am|-F|--title|-t|--body|-b|--body-file|--base|-B|--head|-H|--label|-l|--assignee|-a|--reviewer|-r|--milestone|--repo|-R)[ \t]+$/
const hasQuotedFlag = (text: string, s: Step, shaped: string): boolean =>
  s.quotes.some(([a, b]) => FLAG_SHAPE.test(text.slice(a, b)) && !(VALUE_STEP.test(shaped) && VALUE_FLAG.test(text.slice(s.start, a - 1))))

/** The text the rules match: the command with what a program only stores or prints blanked; null unless every step is certain and inert. */
export const dataMask = (cmd: string): string | null => {
  if (OPAQUE.some(re => re.test(cmd))) return null
  const text = withoutDocs(cmd)
  const sc = text === null ? null : scan(text)
  if (text === null || !sc || sc.q) return null
  for (const s of sc.steps) {
    const t = shape(text, s)
    if (t && (s.hasWrite || hasQuotedFlag(text, s, t) || !INERT.some(re => re.test(t)))) return null
  }
  let view = text
  for (const [a, b] of sc.steps.flatMap(s => s.quotes).sort((x, y) => y[0] - x[0])) view = view.slice(0, a - 1) + "''" + view.slice(b + 1)
  return view
}

export const matchRule = (rules: readonly Rule[], command: string, isPowerShell = false): Rule | undefined => {
  const text = (isPowerShell ? null : dataMask(command)) ?? command
  return rules.find(r => r.re.test(text))
}

export const criticalIn = (critical: readonly string[], command: string): string | undefined => {
  const low = command.toLowerCase()
  return critical.find(name => low.includes(name))
}
