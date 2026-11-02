import { expect, test } from 'claude-code/testing'

import type { SessionStatus } from '../types'

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
  'b.json': status({
    sessionId: 'b',
    title: 'Recipes',
    state: 'running',
    costUsd: 1.5,
    agents: [{ id: 'w1', type: 'savvy-medium', description: 'Migrate schema', status: 'running', stepDone: 2, stepTotal: 4, stepNote: 'events' }],
  }),
}

test('the pane draws sessions, workers and every kind of request, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'agents-monitor' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('session.id', () => ({ value: 'me' }))
  on('session.cwd', () => ({ value: '/repos/coordinator' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.list', () => ({ value: Object.keys(FILES).map(name => ({ kind: 'file', name, mtimeMs: now })) }))
  on('fs.read', (_, e) => {
    const path = String((e as { path?: string }).path ?? '')
    const file = path.includes('sessions') ? FILES[path.split(/[\\/]/).pop() ?? ''] : undefined
    if (file) return { value: JSON.stringify(file) }
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/repos/coordinator', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'agents-monitor', args: '' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Home Server · Bash/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Migrate schema/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Update the console/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /62%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$1\.50/ })).toBeTruthy()
    await ui.unmount()
  }
})
