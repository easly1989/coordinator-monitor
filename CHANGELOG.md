# Changelog

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
