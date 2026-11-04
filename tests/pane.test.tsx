import { describe, expect, test, type TestBody } from 'claude-code/testing'

import type { SessionStatus } from '../types'

type TestOn = Parameters<TestBody>[1]

// The test environment has timers; the engine's lib types leave them out.
declare const setTimeout: (run: () => void, ms: number) => unknown

const PANE = {
  plugin: 'coordinator-monitor',
  component: 'Pane',
  requestId: 'coordinator-monitor',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const now = Date.now()
const status = (over: Partial<SessionStatus>): SessionStatus => ({
  v: 1,
  sessionId: 's',
  title: 't',
  cwd: '/repos/t',
  model: 'claude-opus-5-5',
  state: 'idle',
  isCoordinator: false,
  heartbeat: now,
  startedAt: now,
  rateLimits: [],
  agents: [],
  flow: null,
  requests: [],
  ...over,
})

// An app ask for a shell command, as the app files it: the tool's input as JSON, the command full of here-docs.
const HEREDOC_ASK = JSON.stringify(
  {
    command: [
      'S=C:/tmp/demo',
      "cat > $S/shots.js <<'EOF'",
      'const { chromium } = require("playwright");',
      'console.log("demo");',
      'EOF',
      'cd $S && node shots.js https://example.org out 2>&1 | tail -5',
      ...Array.from({ length: 6 }, (_, n) => `echo "line ${n}"`),
    ].join('\n'),
    timeout: 300000,
  },
  null,
  2,
)

// A large ask whose only block is a file of data: nothing in it can run, so its card may open folded.
const FOLD_ASK = JSON.stringify(
  {
    command: [
      'mkdir -p /tmp/demo',
      "cat > /tmp/demo/cfg.json <<'EOF'",
      '{"url": "https://example.org/feed"}',
      'EOF',
      'cd /tmp/demo && ls',
      ...Array.from({ length: 6 }, (_, n) => `echo "line ${n}"`),
    ].join('\n'),
    timeout: 60000,
  },
  null,
  2,
)

// Two sessions publishing: one waits on a permission and a choice, one runs a worker.
const FILES: Record<string, SessionStatus> = {
  'a.json': status({
    sessionId: 'a',
    title: 'Home Server',
    state: 'waiting',
    rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: new Date(now + 3600_000).toISOString() }],
    requests: [
      { id: 'p1', kind: 'permission', createdAt: now, tool: 'Bash', command: 'git push origin main', rule: 'push to main' },
      {
        id: 'c1',
        kind: 'choice',
        createdAt: now + 1,
        questions: [{ question: 'Which way?', header: 'OAuth', options: [{ label: 'Update the console', description: 'with gcloud\u200B' }, { label: 'Code only' }] }],
      },
      { id: 'x"><y', kind: 'questions', createdAt: now + 2, text: 'not a request id' },
    ],
  }),
  // Idle itself while its worker runs: it counts as running.
  'b.json': status({
    sessionId: 'b',
    title: 'Recipes',
    state: 'idle',
    costUsd: 1.5,
    agents: [{ id: 'w1', type: 'savvy-medium', description: 'Migrate schema', status: 'running', stepDone: 2, stepTotal: 4, stepNote: 'events', ctxPct: 22, tokens: 44_000 }],
    // Its turn ended on a report that waits for a go-ahead.
    requests: [{ id: 'r1', kind: 'report', createdAt: now + 3, text: 'Migrated the schema.\n\nShall I deploy it?', summary: 'Schema migrated; deploy pending', decision: 'Deploy to staging?', awaits: true }],
  }),
  // The coordinator: its request reaches the inbox, its own card stays out of the list.
  'c.json': status({
    sessionId: 'c',
    title: 'Lead',
    state: 'waiting',
    isCoordinator: true,
    requests: [{ id: 'p2', kind: 'permission', createdAt: now + 2, tool: 'Bash', command: 'gh pr merge 7', rule: 'merge' }],
  }),
  // A plain report ahead of a permission, its text not a string: the card still says what it waits on.
  'd.json': status({
    sessionId: 'd',
    title: 'Notes',
    state: 'waiting',
    requests: [
      { id: 'r2', kind: 'report', createdAt: now + 4, text: 42 as never, awaits: false },
      { id: 'p3', kind: 'permission', createdAt: now + 5, tool: 'Bash', command: 'npm publish', rule: 'publish' },
      // A file write, as the app asks it: its path and code lead, the JSON stays a press away.
      // Its explanation shows only beside the request itself, never in its place.
      { id: 'p4', kind: 'ask', createdAt: now + 6, tool: 'Write', command: JSON.stringify({ content: 'print(1)\n'.repeat(30), file_path: 'C:/repos/demo/run.py' }, null, 2), explain: 'Writes a demo script.' },
      // A large command whose split is not certain (a here-string), with a hidden reversal: no summary, the
      // whole command shown, the reversal as a code.
      { id: 'p6', kind: 'ask', createdAt: now + 8, tool: 'Bash', command: HEREDOC_ASK, isInput: true },
      { id: 'p13', kind: 'ask', createdAt: now + 15, tool: 'Bash', command: FOLD_ASK, isInput: true },
      // An explanation is the request's own text: drawn through visible() like every other.
      { id: 'p14', kind: 'permission', createdAt: now + 16, tool: 'Bash', command: 'npm run lint', rule: 'x', explain: `Runs the linter${String.fromCharCode(0x202e)}gnp` },
      // A bare command that looks like JSON with two `command` keys: it is a command, never decoded,
      // whatever the request claims about it.
      { id: 'p7', kind: 'ask', createdAt: now + 9, tool: 'Bash', command: '{"command":"$(evil)","command":"ls -la"}' },
      { id: 'p8', kind: 'ask', createdAt: now + 10, tool: 'Bash', command: '{"command":"$(evil)","command":"ls -la"}', isInput: true },
      // An inline script whose closing quotes are all that follows it: they sit under the block, not alone.
      { id: 'p9', kind: 'permission', createdAt: now + 11, tool: 'Bash', command: `ssh demo "pct exec 180 -- sh -c '\n${'echo step\n'.repeat(3)}'"`, rule: 'ssh' },
      // A short remnant that runs something keeps its own box: it is not a closer.
      { id: 'p10', kind: 'permission', createdAt: now + 12, tool: 'Bash', command: 'python -c "\nprint(1)\n"|sh', rule: 'exec' },
      { id: 'p11', kind: 'permission', createdAt: now + 13, tool: 'Bash', command: 'bash -c "\necho a\n"&&bash x', rule: 'exec' },
      { id: 'p12', kind: 'permission', createdAt: now + 14, tool: 'PowerShell', command: "@'\nWrite-Output 1\n'@ | iex", rule: 'exec' },
      { id: 'p5', kind: 'permission', createdAt: now + 7, tool: 'PowerShell', command: `$s = @"\n${'line\n'.repeat(30)}"@; Remove-Item C:/demo/x # \u202Egnp.exe`, rule: 'delete' },
    ],
  }),
}

