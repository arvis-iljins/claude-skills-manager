'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

function readDisabledSet(configDir) {
  try {
    const f = path.join(configDir, 'settings.local.json');
    if (!fs.existsSync(f)) return new Set();
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return new Set((obj.disabledSkills ?? []).map(s => s.toLowerCase()));
  } catch { return new Set(); }
}

function writeDisabledSet(configDir, set) {
  const f = path.join(configDir, 'settings.local.json');
  let obj = {};
  try { if (fs.existsSync(f)) obj = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch {}
  obj.disabledSkills = [...set];
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2));
}

function parseFrontmatter(text) {
  let name = '', description = '';
  const lines = text.split('\n');
  let inFm = false, fmDone = false;
  for (const line of lines) {
    if (!fmDone && line.trim() === '---') { inFm = !inFm; if (!inFm) fmDone = true; continue; }
    if (inFm) {
      if (line.startsWith('name:')) name = line.slice(5).trim();
      else if (line.startsWith('description:')) description = line.slice(12).trim();
    }
  }
  return { name, description };
}

function readSkillMeta(filePath, fallbackName) {
  try { const { name, description } = parseFrontmatter(fs.readFileSync(filePath, 'utf-8')); return { name: name || fallbackName, description: description || '' }; }
  catch { return { name: fallbackName, description: '' }; }
}

function scanAgentsDir(dir, source) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return skills; }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const isDisabled = entry.name.endsWith('.md.disabled');
    if (!entry.name.endsWith('.md') && !isDisabled) continue;
    const filePath = path.join(dir, entry.name);
    const baseName = entry.name.replace(/\.md(\.disabled)?$/, '');
    const { name, description } = readSkillMeta(filePath, baseName);
    skills.push({ id: `${source}:agent:${entry.name}`, name, description, filePath, source, type: 'agent', isDisabled });
  }
  return skills;
}

function scanSkillsDir(dir, source) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return skills; }
  for (const entry of entries) {
    if (entry.isFile()) {
      const isDisabled = entry.name.endsWith('.md.disabled');
      if (!entry.name.endsWith('.md') && !isDisabled) continue;
      const filePath = path.join(dir, entry.name);
      const baseName = entry.name.replace(/\.md(\.disabled)?$/, '');
      const { name, description } = readSkillMeta(filePath, baseName);
      skills.push({ id: `${source}:skill:${entry.name}`, name, description, filePath, source, type: 'skill', isDisabled });
    } else if (entry.isDirectory()) {
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      const disabledFile = path.join(dir, entry.name, 'SKILL.md.disabled');
      if (fs.existsSync(skillFile)) {
        const { name, description } = readSkillMeta(skillFile, entry.name);
        skills.push({ id: `${source}:skill:${entry.name}`, name: name || entry.name, description, filePath: skillFile, source, type: 'skill', isDisabled: false });
      } else if (fs.existsSync(disabledFile)) {
        const { name, description } = readSkillMeta(disabledFile, entry.name);
        skills.push({ id: `${source}:skill:${entry.name}`, name: name || entry.name, description, filePath: disabledFile, source, type: 'skill', isDisabled: true });
      }
    }
  }
  return skills;
}

