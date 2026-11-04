# Claude Skills Manager — VS Code Extension

A VS Code sidebar that lists all your Claude Code agents, skills, and config files — from both the current project and your global `~/.claude/` folder — and lets you disable any of them without deleting the file.

## Features

- **Project panel** — scans `.claude/agents/` and `.claude/skills/` in the open workspace
- **Global panel** — scans `~/.claude/agents/` and `~/.claude/skills/`
- **Config files** — shows whether `CLAUDE.md`, `settings.json`, `settings.local.json` exist and opens them on click
- **Enable / Disable** — renames a skill file to `*.md.disabled` to prevent Claude Code from loading it; rename back to re-enable
- **Click to open** — click any skill to open its definition file in the editor
- **Auto-refresh** — reloads the tree whenever files in `.claude/` change, and every 60 s for global changes

## Install

### Option A — from VSIX (easiest)

```bash
cd claude-skills-manager
npm install
npm run compile
npx vsce package        # creates claude-skills-manager-0.1.0.vsix
code --install-extension claude-skills-manager-0.1.0.vsix
```

### Option B — development mode (no packaging)

1. Open the `claude-skills-manager` folder in VS Code
2. Press **F5** — a new Extension Development Host window opens with the extension active

### Option C — symlink into extensions folder (macOS/Linux)

```bash
npm install && npm run compile
ln -s "$(pwd)" ~/.vscode/extensions/claude-skills-manager-0.1.0
```

Reload VS Code after any of the above.

## Usage

Click the **Claude Skills** icon in the Activity Bar (left sidebar).

| Action | How |
|---|---|
| Open a skill file | Click the item |
| Disable a skill | Right-click → **Disable** (or click the `⊘` inline button) |
| Enable a skill | Right-click → **Enable** (or click the `✓` inline button) |
| Refresh | Click the `↺` button in the panel title bar |

Disabling renames `skill-name.md` → `skill-name.md.disabled`. Claude Code only loads `.md` files, so it ignores the disabled one. Enable reverses the rename.

## How disable works

Claude Code loads agent definitions from `*.md` files inside `.claude/agents/`. Renaming to `.disabled` prevents the load without deleting the file. The same approach works for skill files inside `.claude/skills/`.

## Development

```bash
npm install
npm run watch   # watch mode — recompiles on save
# F5 in VS Code to launch Extension Development Host
```
