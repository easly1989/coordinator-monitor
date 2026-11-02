# Changelog

## 0.2.0 — 2026-11-02

- **The pane follows the design mockup**: usage cards in a row, pill tabs, amber cards for what waits for you, each subagent ruled off under its session's header with its tier, model, elapsed time, steps and progress bar.
- **Sessions carry their sidebar names** and effort, read from the desktop app's own records, so a session running an older copy of the mod is named too.
- **The app's permission prompts come to the pane** while a coordinator runs: approve once, for the session, or deny. An approval covers exactly the input the card showed; an input too long to show keeps the app's dialog.
- **Answered in the session means gone**: a session's new turn retires the questions it asked. Any request can be dismissed.
- **Security**: status files count only when named after their session; approve-once is taken atomically; approved commands are quoted in the message the session receives; tool calls that would change the shared folder are refused.
- Removed the "Open session" link, which could only point at the sidebar.
- Documented the `pluginConfigs` key for each way of loading the mod.

## 0.1.1

- First published version.
