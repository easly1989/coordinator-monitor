// Protected commands: a session never runs one of these without the person's
// approval from the pane, whatever its permission mode says. The defaults are
// generic; `<busDir>/rules.json` adds to them or replaces them:
//
// { "replaceDefaults": false,
//   "rules": [{ "label": "restart", "pattern": "\\bpm2\\s+restart\\b" }],
//   "critical": ["jellyfin", "homeassistant"],
//   "tierModels": { "light": "Haiku · low" } }

import { HIDDEN } from './request'

type Matcher = { test: (text: string) => boolean }
export type Rule = { label: string; re: Matcher }

const D = (label: string, pattern: string): Rule => ({ label, re: new RegExp(pattern, 'i') })

// `git` and the options that may come before its subcommand (`git -C ../wt merge x`, `git -c k=v push …`).
// A value is a quoted string, an escaped character or a plain character, each starting differently (the escape
// is a backslash, or a backtick in PowerShell), and the options that take a value are not also matched by the
// generic `--name`: every text has one reading, so the match cannot blow up. At most 8 options are read; a
// longer run is the overflow rule below.
const V = String.raw`(?:"(?:[^"\\\x60]|[\\\x60].)*"|'[^']*'|[\\\x60].|[^\s\\\x60"'])+`
const VALUE_OPT = 'git-dir|work-tree|namespace|config-env|attr-source|super-prefix'
const OPT = String.raw`(?:-[Cc]\s+${V}|--(?:${VALUE_OPT})(?:=${V}|\s+${V})|--(?!(?:${VALUE_OPT})(?![\w-]))[\w-]+(?:=${V})?|-[pP])`
const GIT = String.raw`\bgit(?:\.exe)?['"]?(?:\s+${OPT}){0,8}\s+`

// Where each command step ends, for the text last asked about (a `|`, `;`, `&` or newline).
let sepsOf = ''
let seps: number[] = []
const stepEnds = (text: string): number[] => {
  if (text !== sepsOf) {
    sepsOf = text
    seps = []
    for (const m of text.matchAll(/[|;&\n]/g)) seps.push(m.index)
  }
  return seps
}

/**
 * A command: `head` found, and the rest of that step (up to a `|`, `;`, `&` or newline) passing `tail`. A step
 * is read once however many times `head` occurs in it (the first one's rest holds all the later ones'), so the
 * time is linear in the text, where a regex scanning on from every occurrence (`head[^|;&]*tail`) is quadratic.
 */
export const afterRule = (label: string, source: string, tail: RegExp | ((rest: string, m: RegExpExecArray) => boolean)): Rule => {
  const head = new RegExp(source, 'gi')
  const ok = typeof tail === 'function' ? tail : (rest: string) => tail.test(rest)
  return {
    label,
    re: {
      test: text => {
        const ends = stepEnds(text)
        let p = 0
        const done = new Map<string, [number, number]>() // by the head's second group: step end and where its rest began
        head.lastIndex = 0
        for (let m = head.exec(text); m; m = head.exec(text)) {
          head.lastIndex = m.index + 1
          const from = m.index + m[0].length
          while (p < ends.length && (ends[p] ?? 0) < from) p++
          const end = ends[p] ?? text.length
          const seen = done.get(m[2] ?? '')
          if (seen && seen[0] === end && from >= seen[1]) continue
          if (ok(text.slice(from, end), m)) return true
          done.set(m[2] ?? '', [end, from])
        }
        return false
      },
    },
  }
}

