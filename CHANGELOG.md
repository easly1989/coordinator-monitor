# Changelog

## 0.7.0 — 2026-11-10

- **A long permission request scrolls instead of filling the card.** On the terminal and the desktop, the raw command of a permission card taller than 18 rows is drawn in a region of 18 rows that scrolls: ↑ ↓, PgUp PgDn, Home, End, or a press or drag on its bar. Nothing is cut or folded: every row is a slice of the full text (long lines wrap, wide characters and tabs counted by width), the hint under the region gives the row count as screen rows (the card header counts source lines) and says to click the region first, as keys reach it only then, and the header, the steps and the buttons stay outside it, always on screen. A request that fits once laid out wider shows no bar. Surfaces without a client module (vscode, mobile), a request near the 100,000-character limit of a client's props, and a client that faulted draw the whole request as plain code, as before.

## 0.6.9 — 2026-11-05

- **Permission cards never fold (a change from 0.6.8).** 0.6.8 folded a large shell request that only moved files behind a toggle. Reviews found that deciding by parsing what a command can run cannot be made safe: an unclosed quote before a here-doc, a `\` continuation in an unquoted body, a `cat > a.txt <<EOF /etc/passwd` opener, a typed `‹1›` block marker, a `package.json` body and `printf -v PATH` each desynced the parser or hid a run command. So the full command, every block and every step of the reading are always on screen, whatever the length, and the folding code (`canFold`, the touches list and their strings) is gone. The reading keeps what it had: a command that holds the block marker `‹ ›` itself is cut into no block, and an opener with more than one output redirect is never cut out. The tool call's `description` (new optional field, sanitised, stored cut at 300) shows above as "The session says: «…»", muted, on one line of at most 200 characters with any « » removed: the session's claim, not the mod's reading. Report bodies over 6 lines show the first 6 behind a toggle, unless the report waits for a go-ahead, whose button shows only once the report is open; QUESTIONS never fold. A line count also counts `` and U+2028/2029.
- **A forwarded answer quotes the questions it answers** (#33). The message to the session now carries the card's own text, with its time and short id (the ones the read receipt uses), above the answer, for QUESTIONS cards and report replies. The text is what the card showed, drawn like any text from another session (hidden characters as codes), cut at about 1,500 characters with an ellipsis. The message says the answer applies only to the quoted questions, so a session that asked again or compacted cannot read it against another set.

## 0.6.8 — 2026-11-05

- **An empty "Domande per te" raises no card** (#25). A section with no numbered list was judged line by line, so "Nessuna per ora." became a QUESTIONS card. A heading with nothing under it, or only a "nothing to ask" line (Nessuna…, None…), is now treated as if the heading were absent: the turn's report card. Any other body is the QUESTIONS card as written; numbered items are unchanged.
- **Closed sessions leave the pane** (#26). A closed session goes 5 minutes after it ends (time to read a last report). It stays while a planned-task queue is held for it, until the queue is empty, and for up to an hour while a card that awaits an answer (not a report) is held. Its status file is not deleted: the plugin file API cannot delete, and files past the hour are ignored anyway.
- **Digest follow-ups** (#23). A digest state reset under a loaded module (sequence restarting below the delivered mark) no longer hides new notes as delivered. A refused `prompt.submit` while applying answers queues that answer urgent and the rest of the batch still goes out; if that answer cannot be queued either, a toast says so.

## 0.6.7 — 2026-11-04

- **Run-later labels name the real runner and catch spelled-differently files** (#15). A file a block writes was marked "run later by X" only when a later step named it literally. Fail closed, as before: when unsure, the block is marked "may run later".
  - **`tee` is a pass-through.** `cat g.sh | tee x | bash` now says `bash`, not `tee`. A pipe that ends in `tee` names nothing and is only marked.
  - **A glob, a quote, a variable, `~` or a `..` step in a later step's file name marks the block.** An interpreter (`node`, `python`, `bash`, `sh`, `pwsh`, `.`, `source`) given a word that is not a plain file name (`bash g*.sh`, `bash "g".sh`, `f=g.sh; bash $f`, `bash ./sub/../g.sh`, `-c "…"`) or no file at all (`cat g''.sh | bash`), and a program that is not a plain word (`./g*.sh`, `$f`), now mean "may run later". A plain other file (`node build.js`, `python3 build.py --out dist`) does not.
  - **The label reads "may run later (a later command may run it)"**, no longer "piped", as it is not always a pipe.
  - **Noise, measured on the demo ask in the tests:** one block in one ask is marked that does not run (the data file `app.json`, written before an inline `python -c "…"`). The full request is always shown and a card with an interpreter never folds, so the cost is a word.

## 0.6.6 — 2026-11-04

- **Digest follow-ups** (#19). Failure paths and one timing change; nothing else moves.
  - **No duplicate delivery.** If a flush appends its row and the write that removes the notes from the state then fails, the notes are marked delivered in memory and the next flush only cleans up, instead of sending them again.
  - **Free text never overtakes older notes.** When the flush before a free-text answer fails, the answer is queued behind the notes and goes out with them, in order.
  - **A note that must be heard at once is never held back by a failure** (review round). A free-text answer whose flush or append is refused is queued in an urgent row and tried again on every tick, not after `digestMinutes`; the row carries the mark, so a reload keeps it, and quiet notes never get it. The append result is checked, so a refused append no longer loses the record. In a worker session the prompt that answers a card waits behind notes that could not be delivered, as the free text does. Only when it can be neither queued nor appended (the queue cannot be written and the append is refused) is the prompt submitted ahead of them: out of order beats lost. A record note in that same double failure is still dropped.
  - **A note made while a turn runs waits 10 seconds** for the others of its burst, so a run of approvals goes in one row and not one row each. Idle behaviour (`digestMinutes`, the turn that starts anyway, session end) is as before. This is the reading of the lone approval seen at 11:17: the flush woke the session, the turn was running, and the busy path added that note by itself; a note added to a running turn costs no wake, so it was an ordering and noise question, not a cost one.
  - **`$.state` and restarts: a recorded limit, not a proof.** The engine documents that state survives a hot reload of the plugin's code and says nothing of `--resume` or a restart; this was not run against a real restart. The tests prove the mod re-reads the queue at session start. Treat the queue as surviving a reload, and a normal exit as delivering it (the session-end flush); a crash or kill may lose notes up to `digestMinutes` old, which are only a record. A reload with a removal still pending may repeat that one row.

## 0.6.5 — 2026-11-04

- **A large shell request opens folded behind a reveal** (#14). A request over 6 lines or 400 characters shows a recap and a reveal button; the full text, drawn exactly as before, is one press away. Short requests show in full as always.
  - **The recap is built by the mod from the command alone**, never from model text and never from the request's own description: the reading aid's steps, in plain words, each step whole.
  - **A card folds only when no block of it can run, and nothing else in it can.** A block's body is not in the recap, so any block that runs keeps the card open: an interpreter's input (a here-doc into bash, python, node or pwsh), an inline `-c` / `-e` / `-Command` script of any language, a body whose `$( )` run as it is written, a file run later or maybe piped on, a here-string. A file of data (`.json`, `.yml`, `.toml`, `.conf`, `.txt`, `.md`, …) can be read as code by a later command (`GIT_CONFIG_GLOBAL=x.conf git status`, `npm install` beside a package.json, `git apply x.txt`), so a short allowlist decides the rest: every step must run `cat`, `ls`, `mkdir`, `cd`, `echo`, `printf`, `cp`, `mv`, `touch`, `chmod`, or `tee` with exactly one file, with no assignment before it (`PATH=…`, `LD_PRELOAD=…`) and no `$( )`, backtick or `<( )` in it, and the steps must split for certain. Anything else, and every PowerShell card, stays open. Fail closed.
  - **Always shown, folded or not:** a "Touches" list read from the shell text: where it goes (`cd`), what it deletes (`rm`, and the source of a `mv`), what it writes (`>`, `tee`, `cp`/`mv` destinations, `touch`, `dd of=`, `sed -i`, `curl -o`, the file a here-doc writes) with appends (`>>`, `tee -a`) told apart, URLs, ssh/scp hosts and git remotes. Quotes are tracked as the shell reads them, so an apostrophe inside `"…"` no longer hides the commands after it. The risk chips (now also `find -delete`, `zfs`/`zpool`/`qm`/`pct`/`lxc`/`virsh`/`docker` `destroy`, `mkfs`, `-EncodedCommand`), the protected-rule line and the size caption (`17 lines · 1806 characters · 1 block`) stay too.
  - **An explanation on a card is drawn through `visible()`**, like every other text from the request.
  - **The approve and deny buttons work folded.** Where the reading aid gives up (a here-string it cannot place, a comment, a continuation, over 40 steps) the card opens whole, with no recap, as before.
- **Two follow-ups to the quiet-notes digest** (#17 review). The order note a session gets is now drawn through `visible()` and fenced, as the text of the bus answers file is data and now sits inside numbered digest rows. The wake timer is reset when a flush finds nothing, so a stale value no longer makes the tick read the state every second.

## 0.6.4 — 2026-11-04

- **Quiet pane answers no longer wake an idle session** (#16). A note added to an idle session wakes it, and a wake re-reads the whole conversation. So the notes that are only a record now wait and go together:
  - queued: the coordinator's record of an approval, a denial, a read receipt or a reorder, the read receipt and the order note a session gets;
  - delivered as one row, oldest first (`N notes from the pane`; a single note reads as itself): in the next turn that starts anyway (the row before the prompt), at once while a turn is running, after `digestMinutes` (default 15) idle counted from the oldest note, and when the session ends;
  - never held: a free-text answer, a choice, or a reply to a report. It goes out at once, after the queued notes, so the order is the order of the answers. What a waiting tool call or a subagent needs is not a note and is not touched.
  - Nothing is lost: the queue is the session's state (not a file in the bus folder, where another process could write a line the model would read as the mod's), a note made while a flush runs stays for the next one, and a flush that fails keeps its notes. If the queue cannot be kept, the note goes out at once.
  - `digestMinutes` `0` delivers each note at once, as before.

## 0.6.3 — 2026-11-03

- **Here-doc labels that could mislead are gone** (#12). The rule stays fail closed: when in doubt, shell text, and never a "→ file" label on something that runs.
  - A descriptor or a pipe set up anywhere in the request (`exec 3> …`, `mkfifo`, `mknod`, `coproc`) means no here-doc is cut out. So does a target under `/dev` or `/proc`.
  - `cat` given files (`cat notes.txt <<EOF`) reads them, not the body: no block.
  - A file written by a here-doc is marked `run later by …` when the request uses it again in a way that may run it, on the opener line (`; bash f.sh`) or after the body. That covers running it directly (`./f.sh`, marked "the shell"), sourcing it, and any command not known only to read files.
  - An interpreter fed the block with its output redirected (`bash > f <<EOF`) reads as one step: "runs bash on the block below, output to f".
- **What closes a block sits under it.** An inline script's closing quotes (the `'"` after `sh -c '…'`), a here-string's `'@` or a here-doc's end word shows as `followed by: '"` at the foot of the block's box instead of in a box of its own. Anything else after a block, however short (`"|sh`, `'@ | iex`), keeps its own box.
- **`run later by` also catches a file piped or redirected into a program**: `cat f.sh | bash`, `tail -n +1 f.sh | sh`, `< f.sh bash`.
- **A pipe after the file marks the block, named or not.** The split cannot be trusted around `2>&1`, `|&`, a line break before the next step, a quoted `;` or `&`, or a `$( )`. So where a runner cannot be named and a `|` follows the first mention of the file, the block reads `may run later (piped to a later command)`. A false "may run" costs a word; a missed one costs the label.

