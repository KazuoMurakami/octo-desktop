// Integração com o sistema: em qual terminal o Claude abre e em qual editor o projeto abre.
// Só aparece o que está instalado neste computador.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IntegrationOption, Integrations } from '../shared/types.ts';
import { claudeEnv } from './claude.ts';
import { HttpError } from './model.ts';
import { DATA_DIR } from './paths.ts';
import { db } from './store.ts';

/** Caminho completo de um comando no PATH, ou null. */
export function which(command: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- terminais

interface TerminalDef extends IntegrationOption {
  available: () => boolean;
}

const TERMINALS: Record<string, TerminalDef[]> = {
  // No Windows a janela abre no app de terminal padrão do sistema (Windows Terminal ou o console clássico);
  // aqui você escolhe o shell.
  win32: [
    { id: 'cmd', label: 'Prompt de Comando', hint: 'cmd.exe', available: () => true },
    { id: 'powershell', label: 'Windows PowerShell', hint: 'powershell.exe', available: () => true },
    { id: 'pwsh', label: 'PowerShell 7', hint: 'pwsh.exe', available: () => which('pwsh') !== null },
  ],
  darwin: [
    { id: 'terminal', label: 'Terminal', hint: 'Terminal.app', available: () => true },
    { id: 'iterm', label: 'iTerm2', hint: 'iTerm.app', available: () => macApp('iTerm') !== null },
  ],
};

/** Emuladores do Linux: como passar a pasta inicial e o comando a executar. */
export const LINUX_TERMINALS: { id: string; dir: (dir: string) => string[]; exec: string[] }[] = [
  { id: 'x-terminal-emulator', dir: () => [], exec: ['-e'] },
  { id: 'gnome-terminal', dir: (d) => [`--working-directory=${d}`], exec: ['--'] },
  { id: 'konsole', dir: (d) => ['--workdir', d], exec: ['-e'] },
  { id: 'xfce4-terminal', dir: (d) => [`--working-directory=${d}`], exec: ['-x'] },
  { id: 'kitty', dir: (d) => ['--directory', d], exec: [] },
  { id: 'alacritty', dir: (d) => ['--working-directory', d], exec: ['-e'] },
  { id: 'wezterm', dir: (d) => ['start', '--cwd', d], exec: ['--'] },
  { id: 'xterm', dir: () => [], exec: ['-e'] },
];

function terminalOptions(): TerminalDef[] {
  if (process.platform === 'win32' || process.platform === 'darwin') return TERMINALS[process.platform];
  return LINUX_TERMINALS.map((t) => ({ id: t.id, label: t.id, hint: '', available: () => which(t.id) !== null }));
}

// ---------------------------------------------------------------- editores

interface EditorDef {
  id: string;
  label: string;
  /** Windows: pastas de instalação comuns e o executável principal. */
  windows: { dirs: string[]; exe: string; cli: string };
  /** macOS: nome do .app. */
  mac: string;
  /** Linux: comandos no PATH. */
  linux: string[];
  /** Entende .code-workspace (várias pastas numa janela)? */
  multiRoot: boolean;
}

const LOCAL = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
const PROGRAMS = process.env.ProgramFiles ?? 'C:\\Program Files';

const EDITORS: EditorDef[] = [
  {
    id: 'vscode', label: 'VS Code', mac: 'Visual Studio Code', linux: ['code'], multiRoot: true,
    windows: { dirs: [path.join(LOCAL, 'Programs', 'Microsoft VS Code'), path.join(PROGRAMS, 'Microsoft VS Code')], exe: 'Code.exe', cli: 'code' },
  },
  {
    id: 'cursor', label: 'Cursor', mac: 'Cursor', linux: ['cursor'], multiRoot: true,
    windows: { dirs: [path.join(LOCAL, 'Programs', 'cursor'), path.join(PROGRAMS, 'Cursor')], exe: 'Cursor.exe', cli: 'cursor' },
  },
  {
    id: 'windsurf', label: 'Windsurf', mac: 'Windsurf', linux: ['windsurf'], multiRoot: true,
    windows: { dirs: [path.join(LOCAL, 'Programs', 'Windsurf'), path.join(PROGRAMS, 'Windsurf')], exe: 'Windsurf.exe', cli: 'windsurf' },
  },
  {
    id: 'zed', label: 'Zed', mac: 'Zed', linux: ['zed', 'zeditor'], multiRoot: false,
    windows: { dirs: [path.join(LOCAL, 'Programs', 'Zed'), path.join(PROGRAMS, 'Zed')], exe: 'Zed.exe', cli: 'zed' },
  },
];

function macApp(name: string): string | null {
  return [path.join('/Applications', `${name}.app`), path.join(homedir(), 'Applications', `${name}.app`)].find(existsSync) ?? null;
}

/**
 * Como abrir o editor sem passar por um shell. No Windows o `code` do PATH é um .cmd
 * (que o Node não executa sem shell): usamos o executável do app, achado na pasta de
 * instalação ou subindo a partir do .cmd.
 */
function editorCommand(editor: EditorDef): { command: string; args: string[] } | null {
  if (process.platform === 'win32') {
    const { dirs, exe, cli } = editor.windows;
    const installed = dirs.map((dir) => path.join(dir, exe)).find(existsSync);
    if (installed) return { command: installed, args: [] };
    const shim = which(cli);
    for (let dir = shim ? path.dirname(shim) : ''; dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, exe))) return { command: path.join(dir, exe), args: [] };
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const app = macApp(editor.mac);
    return app ? { command: 'open', args: ['-a', app] } : null;
  }
  const bin = editor.linux.map(which).find(Boolean);
  return bin ? { command: bin, args: [] } : null;
}

