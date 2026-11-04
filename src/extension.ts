import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillSource = 'project' | 'global';
type SkillType = 'agent' | 'skill';

interface AgentCall {
  name: string;
  description: string;
  timestamp: number;
  toolType: 'agent' | 'skill';
  toolUseId?: string;
  durationMs?: number;
  inputTokens?: number;
}

interface SkillData {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  type: SkillType;
  isDisabled: boolean;
}

interface CategoryData {
  isCategory: true;
  name: string;
  children: SkillsTreeItem[];
  note?: string;
  tooltip?: string;
}

interface ConfigFileData {
  isConfigFile: true;
  label: string;
  filePath: string;
}

interface ActivityData {
  isActivity: true;
  call: AgentCall;
  filePath?: string;
}

type ItemData = SkillData | CategoryData | ConfigFileData | ActivityData;

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

function parseFrontmatter(text: string): { name: string; description: string } {
  let name = '';
  let description = '';
  const lines = text.split('\n');
  let inFm = false;
  let fmDone = false;

  for (const line of lines) {
    if (!fmDone && line.trim() === '---') {
      inFm = !inFm;
      if (!inFm) fmDone = true;
      continue;
    }
    if (inFm) {
      if (line.startsWith('name:')) { name = line.slice(5).trim(); }
      else if (line.startsWith('description:')) { description = line.slice(12).trim(); }
    }
  }

  return { name, description };
}

function readSkillMeta(filePath: string, fallbackName: string): { name: string; description: string } {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const { name, description } = parseFrontmatter(text);
    return { name: name || fallbackName, description: description || '' };
  } catch {
    return { name: fallbackName, description: '' };
  }
}

// ---------------------------------------------------------------------------
// Transcript / session activity
// ---------------------------------------------------------------------------

