export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  /** When this session first saw it run, and saw it finish (epoch ms). */
  startedAt?: number
  endedAt?: number
  /** Its context window's fill, and that context in tokens, at its last model request. */
  ctxPct?: number
  tokens?: number
}

/** One task of a session: from its own plan (update_plan, TodoWrite), or queued for it by the coordinator. */
export type PlanItem = { text: string; status: 'pending' | 'in_progress' | 'completed'; from?: 'queue' }

export type ChoiceOption = { label: string; description?: string }

export type ChoiceQuestion = {
  header?: string
  question: string
  multiSelect?: boolean
  options: ChoiceOption[]
}

/**
 * `ask` is the app's own permission dialog, up in the session: shown, answered there.
 * `report` is what a session said as its turn ended, when it asked no questions.
 */
export type RequestKind = 'permission' | 'choice' | 'questions' | 'ask' | 'report'

export type MonitorRequest = {
  id: string
  kind: RequestKind
  createdAt: number
  /** permission: the tool and the command it was asked to run. */
  tool?: string
  command?: string
  /** ask: `command` is the tool's input as JSON the mod wrote (more fields than a command), not a bare command. */
  isInput?: boolean
  /** permission: why it is protected (the rule's label). */
  rule?: string
  /** choice: the questions as the model asked them. */
  questions?: ChoiceQuestion[]
  /** questions: the '## Questions for you' section, as markdown; report: the closing message. */
  text?: string
  agentId?: string
  /** report: the desktop wrap-up's recap and its question, when the session gave one. */
  summary?: string
  decision?: string
  /** report: the session waits for the person's go-ahead before it carries on. */
  awaits?: boolean
  /** permission, ask: a model's plain-language gloss of a large request, when the person turned that on. */
  explain?: string
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type FlowInfo = { title: string; done: number; total: number; phase?: string }

export type SessionState = 'running' | 'idle' | 'waiting' | 'ended'

export type SessionStatus = {
  v: 1
  sessionId: string
  /** The mod version that published it; absent before 0.3. */
  version?: string
  /** The sidebar title the desktop app gave the session, else the folder. */
  title: string
  /** The folder title (`project` or `project › worktree`). */
  folder?: string
  cwd: string
  model: string
  effort?: string
  state: SessionState
  isCoordinator: boolean
  heartbeat: number
  startedAt: number
  contextPct?: number
  costUsd?: number
  rateLimits: RateLimit[]
  agents: AgentRow[]
  flow: FlowInfo | null
  requests: MonitorRequest[]
  /** The session's own task list, as its plan tool last left it; absent before 0.6. */
  plan?: PlanItem[]
  /** The desktop app's id for the session (`local_…`), added by the pane: it opens the session. */
  localId?: string
  /** What the coordinator queued for it, added by the pane. */
  queue?: string[]
}

/**
 * `dismiss` drops a request without telling the session anything; `read` drops a report and tells the
 * session it was read. `order` names no request: its text is the planned tasks in the order the
 * person set, for the session to follow.
 */
export type AnswerKind = 'approve-once' | 'approve-session' | 'deny' | 'answer' | 'dismiss' | 'read' | 'order'

export type Answer = { requestId: string; at: number; kind: AnswerKind; text?: string }

export type Board = { sessions: SessionStatus[]; updatedAt: number }

export type Local = {
  requests: MonitorRequest[]
  grantsOnce: string[]
  grantsSession: string[]
  steps: Record<string, { done: number; total: number; note?: string }>
  flow: FlowInfo | null
  plan?: PlanItem[]
  /** The requests this session is done with: answered from the pane, or retired. */
  applied: string[]
  /** The coordinator's version this session last reloaded its plugins to follow. */
  reloadTried?: string
}

export type PaneUi = {
  filter: 'all' | 'waiting' | 'active'
  collapsed: Record<string, boolean>
  picks: Record<string, number[]>
  sent: string[]
  /** Reports drawn whole rather than as their one-line summary; a permission's full command (`<id>:raw`). */
  open?: Record<string, boolean>
  /** Sessions held in place, in the person's order, above the rest. */
  locked?: string[]
  /** Each session's planned tasks, by text, in the order the person set. */
  order?: Record<string, string[]>
  /** Sessions whose task list is folded. */
  tasksFolded?: Record<string, boolean>
}

/** What the coordinator queued per session, by session id: the mod writes it, the pane reads it. */
export type Queues = Record<string, string[]>

declare module 'claude-code' {
  interface PluginState {
    'coordinator-monitor': {
      board: Shaped<Board>
      local: Shaped<Local>
      ui: Shaped<PaneUi>
    }
  }
}
