// Integração com o sistema: em qual terminal o Claude abre e em qual editor o projeto abre.
// Só aparece o que está instalado neste computador.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IntegrationOption, Integrations } from '../shared/types.ts';
import { claudeEnv } from './claude.ts';
import { HttpError } from './model.ts';
import { DATA_DIR } from './paths.ts';
import { db } from './store.ts';
import { describeSpawnError, findOnPath, findProgram, launchDetached, shellQuote } from './system.ts';

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
    // A mesma busca que o terminal usa para abri-lo (ver windowsShell em terminal.ts).
    { id: 'pwsh', label: 'PowerShell 7', hint: 'pwsh.exe', available: () => findProgram('pwsh') !== null },
  ],
  darwin: [
    { id: 'terminal', label: 'Terminal', hint: 'Terminal.app', available: () => true },
    { id: 'iterm', label: 'iTerm2', hint: 'iTerm.app', available: () => macApp('iTerm') !== null },
  ],
};

/** Um emulador de terminal do Linux: como abrir numa pasta e como passar o comando a executar. */
export interface LinuxTerminal {
  id: string;
  label: string;
  /** Caminho do executável (achado no PATH, ou o que veio em $TERMINAL). */
  command: string;
  dir: (dir: string) => string[];
  exec: (command: string[]) => string[];
}

/** O comando vai como argumentos separados, depois de `flag` (ex.: `-e prog args`). */
const argv = (...flag: string[]) => (command: string[]) => [...flag, ...command];

/** Junta um comando numa linha de shell (para terminais que só aceitam o comando como texto). */
function shellLine(command: string[]): string {
  return command.map(shellQuote).join(' ');
}

/** Ordem de preferência quando você não escolheu um em Preferências: primeiro os padrões do sistema. */
const LINUX_TERMINALS: Omit<LinuxTerminal, 'command'>[] = [
  { id: 'x-terminal-emulator', label: 'Terminal padrão do sistema', dir: () => [], exec: argv('-e') },
  { id: 'xdg-terminal-exec', label: 'Terminal padrão (xdg-terminal-exec)', dir: () => [], exec: argv() },
  { id: 'gnome-terminal', label: 'GNOME Terminal', dir: (d) => [`--working-directory=${d}`], exec: argv('--') },
  { id: 'ptyxis', label: 'Ptyxis', dir: (d) => ['--new-window', `--working-directory=${d}`], exec: argv('--') },
  { id: 'kgx', label: 'Console do GNOME', dir: (d) => [`--working-directory=${d}`], exec: argv('--') },
  { id: 'konsole', label: 'Konsole', dir: (d) => ['--workdir', d], exec: argv('-e') },
  { id: 'xfce4-terminal', label: 'Terminal do Xfce', dir: (d) => [`--working-directory=${d}`], exec: argv('-x') },
  { id: 'tilix', label: 'Tilix', dir: (d) => [`--working-directory=${d}`], exec: (command) => ['-e', shellLine(command)] },
  { id: 'terminator', label: 'Terminator', dir: (d) => [`--working-directory=${d}`], exec: argv('-x') },
  { id: 'ghostty', label: 'Ghostty', dir: (d) => [`--working-directory=${d}`], exec: argv('-e') },
  { id: 'kitty', label: 'kitty', dir: (d) => ['--directory', d], exec: argv() },
  { id: 'alacritty', label: 'Alacritty', dir: (d) => ['--working-directory', d], exec: argv('-e') },
  { id: 'wezterm', label: 'WezTerm', dir: (d) => ['start', '--cwd', d], exec: argv('--') },
  { id: 'foot', label: 'foot', dir: (d) => [`--working-directory=${d}`], exec: argv() },
  { id: 'xterm', label: 'XTerm', dir: () => [], exec: argv('-e') },
];

/** Terminais do Linux instalados, com o de $TERMINAL (se houver) na frente. */
function linuxTerminals(): LinuxTerminal[] {
  const found: LinuxTerminal[] = [];
  const preferred = process.env.TERMINAL?.trim().split(/\s+/)[0];
  const preferredPath = preferred ? (path.isAbsolute(preferred) ? (existsSync(preferred) ? preferred : null) : findOnPath(preferred)) : null;
  if (preferredPath) {
    const id = path.basename(preferredPath);
    // Um terminal desconhecido em $TERMINAL usa a convenção do xterm (-e prog args).
    const known = LINUX_TERMINALS.find((t) => t.id === id);
    found.push({ ...(known ?? { id, label: id, dir: () => [], exec: argv('-e') }), command: preferredPath });
  }
  for (const terminal of LINUX_TERMINALS) {
    if (found.some((t) => t.id === terminal.id)) continue;
    const command = findOnPath(terminal.id);
    if (command) found.push({ ...terminal, command });
  }
  return found;
}

/** Nomes procurados no Linux, para a mensagem de "nenhum terminal encontrado". */
export const LINUX_TERMINAL_NAMES = LINUX_TERMINALS.map((t) => t.id);

/** Como abrir o terminal do Linux com este id (detectado há no máximo um minuto). */
export function linuxTerminal(id: string): LinuxTerminal | null {
  return detect().linux.find((t) => t.id === id) ?? null;
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
    const shim = findOnPath(cli);
    for (let dir = shim ? path.dirname(shim) : ''; dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, exe))) return { command: path.join(dir, exe), args: [] };
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const app = macApp(editor.mac);
    return app ? { command: 'open', args: ['-a', app] } : null;
  }
  const bin = editor.linux.map((name) => findOnPath(name)).find(Boolean);
  return bin ? { command: bin, args: [] } : null;
}

// ---------------------------------------------------------------- detecção (com cache: varrer o PATH e as pastas de instalação custa)

let detected: { at: number; terminals: TerminalDef[]; linux: LinuxTerminal[]; editors: EditorDef[] } | null = null;

function detect() {
  if (detected && Date.now() - detected.at < 60_000) return detected;
  const native = process.platform === 'win32' || process.platform === 'darwin';
  const linux = native ? [] : linuxTerminals();
  detected = {
    at: Date.now(),
    terminals: native
      ? TERMINALS[process.platform].filter((t) => t.available())
      : linux.map((t) => ({ id: t.id, label: t.label, hint: t.command, available: () => true })),
    linux,
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
export async function openInEditor(options: { editorId?: string | null; name: string; dir: string; folders: string[] }): Promise<string> {
  const { editors } = detect();
  const editor = editors.find((e) => e.id === (options.editorId || db.preferences.editor)) ?? editors[0];
  if (!editor) throw new HttpError(400, 'Nenhum editor encontrado (procurei VS Code, Cursor, Windsurf e Zed).');
  const command = editorCommand(editor);
  if (!command) throw new HttpError(400, `${editor.label} não foi encontrado.`);

  // Repositórios movidos ou apagados desde o último escaneamento ficam de fora.
  const folders = [...new Set(options.folders)].filter((folder) => existsSync(folder));
  if (!folders.length && !existsSync(options.dir)) throw new HttpError(400, `A pasta ${options.dir} não existe mais. Ela pode ter sido movida, renomeada ou apagada.`);
  let target = options.dir;
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
  await launchDetached(command.command, [...command.args, target], { env: claudeEnv(null), detached: true }).catch((error: unknown) => {
    throw new HttpError(500, describeSpawnError(error, `Não foi possível abrir o ${editor.label}`));
  });
  return editor.label;
}