function findLatestTranscript(cwd: string): string | null {
  // Claude Code stores transcripts at ~/.claude/projects/<encoded-path>/<session>.jsonl
  // The directory name is the cwd with every '/' replaced by '-'.
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) { return null; }

  // Try the project-specific directory first
  const projectDirName = cwd.replace(/\//g, '-');
  const projectDir = path.join(projectsDir, projectDirName);

  let latestFile: string | null = null;
  let latestTime = 0;

  if (fs.existsSync(projectDir)) {
    try {
      const files = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(projectDir, file.name);
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > latestTime) { latestTime = stat.mtimeMs; latestFile = filePath; }
      }
    } catch { /* skip */ }
    if (latestFile) { return latestFile; }
  }

  // Fall back to global search if project dir not found

  try {
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir.name);
      try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(dirPath, file.name);
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs > latestTime) {
            latestTime = stat.mtimeMs;
            latestFile = filePath;
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* skip if projects dir unreadable */ }

  return latestFile;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) { return 'just now'; }
  if (diff < 3_600_000) { return `${Math.floor(diff / 60_000)}m ago`; }
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) { return `${ms}ms`; }
  if (ms < 60_000) { return `${Math.round(ms / 1_000)}s`; }
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k tok`; }
  return `${n} tok`;
}

function parseAgentCallsFromTranscript(transcriptPath: string): AgentCall[] {
  const byId = new Map<string, AgentCall>();
  const ordered: AgentCall[] = [];

  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n').filter(Boolean);

    for (const line of lines.slice(-400)) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const timestamp = typeof obj['timestamp'] === 'string'
          ? new Date(obj['timestamp']).getTime()
          : (typeof obj['ts'] === 'number' ? (obj['ts'] as number) * 1000 : Date.now());

        const msgObj = obj['message'] as Record<string, unknown> | undefined;
        const usage = (msgObj?.['usage'] ?? obj['usage']) as Record<string, number> | undefined;
        const totalTokens = (usage?.['input_tokens'] ?? 0) + (usage?.['output_tokens'] ?? 0);

        const contentArr: unknown[] = Array.isArray(msgObj?.['content']) ? msgObj!['content'] as unknown[]
          : Array.isArray(obj['content']) ? obj['content'] as unknown[]
          : [];

        for (const block of contentArr) {
          if (!block || typeof block !== 'object') { continue; }
          const b = block as Record<string, unknown>;

          if (b['type'] === 'tool_use') {
            const toolName = b['name'] as string;
            const input = (b['input'] as Record<string, unknown>) ?? {};
            const id = b['id'] as string | undefined;

            if (toolName === 'Agent') {
              const agentType = ((input['subagentType'] ?? input['subagent_type']) as string | undefined) ?? '';
              const description = (input['description'] as string | undefined) ?? '';
              const name = (agentType || description.slice(0, 40)) || 'unknown agent';
              const call: AgentCall = { name, description, timestamp, toolType: 'agent', toolUseId: id, inputTokens: totalTokens || undefined };
              if (id) { byId.set(id, call); }
              ordered.push(call);
            } else if (toolName === 'Skill') {
              const name = (input['skill'] as string | undefined) ?? 'unknown skill';
              const description = (input['args'] as string | undefined) ?? '';
              const call: AgentCall = { name, description, timestamp, toolType: 'skill', toolUseId: id, inputTokens: totalTokens || undefined };
              if (id) { byId.set(id, call); }
              ordered.push(call);
            }
          }

          if (b['type'] === 'tool_result') {
            const refId = b['tool_use_id'] as string | undefined;
            if (refId) {
              const pending = byId.get(refId);
              if (pending) { pending.durationMs = timestamp - pending.timestamp; }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file unreadable */ }

  const seen = new Set<string>();
  return ordered.reverse().filter(c => {
    if (seen.has(c.name)) { return false; }
    seen.add(c.name);
    return true;
  }).slice(0, 10);
}

// ---------------------------------------------------------------------------
// File scanners
// ---------------------------------------------------------------------------

function scanAgentsDir(dir: string, source: SkillSource): SkillData[] {
  const skills: SkillData[] = [];
  if (!fs.existsSync(dir)) { return skills; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (!entry.isFile()) { continue; }
    const isDisabled = entry.name.endsWith('.md.disabled');
    if (!entry.name.endsWith('.md') && !isDisabled) { continue; }

    const filePath = path.join(dir, entry.name);
    const baseName = entry.name.replace(/\.md(\.disabled)?$/, '');
    const { name, description } = readSkillMeta(filePath, baseName);

    skills.push({ id: `${source}:agent:${entry.name}`, name, description, filePath, source, type: 'agent', isDisabled });
  }

  return skills;
}

function scanSkillsDir(dir: string, source: SkillSource): SkillData[] {
  const skills: SkillData[] = [];
  if (!fs.existsSync(dir)) { return skills; }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      const isDisabled = entry.name.endsWith('.md.disabled');
      if (!entry.name.endsWith('.md') && !isDisabled) { continue; }
      const filePath = path.join(dir, entry.name);
      const baseName = entry.name.replace(/\.md(\.disabled)?$/, '');
      const { name, description } = readSkillMeta(filePath, baseName);
      skills.push({ id: `${source}:skill:${entry.name}`, name, description, filePath, source, type: 'skill', isDisabled });
    } else if (entry.isDirectory()) {
      // Each skill lives in its own subfolder with SKILL.md
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

// ---------------------------------------------------------------------------
// File decoration provider — colors disabled skill rows red
// ---------------------------------------------------------------------------

const DISABLED_SCHEME = 'claude-skill-disabled';
const ENABLED_SCHEME  = 'claude-skill-enabled';

class SkillDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === DISABLED_SCHEME) {
      return {
        badge: '✗',
        color: new vscode.ThemeColor('list.errorForeground'),
        tooltip: 'Disabled — Claude Code will not load this skill',
      };
    }
    if (uri.scheme === ENABLED_SCHEME) {
      return {
        badge: '✓',
        color: new vscode.ThemeColor('terminal.ansiBlue'),
        tooltip: 'Enabled',
      };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

class SkillsTreeItem extends vscode.TreeItem {
  constructor(public readonly data: ItemData, collapsibleState: vscode.TreeItemCollapsibleState) {
    super('', collapsibleState);

    if ('isCategory' in data) {
      this.label = data.name;
      this.contextValue = 'category';
      this.iconPath = new vscode.ThemeIcon('folder');
      if (data.note) { this.description = data.note; }
      if (data.tooltip) { this.tooltip = new vscode.MarkdownString(data.tooltip); }
      return;
    }

    if ('isActivity' in data) {
      const { call, filePath } = data;
      this.label = call.name;
      this.contextValue = filePath ? 'activity-openable' : 'activity';

      const parts: string[] = [];
      if (call.durationMs != null) { parts.push(formatDuration(call.durationMs)); }
      if (call.inputTokens) { parts.push(formatTokens(call.inputTokens)); }
      parts.push(relativeTime(call.timestamp));
      this.description = parts.join(' · ');

      const icon = call.toolType === 'skill' ? '$(book)' : '$(arrow-right)';
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
      if (filePath) {
        this.command = { command: 'claude-skills.openFile', title: 'Open File', arguments: [filePath] };
      }
      return;
    }

    if ('isConfigFile' in data) {
      this.label = data.label;
      const exists = fs.existsSync(data.filePath);
      this.contextValue = 'configFile';
      this.description = exists ? '✓' : '✗ missing';
      this.tooltip = data.filePath;
      this.iconPath = new vscode.ThemeIcon(exists ? 'file-code' : 'file');
      if (exists) {
        this.command = { command: 'claude-skills.openFile', title: 'Open', arguments: [data.filePath] };
      }
      return;
    }

    // Skill / agent
    this.label = data.name;
    this.contextValue = data.isDisabled ? 'skill-disabled' : 'skill-enabled';
    this.description = data.description;
    this.tooltip = new vscode.MarkdownString(
      `**${data.name}** · \`${data.type}\` · \`${data.source}\`\n\n` +
      (data.description ? `${data.description}\n\n` : '') +
      `*${data.filePath}*`
    );
    // resourceUri drives the FileDecorationProvider (red = disabled, blue = enabled)
    this.resourceUri = vscode.Uri.parse(
      `${data.isDisabled ? DISABLED_SCHEME : ENABLED_SCHEME}:${encodeURIComponent(data.name)}`
    );
    this.iconPath = data.isDisabled
      ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('terminal.ansiBlue'));
    this.command = { command: 'claude-skills.openFile', title: 'Open File', arguments: [data.filePath] };
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