// ---------------------------------------------------------------- detecção (com cache: `where`/`which` custam caro)

let detected: { at: number; terminals: TerminalDef[]; editors: EditorDef[] } | null = null;

function detect() {
  if (detected && Date.now() - detected.at < 60_000) return detected;
  detected = {
    at: Date.now(),
    terminals: terminalOptions().filter((t) => t.available()),
    editors: EDITORS.filter((e) => editorCommand(e) !== null),
  };
  return detected;
}

export function integrations(): Integrations {
  const { terminals, editors } = detect();
  return {
    terminals: terminals.map(({ id, label, hint }) => ({ id, label, hint })),
    editors: editors.map(({ id, label }) => ({ id, label, hint: '' })),
    terminal: preferredTerminal(),
    editor: editors.find((e) => e.id === db.preferences.editor)?.id ?? editors[0]?.id ?? null,
  };
}

/** O terminal escolhido em Preferências, se ainda existir; senão o primeiro disponível. */
export function preferredTerminal(): string | null {
  const { terminals } = detect();
  return terminals.find((t) => t.id === db.preferences.terminal)?.id ?? terminals[0]?.id ?? null;
}

export function isKnownTerminal(id: string): boolean {
  return detect().terminals.some((t) => t.id === id);
}

export function isKnownEditor(id: string): boolean {
  return detect().editors.some((e) => e.id === id);
}

/**
 * Abre pastas no editor. Com várias, gera um .code-workspace (uma raiz por repositório),
 * e o painel de controle de versão do editor mostra as mudanças de cada um.
 */
export function openInEditor(options: { editorId?: string | null; name: string; dir: string; folders: string[] }): string {
  const { editors } = detect();
  const editor = editors.find((e) => e.id === (options.editorId || db.preferences.editor)) ?? editors[0];
  if (!editor) throw new HttpError(400, 'Nenhum editor encontrado (procurei VS Code, Cursor, Windsurf e Zed).');
  const command = editorCommand(editor);
  if (!command) throw new HttpError(400, `${editor.label} não foi encontrado.`);

  let target = options.dir;
  const folders = [...new Set(options.folders)];
  if (editor.multiRoot && folders.length > 1) {
    const dir = path.join(DATA_DIR, 'editor');
    mkdirSync(dir, { recursive: true });
    const slug = options.name.normalize('NFD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'workspace';
    target = path.join(dir, `${slug}.code-workspace`);
    writeFileSync(target, JSON.stringify({ folders: folders.map((folder) => ({ name: path.basename(folder), path: folder })) }, null, 2));
  } else if (folders.length === 1) {
    target = folders[0];
  }
  // Sem as variáveis de sessão do Claude: os terminais do editor não devem herdá-las.
  spawn(command.command, [...command.args, target], { env: claudeEnv(null), stdio: 'ignore', detached: true }).unref();
  return editor.label;
}