## 0.6.2 — 2026-11-03

- **Each card shows its request's short id** (`#x1nb2c`, the last six characters), dim, in its header. A press copies the whole id. The messages sessions get, and the coordinator's notes, quote the same short form. A closing message that asks for a card by its short form is recognised like one that names the whole id.
- **Large shell requests are readable.** An app ask for Bash or PowerShell no longer shows the tool's input as JSON with `\n` and `\"` escapes. It shows the command itself, with real lines and quotes; its other fields (`timeout`) are small `key: value` lines under it. Each block the command hands on whole sits in a box of its own, labelled with where it goes, always shown: a here-doc body (`→ file $S/shots.js · 34 lines · run later by node`, `→ input of python`), a PowerShell here-string, or a long `python -c` / `node -e` script. The parts together are the request, every character of it. A label says when a block runs: an unquoted here-doc whose `$( )` run as it is written (`runs the $( ) in it now`), a body fed to a program that reads code (`→ input of python`), a file run or sourced later (`run later by node`, `run later by source`). Only the JSON the mod wrote itself is decoded: a bare command that looks like JSON is shown as it is. A here-doc is cut out only where its reading is certain; anything else stays shell text. That needs:
  - its word whole as bash reads it: not `<<EOF.x`, `<<EOF"X"`, `<<-EOF-1`, `<<EOF` with a CR, nor a second `<<` on the line;
  - `cat`, `tee` or a program that reads code before it;
  - nothing open after the word: no `|`, no `\` continuation, no open quote or `$(`, no trailing `&&`;
  - no process substitution or duplicated descriptor on the line (`>(…)`, `<(…)`, `>&`);
  - no `|` or `&&` on the line after the end word. The reading aid above says each step in plain words, for example:
  - writes a file;
  - runs a script with node;
  - pipes into a command;
  - goes to a folder;
  - deletes something.

  `visible()`, the size caption and the fallbacks stay.
- **Task rows on a grid.** Number, a source mark (◆ queued by the coordinator, ◇ the session's own), the title, then ▲ ▼ ⤒ at the same place on every row, whatever the title's length. The row never overflows. A long title stays on one line with an ellipsis on the desktop. Hovering it shows it whole, and so does pressing its number, so a keyboard reaches it too. On touch and the terminal it wraps. The controls are icons, not words; a legend line names them. On touch they are full-size buttons, further apart. The session lock is a 🔒 / 🔓 icon button the size of Open beside it.

  A ping-pong scroll for long titles was left out. The mod hears no hover, so it would have to redraw every row on a timer even while nothing moves.

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