class SkillsProvider implements vscode.TreeDataProvider<SkillsTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SkillsTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private transcriptWatcher: fs.FSWatcher | null = null;
  private currentTranscript: string | null = null;
  private lastScannedSkills: SkillData[] = [];

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  watchTranscript(cwd: string): void {
    const transcript = findLatestTranscript(cwd);
    if (!transcript || transcript === this.currentTranscript) { return; }

    this.transcriptWatcher?.close();
    this.currentTranscript = transcript;

    try {
      this.transcriptWatcher = fs.watch(transcript, () => this.refresh());
    } catch { /* file may not be watchable */ }
  }

  getAllSkills(): SkillData[] {
    return this.lastScannedSkills;
  }

  dispose(): void {
    this.transcriptWatcher?.close();
  }

  getTreeItem(element: SkillsTreeItem): SkillsTreeItem {
    return element;
  }

  getChildren(element?: SkillsTreeItem): SkillsTreeItem[] {
    if (!element) { return this.buildRoots(); }
    const data = element.data;
    if ('isCategory' in data) { return data.children; }
    return [];
  }

  private buildRoots(): SkillsTreeItem[] {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const home = os.homedir();

    // Keep transcript watcher pointed at the latest session file
    this.watchTranscript(cwd);

    const projAgents = scanAgentsDir(path.join(cwd, '.claude', 'agents'), 'project');
    const projSkills = scanSkillsDir(path.join(cwd, '.claude', 'skills'), 'project');
    const globAgents = scanAgentsDir(path.join(home, '.claude', 'agents'), 'global');
    const globSkills = scanSkillsDir(path.join(home, '.claude', 'skills'), 'global');

    const toItems = (skills: SkillData[]) =>
      skills.map(s => new SkillsTreeItem(s, vscode.TreeItemCollapsibleState.None));

    const toConfigItems = (files: { label: string; filePath: string }[]) =>
      files.map(f => new SkillsTreeItem({ isConfigFile: true, ...f }, vscode.TreeItemCollapsibleState.None));

    const projConfigFiles = [
      { label: 'CLAUDE.md', filePath: path.join(cwd, 'CLAUDE.md') },
      { label: 'settings.json', filePath: path.join(cwd, '.claude', 'settings.json') },
      { label: 'settings.local.json', filePath: path.join(cwd, '.claude', 'settings.local.json') },
    ];

    const globConfigFiles = [
      { label: 'CLAUDE.md', filePath: path.join(home, '.claude', 'CLAUDE.md') },
      { label: 'settings.json', filePath: path.join(home, '.claude', 'settings.json') },
    ];

    const makeSection = (
      name: string,
      children: SkillsTreeItem[],
      note?: string,
      tooltip?: string
    ) =>
      new SkillsTreeItem(
        { isCategory: true, name, children, note, tooltip },
        children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );

    // Cache for disable-all / enable-all
    const allSkills = [...projAgents, ...projSkills, ...globAgents, ...globSkills];
    this.lastScannedSkills = allSkills;
    const skillFileByName = new Map<string, string>(
      allSkills.map(s => [s.name.toLowerCase(), s.filePath])
    );

    // Session activity — agents called in the current session transcript
    const transcript = this.currentTranscript ?? findLatestTranscript(cwd);
    const agentCalls = transcript ? parseAgentCallsFromTranscript(transcript) : [];

    const activityChildren = agentCalls.length > 0
      ? agentCalls.map(call => {
          const filePath = skillFileByName.get(call.name.toLowerCase());
          return new SkillsTreeItem(
            { isActivity: true, call, filePath },
            vscode.TreeItemCollapsibleState.None
          );
        })
      : [new SkillsTreeItem(
          { isCategory: true, name: 'No agent calls found in session', children: [] },
          vscode.TreeItemCollapsibleState.None
        )];

    const activityRoot = makeSection(
      agentCalls.length > 0 ? `Session Activity (${agentCalls.length})` : 'Session Activity',
      activityChildren,
      agentCalls.length > 0 ? 'agents called this session' : 'no agents called yet',
      `**Session Activity** — agents Claude delegated to in the current session.\n\nRead live from \`~/.claude/projects/*/‌*.jsonl\` (the session transcript). Updates automatically as Claude calls the Agent tool.\n\nClick an item to open its definition file.`
    );

    // Agents root — project + global as sub-groups
    const projAgentsDisabled = projAgents.filter(s => s.isDisabled).length;
    const globAgentsDisabled = globAgents.filter(s => s.isDisabled).length;
    const totalAgents = projAgents.length + globAgents.length;
    const totalAgentsDisabled = projAgentsDisabled + globAgentsDisabled;

    const agentsRoot = makeSection(
      `Agents (${totalAgents})${totalAgentsDisabled ? ` — ${totalAgentsDisabled} off` : ''}`,
      [
        makeSection(
          `Project (${projAgents.length})`,
          toItems(projAgents),
          `.claude/agents/`,
          `**Project agents** — defined in \`.claude/agents/\` inside this workspace.\n\nClaude delegates tasks to these when you ask it to code, review, or research. Each is a \`.md\` file with a name, description, and instructions.`
        ),
        makeSection(
          `Global (${globAgents.length})`,
          toItems(globAgents),
          `~/.claude/agents/`,
          `**Global agents** — defined in \`~/.claude/agents/\` on your machine.\n\nAvailable in every project. Same format as project agents.`
        ),
      ],
      `${projAgents.length} project · ${globAgents.length} global`,
      `**Agents** — specialized sub-agents Claude can delegate tasks to.\n\nProject agents are in \`.claude/agents/\`, global agents in \`~/.claude/agents/\`.`
    );

    // Skills root — project + global as sub-groups
    const projSkillsDisabled = projSkills.filter(s => s.isDisabled).length;
    const globSkillsDisabled = globSkills.filter(s => s.isDisabled).length;
    const totalSkills = projSkills.length + globSkills.length;
    const totalSkillsDisabled = projSkillsDisabled + globSkillsDisabled;

    const skillsRoot = makeSection(
      `Skills (${totalSkills})${totalSkillsDisabled ? ` — ${totalSkillsDisabled} off` : ''}`,
      [
        makeSection(
          `Project (${projSkills.length})`,
          toItems(projSkills),
          `.claude/skills/`,
          `**Project skills** — defined in \`.claude/skills/\` inside this workspace.\n\nSkills are slash commands and prompt snippets loaded with the Skill tool (e.g. \`/code-review\`). Each lives in its own subfolder with a \`SKILL.md\` file.`
        ),
        makeSection(
          `Global (${globSkills.length})`,
          toItems(globSkills),
          `~/.claude/skills/`,
          `**Global skills** — defined in \`~/.claude/skills/\` on your machine.\n\nAvailable as slash commands in every project. Installed skills (e.g. \`artifact-design\`, \`dataviz\`) live here.`
        ),
      ],
      `${projSkills.length} project · ${globSkills.length} global`,
      `**Skills** — slash commands and prompt snippets Claude loads with the Skill tool.\n\nProject skills are in \`.claude/skills/\`, global skills in \`~/.claude/skills/\`.`
    );

    // Config files root
    const configRoot = makeSection(
      'Config Files',
      [
        makeSection(
          'Project',
          toConfigItems(projConfigFiles),
          'CLAUDE.md · settings.json',
          `**Project config files**\n\n- \`CLAUDE.md\` — instructions Claude reads at the start of every session in this project\n- \`settings.json\` — project-level permissions, hooks, and env vars\n- \`settings.local.json\` — your personal overrides (not committed to git)`
        ),
        makeSection(
          'Global',
          toConfigItems(globConfigFiles),
          '~/.claude/',
          `**Global config files**\n\n- \`~/.claude/CLAUDE.md\` — instructions Claude reads in every session on this machine\n- \`~/.claude/settings.json\` — your personal default permissions and hooks`
        ),
      ],
      'CLAUDE.md · settings.json',
      `**Config files** — instructions and permissions Claude reads on startup.\n\nProject config is in \`.claude/\`, global config in \`~/.claude/\`.`
    );

    return [activityRoot, agentsRoot, skillsRoot, configRoot];
  }
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SkillsProvider();
  const decorationProvider = new SkillDecorationProvider();

  const treeView = vscode.window.createTreeView('claude-skills-tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  context.subscriptions.push(
    treeView,
    { dispose: () => provider.dispose() },

    vscode.commands.registerCommand('claude-skills.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('claude-skills.openFile', (filePath: string) => {
      if (!filePath || !fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`File not found: ${filePath}`);
        return;
      }
      vscode.window.showTextDocument(vscode.Uri.file(filePath));
    }),

    vscode.commands.registerCommand('claude-skills.disableSkill', async (item: SkillsTreeItem) => {
      const data = item?.data;
      if (!data || 'isCategory' in data || 'isConfigFile' in data || 'isActivity' in data || data.isDisabled) { return; }

      const answer = await vscode.window.showWarningMessage(
        `Disable "${data.name}"? The file will be renamed with a .disabled suffix so Claude Code won't load it.`,
        { modal: true },
        'Disable'
      );
      if (answer !== 'Disable') { return; }

      try {
        fs.renameSync(data.filePath, data.filePath + '.disabled');
        vscode.window.showInformationMessage(`Disabled: ${data.name}`);
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to disable ${data.name}: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('claude-skills.enableSkill', (item: SkillsTreeItem) => {
      const data = item?.data;
      if (!data || 'isCategory' in data || 'isConfigFile' in data || !data.isDisabled) { return; }

      const newPath = data.filePath.replace(/\.disabled$/, '');
      try {
        fs.renameSync(data.filePath, newPath);
        vscode.window.showInformationMessage(`Enabled: ${data.name}`);
        provider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to enable ${data.name}: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('claude-skills.disableAll', async () => {
      const skills = provider.getAllSkills().filter(s => !s.isDisabled);
      if (skills.length === 0) {
        vscode.window.showInformationMessage('All skills are already disabled.');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Disable all ${skills.length} skills? Claude Code will not load any of them.`,
        { modal: true }, 'Disable All'
      );
      if (answer !== 'Disable All') { return; }
      const errors: string[] = [];
      for (const s of skills) {
        try { fs.renameSync(s.filePath, s.filePath + '.disabled'); }
        catch { errors.push(s.name); }
      }
      if (errors.length) {
        vscode.window.showErrorMessage(`Failed to disable: ${errors.join(', ')}`);
      } else {
        vscode.window.showInformationMessage(`Disabled ${skills.length} skills.`);
      }
      provider.refresh();
    }),

    vscode.commands.registerCommand('claude-skills.enableAll', async () => {
      const skills = provider.getAllSkills().filter(s => s.isDisabled);
      if (skills.length === 0) {
        vscode.window.showInformationMessage('All skills are already enabled.');
        return;
      }
      const errors: string[] = [];
      for (const s of skills) {
        const newPath = s.filePath.replace(/\.disabled$/, '');
        try { fs.renameSync(s.filePath, newPath); }
        catch { errors.push(s.name); }
      }
      if (errors.length) {
        vscode.window.showErrorMessage(`Failed to enable: ${errors.join(', ')}`);
      } else {
        vscode.window.showInformationMessage(`Enabled ${skills.length} skills.`);
      }
      provider.refresh();
    }),
  );

  // Auto-refresh when .claude dir contents change
  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/**');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => provider.refresh()),
    watcher.onDidCreate(() => provider.refresh()),
    watcher.onDidDelete(() => provider.refresh()),
  );

  // Periodic refresh: catch global dir changes + re-check for a new session transcript
  const timer = setInterval(() => {
    provider.watchTranscript(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    );
    provider.refresh();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void { /* nothing */ }
