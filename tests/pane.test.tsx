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
        questions: [{ question: 'Which way?', header: 'OAuth', options: [{ label: 'Update the console', description: 'with gcloud' }, { label: 'Code only' }] }],
      },
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
    ],
  }),
}

test('the pane draws sessions, workers and every kind of request, on every surface', async ($, on) => {
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
  expect(mine.version).toBe('0.5.0')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /HomeLab · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Migrate schema/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Update the console/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · extra/ })).toBeTruthy()
    // The session's card says it waits; the command is written out once, on the inbox card.
    expect(await ui.find({ type: 'Text', text: /^waiting for a permission$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Code', source: 'git push origin main' } as never)).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /git push origin main/ })).toBeFalsy()
    // The fixtures publish no version, as copies before 0.3 did: each is flagged.
    expect(await ui.find({ type: 'Text', text: /runs mod < 0\.3: \/reload-plugins there/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\s*Running\s*$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Lead · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Lead$/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /3 active \/ 3/ })).toBeTruthy()
    // Notes: its report waits on nothing, so its card names the permission behind it.
    expect((await ui.findAll({ type: 'Text', text: /^waiting for a permission$/ })).length).toBe(2)
    // Each worker row carries its context, tokens and elapsed time.
    expect(await ui.find({ type: 'Text', text: /ctx 22% · 44k/ })).toBeTruthy()
    // A report waiting for a go-ahead: its wrap-up question as the gist, the whole text on demand.
    expect(await ui.find({ type: 'Text', text: /GO-AHEAD/ })).toBeTruthy()
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
  expect(await ui.find({ key: 'open-me' })).toBeFalsy()
  expect(await ui.find({ key: 'open-b' })).toBeFalsy()
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
  const setup = (on: TestOn, agents: unknown[] = []) => {
    const written: Record<string, string> = {}
    on('command.register', () => ({ value: { command: 'agents-monitor' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('env.get', () => ({ value: undefined }))
    on('settings.read', () => ({ value: {} }))
    on('session.id', () => ({ value: 'me' }))
    on('session.cwd', () => ({ value: '/repos/project' }))
    on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
    on('session.usage', () => ({ value: { rateLimits: [] } as never }))
    on('agent.list', () => ({ value: agents as never }))
    on('fs.exists', () => ({ value: false }))
    const path = (e: unknown) => String((e as { path?: string }).path ?? '').replace(/\\/g, '/')
    // The bus as this session writes it: its own status file, and the answers the pane leaves.
    on('fs.list', (_, e) => ({ value: path(e).endsWith('/sessions') && written[`${path(e)}/me.json`] ? [{ kind: 'file', name: 'me.json', mtimeMs: Date.now() } as never] : [] }))
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