// What may follow a branch name on a push line: a blank, a quote, a separator, a bracket, a redirect.
const MAIN = String.raw`(?:[\s:+]|(?:refs/)?heads/)(?:main|master)(?=$|[\s;&|"'(){}<>\x60])`
// An alias whose value runs merge or push, defined by `git config alias.x …`.
// `remote.<name>.push` is a refspec every plain `git push` then uses (set on the line or in the config).
const PUSH_KEY = String.raw`remote\.(?:[^\s.=]+\.){1,3}push(?![\w-])`
const PUSH_KEY_SET = new RegExp(PUSH_KEY, 'i')
const aliasDefinesMerge = (rest: string): boolean => {
  const m = /\balias\.[^\s=]*/i.exec(rest)
  if (m && /merge|push/i.test(rest.slice(m.index + m[0].length))) return true
  return PUSH_KEY_SET.test(rest) && !/\s--(?:get|list|unset)|\s-l\b/i.test(rest)
}
// `gh` or `gh.exe`, after a path and quotes or not.
const GH_CMD = String.raw`\bgh(?:\.exe)?['"]?\s+`
// A `gh api` call that merges (the merge endpoints), or writes the main branch (a method other than GET, or a field,
// which makes it a POST).
const API_WRITE = /(?:-X|--method)[ =]\s*['"]?(?:PATCH|POST|PUT|DELETE)|\s(?:-[fF]|--(?:raw-)?field|--input)/i
const apiTail = (rest: string): boolean =>
  /\bpulls\/[^/\s]+\/merge\b|\/merges(?![\w-])/i.test(rest) || (/\bgit\/refs\/heads\/(?:main|master)(?![\w/-])/i.test(rest) && API_WRITE.test(rest))
// More than 8 words between `git -x` and a merge or a push: read as one.
const overflow = (rest: string): boolean => rest.trim().split(/\s+/).some((w, i) => i >= 8 && /^(?:merge|push)(?![-\w])/i.test(w))
// A push to main (or of every branch), a forced one, or an alias set to run a merge or a push.
// A refspec with a wildcard, a brace list or a bare `:` may name main without saying so; `-f` may sit in a bundle
// of short flags (`-uf`).
const PUSH = new RegExp(String.raw`${MAIN}|\s--(?:all|mirror)(?![\w-])|--force\b|\s-[a-z]*f[a-z]*(?![\w-])|\*|(?<!\$)\{|(?:^|\s)['"]?\+?:['"]?(?=\s|$)`, 'i')
const gitTail = (rest: string, m: RegExpExecArray): boolean => !m[2] || (/^(?:push|send-pack)$/i.test(m[2]) ? PUSH.test(rest) : aliasDefinesMerge(rest))

export const DEFAULT_RULES: readonly Rule[] = [
  // merges and pushes to the main line
  D('merge', String.raw`${GH_CMD}pr\s+merge\b`),
  // An alias set to run a merge: what it runs is not read.
  afterRule('merge', String.raw`${GH_CMD}alias\s+set\b`, /merge/i),
  afterRule('merge', String.raw`${GIT}(?:(merge)(?![-\w])|(push|send-pack|config)\b)`, gitTail),
  // More than 8 options before the subcommand: it is not read, so a merge or a push after them is taken as one.
  // An alias defined on the command line (`-c alias.mm=merge`): what it runs is not read.
  afterRule('merge', String.raw`\bgit(?:\.exe)?['"]?\s+-\S*`, overflow),
  afterRule('merge', String.raw`\bgit\b`, new RegExp(String.raw`\s(?:-c|--config-env)[ =]?\s*['"]?(?:alias\.|${PUSH_KEY})`, 'i')),
  afterRule('merge', String.raw`${GH_CMD}api\b`, apiTail),
  // deploys and releases
  afterRule('deploy', String.raw`\b(?:vercel|netlify)\b`, /--prod\b/i),
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
  afterRule('restart', String.raw`\bdocker[\s-]compose\b`, /\b(?:restart|stop|down|up|kill|rm)\b/i),
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
//   with a flag that is not (`--output=`) or one written in quotes (`git commit '-m' …`: a quoted word that
//   starts like a flag, `-v` or `--output=a b`, leaves the whole text unmasked unless it is the value of a flag
//   of that tool, `-m`, `--body`, `grep -e`…), or a backslash-newline inside double quotes;
// - a step that writes a file with `>`; a here-doc body that goes anywhere but a .md or .txt file or stdout;
// - the text has a hidden character, a curly quote, a CR, a backtick, `$'`, `$(`, `${` or `$[` (but for the
//   one `git commit -m "$(cat <<'EOF'` form), a here-string, process substitution, a line continuation,
//   a backslash before a quote or a metacharacter, a comment, a subshell or a brace, `eval`, a shell or
//   interpreter given a code string (`bash -c`, `python -c`, `node -e`, `pwsh -Command`), a descriptor
//   or pipe set up for later (`exec 3>`, mkfifo, coproc), or a /dev or /proc target;
// - a quote is left open, a here-doc has no end line (or a line that starts with the word and goes on with
//   `)`, `;`, `|`, `&` or a blank) or two openers share a line, or an unquoted here-doc body, its
//   backslash-newlines dropped, expands `$( )` or holds the end word.
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

// What may follow a `$` inside double quotes or an unquoted here-doc body: a name, a digit, a special parameter,
// whitespace, a closing quote or the end. Everything else (`$(`, `${`, `$[`, which evaluates the command in an
// array subscript, `$'`, `$"`) can run code, so it is not data.
const EXPANDS = /^[^\w$?#!@*\s"-]/

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
      // In double quotes a backslash-newline is dropped by the shell: it can split a flag (`"--out\<nl>put=x"`).
      if (q === '"' && c === '\\') {
        if (!next || next === '\n') return null
        i++
      } else if (c === q) {
        quotes.push([qs, i])
        q = ''
      } else if (q === '"' && c === '$' && EXPANDS.test(next)) return null
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
  let t = ''
  let at = s.start
  for (const [a, b] of s.quotes) {
    t += text.slice(at, a - 1) + "''"
    at = b + 1
  }
  return (t + text.slice(at, s.end)).trim()
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
    // A top-level body ends at a line that is exactly the word; one that starts with the word and goes on
    // with `)`, `;`, `|`, `&` or a blank (`EOF)`, `EOF ;`) is not read, and one that goes on with a word
    // character (`EOFs are fine`) is plain body. Inside `$( )` bash also ends the body at a line that starts
    // with the word and has a `)` anywhere later (`EOF_=1 gh pr merge 5)`) and runs the rest as code: there
    // any line that starts with the word and is not exactly it is not read.
    const strip = (l: string) => (m[1] ? l.replace(/^\t+/, '') : l)
    const ends = (l: string) => strip(l).startsWith(word) && /^(?:[);|&\s]|$)/.test(strip(l).slice(word.length))
    const head = line.slice(0, m.index)
    const sub = /^(.*?)\$\([ \t]*cat[ \t]*$/.exec(head)
    const end = lines.findIndex((l, j) => j > i && ends(l))
    if (end < 0 || strip(lines[end] ?? '') !== word) return null
    if (sub && lines.slice(i + 1, end).some(l => strip(l).startsWith(word))) return null
    // An unquoted word: the shell drops each backslash-newline, then runs each `$( )` in the body as it reads
    // it, and a joined line can be the end word (`EO\<nl>F`) that ends the body early.
    const joined = lines.slice(i + 1, end).join('\n').replace(/\\\n/g, '')
    if (!m[2] && (/\$(?![\w$?#!@*\s"-]|$)|`/.test(joined) || joined.split('\n').some(ends))) return null
    const after = line.slice((m.index ?? 0) + m[0].length)
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

// A flag written in quotes (`grep '--pre=sh' …`, `git diff '--output=a b'`) is hidden by the shaped text, so a
// quoted word that starts like a flag (a dash, a letter; `- item` does not) leaves the text unmasked, unless it
// is the value of a flag of that step that takes one (`git commit -m '-fix'`, `grep -e '-v'`): there it is a
// message or a pattern, and a plain mention of `- item` or `-fix` stays quiet. The value flags are those of
// each tool; one that takes no value in a step (`gh pr review -r`, `git commit --template`) is not listed.
const FLAG_SHAPE = /^--?[A-Za-z]/
const GH = '--body|-b|--body-file|-F|--repo|-R'
const VALUE_FLAGS: [RegExp, RegExp][] = (
  [
    [String.raw`git[ \t]+commit`, '-m|-am|-F'],
    [String.raw`gh[ \t]+pr[ \t]+create`, `${GH}|--title|-t|--base|-B|--head|-H|--label|-l|--assignee|-a|--reviewer|-r|--milestone|-m`],
    [String.raw`gh[ \t]+pr[ \t]+edit`, `${GH}|--title|-t|--base|-B|--milestone|-m`],
    [String.raw`gh[ \t]+issue[ \t]+create`, `${GH}|--title|-t|--label|-l|--assignee|-a|--milestone|-m`],
    [String.raw`gh[ \t]+issue[ \t]+edit`, `${GH}|--title|-t|--milestone|-m`],
    [String.raw`gh[ \t]+(?:pr|issue)[ \t]+(?:comment|review)`, GH],
    [String.raw`(?:grep|egrep|fgrep)`, '-[nivwxcHhrIE]*[ef]'],
  ] as const
).map(([head, flags]) => [new RegExp(`^${head}(?![\\w-])`), new RegExp(`^(?:${flags})$`)])
// A word is a value when the word before it is a value flag that is not itself the value of one (`-m -m '--x'`:
// the second -m is the first one's value, so '--x' is a flag-shaped word of its own). The words are the shaped
// text before the quote; a quote glued to the word before it (`-m'--x'`) is not a word of its own. The words
// are read once, left to right, across all the quotes of the step: the state is carried from one quote to the next.
// `echo` prints a word that is not an option of its own as it is: a quoted `-e gh pr merge 5` is text. Only
// a word that is itself an option (`'-e'`) is read as a flag, as everywhere else.
const hasQuotedFlag = (text: string, s: Step, shaped: string): boolean => {
  const echo = /^echo(?![\w-])/.test(shaped)
  const flags = VALUE_FLAGS.find(([head]) => head.test(shaped))?.[1]
  // `want`: the last complete word is a value flag that is not itself a value. `cur`: the word being read.
  let want = false
  let cur = ''
  let at = s.start
  return s.quotes.some(([a, b]) => {
    const word = text.slice(a, b)
    if (echo) return /^-[neE]+$/.test(word)
    if (flags) {
      const parts = text.slice(at, a - 1).split(/\s+/)
      cur += parts[0]
      for (const part of parts.slice(1)) {
        want = !want && flags.test(cur)
        cur = part
      }
      // The quote is a word of its own only when a blank comes before it: then `cur` is empty.
      const value = want && /\s/.test(text[a - 2] ?? '')
      cur += "''"
      at = b + 1
      return FLAG_SHAPE.test(word) && !value
    }
    return FLAG_SHAPE.test(word)
  })
}

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
  let view = ''
  let at = 0
  for (const [a, b] of sc.steps.flatMap(s => s.quotes).sort((x, y) => x[0] - y[0])) {
    view += text.slice(at, a - 1) + "''"
    at = b + 1
  }
  return view + text.slice(at)
}

/**
 * `text` as the shell reads its words: quotes, backslash escapes (a backslash-newline is dropped) and empty
 * `''` / `""` count for nothing, so `gh pr 'merge' 5`, `g''h`, `mer\ge` and `"gh" pr merge` are the plain
 * words; in PowerShell the escape is the backtick and `''` / `""` inside a string is a quote. The text of a
 * quoted string stays; text already blanked by `dataMask` is a lone `''` word and goes. `$'` / `$"` lose the `$`.
 */
export const unquote = (text: string, isPowerShell = false): string => {
  const esc = isPowerShell ? '`' : '\\'
  let out = ''
  let q = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    const next = text[i + 1] ?? ''
    if (q === "'") {
      if (c !== "'") out += c
      else if (isPowerShell && next === "'") {
        out += c
        i++
      } else q = ''
    } else if (q === '"') {
      if (c === '"') {
        if (isPowerShell && next === '"') {
          out += c
          i++
        } else q = ''
      } else if (c === esc && (isPowerShell || /[$`"\\\n]/.test(next))) {
        if (next !== '\n') out += next
        i++
      } else out += c
    } else if (c === "'" || c === '"') q = c
    else if (c === esc) {
      if (next !== '\n') out += next
      i++
    } else if (c === '$' && !isPowerShell && (next === "'" || next === '"')) continue
    else out += c
  }
  return out
}

/** `text` with the `|`, `;` and `&` inside quotes, and an escaped blank, made plain, so a rule's `[^|;&]*` does not stop at a quoted one. */
const flatten = (text: string, isPowerShell: boolean): string => {
  const esc = isPowerShell ? '`' : '\\'
  let out = ''
  let q = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? ''
    if (q) {
      if (c === q) q = ''
      else if (q === '"' && c === esc) {
        out += c + (text[++i] ?? '')
        continue
      }
      out += '|;&'.includes(c) ? '_' : c
    } else if (c === "'" || c === '"') {
      q = c
      out += c
    } else if (c === esc && text[i + 1] === ' ') {
      out += '__'
      i++
    } else out += c
  }
  return out
}

export const matchRule = (rules: readonly Rule[], command: string, isPowerShell = false): Rule | undefined => {
  // PowerShell's `--%` only stops its own parsing: git sees the words after it.
  if (isPowerShell) command = command.replace(/(?<=\s)--%(?=\s)/g, '')
  const text =(isPowerShell ? null : dataMask(command)) ?? command
  const flat = flatten(text, isPowerShell)
  // A backslash (a backtick in PowerShell) before a line break joins the lines, in either line ending.
  const joined = /[\\`]\r\n/.test(text) ? text.replace(/[\\`]\r\n/g, ' ') : text
  const views = [...new Set([text, unquote(text, isPowerShell), flat, unquote(flat, isPowerShell), ...(joined === text ? [] : [joined, unquote(joined, isPowerShell)])])]
  return rules.find(r => views.some(v => r.re.test(v)))
}

export const criticalIn = (critical: readonly string[], command: string): string | undefined => {
  const low = command.toLowerCase()
  return critical.find(name => low.includes(name))
}