function findLatestTranscript(cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  let latestFile = null, latestTime = 0;

  // Try project-specific dir first (cwd with / replaced by -)
  if (cwd) {
    const projectDir = path.join(projectsDir, cwd.replace(/\//g, '-'));
    if (fs.existsSync(projectDir)) {
      try {
        for (const file of fs.readdirSync(projectDir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
          const filePath = path.join(projectDir, file.name);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs > latestTime) { latestTime = stat.mtimeMs; latestFile = filePath; }
        }
      } catch {}
      if (latestFile) return latestFile;
    }
  }

  // Fall back to global search
  try {
    for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
      try {
        for (const file of fs.readdirSync(path.join(projectsDir, dir.name), { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.jsonl'))) {
          const filePath = path.join(projectsDir, dir.name, file.name);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs > latestTime) { latestTime = stat.mtimeMs; latestFile = filePath; }
        }
      } catch {}
    }
  } catch {}
  return latestFile;
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatDuration(ms) {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTokens(n) {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function parseAgentCallsFromTranscript(transcriptPath) {
  const byId = new Map();
  const ordered = [];
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-400)) {
      try {
        const obj = JSON.parse(line);
        const timestamp = typeof obj['timestamp'] === 'string' ? new Date(obj['timestamp']).getTime() : (typeof obj['ts'] === 'number' ? obj['ts'] * 1000 : 0);
        const msgObj = obj['message'];
        const usage = msgObj?.['usage'] ?? obj['usage'] ?? {};
        const totalTokens = (usage['input_tokens'] ?? 0) + (usage['output_tokens'] ?? 0);
        const contentArr = Array.isArray(msgObj?.['content']) ? msgObj['content'] : Array.isArray(obj['content']) ? obj['content'] : [];
        for (const block of contentArr) {
          if (!block || typeof block !== 'object') continue;
          if (block['type'] === 'tool_use') {
            const toolName = block['name'];
            const input = block['input'] ?? {};
            const id = block['id'];
            if (toolName === 'Agent') {
              const agentType = input['subagentType'] ?? input['subagent_type'] ?? '';
              const name = (agentType || (input['description'] ?? '').slice(0, 40)) || 'unknown agent';
              const call = { name, description: input['description'] ?? '', timestamp, toolType: 'agent', toolUseId: id, inputTokens: totalTokens || undefined };
              if (id) byId.set(id, call);
              ordered.push(call);
            } else if (toolName === 'Skill') {
              const name = input['skill'] ?? 'unknown skill';
              const call = { name, description: input['args'] ?? '', timestamp, toolType: 'skill', toolUseId: id, inputTokens: totalTokens || undefined };
              if (id) byId.set(id, call);
              ordered.push(call);
            }
          }
          if (block['type'] === 'tool_result' && block['tool_use_id']) {
            const pending = byId.get(block['tool_use_id']);
            if (pending) pending.durationMs = timestamp - pending.timestamp;
          }
        }
      } catch {}
    }
  } catch {}
  const seen = new Set();
  return ordered.reverse().filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; }).slice(0, 10);
}

const DISABLED_SCHEME = 'claude-skill-disabled';
const ENABLED_SCHEME  = 'claude-skill-enabled';

class SkillDecorationProvider {
  provideFileDecoration(uri) {
    if (uri.scheme === DISABLED_SCHEME) return { badge: '✗', color: new vscode.ThemeColor('list.errorForeground'), tooltip: 'Disabled — Claude Code will not load this skill' };
    if (uri.scheme === ENABLED_SCHEME) return { badge: '✓', color: new vscode.ThemeColor('terminal.ansiBlue'), tooltip: 'Enabled' };
    return undefined;
  }
}

class SkillsTreeItem extends vscode.TreeItem {
  constructor(data, collapsibleState) {
    super('', collapsibleState);
    this.data = data;

    if ('isCategory' in data) {
      this.label = data.name;
      this.contextValue = 'category';
      this.iconPath = new vscode.ThemeIcon('folder');
      if (data.note) this.description = data.note;
      if (data.tooltip) this.tooltip = new vscode.MarkdownString(data.tooltip);
      return;
    }

    if ('isDetail' in data) {
      this.label = data.text;
      this.contextValue = 'detail';
      this.iconPath = new vscode.ThemeIcon(data.iconId);
      if (data.command) this.command = data.command;
      return;
    }

    if ('isActivity' in data) {
      const { call, filePath } = data;
      this.label = call.name;
      this.contextValue = filePath ? 'activity-openable' : 'activity';
      const parts = [];
      if (call.durationMs != null) parts.push(formatDuration(call.durationMs));
      if (call.inputTokens) parts.push(formatTokens(call.inputTokens));
      parts.push(relativeTime(call.timestamp));
      this.description = parts.join(' · ');
      this.tooltip = new vscode.MarkdownString(
        `**${call.name}** *(${call.toolType})*\n\n` +
        (call.durationMs != null ? `Duration: ${formatDuration(call.durationMs)}\n\n` : '') +
        (call.inputTokens ? `Tokens: ${formatTokens(call.inputTokens)}\n\n` : '') +
        (call.description ? `${call.description}\n\n` : '') +
        (filePath ? `*${filePath}*` : '*file not found in scanned skills*')
      );
      this.iconPath = call.toolType === 'skill'
        ? new vscode.ThemeIcon('book', new vscode.ThemeColor('terminal.ansiGreen'))
        : new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('terminal.ansiCyan'));
      return;
    }

    if ('isConfigFile' in data) {
      const exists = fs.existsSync(data.filePath);
      this.label = data.label;
      this.contextValue = 'configFile';
      this.description = exists ? '✓' : '✗ missing';
      this.tooltip = data.filePath;
      this.iconPath = new vscode.ThemeIcon(exists ? 'file-code' : 'file');
      if (exists) this.command = { command: 'claude-skills.openFile', title: 'Open', arguments: [data.filePath] };
      return;
    }

