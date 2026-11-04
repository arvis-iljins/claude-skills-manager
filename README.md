# Claude Skills Manager

A VS Code extension that shows all Claude agents, skills, and config files from your project (`.claude/`) and global (`~/.claude/`) directories. Tracks live session activity and lets you enable / disable agents without touching any git-tracked files.

---

## Features

- **Session Activity** — live feed of every Agent and Skill tool call, read straight from `~/.claude/projects/*/*.jsonl`. Updates automatically as Claude delegates work.
- **Agents** — browse project (`.claude/agents/`) and global (`~/.claude/agents/`) agents with frontmatter description, enable/disable toggle.
- **Skills** — same for `.claude/skills/` and `~/.claude/skills/`.
- **Config Files** — quick links to `CLAUDE.md`, `settings.json`, `settings.local.json` for both project and global scopes.
- **Filter** — search bar across all agent and skill names and descriptions.
- **Hard disable** — disabled agents are truly blocked. Claude cannot use them even if it tries.

---

## Install

```bash
code --install-extension claude-skills-manager-0.1.0.vsix
```

Reload VS Code. The Claude shield icon appears in the Activity Bar.

On first activation the extension automatically installs a blocking hook into `~/.claude/settings.json`. No manual setup needed.

---

## Disable / Enable

Click the **✗** (circle-slash) icon on any agent to disable it. Click **✓** (pass) to re-enable.

**What actually happens:**

1. The disabled agent name is written to `.claude/settings.local.json` in your workspace under `disabledSkills` (this file is gitignored — no git diff, no accidental commits).

2. When Claude Code tries to start any agent, a `SubagentStart` hook fires. It runs `~/.claude/skills-manager-block.js`, which reads `.claude/settings.local.json` and exits with code 2 if the agent is in the disabled list.

3. Claude Code treats exit code 2 as a hard block — the agent never starts and Claude sees an error message: *"Agent X is disabled in Claude Skills Manager. Enable it in the VS Code sidebar to use it."*

This is a **real block** at the runtime level, not a visual hint. Claude cannot delegate to a disabled agent.

---

## How the hook works

The extension installs one hook into `~/.claude/settings.json` on activation:

```json
{
  "hooks": {
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/skills-manager-block.js",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The `SubagentStart` event fires before every agent starts. The hook script receives a JSON payload on stdin with the `agent_type` field (e.g. `"n8n-workflow-builder"`). It reads the project's `settings.local.json`, checks the `disabledSkills` list, and exits with code 2 to block or 0 to allow.

**Key details:**
- The hook reads `cwd` from the payload so it always checks the correct project's disable list.
- Disabling is per-project. Each workspace has its own `settings.local.json`.
- The hook script is at `~/.claude/skills-manager-block.js` and is re-written on every VS Code activation to stay up to date.
- `~/.claude/settings.json` is NOT gitignored — it's your personal global config. The extension only appends to the `hooks.SubagentStart` array and never removes other entries.

---

## Toolbar buttons

| Icon | Action |
|---|---|
| Refresh | Re-scan agents, skills, and config files |
| ✓ Enable All | Remove all disabled flags |
| ✗ Disable All | Disable all agents and skills |
| Search | Filter by name or description |
| Clear filter | Reset filter |
| Trash | Clear session activity from the panel |

---

## Sharing with teammates

Just share the `.vsix` file. Each person installs it independently:

```bash
code --install-extension claude-skills-manager-0.1.0.vsix
```

On first activation the hook is installed automatically. Each teammate has their own independent disabled list (stored locally in their project's `settings.local.json`). What you disable does not affect anyone else's session.

---

## Development

```bash
cd claude-skills-manager
# Edit src/extension.js
# Package and reinstall:
bash build.sh
```

The build script packages the extension as a `.vsix` and reinstalls it into VS Code.
