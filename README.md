# Claude Skills Manager — VS Code Extension

A VS Code sidebar that shows all your Claude Code agents, skills, and config files — from both the open project and your global `~/.claude/` folder — and lets you disable any of them with one click.

---

## What it shows

```
📁 Session Activity — 3 agents used
   → ecom-backend-coder        2m ago   ← click to open the agent file
   → jdedb-coder               8m ago
   → code-reviewer             15m ago

📁 Project — 12 skills (1 off)
   📁 Agents (9)
      🔵 ecom-backend-coder    [agent]  ← blue = enabled, click to open
      🔵 jdedb-coder           [agent]
      🔴 old-agent             [agent]  ← red = disabled
   📁 Skills (3)
      🔵 dataviz               [skill]
   📁 Config Files
      ✓ CLAUDE.md                       ← click to open
      ✓ settings.json
      ✗ settings.local.json  missing

📁 Global — 5 skills
   📁 Agents / Skills / Config Files
   ...
```

**Session Activity** reads `~/.claude/projects/*/*.jsonl` (the live Claude Code transcript) and parses `Agent` tool calls so you can see which agents were delegated to and when. The panel watches the transcript file and updates automatically as Claude works.

**Color coding:** blue label = enabled, red label = disabled. The badge on each item (✓ / ✗) confirms the state at a glance.

---

## How to install

### Option A — package as VSIX and install (recommended)

```bash
cd claude-skills-manager
npm install
npm run compile
npx vsce package
# creates claude-skills-manager-0.1.0.vsix
code --install-extension claude-skills-manager-0.1.0.vsix
```

Reload VS Code. The extension loads automatically on every future startup.

### Option B — development mode (no packaging, instant)

1. Open the `claude-skills-manager` folder in VS Code
2. Press **F5** — a new Extension Development Host window opens with the extension active
3. The panel appears in the Activity Bar on the left

### Option C — symlink (macOS / Linux, no packaging)

```bash
npm install && npm run compile
ln -s "$(pwd)" ~/.vscode/extensions/claude-skills-manager-0.1.0
```

Reload VS Code (`Cmd+Shift+P` → **Developer: Reload Window**).

---

## How to use

Click the **Claude Skills** icon in the Activity Bar (the circular icon on the left sidebar).

| Action | How |
|---|---|
| Open a skill / agent file to edit | Click the item |
| Disable a skill | Right-click → **Disable**, or click the `⊘` inline button |
| Enable a skill | Right-click → **Enable**, or click the `✓` inline button |
| Disable **all** skills at once | Click `⊘` in the panel title bar |
| Enable **all** skills at once | Click `✓` in the panel title bar |
| Refresh the list manually | Click `↺` in the panel title bar |

---

## How disabling works

Disabling renames the file:

```
.claude/agents/some-agent.md  →  .claude/agents/some-agent.md.disabled
```

Claude Code only loads `.md` files, so it ignores the `.disabled` one. Enabling reverses the rename. No file is ever deleted.

---

## Project structure

```
claude-skills-manager/
├── src/
│   └── extension.ts    ← all logic (TypeScript)
├── assets/
│   └── icon.svg        ← activity bar icon
├── package.json        ← manifest, commands, menus
├── tsconfig.json
├── .gitignore
└── .vscodeignore
```

---

## Development

```bash
npm install
npm run watch       # recompile on save
# F5 in VS Code to open the Extension Development Host
```

After editing `src/extension.ts`, the Extension Development Host reloads automatically when you press **F5** again or run **Developer: Reload Window** inside it.

To publish to the VS Code Marketplace, see the [vsce publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
