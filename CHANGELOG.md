# Changelog

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