    this.label = data.name;
    this.contextValue = data.isDisabled ? 'skill-disabled' : 'skill-enabled';
    this.description = data.description;
    this.tooltip = new vscode.MarkdownString(`**${data.name}** · \`${data.type}\` · \`${data.source}\`\n\n${data.description ? data.description + '\n\n' : ''}*${data.filePath}*`);
    this.resourceUri = vscode.Uri.parse(`${data.isDisabled ? DISABLED_SCHEME : ENABLED_SCHEME}:${encodeURIComponent(data.name)}`);
    this.iconPath = data.isDisabled
      ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('terminal.ansiBlue'));
    this.command = { command: 'claude-skills.openFile', title: 'Open File', arguments: [data.filePath] };
  }
}

class SkillsProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.transcriptWatcher = null;
    this.currentTranscript = null;
    this.lastScannedSkills = [];
    this.filterText = '';
    this.sessionClearedAt = 0;
  }
  refresh() { this._onDidChangeTreeData.fire(undefined); }
  watchTranscript(cwd) {
    const transcript = findLatestTranscript(cwd);
    if (!transcript || transcript === this.currentTranscript) return;
    this.transcriptWatcher?.close();
    this.currentTranscript = transcript;
    try { this.transcriptWatcher = fs.watch(transcript, () => this.refresh()); } catch {}
  }
  getAllSkills() { return this.lastScannedSkills; }
  dispose() { this.transcriptWatcher?.close(); }
  getTreeItem(element) { return element; }
  getChildren(element) {
    if (!element) return this.buildRoots();
    const data = element.data;
    if ('isCategory' in data) return data.children;
    if ('isActivity' in data) return data.children ?? [];
    return [];
  }
  buildRoots() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const home = os.homedir();
    this.watchTranscript(cwd);

    const ft = this.filterText;
    const applyFilter = skills => ft
      ? skills.filter(s => s.name.toLowerCase().includes(ft) || s.description.toLowerCase().includes(ft))
      : skills;

    // scan once, derive filtered views and unfiltered cache from the same results
    const projDisabled = readDisabledSet(path.join(cwd, '.claude'));
    const globDisabled = readDisabledSet(path.join(home, '.claude'));
    const applyDisabled = (items, disabled) => items.map(s => disabled.has(s.name.toLowerCase()) ? { ...s, isDisabled: true } : s);

    const rawProjAgents = applyDisabled(scanAgentsDir(path.join(cwd, '.claude', 'agents'), 'project'), projDisabled);
    const rawProjSkills = applyDisabled(scanSkillsDir(path.join(cwd, '.claude', 'skills'), 'project'), projDisabled);
    const rawGlobAgents = applyDisabled(scanAgentsDir(path.join(home, '.claude', 'agents'), 'global'), globDisabled);
    const rawGlobSkills = applyDisabled(scanSkillsDir(path.join(home, '.claude', 'skills'), 'global'), globDisabled);

    const projAgents = applyFilter(rawProjAgents);
    const projSkills = applyFilter(rawProjSkills);
    const globAgents = applyFilter(rawGlobAgents);
    const globSkills = applyFilter(rawGlobSkills);

    this.lastScannedSkills = [...rawProjAgents, ...rawProjSkills, ...rawGlobAgents, ...rawGlobSkills];
    const skillFileByName = new Map(this.lastScannedSkills.map(s => [s.name.toLowerCase(), s.filePath]));

    const toItems = s => s.map(x => new SkillsTreeItem(x, vscode.TreeItemCollapsibleState.None));
    const toConfigItems = files => files.map(f => new SkillsTreeItem({ isConfigFile: true, ...f }, vscode.TreeItemCollapsibleState.None));

    const makeSection = (name, children, note, tooltip) => new SkillsTreeItem(
      { isCategory: true, name, children, note: note || undefined, tooltip: tooltip || undefined },
      children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );

    const projConfigFiles = [
      { label: 'CLAUDE.md', filePath: path.join(cwd, 'CLAUDE.md') },
      { label: 'settings.json', filePath: path.join(cwd, '.claude', 'settings.json') },
      { label: 'settings.local.json', filePath: path.join(cwd, '.claude', 'settings.local.json') },
    ];
    const globConfigFiles = [
      { label: 'CLAUDE.md', filePath: path.join(home, '.claude', 'CLAUDE.md') },
      { label: 'settings.json', filePath: path.join(home, '.claude', 'settings.json') },
    ];

    const transcript = this.currentTranscript ?? findLatestTranscript();
    const agentCallsAll = transcript ? parseAgentCallsFromTranscript(transcript) : [];

    const makeDetailItem = (iconId, text, cmd) => new SkillsTreeItem({ isDetail: true, text, iconId, command: cmd }, vscode.TreeItemCollapsibleState.None);
    const makeActivityItem = (call) => {
      const filePath = skillFileByName.get(call.name.toLowerCase());
      const details = [];
      if (call.description) details.push(makeDetailItem('note', call.description.length > 70 ? call.description.slice(0, 70) + '…' : call.description));
      if (call.durationMs != null) details.push(makeDetailItem('clock', `Duration: ${formatDuration(call.durationMs)}`));
      if (call.inputTokens) details.push(makeDetailItem('pulse', `Tokens: ${formatTokens(call.inputTokens)}`));
      if (filePath) details.push(makeDetailItem('file', `Open: ${path.basename(filePath)}`, { command: 'claude-skills.openFile', title: 'Open', arguments: [filePath] }));
      return new SkillsTreeItem({ isActivity: true, call, filePath, children: details }, details.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    };

    const clearedAt = this.sessionClearedAt;
    const visibleCalls = agentCallsAll.filter(c => c.timestamp > clearedAt);
    const agentCallItems = visibleCalls.filter(c => c.toolType === 'agent').map(makeActivityItem);
    const skillCalls = visibleCalls.filter(c => c.toolType === 'skill');
    const customSkillItems = skillCalls.filter(c => skillFileByName.has(c.name.toLowerCase())).map(makeActivityItem);
    const builtinSkillItems = skillCalls.filter(c => !skillFileByName.has(c.name.toLowerCase())).map(makeActivityItem);

    let activityChildren;
    if (visibleCalls.length > 0) {
      const skillChildren = [];
      if (customSkillItems.length) skillChildren.push(makeSection(`Custom (${customSkillItems.length})`, customSkillItems, 'from .claude/skills/', `**Custom skills** — skills from your \`.claude/skills/\` or \`~/.claude/skills/\` folder.`));
      if (builtinSkillItems.length) skillChildren.push(makeSection(`Claude built-in (${builtinSkillItems.length})`, builtinSkillItems, 'anthropic skills', `**Claude built-in skills** — skills shipped with Claude Code (e.g. \`code-review\`, \`simplify\`, \`dataviz\`).`));
      activityChildren = [
        makeSection(`Agents (${agentCallItems.length})`, agentCallItems, `${agentCallItems.length} called`, `**Agents in session** — sub-agents Claude delegated work to this session.`),
        makeSection(`Skills (${skillCalls.length})`, skillChildren.length > 0 ? skillChildren : [], `${skillCalls.length} loaded`, `**Skills in session** — skills Claude loaded via the Skill tool this session.`),
      ];
    } else {
      activityChildren = [new SkillsTreeItem({ isCategory: true, name: 'No activity yet — try calling an agent or skill', children: [] }, vscode.TreeItemCollapsibleState.None)];
    }

    const totalAgents = projAgents.length + globAgents.length;
    const totalAgentsDisabled = projAgents.filter(s => s.isDisabled).length + globAgents.filter(s => s.isDisabled).length;
    const totalSkills = projSkills.length + globSkills.length;
    const totalSkillsDisabled = projSkills.filter(s => s.isDisabled).length + globSkills.filter(s => s.isDisabled).length;

    return [
      makeSection(
        visibleCalls.length > 0 ? `Session Activity (${visibleCalls.length})` : 'Session Activity',
        activityChildren,
        visibleCalls.length > 0 ? `${visibleCalls.length} calls this session` : 'no activity yet',
        `**Session Activity** — agents Claude delegated to in the current session.\n\nRead live from \`~/.claude/projects/*/‌*.jsonl\`. Updates automatically as Claude calls the Agent tool.\n\nClick an item to open its definition file.`
      ),
      makeSection(
        `Agents (${totalAgents})${totalAgentsDisabled ? ` — ${totalAgentsDisabled} off` : ''}`,
        [
          makeSection(`Project (${projAgents.length})`, toItems(projAgents), `.claude/agents/`, `**Project agents** — defined in \`.claude/agents/\` inside this workspace.\n\nClaude delegates tasks to these when you ask it to code, review, or research.`),
          makeSection(`Global (${globAgents.length})`, toItems(globAgents), `~/.claude/agents/`, `**Global agents** — defined in \`~/.claude/agents/\` on your machine.\n\nAvailable in every project.`),
        ],
        `${projAgents.length} project · ${globAgents.length} global`,
        `**Agents** — specialized sub-agents Claude can delegate tasks to.\n\nProject agents are in \`.claude/agents/\`, global agents in \`~/.claude/agents/\`.`
      ),
      makeSection(
        `Skills (${totalSkills})${totalSkillsDisabled ? ` — ${totalSkillsDisabled} off` : ''}`,
        [
          makeSection(`Project (${projSkills.length})`, toItems(projSkills), `.claude/skills/`, `**Project skills** — defined in \`.claude/skills/\` inside this workspace.\n\nSlash commands and prompt snippets loaded with the Skill tool.`),
          makeSection(`Global (${globSkills.length})`, toItems(globSkills), `~/.claude/skills/`, `**Global skills** — defined in \`~/.claude/skills/\` on your machine.\n\nAvailable as slash commands in every project.`),
        ],
        `${projSkills.length} project · ${globSkills.length} global`,
        `**Skills** — slash commands and prompt snippets Claude loads with the Skill tool.\n\nProject skills are in \`.claude/skills/\`, global skills in \`~/.claude/skills/\`.`
      ),
      makeSection(
        'Config Files',
        [
          makeSection('Project', toConfigItems(projConfigFiles), 'CLAUDE.md · settings.json', `**Project config files**\n\n- \`CLAUDE.md\` — instructions Claude reads at the start of every session\n- \`settings.json\` — project-level permissions and hooks\n- \`settings.local.json\` — your personal overrides (not committed to git)`),
          makeSection('Global', toConfigItems(globConfigFiles), '~/.claude/', `**Global config files**\n\n- \`~/.claude/CLAUDE.md\` — instructions Claude reads in every session on this machine\n- \`~/.claude/settings.json\` — your personal default permissions and hooks`),
        ],
        'CLAUDE.md · settings.json',
        `**Config files** — instructions and permissions Claude reads on startup.\n\nProject config is in \`.claude/\`, global config in \`~/.claude/\`.`
      ),
    ];
  }
}

