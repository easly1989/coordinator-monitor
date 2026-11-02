# coordinator-monitor

One pane for every local Claude Code session: what each one is doing, its subagents, and everything that waits for you (permissions and questions) answerable in place.

<p align="center">
  <img src="docs/overview.png" alt="The coordinator session with the Agents pane beside the chat" width="900" />
</p>

<p align="center">
  <a href="https://buymeacoffee.com/easly1989"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black" alt="Buy me a coffee" /></a>
  <a href="https://paypal.me/carloruggiero"><img src="https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white" alt="Donate via PayPal" /></a>
  <a href="https://buy.stripe.com/8x26oAeqA7h6dPk80hfbq00"><img src="https://img.shields.io/badge/Donate-Stripe-635BFF?logo=stripe&logoColor=white" alt="Donate via Stripe" /></a>
  <a href="https://liberapay.com/amon2126/donate"><img src="https://img.shields.io/badge/Donate-Liberapay-F6C915?logo=liberapay&logoColor=black" alt="Donate via Liberapay" /></a>
  <a href="https://github.com/sponsors/easly1989"><img src="https://img.shields.io/badge/Sponsor-GitHub-EA4AAA?logo=githubsponsors&logoColor=white" alt="Sponsor on GitHub" /></a>
</p>

It is a Claude Code **mod** (function hooks, the early-access plugin API). Made for a "coordinator" workflow, where you talk to one session and it delegates to many, but useful as soon as you run more than one session at a time.

> Status: **0.1, early.** Built against Claude Code 2.1.316. The screenshots come from the design mockup; real ones will replace them once the pane has run on more machines.

## What it does

- **Every local session in one place.** Each session that runs the mod publishes its status (state, model, context, cost, subagents) to a shared folder; the pane reads them all. Sessions are grouped with their subagents, waiting ones first.
- **savvy-flow aware.** With [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow) and [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) installed, workers show up with their tier crab (astronaut, detective, engineer, chef, racer), model and effort, and the steps they report. Without them, any subagent is listed.
- **Protected commands wait for you.** Merges, pushes to `main`, deploys and service restarts never run without your approval, whatever the session's permission mode. The session is told to stop and wait; you approve once, for the session, or deny, from the pane.
- **Questions come to you.** A session's multiple-choice question (the dialog with options) is forwarded to the pane with every option and a free answer field. Open questions a session ends its turn with, under a `## Questions for you` heading, are shown too, with a reply box.
- **Answered means gone.** A request leaves the pane as soon as you answer it; the owning session receives your answer as a new message and carries on.
- **Usage at a glance.** The 5-hour and weekly limits, as the latest session reported them.

<p align="center">
  <img src="docs/sessions.png" alt="Sessions with their savvy-flow workers" width="440" />
  <img src="docs/questions.png" alt="A forwarded multiple-choice question and open questions" width="440" />
</p>

## Install

Requires Claude Code 2.1.316 or later (mods are early access and the API may change between releases).

**For every session, including the desktop app** — clone the repository and add its folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. If the variable already holds other folders (savvy-progress, say), append to it rather than replacing it. On Windows, prefer an absolute path (`C:/Users/you/coordinator-monitor`).

```bash
git clone https://github.com/easly1989/coordinator-monitor.git ~/coordinator-monitor
```

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/coordinator-monitor"
  }
}
```

**For one session:**

```bash
claude --plugin-dir ~/coordinator-monitor
```

The mod has to run in **every** session you want to see: that is what publishes the session's status.

## Use

- `/agents-monitor` opens the pane in the current session.
- Set **Coordinator folder** (`/config`, or `pluginConfigs` below) to the folder name of your coordinator session: the pane opens there by itself, and that session keeps its own questions instead of forwarding them.
- Click a subagent of the current session to open its transcript. For another session, the pane tells you which one to open from the sidebar (jumping straight into another session is not something the mod API offers yet).
- Ask your sessions (in your `CLAUDE.md`) to end a turn that needs your input with a `## Questions for you` section, numbered. The Italian `## Domande per te` works too.

### Settings

```json
{
  "pluginConfigs": {
    "coordinator-monitor": {
      "options": {
        "language": "auto",
        "coordinatorFolder": "coordinator",
        "forwardQuestions": "on",
        "busDir": ""
      }
    }
  }
}
```

| Option | Default | What it does |
| --- | --- | --- |
| `language` | `auto` | `en` or `it`; `auto` follows Claude Code's `language` setting, then the locale. |
| `coordinatorFolder` | empty | Folder name of the coordinator session: the pane opens there by itself. |
| `forwardQuestions` | `on` | `off` keeps questions in their session's own dialog. |
| `busDir` | `~/.claude/coordinator-monitor` | The shared folder sessions publish to. |

### Protected commands

The defaults cover merges (`gh pr merge`, `git merge`, pushes to `main`/`master`, force pushes), deploys and releases (`vercel --prod`, `fly deploy`, `npm publish`, `kubectl apply`, `helm upgrade`, `terraform apply`, `gh release create`, `docker push`, …) and service restarts (`docker restart/stop`, `docker compose up/down/restart`, `systemctl restart`, `reboot`, Home Assistant `ha core restart`, Proxmox `pct`/`qm`), also when wrapped in `ssh host "…"`.

Add your own, or mark services as critical so their requests stand out, in `<busDir>/rules.json` (read when a session starts):

```json
{
  "replaceDefaults": false,
  "rules": [{ "label": "restart", "pattern": "\\bpm2\\s+restart\\b" }],
  "critical": ["jellyfin", "homeassistant"],
  "tierModels": { "light": "Haiku · low", "medium": "Sonnet · medium" }
}
```

`tierModels` relabels the savvy tiers when your copies of the savvy agents run other models than upstream.

The rules are a guard against a session doing something you wanted to supervise, not a sandbox: a command written to dodge a pattern is not caught. Keep your normal permission settings.

## How it works

```
session A ─┐  publishes  <busDir>/sessions/A.json  (every 3 s)
session B ─┤             <busDir>/sessions/B.json
session C ─┘             …
                 ▲ reads all                 │ writes
            the pane (any session) ──────► <busDir>/answers/B.json
                                             │ picked up by B on its next tick
                                             ▼
                          B receives your answer as a new message and goes on
```

Everything stays on your machine: plain JSON files, no server, no network. A session that stops publishing for 15 minutes drops out of the pane; a closed one stays an hour, marked as ended.

## Credits

- The pixel crabs and their animations are adapted from [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) by [johnnyvizz](https://github.com/johnnyvizz) (MIT; see [NOTICE](NOTICE)), and the tiers come from [savvy-flow](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-flow). Both are worth installing alongside this mod.
- Built by Carlo Ruggiero ([@easly1989](https://github.com/easly1989)) — [easly1989.github.io](https://easly1989.github.io/).

## Support

If coordinator-monitor is useful to you, consider a donation — it genuinely helps and is much appreciated. ♥ The easiest way is [**Buy Me a Coffee**](https://buymeacoffee.com/easly1989). If you prefer another, the [donation page](https://easly1989.github.io/donate.html) lists them all: [PayPal](https://paypal.me/carloruggiero), [Stripe](https://buy.stripe.com/8x26oAeqA7h6dPk80hfbq00), [Liberapay](https://liberapay.com/amon2126/donate) or [GitHub Sponsors](https://github.com/sponsors/easly1989).

## License

[GNU Affero General Public License v3.0 or later](LICENSE). The code adapted from savvy-progress keeps its MIT notice, reproduced in [NOTICE](NOTICE).
