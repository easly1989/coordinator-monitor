# Changelog

## 0.6.1 — 2026-11-03

### Security

- **The full request is always on the card, and it is what you approve.** It is shown whole, wrapped and never cut. Hidden characters in it are drawn as codes; a CR or another character a shell may take for a line break also breaks the line there. Padding that could push a step out of sight is counted instead of drawn: three or more blank lines, or twenty or more spaces or tabs, show as `⟨300 blank lines⟩` or `⟨3000 spaces⟩`. The request's size (lines and characters) always sits above it, with or without the aid. The 0.6.0 summary is now only a reading aid above the request, labelled "Reading aid, may be inaccurate". It never takes the request's place, and no toggle hides the request. Parsing shells cannot be made exact, so the request itself is the safeguard.
- **The reading aid gives up rather than guess.** Steps follow the asking tool's shell (Bash or PowerShell). In PowerShell `\"` ends a string and a doubled quote stays inside one; in bash a backslash inside single quotes is literal. A lone `&` ends a step, and nothing inside a step is collapsed. Any of these means no steps at all:
  - a curly quote (PowerShell reads it as a quote);
  - a comment (`#` starting a word, or `<#`);
  - a bare CR, or another hidden character;
  - an open quote or `$(`;
  - a here-doc or here-string;
  - a backtick substitution or `$'…'` in bash;
  - a line continuation;
  - more than 40 steps.

  The step count sits next to the request's size.
- **Hidden characters show as codes everywhere another session's text is drawn.** That covers the session title, the tool, the rule, the request, the explanation, reports, questions, choices and their options, tasks and subagent rows. The set covers controls, bidi marks, overrides and isolates, zero-width and other invisible fillers, variation selectors, tag characters and lone surrogates. It also covers every character Unicode lists as default-ignorable or as a format character, beyond the first plane too (`\u{E0041}`), and stacks of three or more combining marks.
- **Request ids are checked.** The mod makes ids short and plain: letters, digits, `_` and `-`, 40 at most. A request read from another session with any other id is dropped.
- **The coordinator's record of an answer carries no text from the other session** except its title, quoted. It holds the request id and your answer, but no question or report text, and no task list on a reorder. A dismissal leaves no record. The mod API has no model-readable role for an appended note other than a user-role one, so the fix keeps the content small instead.
- **The explanation never replaces the request.** `explainRequests` stays off by default. When on, its text shows beside the full request, labelled as unverified.
- **The `queue` tool answers only in the coordinator.** A call from any other session changes nothing.
- **A subagent's request is answered to that agent.** An approval, denial or answer for a protected command a subagent asked for goes to the agent itself. When the agent can no longer be reached, the parent session gets the answer wrapped with the agent's id and task. The wrapper says the command is that agent's, not the parent's. Grants are keyed to whoever asked: an approval for a subagent serves that agent alone, never its parent or another agent, so the parent running the same command is asked again.

## 0.6.0 — 2026-11-03