test('the pane draws sessions, workers and every kind of request, on every surface', { options: { digestMinutes: '0' } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'agents-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'APPDATA' ? 'C:/AppData' : undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repos/coordinator' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  const written: Record<string, string> = {}
  on('fs.write', (_, e) => {
    const w = e as { path?: string; text?: string }
    written[String(w.path ?? '').replace(/\\/g, '/')] = String(w.text ?? '')
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  const notes: string[] = []
  on('session.append', (_, e, next) => {
    notes.push(JSON.stringify((e as { message: unknown }).message))
    return next(e)
  })
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } } as never
  })
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], env: e.init?.env as Record<string, string> | undefined })
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  // The desktop app's own record of this session, as it files it.
  const DESK = 'C:/AppData/Claude/claude-code-sessions'
  const DIRS: Record<string, never[]> = {
    [DESK]: [{ kind: 'dir', name: 'acct' } as never],
    [`${DESK}/acct`]: [{ kind: 'dir', name: 'org' } as never],
    [`${DESK}/acct/org`]: [
      { kind: 'file', name: 'local_other.json', mtimeMs: now } as never,
      { kind: 'file', name: 'local_me.json', mtimeMs: now - 1 } as never,
      { kind: 'file', name: 'local_a.json', mtimeMs: now - 2 } as never,
    ],
  }
  const DOCS: Record<string, unknown> = {
    [`${DESK}/acct/org/local_other.json`]: { cliSessionId: 'other', title: 'Not me' },
    [`${DESK}/acct/org/local_me.json`]: { cliSessionId: 'me', title: 'Coordinatore', effort: 'high' },
    // A session on an older copy of the mod publishes its folder name; the pane names it anyway.
    [`${DESK}/acct/org/local_a.json`]: { cliSessionId: 'a', title: 'HomeLab', effort: 'xhigh' },
  }
  const slash = (e: unknown): string => String((e as { path?: string }).path ?? '').replace(/\\/g, '/')
  on('fs.list', (_, e) => {
    const p = slash(e)
    return { value: DIRS[p] ?? (p.endsWith('/sessions') ? Object.keys(FILES).map(name => ({ kind: 'file', name, mtimeMs: now }) as never) : []) }
  })
  on('fs.read', (_, e) => {
    const p = slash(e)
    const doc = DOCS[p] ?? (p.includes('/sessions/') ? FILES[p.split('/').pop() ?? ''] : undefined)
    if (doc) return { value: JSON.stringify(doc) }
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/repos/coordinator', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'agents-monitor', args: '' } as never)

  // This session publishes the desktop's title and effort, not its folder name.
  for (let i = 0; i < 300 && !Object.keys(written).some(k => k.endsWith('/sessions/me.json')); i++) await new Promise<void>(r => setTimeout(r, 10))
  const mine = JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
  expect(mine.title).toBe('Coordinatore')
  expect(mine.folder).toBe('coordinator')
  expect(mine.effort).toBe('high')
  expect(mine.version).toBe('0.6.5')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /HomeLab · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Migrate schema/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Update the console/ })).toBeTruthy()
    // A choice's whole option is its press target: the title and the line under it.
    expect((await ui.find({ key: 'c1-0-0-b' }))?.text).toMatch(/Update the console\s*with gcloud/)
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · extra/ })).toBeTruthy()
    // The session's card says it waits; the command is written out once, on the inbox card.
    expect(await ui.find({ type: 'Text', text: /^waiting for a permission$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', source: 'git push origin main' } as never)).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Writes C:\/repos\/demo\/run\.py · 31 lines$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', text: /^(print\(1\)\n){11}print\(1\)$/ })).toBeTruthy()
    // The aid sits above the request, labelled as such; the request itself is always there, whole.
    expect(await ui.find({ type: 'Text', text: /^Reading aid, may be inaccurate/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', text: /"file_path": "C:\/repos\/demo\/run\.py"/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Writes a demo script/ })).toBeTruthy()
    expect(await ui.find({ key: 'raw-p4-b' })).toBeFalsy()
    // The request's size shows even with no aid, so a tail pushed out of sight is given away.
    expect(await ui.find({ type: 'Text', text: /^Full request \(what you approve\) · 32 lines · \d+ characters · 1 block$/ })).toBeTruthy()
    // A here-string is its own labelled block; the line after it is shell text, its reversal a code.
    expect(await ui.find({ type: 'Text', text: /^here-string \$s · 30 lines$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', text: /^"@; Remove-Item C:\/demo\/x # \\u202Egnp\.exe$/ })).toBeTruthy()
    // Another session's texts draw their hidden characters as codes; a request with an id the mod
    // would not make is dropped.
    expect((await ui.find({ key: 'c1-0-0-b' }))?.text).toMatch(/with gcloud\\u200B/)
    expect(await ui.find({ text: /not a request id/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /git push origin main/ })).toBeFalsy()
    // The fixtures publish no version, as copies before 0.3 did: each is flagged.
    expect(await ui.find({ type: 'Text', text: /runs mod < 0\.3: \/reload-plugins there/ })).toBeTruthy()
    // A badge is a rounded pill where SVG draws, its words its alt text; reversed text on the terminal.
    const badge = (label: string) => (surface === 'terminal' ? ui.find({ type: 'Text', text: new RegExp(`^\\s*${label}\\s*$`) }) : ui.find({ type: 'Svg', alt: label } as never))
    expect(await badge('Running')).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Lead · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Lead$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /3 active \/ 3/ })).toBeTruthy()
    // Notes: its report waits on nothing, so its card names the permission behind it.
    expect((await ui.findAll({ type: 'Text', text: /^waiting for a permission$/ })).length).toBe(2)
    // Each worker row carries its context, tokens and elapsed time.
    expect(await ui.find({ type: 'Text', text: /ctx 22% · 44k/ })).toBeTruthy()
    // A report waiting for a go-ahead: its wrap-up question as the gist, the whole text on demand.
    expect(await badge('GO-AHEAD')).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Deploy to staging\?/ })).toBeTruthy()
    expect(await ui.find({ text: /Migrated the schema/ })).toBeFalsy()
    await ui.press({ key: 'more-r1' })
    expect(await ui.find({ text: /Migrated the schema/ })).toBeTruthy()
    await ui.press({ key: 'more-r1' })
    // A session the desktop app knows opens from its card, by the app's deep link.
    await ui.press({ key: 'open-a' })
    expect(runs.at(-1)?.env?.CM_URL).toBe('claude://claude.ai/epitaxy/local_a')
    await ui.unmount()
  }
  // This session has no link to itself; one the desktop app does not know has none either.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // An app ask's JSON is read as what it is: the command itself, its here-doc a labelled block, the
  // other fields as lines, a reading aid in plain words above. No JSON escapes are left to read.
  expect(await ui.find({ type: 'Code', text: /"command": "S=/ })).toBeFalsy()
  // Over 6 lines, with nothing in it that can run (p13: a file of data), it opens folded: the recap, what it
  // touches, its size and its fields stay, and it can be approved as it is; its text is one press away.
  expect(await ui.find({ type: 'Code', text: /example\.org\/feed/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /^Touches \(always shown, read from the command\)$/ })).toBeTruthy()
  for (const line of [/^writes {2}\/tmp\/demo\/cfg\.json$/, /^goes to {2}\/tmp\/demo$/, /^url {2}https:\/\/example\.org\/feed$/])
    expect(await ui.find({ type: 'Text', text: line })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^timeout: 60000$/ })).toBeTruthy()
  expect(await ui.find({ key: 'once-p13' })).toBeTruthy()
  await ui.press({ key: 'full-p13' })
  expect(await ui.find({ type: 'Code', text: /example\.org\/feed/ })).toBeTruthy()
  // A block that runs keeps the card open, however large (p6: a script run later by node): its body is
  // on screen at once and there is nothing to unfold. So with short asks, and a request the aid gave up on.
  expect(await ui.find({ type: 'Code', text: /chromium/ })).toBeTruthy()
  for (const id of ['p6', 'p1', 'p5']) expect(await ui.find({ key: `full-${id}` })).toBeFalsy()
  // An explanation is drawn through visible(): a reversal shows as its code.
  expect(await ui.find({ type: 'Text', text: /^Runs the linter\\u202Egnp$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^→ file \$S\/shots\.js · 2 lines · run later by node$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Code', text: /^const \{ chromium \} = require\("playwright"\);\nconsole\.log\("demo"\);$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Code', text: /^EOF\ncd \$S && node shots\.js/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^timeout: 300000$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^followed by: '"$/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Code' })).some(c => c.text === `'"`)).toBe(false)
  for (const rest of ['"|sh', '"&&bash x', "'@ | iex"]) {
    expect((await ui.findAll({ type: 'Code' })).some(c => c.text === rest)).toBe(true)
    expect(await ui.find({ type: 'Text', text: `followed by: ${rest}` } as never)).toBeFalsy()
  }
  expect(await ui.find({ type: 'Text', text: /writes \$S\/shots\.js \(2 lines, run later by node\)/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /pipes into: tail -5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Full request \(what you approve\) · 11 steps · 12 lines · \d+ characters · 1 block$/ })).toBeTruthy()
  // The duplicate-key command shows as itself on both cards: no `ls -la` stands in for what runs.
  expect((await ui.findAll({ type: 'Code', text: /^\{"command":"\$\(evil\)","command":"ls -la"\}$/ })).length).toBe(2)
  expect((await ui.findAll({ type: 'Code' })).some(c => c.text === 'ls -la')).toBe(false)
  // Each card shows its request's short id; a press copies the whole id.
  expect((await ui.find({ key: 'id-p4' }))?.text).toBe('#p4')
  await ui.press({ key: 'id-p4' })
  expect(copied).toEqual(['p4'])
  expect(await ui.find({ key: 'open-me' })).toBeFalsy()
  expect(await ui.find({ key: 'open-b' })).toBeFalsy()
  // Every answer given here is noted in this session (the coordinator) too: the session's title quoted,
  // the request id and the answer, nothing else the session wrote. A dismissal leaves no note.
  await ui.press({ key: 'once-p1' })
  expect(Object.entries(written).find(([k]) => k.endsWith('/answers/a.json'))?.[1]).toContain('approve-once')
  await ui.press({ key: 'read-r2' })
  await ui.press({ key: 'dismiss-c1' })
  expect(notes[0]).toMatch(/answered request p1 \(#p1\) of the session titled \\"HomeLab\\" in the pane: approved once/)
  expect(notes[0]).not.toMatch(/git push/)
  expect(notes[1]).toMatch(/request r2 \(#r2\) of the session titled \\"Notes\\"[\s\S]*marked as read/)
  expect(notes.length).toBe(2)
  await ui.unmount()
})

test('questions leave when the person replies in the session, or the session speaks again', async ($, on) => {
  const written: Record<string, string> = {}
  on('command.register', () => ({ value: { command: 'agents-monitor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repos/project' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } as never }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    written[e.path.replace(/\\/g, '/')] = e.text
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('prompt.submit', (_, e) => ({ text: (e as { text: string }).text }) as never)

  const mine = (): SessionStatus => JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(r, 5))
  }

  await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Done.\n\n## Questions for you\n\n1. Which port?', isAborted: false } as never)
  await settle()
  expect(mine().requests.map(r => r.kind)).toEqual(['questions'])

  // A background task's notification starts a turn: that is not the person answering.
  await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' }, wait: false } as never)
  await $.turn.start({ turnId: 't2' } as never)
  await settle()
  expect(mine().requests.map(r => r.kind)).toEqual(['questions'])
  // Carlo answers in the session itself.
  await $.prompt.submit({ text: '8080', origin: { kind: 'composer' }, wait: false } as never)
  await settle()
  expect(mine().requests).toEqual([])

  // The answer may come through another session instead: the session's next closing message supersedes the questions.
  await $.turn.complete({ turnId: 't2', answer: 'Done.\n\n## Questions for you\n\n1. Which host?', isAborted: false } as never)
  await settle()
  await $.prompt.submit({ text: 'Carlo says: localhost', origin: { kind: 'peer' }, wait: false } as never)
  await $.turn.start({ turnId: 't3' } as never)
  await settle()
  await $.turn.complete({ turnId: 't3', answer: 'Set the host to localhost.', isAborted: false } as never)
  await settle()
  expect(mine().requests.map(r => r.kind)).toEqual(['report'])
})

describe('a session reporting', () => {
  const setup = (on: TestOn, agents: unknown[] = [], cwd = '/repos/project') => {
    const written: Record<string, string> = {}
    on('command.register', () => ({ value: { command: 'agents-monitor' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('env.get', () => ({ value: undefined }))
    on('settings.read', () => ({ value: {} }))
    on('session.id', () => ({ value: 'me' }))
    on('session.cwd', () => ({ value: cwd }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { rateLimits: [] } as never }))
    on('agent.list', () => ({ value: agents as never }))
    on('fs.exists', () => ({ value: false }))
    const path = (e: unknown) => String((e as { path?: string }).path ?? '').replace(/\\/g, '/')
    // The bus as this session writes it: its own status file, and the answers the pane leaves.
    on('fs.list', (_, e) => ({
      value: path(e).endsWith('/sessions') ? Object.keys(written).filter(k => k.startsWith(`${path(e)}/`)).map(k => ({ kind: 'file', name: k.split('/').pop(), mtimeMs: Date.now() }) as never) : [],
    }))
    on('fs.read', (_, e) => {
      const text = written[path(e)]
      if (text !== undefined) return { value: text }
      throw new Error('ENOENT')
    })
    on('fs.write', (_, e) => {
      written[e.path.replace(/\\/g, '/')] = e.text
      return { value: undefined }
    })
    on('clock.every', () => ({ value: undefined }))
    on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
    on('turn.complete', () => ({ text: '' }) as never)
    on('tool.call', () => ({ result: 'ok' }) as never)
    const prompts: string[] = []
    on('prompt.submit', (_, e) => {
      prompts.push((e as { text: string }).text)
      return { text: (e as { text: string }).text } as never
    })
    const mine = (): SessionStatus => JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise<void>(r => setTimeout(r, 5))
    }
    const answersFile = () => Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace('/sessions/', '/answers/') ?? ''
    return { mine, settle, written, prompts, answersFile }
  }

  test('a turn that ends on a report shows it, waiting when it asks for a go-ahead', async ($, on) => {
    const { mine, settle } = setup(on)
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.turn.start({ turnId: 't1' } as never)
    // The desktop's wrap-up box: its recap and its one question.
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Fix merged on the branch.', ask: 'Open the PR?' } as never)
    await $.turn.complete({ turnId: 't1', answer: 'Fixed the parser and pushed the branch.', isAborted: false } as never)
    await settle()
    const [r] = mine().requests
    expect(r?.kind).toBe('report')
    expect(r?.summary).toBe('Fix merged on the branch.')
    expect(r?.decision).toBe('Open the PR?')
    expect(r?.awaits).toBe(true)
    expect(mine().state).toBe('waiting')

    // A turn a notification started keeps it; that turn's own closing message supersedes it, and a
    // report that only informs does not make the session wait.
    await $.prompt.submit({ text: 'build finished', origin: { kind: 'task-notification' }, wait: false } as never)
    await $.turn.start({ turnId: 't2' } as never)
    await settle()
    expect(mine().requests.map(x => x.id)).toEqual([r?.id])
    await $.turn.complete({ turnId: 't2', answer: 'All tests pass. Nothing left to do.', isAborted: false } as never)
    await settle()
    expect(mine().requests.map(x => [x.kind, x.awaits])).toEqual([['report', false]])
    expect(mine().state).toBe('idle')

    // Asking for confirmation in so many words, with no wrap-up, waits too.
    await $.turn.start({ turnId: 't3' } as never)
    await $.turn.complete({ turnId: 't3', answer: 'Il branch è pronto. Attendo la tua conferma prima del merge.', isAborted: false } as never)
    await settle()
    expect(mine().requests[0]?.awaits).toBe(true)
  })

  test('a read receipt tells the session as a note, starts no turn, and the report leaves', { options: { digestMinutes: '0' } }, async ($, on) => {
    const { mine, settle, prompts } = setup(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const notes: string[] = []
    on('session.append', (_, e, next) => {
      notes.push(JSON.stringify((e as { message: unknown }).message))
      return next(e)
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.turn.start({ turnId: 't1' } as never)
    await $.turn.complete({ turnId: 't1', answer: 'Migrated the schema; all tests pass.', isAborted: false } as never)
    await settle()
    const [r] = mine().requests
    expect(r?.kind).toBe('report')
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: `read-${r?.id}` })
    await settle()
    expect(notes.at(-1)).toMatch(/Read receipt: .*Do not reply to this; carry on with your work/)
    expect(prompts).toEqual([])
    expect(mine().requests).toEqual([])
    await ui.unmount()
  })

  test('savvy workers and the flow report through the tools as the model calls them', async ($, on) => {
    const { mine, settle } = setup(on, [{ id: 'w1', type: 'savvy-medium', description: 'Migrate schema', status: 'running' }])
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    // The tool's arguments ride beside `tool`, the worker's loop as `agentId`.
    await $.tool.call({ tool: 'mcp__savvy-progress__step', done: 0, total: 4, agentId: 'w1' } as never)
    // Later reports name `done` alone; the total stands.
    await $.tool.call({ tool: 'mcp__savvy-progress__step', done: 1, note: 'schema', agentId: 'w1' } as never)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Calendar', total: 3, done: 1, phase: 'delegate' } as never)
    await $.turn.start({ turnId: 't1' } as never)
    await $.turn.complete({ turnId: 't1', answer: '', isAborted: false } as never)
    await settle()
    expect(mine().agents[0]).toMatchObject({ stepDone: 1, stepTotal: 4, stepNote: 'schema' })
    expect(mine().flow).toEqual({ title: 'Calendar', done: 1, total: 3, phase: 'delegate' })
  })

  test('a protected command the person answered in the session leaves the pane', async ($, on) => {
    const { mine, settle } = setup(on)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 7' }, tool_use_id: 'u1' } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission'])
    // A background task's notification is not the person: the card stays.
    await $.prompt.submit({ text: 'task done', origin: { kind: 'task-notification' }, wait: false } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission'])
    // A slash command is not an answer either.
    await $.prompt.submit({ text: '/help', command: { name: 'help', args: '' }, origin: { kind: 'composer' }, wait: false } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission'])
    await $.prompt.submit({ text: 'leave it for now', origin: { kind: 'composer' }, wait: false } as never)
    await settle()
    expect(mine().requests).toEqual([])
  })

  test('a card the pane answered survives the person typing until its answer is applied, and an answer retires no other card', async ($, on) => {
    const { mine, settle, written, prompts, answersFile } = setup(on)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 7' }, tool_use_id: 'u1' } as never)
    await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' }, tool_use_id: 'u2' } as never)
    await settle()
    const [a, b] = mine().requests
    expect([a?.command, b?.command]).toEqual(['gh pr merge 7', 'npm publish'])

    // Approved from the pane, not yet picked up; then the person types: the approval still reaches the
    // session, and only the unanswered card is retired.
    written[answersFile()] = JSON.stringify([{ requestId: a?.id, at: Date.now(), kind: 'approve-once' }])
    await $.prompt.submit({ text: 'meanwhile, update the docs', origin: { kind: 'composer' }, wait: false } as never)
    for (let i = 0; i < 300 && !prompts.some(t => t.includes('gh pr merge 7')); i++) await new Promise<void>(r => setTimeout(r, 10))
    await settle()
    expect(prompts.filter(t => t.startsWith('Approved')).length).toBe(1)
    expect(mine().requests).toEqual([])

    // Two cards again; approving one from the pane sends the session a message, which leaves the other.
    await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' }, tool_use_id: 'u3' } as never)
    await $.tool.check({ tool: 'Bash', input: { command: 'gh release create v1' }, tool_use_id: 'u4' } as never)
    delete written[answersFile()]
    await settle()
    expect(mine().requests.map(r => r.command)).toEqual(['npm publish', 'gh release create v1'])
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const [first] = mine().requests
    await ui.press({ key: `once-${first?.id}` })
    await settle()
    expect(prompts.some(t => t.includes('npm publish'))).toBe(true)
    expect(mine().requests.map(r => r.command)).toEqual(['gh release create v1'])
    await ui.unmount()
  })

  test('a closing message asking for one of the session own cards repeats nothing, before or after its answer', async ($, on) => {
    const { mine, settle, prompts } = setup(on)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 176' }, tool_use_id: 'u1' } as never)
    await settle()
    const id = mine().requests[0]?.id ?? ''
    expect(id).not.toBe('')

    // The session asks for the card in prose next to a real question: only the real one stays.
    await $.turn.start({ turnId: 't1' } as never)
    await $.turn.complete({ turnId: 't1', answer: `Waiting.\n\n## Domande per te\n\n1. Approvi nel pannello la richiesta ${id} (merge di PR #176)?\n2. Which port?`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission', 'questions'])
    expect(mine().requests[1]?.text).toBe('2. Which port?')

    // A section asking only for the card adds nothing; one with no numbered list is judged line by line.
    await $.turn.start({ turnId: 't2' } as never)
    await $.turn.complete({ turnId: 't2', answer: `## Questions for you\n\n1. Approve request ${id} in the pane?`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission'])
    // Its short form, as the card shows it, is the same card.
    await $.turn.start({ turnId: 't2a' } as never)
    await $.turn.complete({ turnId: 't2a', answer: `## Questions for you\n\n1. Approve #${id.slice(-6)} in the pane?`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => r.kind)).toEqual(['permission'])
    await $.turn.start({ turnId: 't2b' } as never)
    await $.turn.complete({ turnId: 't2b', answer: `## Questions for you\n\n- Approve request ${id} in the pane?\n- Which branch?`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => r.text ?? r.kind)).toEqual(['permission', '- Which branch?'])

    // Approved from the pane; a closing message still asking for it does not wait on the person.
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: `once-${id}` })
    await settle()
    expect(prompts.some(t => t.includes('gh pr merge 176'))).toBe(true)
    await $.turn.start({ turnId: 't3' } as never)
    await $.turn.complete({ turnId: 't3', answer: `Attendo che tu approvi la richiesta ${id}.`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => [r.kind, r.awaits])).toEqual([['report', false]])
    expect(mine().state).toBe('idle')
    await $.turn.start({ turnId: 't4' } as never)
    await $.turn.complete({ turnId: 't4', answer: `## Domande per te\n\n1. Approvi la richiesta ${id}?`, isAborted: false } as never)
    await settle()
    expect(mine().requests).toEqual([])
    // Naming the request as history is no ask for it: a real go-ahead still waits.
    await $.turn.start({ turnId: 't5' } as never)
    await $.turn.complete({ turnId: 't5', answer: `La richiesta ${id} è stata approvata e il merge è fatto. Faccio anche il push del tag?`, isAborted: false } as never)
    await settle()
    expect(mine().requests.map(r => [r.kind, r.awaits])).toEqual([['report', true]])
    await ui.unmount()
  })

  test('the answers a question offers as bold bullets are buttons in the pane', async ($, on) => {
    const { mine, settle, prompts } = setup(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    const merge = '1. Merge #319, then #320?\n   - **Done, clean up:** remove both worktrees and branches.\n   - **Not now:** leave everything as is.'
    await $.turn.start({ turnId: 't1' } as never)
    await $.turn.complete({ turnId: 't1', answer: `## Questions for you\n\n${merge}`, isAborted: false } as never)
    await settle()
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const [q] = mine().requests
    // One item: a press answers it with the label alone; the free-text box stays.
    expect(await ui.find({ key: `reply-${q?.id}` })).toBeTruthy()
    await ui.press({ key: `opt-${q?.id}-0-0` })
    await settle()
    expect(prompts.at(-1)).toMatch(/\n\nDone, clean up$/)
    await ui.unmount()

    // Several items: picked one by one, sent together with their numbers.
    await $.turn.start({ turnId: 't2' } as never)
    await $.turn.complete({ turnId: 't2', answer: `## Questions for you\n\n${merge}\n2. Which tag?\n   - **v1.2.0**\n   - **v2.0.0:** breaking`, isAborted: false } as never)
    await settle()
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const [q2] = mine().requests
    // A second press on a pick takes it back.
    await ui.press({ key: `opt-${q2?.id}-0-0` })
    await ui.press({ key: `opt-${q2?.id}-0-0` })
    await ui.press({ key: `opt-${q2?.id}-0-1` })
    await ui.press({ key: `opt-${q2?.id}-1-1` })
    expect(mine().requests.length).toBe(1)
    await ui.press({ key: `send-${q2?.id}` })
    await settle()
    expect(prompts.at(-1)).toMatch(/\n\n1\. Not now\n2\. v2\.0\.0$/)
    await ui.unmount()
  })

  test("a session's tasks, queue and progress show on its card, reorder without removal, fold, and the card locks", { options: { digestMinutes: '0' } }, async ($, on) => {
    const { mine, settle, prompts, written } = setup(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const notes: string[] = []
    on('session.append', (_, e, next) => {
      notes.push(JSON.stringify((e as { message: unknown }).message))
      return next(e)
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    // The desktop's plan tool: a whole list, then moved on step by step.
    const items = ['Parse the feed', 'Write the tests', 'Update the docs', 'Cut the release'].map((content, i) => ({ content, status: i ? 'pending' : 'in_progress' }))
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items } as never)
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
    // A subagent's list is its own.
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'worker step', status: 'pending' }], agentId: 'w1' } as never)
    await settle()
    expect(mine().plan?.map(p => p.status)).toEqual(['completed', 'in_progress', 'pending', 'pending'])

    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    // The coordinator queues a task for the session by its title; the pane shows it among the planned.
    // Two queued at once both land; a name that matches nothing changes nothing.
    // Outside the coordinator the queue tool changes nothing; the queue stands as the coordinator's left it.
    const queue = (args: object) => $.tool.call({ tool: 'mcp__coordinator-monitor__queue', ...args } as never) as Promise<{ result?: string }>
    expect((await queue({ action: 'add', session: 'project', text: 'x' })).result).toMatch(/Only the coordinator/)
    const bus = Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace(/\/sessions\/me\.json$/, '') ?? ''
    expect(written[`${bus}/queues.json`]).toBeUndefined()
    written[`${bus}/queues.json`] = JSON.stringify({ me: ['Benchmark the parser'] })
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'tasks-me' }))?.text).toMatch(/TASKS · 1 in progress · 3 planned · ✓ 1 done/)
    expect(await ui.find({ text: /^1 \/ 5 tasks$/ })).toBeTruthy()
    expect(await ui.find({ text: /from the coordinator/ })).toBeTruthy()
    // No control removes a task.
    expect(await ui.find({ text: /Removing a task: ask the coordinator or the session/ })).toBeTruthy()
    // The controls are icons at the end of each row, named by the legend line; the lock is an icon too.
    expect((await ui.find({ key: 'up-me-0' }))?.text).toBe('▲')
    expect((await ui.find({ key: 'top-me-0' }))?.text).toBe('⤒')
    expect((await ui.find({ key: 'lock-me' }))?.text).toBe('🔓')
    expect(await ui.find({ text: /Move to the top|Unlock/ })).toBeFalsy()

    // Down on the first planned task: the order holds in the pane and reaches the session as a note, with no turn.
    const before = prompts.length
    await ui.press({ key: 'down-me-0' })
    await settle()
    expect(notes.at(-1)).toMatch(/1\. Cut the release\\n2\. Update the docs\\n3\. Benchmark the parser \(queued by the coordinator\)/)
    expect(prompts.length).toBe(before)
    // A move that moves nothing tells nobody.
    await ui.press({ key: 'up-me-0' })
    await settle()
    expect(notes.length).toBe(1)
    expect((await ui.find({ key: 'pl-me-0' }))?.text).toMatch(/Cut the release/)
    // A new plan keeps the order for the tasks it still has.
    await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', done: [2], start: 3 } as never)
    await settle()
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    expect((await ui.find({ key: 'pl-me-0' }))?.text).toMatch(/Cut the release/)

    // Folded, the list hides; locked, the card heads its own group.
    await ui.press({ key: 'tasks-me' })
    expect(await ui.find({ key: 'pl-me-0' })).toBeFalsy()
    expect(await ui.find({ text: /LOCKED/ })).toBeFalsy()
    await ui.press({ key: 'lock-me' })
    expect(await ui.find({ text: /LOCKED · your order/ })).toBeTruthy()
    // The wrap-up checks the list off.
    await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Done.' } as never)
    await settle()
    expect(mine().plan?.every(p => p.status === 'completed')).toBe(true)
    await ui.unmount()
  })

  test('the coordinator queues tasks for a session; two at once both land', { options: { coordinatorFolder: 'coordinator' } }, async ($, on) => {
    const { settle, written } = setup(on, [], '/repos/coordinator')
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/repos/coordinator', surface: 'desktop', isInteractive: true })
    await settle()
    const bus = Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace(/\/sessions\/me\.json$/, '') ?? ''
    written[`${bus}/sessions/p.json`] = JSON.stringify(status({ sessionId: 'p', title: 'project', heartbeat: Date.now() }))
    await $.command.run({ command: 'agents-monitor', args: '' } as never)
    const queue = (args: object) => $.tool.call({ tool: 'mcp__coordinator-monitor__queue', ...args } as never) as Promise<{ result?: string }>
    await Promise.all([queue({ action: 'add', session: 'project', text: 'Benchmark the parser' }), queue({ action: 'add', session: 'proj', text: 'Profile the cache' })])
    expect((await queue({ action: 'list', session: 'project' })).result).toMatch(/1\. Benchmark the parser\n2\. Profile the cache/)
    expect((await queue({ action: 'add', session: 'nowhere', text: 'x' })).result).toMatch(/No session/)
    expect((await queue({ action: 'remove', session: 'project', text: 'Profile' })).result).not.toMatch(/Profile/)
    expect(JSON.parse(written[`${bus}/queues.json`] ?? '{}')).toEqual({ p: ['Benchmark the parser'] })
    await settle()
  })

  describe('quiet notes (an approval, a denial, a read receipt) are delivered together', () => {
    type Row = { seq: number; at: number; text: string }
    // The queue is the session's state, not a file in the bus where another process could write it: the
    // tests hold that value themselves, so they can read it and seed what an earlier run left.
    const track = (on: TestOn) => {
      // As the engine stores a shaped value: the value under its shape's name.
      type Stored = { shape: string; value: { seq: number; rows: Row[] } }
      let cur: Stored | undefined
      let version = 0
      const isDigest = (e: unknown) => (e as { key?: string }).key === 'digest'
      on('state.get', (_, e, next) => (isDigest(e) ? ({ value: { value: cur, version } } as never) : next(e)))
      on('state.set', (_, e, next) => {
        if (!isDigest(e)) return next(e)
        const w = e as unknown as { value: Stored; ifVersion?: number }
        if (w.ifVersion !== undefined && w.ifVersion !== version) return { value: { isSet: false, version } } as never
        cur = w.value
        return { value: { isSet: true, version: ++version } } as never
      })
      return {
        rows: (): Row[] => cur?.value.rows ?? [],
        seed: (v: Stored['value']) => {
          cur = { shape: 'digest-1', value: v }
          version++
        },
      }
    }
    const watch = (on: TestOn) => {
      const notes: string[] = []
      on('session.append', (_, e, next) => {
        notes.push(((e as unknown as { message: { content: { text: string }[] } }).message.content[0]?.text) ?? '')
        return next(e)
      })
      return notes
    }

    test('a read receipt waits in the session state, and is read in the turn that starts anyway', async ($, on) => {
      const { mine, settle } = setup(on)
      on('ui.open', () => ({ value: { isPlaced: true } }))
      const notes = watch(on)
      const queue = track(on)
      await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
      await $.turn.start({ turnId: 't1' } as never)
      await $.turn.complete({ turnId: 't1', answer: 'Migrated the schema; all tests pass.', isAborted: false } as never)
      await settle()
      const [r] = mine().requests
      await $.command.run({ command: 'agents-monitor', args: '' } as never)
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      await ui.press({ key: `read-${r?.id}` })
      await settle()
      // Nothing was added to the conversation: an idle session would have been woken by it.
      expect(notes).toEqual([])
      expect(queue.rows().map(x => x.text)).toEqual([expect.stringMatching(/Read receipt: .*Do not reply to this/)])
      // The next turn starts for its own reasons: the note is the row before it.
      await $.turn.start({ turnId: 't2' } as never)
      await settle()
      expect(notes).toEqual([expect.stringMatching(/Read receipt: .*Do not reply to this/)])
      expect(queue.rows()).toEqual([])
      await ui.unmount()
    })

    test('the coordinator hears free text at once, after the notes before it, in order', { options: { coordinatorFolder: 'coordinator' } }, async ($, on) => {
      const { settle, written } = setup(on, [], '/repos/coordinator')
      on('ui.open', () => ({ value: { isPlaced: true } }))
      const notes = watch(on)
      const queue = track(on)
      on('ui.toast', () => ({ value: undefined }))
      await $.session.start({ cwd: '/repos/coordinator', surface: 'desktop', isInteractive: true })
      await settle()
      const bus = Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace(/\/sessions\/me\.json$/, '') ?? ''
      const ask = '1. Merge #319, then #320?\n   - **Done, clean up:** remove both worktrees and branches.\n   - **Not now:** leave everything as is.'
      written[`${bus}/sessions/p.json`] = JSON.stringify(
        status({
          sessionId: 'p',
          title: 'project',
          heartbeat: Date.now(),
          requests: [
            { id: 'a1', kind: 'permission', createdAt: Date.now(), tool: 'Bash', command: 'npm test', rule: 'x' },
            { id: 'a2', kind: 'permission', createdAt: Date.now() + 1, tool: 'Bash', command: 'npm run lint', rule: 'x' },
            { id: 'q1', kind: 'questions', createdAt: Date.now() + 2, text: ask },
          ],
        }),
      )
      await $.command.run({ command: 'agents-monitor', args: '' } as never)
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      await ui.press({ key: 'once-a1' })
      await ui.press({ key: 'deny-a2' })
      await settle()
      expect(notes).toEqual([])
      expect(queue.rows().map(x => x.seq)).toEqual([1, 2])
      await ui.press({ key: 'opt-q1-0-0' })
      await settle()
      // One row for the two quiet notes, oldest first, then the answer; none kept back.
      expect(notes.length).toBe(2)
      expect(notes[0]).toMatch(/^\[coordinator-monitor\] 2 notes from the pane, oldest first[\s\S]*1\. .*request a1[\s\S]*approved once[\s\S]*2\. .*request a2[\s\S]*denied$/)
      expect(notes[1]).toMatch(/request q1 \(#q1\) of the session titled \\?"project\\?" in the pane: [\s\S]*Done, clean up/)
      expect(queue.rows()).toEqual([])
      await ui.unmount()
    })

    test('the text of an order from the bus answers file is data: drawn through visible() and fenced in the queued note', async ($, on) => {
      const { mine, settle, written, answersFile } = setup(on)
      const queue = track(on)
      // A hidden reversal and a code fence in a task, the two things that could pass for the digest's own structure.
      const text = `1. ship it ${String.fromCharCode(0x202e)}gnp\n2. \`\`\`\nnot a row`
      on('ui.open', () => ({ value: { isPlaced: true } }))
      await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
      await $.turn.start({ turnId: 't1' } as never)
      await $.turn.complete({ turnId: 't1', answer: 'Migrated the schema; all tests pass.', isAborted: false } as never)
      await settle()
      const [r] = mine().requests
      // The answers file as the pane left it; the person's next answer applies everything in it.
      written[answersFile()] = JSON.stringify([{ requestId: 'order-1', at: Date.now(), kind: 'order', text }])
      await $.command.run({ command: 'agents-monitor', args: '' } as never)
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      await ui.press({ key: `read-${r?.id}` })
      await settle()
      const [row] = queue.rows()
      await ui.unmount()
      expect(row?.text).toContain('\\u202Egnp')
      expect(row?.text).not.toContain(String.fromCharCode(0x202e))
      // Fenced by a longer fence than the three backticks in the text, so nothing in it can close the fence early.
      expect(row?.text).toMatch(/\n````\n1\. ship it [\s\S]*\n2\. ```\nnot a row\n````$/)
    })

    test('notes left from before a restart are delivered once they are old enough, and not before', async ($, on) => {
      const { settle } = setup(on)
      const notes = watch(on)
      const queue = track(on)
      const minutes = (n: number) => Date.now() - n * 60_000
      // What a session left in its state: a note from 20 minutes ago and one from 2 minutes ago.
      queue.seed({ seq: 2, rows: [{ seq: 1, at: minutes(20), text: 'old note' }, { seq: 2, at: minutes(2), text: 'newer note' }] })
      await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
      await settle()
      expect(notes).toEqual([expect.stringMatching(/^\[coordinator-monitor\] 2 notes from the pane[\s\S]*1\. old note\n\n2\. newer note$/)])
      expect(queue.rows()).toEqual([])
      // Younger than the interval, a note stays.
      queue.seed({ seq: 3, rows: [{ seq: 3, at: minutes(2), text: 'fresh note' }] })
      await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
      await settle()
      expect(notes.length).toBe(1)
      expect(queue.rows().map(x => x.text)).toEqual(['fresh note'])
    })
  })

  test("a subagent's request is answered to that agent; when it is gone, the parent is told whose it is", async ($, on) => {
    const { mine, settle, written, prompts, answersFile } = setup(on, [{ id: 'w1', type: 'savvy-medium', description: 'Release worker', status: 'completed' }])
    on('tool.check', () => ({ decision: 'allow' }) as never)
    const sent: string[] = []
    let isReachable = true
    on('session.send', (_, e) => {
      sent.push(e.text)
      return isReachable ? { isDelivered: true } : { isDelivered: false, reason: 'gone' }
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' }, tool_use_id: 'u1', agentId: 'w1' } as never)
    await settle()
    const [a] = mine().requests
    expect(a?.agentId).toBe('w1')
    written[answersFile()] = JSON.stringify([{ requestId: a?.id, at: Date.now(), kind: 'approve-once' }])
    for (let i = 0; i < 300 && !sent.length; i++) await new Promise<void>(r => setTimeout(r, 10))
    expect(sent[0]).toMatch(/Approved[\s\S]*npm publish/)
    expect(prompts.some(t => t.includes('npm publish'))).toBe(false)

    isReachable = false
    const check = async (u: string, agentId?: string) =>
      ((await $.tool.check({ tool: 'Bash', input: { command: 'gh release create v1' }, tool_use_id: u, agentId } as never)) as { decision?: string }).decision
    await check('u2', 'w1')
    await settle()
    const [b] = mine().requests
    written[answersFile()] = JSON.stringify([{ requestId: b?.id, at: Date.now(), kind: 'approve-once' }])
    for (let i = 0; i < 300 && !prompts.some(t => t.includes('gh release create v1')); i++) await new Promise<void>(r => setTimeout(r, 10))
    expect(prompts.at(-1)).toMatch(/subagent "w1 \(Release worker\)"[\s\S]*that agent's, not yours[\s\S]*for that agent alone[\s\S]*Approved[\s\S]*gh release create v1/)
    // The approval is the agent's alone: the parent running the same command is asked again.
    expect(await check('u3')).toBe('deny')
    expect(await check('u4', 'w1')).toBe('allow')
    await settle()
  })
})
describe('the app asking for a permission', () => {
  // `file` is the name the coordinator's status file is listed under: anything but c.json poses as it.
  // `version` is the copy of the mod the coordinator publishes.
  const setup = (on: TestOn, coordinator: boolean, file = 'c.json', version?: string) => {
    const written: Record<string, string> = {}
    const COORD = JSON.stringify({ v: 1, sessionId: 'c', version, title: 'Coordinatore', cwd: '/c', model: 'm', state: 'running', isCoordinator: true, heartbeat: Date.now(), startedAt: 0, rateLimits: [], agents: [], flow: null, requests: [] })
    on('command.register', () => ({ value: { command: 'agents-monitor' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('env.get', () => ({ value: undefined }))
    on('settings.read', () => ({ value: {} }))
    on('session.id', () => ({ value: 'me' }))
    on('session.cwd', () => ({ value: '/repos/project' }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { rateLimits: [] } as never }))
    on('agent.list', () => ({ value: [] }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', (_, e) => ({ value: coordinator && e.path.replace(/\\/g, '/').endsWith('/sessions') ? [{ kind: 'file', name: file, mtimeMs: Date.now() } as never] : [] }))
    on('fs.read', (_, e) => {
      const p = e.path.replace(/\\/g, '/')
      if (coordinator && p.endsWith(`/sessions/${file}`)) return { value: COORD }
      if (written[p] !== undefined) return { value: written[p] }
      throw new Error('ENOENT')
    })
    on('fs.write', (_, e) => {
      written[e.path.replace(/\\/g, '/')] = e.text
      return { value: undefined }
    })
    on('clock.every', () => ({ value: undefined }))
    const mine = () => JSON.parse(Object.entries(written).find(([k]) => k.endsWith('/sessions/me.json'))?.[1] ?? '{}') as SessionStatus
    // The pane, while the session waits: what it saw on the card, and the answer it gives (none: no answer in time).
    // `hold`: the pane takes its time, while the person answers the app's own dialog in the session.
    const pane = { reply: undefined as string | undefined, seen: [] as string[], hold: undefined as Promise<void> | undefined }
    on('process.run', async (_, e) => {
      const ask = mine().requests.at(-1)
      pane.seen.push(ask?.command ?? '')
      await pane.hold
      // The engine resolves the mod's paths: the answers file sits beside the status file it wrote.
      const file = Object.keys(written).find(k => k.endsWith('/sessions/me.json'))?.replace('/sessions/', '/answers/')
      expect(file?.endsWith(String(e.init?.env?.CM_FILE).slice(1))).toBe(true)
      if (ask && file && pane.reply) written[file] = JSON.stringify([{ requestId: ask.id, at: Date.now(), kind: pane.reply }])
      return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
    })
    return { mine, pane }
  }

  test('goes to the pane while a coordinator is there, and the session waits for the answer', async ($, on) => {
    const { mine, pane } = setup(on, true)
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    type R = { decision?: { behavior: string } }
    pane.reply = 'approve-once'
    const r = (await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)) as R
    expect(r.decision?.behavior).toBe('allow')
    expect(dialog).toBe(false)
    expect(pane.seen).toEqual(['npm test'])
    expect(mine().requests).toEqual([])
    // Any field beyond the command is part of what is asked: it shows, and the answer covers it alone.
    pane.reply = 'deny'
    const d = (await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests', dangerouslyDisableSandbox: true } } as never)) as R
    expect(d.decision?.behavior).toBe('deny')
    expect(pane.seen[1]).toContain('"dangerouslyDisableSandbox": true')
    expect(pane.seen[1]).not.toContain('run tests')
    // No answer in time: the app's own dialog asks.
    pane.reply = undefined
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } } as never)
    expect(dialog).toBe(true)
    expect(mine().requests).toEqual([])
    // Too long to show whole: the dialog, without asking the pane.
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'x'.repeat(9000) } } as never)
    expect(pane.seen.length).toBe(3)
  })

  test('a protected command waits in its call for the pane: approved, it runs with no new turn', async ($, on) => {
    const { mine, pane } = setup(on, true)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    const prompts: string[] = []
    on('prompt.submit', (_, e) => {
      prompts.push((e as { text: string }).text)
      return { text: (e as { text: string }).text } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    type V = { decision?: string; reason?: string }
    pane.reply = 'approve-once'
    const ok = (await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 7' }, tool_use_id: 'u1' } as never)) as V
    expect(ok.decision).toBe('allow')
    expect(pane.seen).toEqual(['gh pr merge 7'])
    expect(mine().requests).toEqual([])
    expect(prompts).toEqual([])
    // No answer in time: refused, and the card stays for the answer to come by turns.
    pane.reply = undefined
    const later = (await $.tool.check({ tool: 'Bash', input: { command: 'gh pr merge 8' }, tool_use_id: 'u2' } as never)) as V
    expect(later.decision).toBe('deny')
    expect(mine().requests.map(r => r.command)).toEqual(['gh pr merge 8'])
    expect(later.reason).toContain(mine().requests[0]?.id ?? '?')
  })

  test('a dialog answered in the session leaves the pane, by the call running or the turn ending', async ($, on) => {
    const { mine, pane } = setup(on, true)
    on('classic.PermissionRequest', () => ({ decision: { behavior: 'allow' } }) as never)
    on('tool.call', () => ({ result: 'ok' }) as never)
    on('turn.complete', () => ({ text: '' }) as never)
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    const asked = async () => {
      for (let i = 0; i < 300 && !mine().requests?.length; i++) await new Promise<void>(r => setTimeout(r, 10))
      return mine().requests.map(r => r.kind)
    }
    // The session republishes in the background once it retires a card.
    const left = async () => {
      for (let i = 0; i < 300 && mine().requests.length; i++) await new Promise<void>(r => setTimeout(r, 10))
      return mine().requests
    }
    let release = () => {}
    pane.hold = new Promise<void>(r => (release = r))
    const first = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
    expect(await asked()).toEqual(['ask'])
    // Allowed at the dialog: the call runs, and the card goes.
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    expect(await left()).toEqual([])
    release()
    await first

    pane.hold = new Promise<void>(r => (release = r))
    const second = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm run build' } } as never)
    expect(await asked()).toEqual(['ask'])
    // Refused, or interrupted: the turn ends, and nothing waits on the dialog any more.
    await $.turn.complete({ turnId: 't1', answer: '', isAborted: true } as never)
    expect(await left()).toEqual([])
    release()
    await second
  })

  test('a session reloads its plugins once when the coordinator runs a newer copy', async ($, on) => {
    setup(on, true, 'c.json', '9.9.9')
    const runs: string[] = []
    on('command.run', (_, e) => {
      runs.push(e.command)
      return { text: '' } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    for (let i = 0; i < 300 && !runs.length; i++) await new Promise<void>(r => setTimeout(r, 10))
    expect(runs).toEqual(['reload-plugins'])
  })

  test('a status file posing as another session does not count', async ($, on) => {
    setup(on, true, 'forged.json')
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
    expect(dialog).toBe(true)
  })

  test('keeps the dialog when no coordinator is there', async ($, on) => {
    setup(on, false)
    let dialog = false
    on('classic.PermissionRequest', () => {
      dialog = true
      return { decision: { behavior: 'allow' } } as never
    })
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } } as never)
    expect(dialog).toBe(true)
  })

  test('no session may write the pane answers itself', async ($, on) => {
    setup(on, true)
    on('tool.check', () => ({ decision: 'allow' }) as never)
    await $.session.start({ cwd: '/repos/project', surface: 'desktop', isInteractive: true })
    const r = (await $.tool.check({ tool: 'Write', input: { file_path: 'C:\\Users\\x\\.claude\\coordinator-monitor\\answers\\me.json', content: '[]' }, tool_use_id: 'u1', isReadOnly: false } as never)) as { decision?: string }
    expect(r.decision).toBe('deny')
    // The mod's own source, and a read of the bus, stay allowed.
    const src = (await $.tool.check({ tool: 'Edit', input: { file_path: 'C:\\repos\\coordinator-monitor\\hooks\\register.tsx', old_string: 'a', new_string: '.claude/coordinator-monitor' }, tool_use_id: 'u2' } as never)) as { decision?: string }
    expect(src.decision).toBe('allow')
    const look = (await $.tool.check({ tool: 'Read', input: { file_path: 'C:\\Users\\x\\.claude\\coordinator-monitor\\sessions\\c.json' }, tool_use_id: 'u3', isReadOnly: true } as never)) as { decision?: string }
    expect(look.decision).toBe('allow')
  })
})