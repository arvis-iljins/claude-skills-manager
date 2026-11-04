# Claude Skills Manager

A VS Code extension that shows all Claude agents, skills, and config files from your project (`.claude/`) and global (`~/.claude/`) directories. Tracks live session activity and lets you enable / disable agents and skills without touching any git-tracked files.

---

## Features

- **Session Activity** — live feed of every Agent and Skill tool call, read straight from `~/.claude/projects/*/‌*.jsonl`. Updates automatically as Claude delegates work.
- **Agents** — browse project (`.claude/agents/`) and global (`~/.claude/agents/`) agents with frontmatter description, enable/disable toggle.
- **Skills** — same for `.claude/skills/` and `~/.claude/skills/`.
- **Config Files** — quick links to `CLAUDE.md`, `settings.json`, `settings.local.json` for both project and global scopes.
- **Filter** — search bar across all agent and skill names and descriptions.
- **Disable without git changes** — disabled state is stored in `settings.local.json` (gitignored), so your team never sees it.

---

## Install

```bash
code --install-extension claude-skills-manager-0.1.0.vsix
```

Reload VS Code. The Claude shield icon appears in the Activity Bar.

---

## Disable / Enable

Click the **✗** (circle-slash) icon on any agent or skill to disable it. Click **✓** (pass) to re-enable. The state is written to:

- **Project agent/skill** → `.claude/settings.local.json` in your workspace
- **Global agent/skill** → `~/.claude/settings.local.json`

Both files are gitignored — no git diff, no accidental commits.

> **Note:** Disabling currently marks the item in the panel (red icon, ✗ badge). It acts as a personal reminder and a signal to future prompt injection — see **Roadmap** below.

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

Each teammate has their own independent disabled list (stored locally in their `settings.local.json`). What you disable does not affect anyone else's session.

---

## Roadmap — Hard Disable via Prompt Hook

The planned approach for truly blocking Claude from using a disabled agent (not just showing it red):

1. **Store disabled list** in `settings.local.json` — already done, gitignored.
2. **Register a `prompt.compose` hook** in Claude Code that reads the disabled list before each message and injects:
   ```
   DISABLED AGENTS — do not delegate to: n8n-workflow-builder, ecom-backend-coder
   ```
   into the system prompt.
3. Claude sees the instruction and won't delegate to those agents, even though their `.md` files still exist on disk.
4. Zero file renames, zero git changes — the hook reads from `settings.local.json` at runtime.

**Current blocker:** the `cc-plugin-sec-default` Claude Code plugin runs first and swallows the `prompt.compose` event before the skills-manager hook fires. Fixing hook priority is the remaining work before this is functional.

---

## Development

```bash
cd claude-skills-manager
# Edit src/extension.js
# Package and reinstall:
bash build.sh
```

The build script packages the extension as a `.vsix` and reinstalls it into VS Code.