- **Each session's tasks.** A session's card lists its tasks in progress and planned, as its own task list has them (the desktop's `update_plan`, the CLI's `TodoWrite`; a subagent's list stays its own), plus what the coordinator queued for it through its new `queue` tool. Planned tasks reorder with ▲ ▼ ⤒, shown under the pointer on the desktop and always on the terminal and mobile; the session gets the new order as a note it reads at its next request, with no turn of its own. The pane has no control that removes a task. The list folds per session.
- **Progress per session**: a bar under the header, tasks done out of all the session has to do, the queue included. A session with no task list shows none.
- **Lock a session in place.** 🔒 keeps a session in a group at the top, in your order (▲ moves it up), so it stops jumping as sessions start and stop working.
- **A hat for each session's crab**, themed by a word of its name (home lab, website, spec, coordinator, planner…), else picked from it; `hats` in `rules.json` sets one.
- **Rounder, fuller cards.** State badges and risk tags are rounded pills, bars have rounded ends, and the session's header band reaches the card's edges.
- **Compact subagent rows**: name, tier and model, context, tokens and time on one line, the bar right under it, the step note last.
- **Approvals land faster.** While a coordinator runs, a protected command waits in its call for the pane's answer for up to two minutes: approved, it runs at once, with no refusal and no new turn. A session with a card waiting looks for answers every second instead of every three, and the pane reads again right after you answer.
- **Large requests read at a glance.** A long shell command is split into its steps with tags for what they can do; a file write shows its path, size and first lines as code, an edit its diff; the full request is one click away. `explainRequests` (off by default) adds a short Haiku explanation, labelled as unverified.
- **The coordinator hears every answer.** Each answer given in the pane (approvals, denials, choices, replies, go-aheads, dismissals, read receipts, a new task order) is added to the pane's own session as a note: when, which session, what it asked (its text fenced as data) and the answer. The coordinator reads it at its next request; no turn is started for it.
- **Mark as read.** Report cards get a third action beside reply and dismiss: the session gets a note that its report was read, not to be answered; it starts no turn, so no reply or new report can follow it. The card leaves the pane.

## 0.5.1 — 2026-11-03

- **An approved request no longer comes back as a question.** A session told to wait for a protected command or a forwarded choice would end its turn asking, in its questions or its report, to "approve request <id> in the pane": a second card next to the real one, still waiting after the approval. Such items are now left out of the questions card (a section of only those adds none), and a report that only points at one of the session's own requests, open or done with, no longer waits on you. The message the session reads when it is told to wait also asks it not to repeat the request among its questions.
- **A question's options are buttons.** Bullets under a numbered question that open on a bold label (`- **Not now:** …`) show as buttons on its card, as the desktop's own box draws them. One question answers on a press; several are picked one by one and sent together, each with its number. The free-text reply stays.
- **A choice's option picks from its description too**, not only from its title: both lines are one press target. The padding around them is not (the mod API has no pressable box), so it is now thin.

## 0.5.0 — 2026-11-03

- **Reports reach the pane.** A session that ends its turn with a report and no `## Questions for you` section now shows it in the inbox: one line (the desktop wrap-up's question or recap, else the report's first paragraph), the whole report and a reply box on demand, and a dismiss. A report that waits for a go-ahead (the wrap-up asked one, or the text asks for confirmation) is marked as such, gets a one-click **Go ahead**, and makes the session count as waiting. Reports are written to the local shared folder like the rest of the status.
- **Cards answered in the session leave the pane.** An app permission answered at the session's own dialog goes once the call runs or the turn ends. Questions, choices, reports and protected commands go once you type in the session itself (not a slash command, not a turn a notification or another session started; a protected command is asked again, as a new card, if the session tries it again); a card the pane already answered is applied first, never dropped. A session's next closing message supersedes what it asked or reported before, so an answer relayed by another session clears the card too. A closed session's requests leave the inbox.
- **Robustness**: a request's texts read from another session's status file are drawn only as strings; a session's card names the first request that actually waits on you.
- **savvy-progress steps show up.** Workers' step bars and the orchestrator's flow stayed empty: the mod read the tools' arguments from `input`, where the engine puts them beside `tool`.
- **Open a session from the pane.** A session's card, and each inbox card, has an **Open** button that brings that session up in the desktop app, through the app's own deep link.
- **A permission is written out once**, on its inbox card: the waiting session's card just says it waits for one.
- **A session stands apart from its subagents**, as in the mockup: its header is a shaded band with larger type, and each subagent is an inset, ruled-off row in smaller type, with its context (as a share and in tokens) and elapsed time.

## 0.4.0 — 2026-11-03

- **Sessions follow the coordinator's copy of the mod.** Mods do not hot-reload; now, when a live coordinator publishes a newer version, every other session runs `/reload-plugins` itself once it is idle (at most once per version). After an update, reload the coordinator alone. Sessions on a copy older than 0.4 still need one manual reload to learn this.

## 0.3.1 — 2026-11-03

- **The coordinator is left out of "Sessions and subagents"**: its chat is beside the pane. Its protected commands still reach the inbox.
- **The coordinator's own permission prompts stay in its chat**, as the app's dialog: the person is already there.
- **A session counts as active while any of its subagents runs**, even when the session itself sits idle waiting for them.

## 0.3.0 — 2026-11-03

- **A session running an older copy of the mod is flagged** on its card, with the hint to run `/reload-plugins` there: mods do not hot-reload, and an older copy can behave differently (a 0.2.0 build from before the release stopped subagents at their first permission prompt).
- Every status file now carries the mod version that wrote it.

## 0.2.0 — 2026-11-02

- **The pane follows the design mockup**: usage cards in a row, pill tabs, amber cards for what waits for you, each subagent ruled off under its session's header with its tier, model, elapsed time, steps and progress bar.
- **Sessions carry their sidebar names** and effort, read from the desktop app's own records, so a session running an older copy of the mod is named too.
- **The app's permission prompts come to the pane** while the coordinator's pane is open, the coordinator's own included: the session holds until you approve once, for the session, or deny, then carries on in the same turn. An approval covers exactly the input the card showed; an input too long to show, or no answer in nine minutes, keeps the app's dialog.
- **Answered in the session means gone**: a session's new turn retires the questions it asked. Any request can be dismissed.
- **Security**: status files count only when named after their session; approve-once is taken atomically; approved commands are quoted in the message the session receives; tool calls that would change the shared folder are refused.
- Removed the "Open session" link, which could only point at the sidebar.
- Documented the `pluginConfigs` key for each way of loading the mod.

## 0.1.1

- First published version.
