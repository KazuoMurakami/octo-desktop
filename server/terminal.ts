import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeAccount } from '../shared/types.ts';
import { claudeEnv, requireClaude } from './claude.ts';
import { LINUX_TERMINALS, preferredTerminal } from './integrations.ts';
import { RUNTIME_DIR } from './paths.ts';

/**
 * No app desktop, process.execPath é o executável do Octo, que só se comporta como Node
 * com ELECTRON_RUN_AS_NODE=1. Na linha de comando é o próprio node.
 */
const IN_ELECTRON = Boolean(process.versions.electron);

// O launcher é copiado para a pasta de dados: dentro do app empacotado ele fica num .asar,
// que só o Octo consegue ler.
mkdirSync(RUNTIME_DIR, { recursive: true });
const LAUNCHER = path.join(RUNTIME_DIR, 'launcher.mjs');
writeFileSync(LAUNCHER, readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs')));

// No Windows o launcher roda por um .cmd: o cmd.exe só espera um programa de janela (o Octo
// como Node) terminar quando ele é chamado de um script. Os caminhos chegam por variáveis de
// ambiente, que preservam acentos melhor que o texto de um .cmd.
const WINDOWS_SCRIPT = path.join(RUNTIME_DIR, 'launch.cmd');
if (process.platform === 'win32') {
  writeFileSync(
    WINDOWS_SCRIPT,
    [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%OCTO_NODE%" "%OCTO_LAUNCHER%" "%OCTO_JOB%"',
      'set "ELECTRON_RUN_AS_NODE="',
      'set "OCTO_NODE="',
      'set "OCTO_LAUNCHER="',
      'set "OCTO_JOB="',
      'set "OCTO_SCRIPT="',
      '',
    ].join('\r\n'),
  );
}

export interface TerminalRequest {
  cwd: string;
  account: ClaudeAccount | null;
  /** Argumentos para o Claude Code (sem o executável). */
  args: string[];
  title: string;
  banner?: string;
}

/**
 * Abre uma janela de terminal nova rodando o Claude Code — o mesmo fluxo de
 * "abrir a pasta, digitar cmd e rodar claude", mas já com a conta e o contexto certos.
 * O terminal é o escolhido em Preferências.
 */
export function openClaudeTerminal(request: TerminalRequest): void {
  const claude = requireClaude();
  const env = claudeEnv(request.account);
  const jobFile = path.join(RUNTIME_DIR, `job-${randomUUID()}.json`);
  writeFileSync(
    jobFile,
    JSON.stringify({
      cwd: request.cwd,
      command: claude.command,
      args: [...claude.prefixArgs, ...request.args],
      env: request.account?.configDir ? { CLAUDE_CONFIG_DIR: request.account.configDir } : {},
      unsetEnv: Object.keys(process.env).filter((key) => !(key in env)),
      banner: request.banner,
    }),
  );
  launch(request.cwd, request.title, jobFile);
}

/** Abre só o shell na pasta, sem o Claude: para olhar as mudanças, rodar git, testes etc. */
export function openShell(cwd: string, title: string): void {
  launch(cwd, title, null);
}

function launch(cwd: string, rawTitle: string, jobFile: string | null): void {
  const terminal = preferredTerminal();
  if (!terminal) throw new Error('Nenhum terminal encontrado neste computador.');
  const title = rawTitle.replace(/["%^&|<>]/g, '').slice(0, 80) || 'Octo';
  if (process.platform === 'win32') return launchWindows(terminal, cwd, title, jobFile);

  // O Terminal do macOS não herda o ambiente do Octo, então a variável vai na própria linha.
  const runner = jobFile ? [...(IN_ELECTRON ? ['env', 'ELECTRON_RUN_AS_NODE=1'] : []), process.execPath, LAUNCHER, jobFile] : null;
  if (process.platform === 'darwin') return launchMac(terminal, cwd, runner);
  launchLinux(terminal, cwd, runner);
}

/**
 * `start` abre uma janela nova no app de terminal padrão do Windows (Windows Terminal ou o
 * console clássico); o shell (cmd, PowerShell) fica aberto na pasta quando o Claude termina.
 */
function launchWindows(terminal: string, cwd: string, title: string, jobFile: string | null): void {
  const powershell = terminal === 'powershell' || terminal === 'pwsh' ? `${terminal}.exe` : null;
  let command: string;
  if (powershell) {
    // O PowerShell chama o mesmo launch.cmd pelo cmd (que espera o Octo-como-Node terminar)
    // e depois limpa as variáveis usadas para passar os caminhos.
    command = jobFile
      ? `${powershell} -NoExit -NoLogo -Command "& $env:ComSpec /d /c $env:OCTO_SCRIPT; Remove-Item Env:OCTO_* -ErrorAction SilentlyContinue"`
      : `${powershell} -NoExit -NoLogo`;
  } else {
    command = jobFile ? `cmd.exe /k ""${WINDOWS_SCRIPT}""` : 'cmd.exe /k';
  }
  const env = jobFile
    ? { ...claudeEnv(null), OCTO_SCRIPT: WINDOWS_SCRIPT, OCTO_NODE: process.execPath, OCTO_LAUNCHER: LAUNCHER, OCTO_JOB: jobFile }
    : claudeEnv(null);
  spawn('cmd.exe', ['/d', '/s', '/c', `start "${title}" ${command}`], {
    cwd,
    env,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  }).unref();
}

function launchMac(terminal: string, cwd: string, runner: string[] | null): void {
  const command = [`cd ${shellQuote(cwd)}`, ...(runner ? [runner.map(shellQuote).join(' ')] : [])].join(' && ');
  // Dentro de uma string AppleScript, \ e " precisam de escape (o shellQuote pode gerar '\'').
  const text = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script =
    terminal === 'iterm'
      ? ['tell application "iTerm"', 'activate', 'set newWindow to (create window with default profile)', `tell current session of newWindow to write text "${text}"`, 'end tell']
      : [`tell application "Terminal" to do script "${text}"`, 'tell application "Terminal" to activate'];
  spawn('osascript', script.flatMap((line) => ['-e', line]), { stdio: 'ignore' }).unref();
}

function launchLinux(terminal: string, cwd: string, runner: string[] | null): void {
  const def = LINUX_TERMINALS.find((t) => t.id === terminal);
  if (!def) throw new Error(`Terminal desconhecido: ${terminal}`);
  spawn(def.id, [...def.dir(cwd), ...(runner ? [...def.exec, ...runner] : [])], {
    cwd,
    env: claudeEnv(null),
    stdio: 'ignore',
    detached: true,
  }).unref();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Abre a pasta no gerenciador de arquivos do sistema. */
export function revealFolder(folder: string): void {
  const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(opener, [folder], { stdio: 'ignore', detached: true }).unref();
}

/** Diálogo nativo de seleção de pasta. Retorna null se o usuário cancelar. */
export function pickFolder(): Promise<string | null> {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = 'Escolha a pasta raiz do workspace (a que contém seus repositórios)'",
      '$dialog.ShowNewFolderButton = $false',
      "if ($dialog.ShowDialog($owner) -eq 'OK') { $dialog.SelectedPath }",
    ].join('; ');
    return runPicker('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Escolha a pasta raiz do workspace")']);
  }
  return runPicker('zenity', ['--file-selection', '--directory']);
}

function runPicker(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10 * 60_000 }, (error, stdout) => {
      const picked = stdout?.trim();
      if (picked) return resolve(picked.replace(/\/$/, '') || picked);
      // Cancelar o diálogo também sai com erro no osascript/zenity.
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${command} indisponível`));
      resolve(null);
    });
  });
}
