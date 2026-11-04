import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillSource = 'project' | 'global';
type SkillType = 'agent' | 'skill';

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
}

interface ConfigFileData {
  isConfigFile: true;
  label: string;
  filePath: string;
}

type ItemData = SkillData | CategoryData | ConfigFileData;

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
// Tree item
// ---------------------------------------------------------------------------

class SkillsTreeItem extends vscode.TreeItem {
  constructor(public readonly data: ItemData, collapsibleState: vscode.TreeItemCollapsibleState) {
    super('', collapsibleState);

    if ('isCategory' in data) {
      this.label = data.name;
      this.contextValue = 'category';
      this.iconPath = new vscode.ThemeIcon('folder');
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
    this.iconPath = data.isDisabled
      ? new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('list.errorForeground'))
      : new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('terminal.ansiGreen'));
    this.command = { command: 'claude-skills.openFile', title: 'Open File', arguments: [data.filePath] };
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

class SkillsProvider implements vscode.TreeDataProvider<SkillsTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SkillsTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
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

    const makeSection = (name: string, children: SkillsTreeItem[]) =>
      new SkillsTreeItem(
        { isCategory: true, name, children },
        vscode.TreeItemCollapsibleState.Expanded
      );

    const projDisabled = [...projAgents, ...projSkills].filter(s => s.isDisabled).length;
    const globDisabled = [...globAgents, ...globSkills].filter(s => s.isDisabled).length;

    const projLabel = `Project — ${projAgents.length + projSkills.length} skills${projDisabled ? ` (${projDisabled} off)` : ''}`;
    const globLabel = `Global — ${globAgents.length + globSkills.length} skills${globDisabled ? ` (${globDisabled} off)` : ''}`;

    const projRoot = makeSection(projLabel, [
      makeSection(`Agents (${projAgents.length})`, toItems(projAgents)),
      makeSection(`Skills (${projSkills.length})`, toItems(projSkills)),
      makeSection('Config Files', toConfigItems(projConfigFiles)),
    ]);

    const globRoot = makeSection(globLabel, [
      makeSection(`Agents (${globAgents.length})`, toItems(globAgents)),
      makeSection(`Skills (${globSkills.length})`, toItems(globSkills)),
      makeSection('Config Files', toConfigItems(globConfigFiles)),
    ]);

    return [projRoot, globRoot];
  }
}

// ---------------------------------------------------------------------------
// Activate / deactivate
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SkillsProvider();

  const treeView = vscode.window.createTreeView('claude-skills-tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    treeView,

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
      if (!data || 'isCategory' in data || 'isConfigFile' in data || data.isDisabled) { return; }

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
  );

  // Auto-refresh when .claude dir contents change
  const watcher = vscode.workspace.createFileSystemWatcher('**/.claude/**');
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(() => provider.refresh()),
    watcher.onDidCreate(() => provider.refresh()),
    watcher.onDidDelete(() => provider.refresh()),
  );

  // Periodic refresh to catch changes in ~/.claude (outside workspace)
  const timer = setInterval(() => provider.refresh(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void { /* nothing */ }