const HOOK_SCRIPT_CONTENT = `'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let raw = '';
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    if (input.tool_name !== 'Agent') { process.exit(0); return; }
    const toolInput = input.tool_input ?? {};
    const agentType = (toolInput.subagent_type ?? toolInput.subagentType ?? '').toLowerCase();
    if (!agentType) { process.exit(0); return; }
    const checkPaths = [
      path.join(process.cwd(), '.claude', 'settings.local.json'),
      path.join(os.homedir(), '.claude', 'settings.local.json'),
    ];
    for (const f of checkPaths) {
      try {
        const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const disabled = (obj.disabledSkills ?? []).map(s => s.toLowerCase());
        if (disabled.includes(agentType)) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Agent "' + agentType + '" is disabled in Claude Skills Manager. Enable it in the VS Code sidebar to use it.'
            }
          }));
          process.exit(0);
          return;
        }
      } catch {}
    }
    process.exit(0);
  } catch { process.exit(0); }
});
`;

function ensureHookInstalled() {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const scriptPath = path.join(claudeDir, 'skills-manager-block.js');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(scriptPath, HOOK_SCRIPT_CONTENT, 'utf-8');

    let settings = {};
    try { if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}

    const hookCommand = `node ${scriptPath}`;
    const existing = (settings.hooks?.PreToolUse ?? []);
    const alreadyRegistered = existing.some(entry =>
      entry.hooks?.some(h => h.type === 'command' && h.command === hookCommand)
    );
    if (alreadyRegistered) return;

    settings.hooks = settings.hooks ?? {};
    settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];
    settings.hooks.PreToolUse.push({
      matcher: 'Agent',
      hooks: [{ type: 'command', command: hookCommand, timeout: 5 }]
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch {}
}

function activate(context) {
  ensureHookInstalled();
  const provider = new SkillsProvider();
  const treeView = vscode.window.createTreeView('claude-skills-tree', { treeDataProvider: provider, showCollapseAll: true });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new SkillDecorationProvider()),
    treeView,
    { dispose: () => provider.dispose() },

    vscode.commands.registerCommand('claude-skills.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('claude-skills.setFilter', async () => {
      const val = await vscode.window.showInputBox({ prompt: 'Filter skills by name or description', value: provider.filterText, placeHolder: 'name or description...' });
      if (val !== undefined) {
        provider.filterText = val.toLowerCase().trim();
        treeView.message = provider.filterText ? `Filter: "${provider.filterText}"` : undefined;
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('claude-skills.clearFilter', () => {
      provider.filterText = '';
      treeView.message = undefined;
      provider.refresh();
    }),

    vscode.commands.registerCommand('claude-skills.clearActivity', () => {
      provider.sessionClearedAt = Date.now();
      provider.refresh();
    }),

    vscode.commands.registerCommand('claude-skills.openFile', (filePath) => {
      if (!filePath || !fs.existsSync(filePath)) { vscode.window.showWarningMessage(`File not found: ${filePath}`); return; }
      vscode.window.showTextDocument(vscode.Uri.file(filePath));
    }),

    vscode.commands.registerCommand('claude-skills.disableSkill', async (item) => {
      const data = item?.data;
      if (!data || 'isCategory' in data || 'isConfigFile' in data || 'isActivity' in data || data.isDisabled) return;
      const configDir = data.source === 'global'
        ? path.join(os.homedir(), '.claude')
        : path.join((vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()), '.claude');
      try {
        const set = readDisabledSet(configDir);
        set.add(data.name.toLowerCase());
        writeDisabledSet(configDir, set);
        vscode.window.showInformationMessage(`Disabled: ${data.name} (saved to settings.local.json — no git changes)`);
        provider.refresh();
      } catch (err) { vscode.window.showErrorMessage(`Failed to disable ${data.name}: ${err.message}`); }
    }),

    vscode.commands.registerCommand('claude-skills.enableSkill', (item) => {
      const data = item?.data;
      if (!data || 'isCategory' in data || 'isConfigFile' in data || 'isActivity' in data || !data.isDisabled) return;
      const configDir = data.source === 'global'
        ? path.join(os.homedir(), '.claude')
        : path.join((vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()), '.claude');
      try {
        const set = readDisabledSet(configDir);
        set.delete(data.name.toLowerCase());
        writeDisabledSet(configDir, set);
        vscode.window.showInformationMessage(`Enabled: ${data.name}`);
        provider.refresh();
      } catch (err) { vscode.window.showErrorMessage(`Failed to enable ${data.name}: ${err.message}`); }
    }),

    vscode.commands.registerCommand('claude-skills.disableAll', async () => {
      const skills = provider.getAllSkills().filter(s => !s.isDisabled);
      if (!skills.length) { vscode.window.showInformationMessage('All skills are already disabled.'); return; }
      const answer = await vscode.window.showWarningMessage(`Disable all ${skills.length} skills? (saved to settings.local.json — no git changes)`, { modal: true }, 'Disable All');
      if (answer !== 'Disable All') return;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const projConfigDir = path.join(cwd, '.claude');
      const globConfigDir = path.join(os.homedir(), '.claude');
      const projSet = readDisabledSet(projConfigDir);
      const globSet = readDisabledSet(globConfigDir);
      for (const s of skills) {
        (s.source === 'global' ? globSet : projSet).add(s.name.toLowerCase());
      }
      try { writeDisabledSet(projConfigDir, projSet); writeDisabledSet(globConfigDir, globSet); }
      catch (err) { vscode.window.showErrorMessage(`Failed: ${err.message}`); return; }
      vscode.window.showInformationMessage(`Disabled ${skills.length} skills.`);
      provider.refresh();
    }),

    vscode.commands.registerCommand('claude-skills.enableAll', async () => {
      const skills = provider.getAllSkills().filter(s => s.isDisabled);
      if (!skills.length) { vscode.window.showInformationMessage('All skills are already enabled.'); return; }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const projConfigDir = path.join(cwd, '.claude');
      const globConfigDir = path.join(os.homedir(), '.claude');
      try {
        writeDisabledSet(projConfigDir, new Set());
        writeDisabledSet(globConfigDir, new Set());
      } catch (err) { vscode.window.showErrorMessage(`Failed: ${err.message}`); return; }
      vscode.window.showInformationMessage(`Enabled ${skills.length} skills.`);
      provider.refresh();
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/**');
  context.subscriptions.push(watcher, watcher.onDidChange(() => provider.refresh()), watcher.onDidCreate(() => provider.refresh()), watcher.onDidDelete(() => provider.refresh()));
  const getCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const timer = setInterval(() => { provider.watchTranscript(getCwd()); provider.refresh(); }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}
module.exports = { activate, deactivate };
