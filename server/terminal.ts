import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeAccount } from '../shared/types.ts';
import { claudeEnv, requireClaude } from './claude.ts';
import { LINUX_TERMINAL_NAMES, linuxTerminal, preferredTerminal } from './integrations.ts';
import { HttpError, requireFolder } from './model.ts';
import { RUNTIME_DIR } from './paths.ts';
import { baseEnv, describeSpawnError, findProgram, launchDetached, shellQuote, windowsCmd } from './system.ts';

/**
 * No app desktop, process.execPath é o executável do Octo, que só se comporta como Node
 * com ELECTRON_RUN_AS_NODE=1. Na linha de comando é o próprio node.
 */
const IN_ELECTRON = Boolean(process.versions.electron);

// O launcher é copiado para a pasta de dados: dentro do app empacotado ele fica num .asar,
// que só o Octo consegue ler.
mkdirSync(RUNTIME_DIR, { recursive: true });
// Jobs e scripts que ficaram para trás (ex.: a janela fechou antes de o launcher começar)
// guardam prompts: somem depois de um dia.
for (const name of readdirSync(RUNTIME_DIR)) {
  if (!/^(job-.+\.json|octo-.+\.command)$/.test(name)) continue;
  try {
    const file = path.join(RUNTIME_DIR, name);
    if (Date.now() - statSync(file).mtimeMs > 24 * 3600_000) unlinkSync(file);
  } catch {
    /* já removido */
  }
}
const LAUNCHER = path.join(RUNTIME_DIR, 'launcher.mjs');
writeFileSync(LAUNCHER, readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs')));

// No Windows o launcher roda por um .cmd: o cmd.exe só espera um programa de janela (o Octo
// como Node) terminar quando ele é chamado de um script. Os caminhos chegam por variáveis de
// ambiente, que preservam acentos melhor que o texto de um .cmd. O NODE_OPTIONS vazio (ver
// launch()) e o ELECTRON_RUN_AS_NODE valem só até o endlocal: o shell que fica aberto segue com os seus.
const WINDOWS_SCRIPT = path.join(RUNTIME_DIR, 'launch.cmd');
if (process.platform === 'win32') {
  writeFileSync(
    WINDOWS_SCRIPT,
    [
      '@echo off',
      'setlocal',
      'set "ELECTRON_RUN_AS_NODE=1"',
      'set "NODE_OPTIONS="',
      '"%OCTO_NODE%" "%OCTO_LAUNCHER%" "%OCTO_JOB%"',
      'endlocal',
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

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* já removido */
  }
}

/** O terminal escolhido em Preferências (ou o primeiro disponível); falha antes de gravar qualquer coisa. */
function requireTerminal(): string {
  const terminal = preferredTerminal();
  if (terminal) return terminal;
  throw new HttpError(
    400,
    process.platform === 'linux'
      ? `Nenhum terminal encontrado. Procurei: ${LINUX_TERMINAL_NAMES.join(', ')}. Instale um deles ou defina a variável TERMINAL.`
      : 'Nenhum terminal encontrado neste computador.',
  );
}

/**
 * Abre uma janela de terminal nova rodando o Claude Code — o mesmo fluxo de
 * "abrir a pasta, digitar cmd e rodar claude", mas já com a conta e o contexto certos.
 * O terminal é o escolhido em Preferências. Só resolve depois que o terminal abriu de fato.
 */
export async function openClaudeTerminal(request: TerminalRequest): Promise<void> {
  const claude = requireClaude();
  requireFolder(request.cwd);
  const terminal = requireTerminal();
  const env = claudeEnv(request.account);
  const jobFile = path.join(RUNTIME_DIR, `job-${randomUUID()}.json`);
  writeFileSync(
    jobFile,
    JSON.stringify({
      cwd: request.cwd,
      command: claude.command,
      args: [...claude.prefixArgs, ...request.args],
      env: {
        ...(request.account?.configDir ? { CLAUDE_CONFIG_DIR: request.account.configDir } : {}),
        // O launcher roda com o NODE_OPTIONS vazio (ver launch()); o Claude recebe o de sempre. Lido do
        // process.env: no Windows ele acha a variável com qualquer caixa (ex.: node_options), como o Node.
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
      },
      unsetEnv: Object.keys(process.env).filter((key) => !(key in env)),
      banner: request.banner,
    }),
    { mode: 0o600 },
  );
  try {
    await launch(terminal, request.cwd, request.title, jobFile);
  } catch (error) {
    // O job guarda o prompt: não fica esquecido na pasta de dados se o terminal não abriu.
    removeFile(jobFile);
    throw error;
  }
}

/** Abre só o shell na pasta, sem o Claude: para olhar as mudanças, rodar git, testes etc. */
export async function openShell(cwd: string, title: string): Promise<void> {
  requireFolder(cwd);
  await launch(requireTerminal(), cwd, title, null);
}

function launch(terminal: string, cwd: string, rawTitle: string, jobFile: string | null): Promise<void> {
  const title = rawTitle.replace(/["%^&|<>]/g, '').slice(0, 80) || 'Octo';
  if (process.platform === 'win32') return launchWindows(terminal, cwd, title, jobFile);

  // O Terminal do macOS não herda o ambiente do Octo, então a variável vai na própria linha. O
  // NODE_OPTIONS vai vazio: o Node do Electron recusa algumas opções (ex.: --openssl-legacy-provider)
  // e sairia antes de abrir o Claude, que recebe o valor original pelo job.
  const runner = jobFile ? [...(IN_ELECTRON ? ['/usr/bin/env', 'ELECTRON_RUN_AS_NODE=1', 'NODE_OPTIONS='] : []), process.execPath, LAUNCHER, jobFile] : null;
  if (process.platform === 'darwin') return launchMac(terminal, cwd, runner);
  return launchLinux(terminal, cwd, runner);
}

/** O Windows PowerShell (5.1), que vem com o sistema, por caminho absoluto (ver windowsShell). */
function windowsPowerShell(): string {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * O shell escolhido no Windows, por caminho absoluto: com o nome solto, tanto o spawn quanto o
 * `start` procuram primeiro na pasta da sessão, e um cmd.exe dentro do repositório rodaria no
 * lugar do shell.
 */
function windowsShell(terminal: string): string {
  if (terminal === 'powershell') return windowsPowerShell();
  if (terminal !== 'pwsh') return windowsCmd();
  const pwsh = findProgram('pwsh');
  if (!pwsh) throw new HttpError(400, 'O PowerShell 7 não foi encontrado. Escolha outro terminal em Preferências.');
  return pwsh;
}

/**
 * Comando que o `start` executa no Windows: o shell por caminho absoluto, entre aspas (o título vem
 * antes, como o primeiro argumento entre aspas do `start`). Para o cmd, o caminho do launch.cmd fica
 * fora das aspas do cmd externo: & ^ | < > ( ) são escapados com ^ (ex.: um perfil "R&D"). No
 * PowerShell, o caminho nem passa pela linha de comando: o cmd interno recebe ""%OCTO_SCRIPT%"" e
 * expande a variável já dentro das aspas. Aspas e % são montados com [char] para o cmd externo não
 * os interpretar (e sem -EncodedCommand, que antivírus costumam tratar como suspeito).
 */
export function windowsStartCommand(terminal: string, script: string | null): string {
  const shell = `"${windowsShell(terminal)}"`;
  if (terminal === 'powershell' || terminal === 'pwsh') {
    if (!script) return `${shell} -NoExit -NoLogo`;
    const quoted = "([char]34 + [char]34 + [char]37 + 'OCTO_SCRIPT' + [char]37 + [char]34 + [char]34)";
    return `${shell} -NoExit -NoLogo -Command "& $env:ComSpec /d /s /c ${quoted}; Remove-Item Env:OCTO_* -ErrorAction SilentlyContinue"`;
  }
  return script ? `${shell} /k ""${script.replace(/[\^&|<>()]/g, '^$&')}""` : `${shell} /k`;
}

/**
 * `start` abre uma janela nova no app de terminal padrão do Windows (Windows Terminal ou o
 * console clássico); o shell (cmd, PowerShell) fica aberto na pasta quando o Claude termina.
 */
async function launchWindows(terminal: string, cwd: string, title: string, jobFile: string | null): Promise<void> {
  const env = jobFile
    ? { ...claudeEnv(null), OCTO_SCRIPT: WINDOWS_SCRIPT, OCTO_NODE: process.execPath, OCTO_LAUNCHER: LAUNCHER, OCTO_JOB: jobFile }
    : claudeEnv(null);
  // O cmd sai logo depois do `start`: um código ≠ 0 nesse intervalo é o `start` sem achar o programa.
  await launchDetached(windowsCmd(), ['/d', '/s', '/c', `start "${title}" ${windowsStartCommand(terminal, jobFile ? WINDOWS_SCRIPT : null)}`], {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true,
    settle: 5000,
  }).catch((error: unknown) => {
    // Sem `code`, foi o `start` que saiu com erro (ex.: o pwsh.exe foi desinstalado).
    const startFailed = !(error as NodeJS.ErrnoException).code;
    throw new HttpError(
      500,
      startFailed
        ? `O Windows não conseguiu abrir o terminal escolhido (${terminal}). Escolha outro em Preferências.`
        : describeSpawnError(error, 'Não foi possível abrir o terminal'),
    );
  });
}

/**
 * Script .command que o Terminal do macOS executa: entra na pasta, roda o Claude e deixa um
 * shell aberto ali quando ele termina. Ele se apaga ao começar (o prompt fica no job, à parte).
 */
export function macCommandScript(cwd: string, runner: string[]): string {
  return ['#!/bin/sh', 'rm -f "$0"', `cd ${shellQuote(cwd)} && ${runner.map(shellQuote).join(' ')}`, 'exec "${SHELL:-/bin/zsh}" -l', ''].join('\n');
}

async function launchMac(terminal: string, cwd: string, runner: string[] | null): Promise<void> {
  if (terminal === 'iterm') {
    const command = [`cd ${shellQuote(cwd)}`, ...(runner ? [runner.map(shellQuote).join(' ')] : [])].join(' && ');
    // Dentro de uma string AppleScript, \ e " precisam de escape (o shellQuote pode gerar '\'').
    const text = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await runAppleScript(
      ['tell application "iTerm"', 'activate', 'set newWindow to (create window with default profile)', `tell current session of newWindow to write text "${text}"`, 'end tell'],
      'iTerm2',
    );
    return;
  }
  // Terminal.app: abrir um arquivo pelo `open` passa pelo LaunchServices e não depende da
  // permissão de Automação (que o AppleScript exigiria e que pode ser negada em silêncio).
  if (!runner) return openOnMac(['-a', 'Terminal', cwd], 'o Terminal');
  const script = path.join(RUNTIME_DIR, `octo-${randomUUID()}.command`);
  writeFileSync(script, macCommandScript(cwd, runner), { mode: 0o700 });
  chmodSync(script, 0o700);
  try {
    await openOnMac(['-a', 'Terminal', script], 'o Terminal');
  } catch (error) {
    removeFile(script);
    throw error;
  }
}

function openOnMac(args: string[], what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', args, { env: baseEnv(), timeout: 30_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const said = String(stderr ?? '').trim().split('\n')[0];
      reject(new HttpError(500, `Não foi possível abrir ${what}${said ? `: ${said}` : '.'}`));
    });
  });
}

/** Roda um AppleScript e traduz a recusa da permissão de Automação (-1743) numa orientação. */
function runAppleScript(lines: string[], app: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // O macOS pode mostrar o pedido de permissão na primeira vez: espera a resposta da pessoa.
    execFile('osascript', lines.flatMap((line) => ['-e', line]), { env: baseEnv(), timeout: 120_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const said = String(stderr ?? '');
      if (/-1743|not authori[sz]ed/i.test(said)) {
        reject(
          new HttpError(
            400,
            `O macOS não deixou o Octo controlar o ${app}. Libere em Ajustes do Sistema › Privacidade e Segurança › Automação (ative o ${app} dentro de Octo) e tente de novo.`,
          ),
        );
        return;
      }
      reject(new HttpError(500, `Não foi possível abrir o ${app}: ${said.trim().split('\n')[0] || error.message}`));
    });
  });
}

/**
 * Argumentos do terminal do Linux. O Claude roda dentro de um `sh` que, quando ele termina,
 * abre o shell da pessoa na pasta (como o /k do cmd): a janela não fecha nem esconde um erro.
 */
export function linuxTerminalArgs(def: { dir: (dir: string) => string[]; exec: (command: string[]) => string[] }, cwd: string, runner: string[] | null): string[] {
  if (!runner) return def.dir(cwd);
  const keepOpen = ['/bin/sh', '-c', 'cd "$1" 2>/dev/null; shift; "$@"; exec "${SHELL:-/bin/sh}"', 'octo', cwd, ...runner];
  return [...def.dir(cwd), ...def.exec(keepOpen)];
}

async function launchLinux(terminal: string, cwd: string, runner: string[] | null): Promise<void> {
  const def = linuxTerminal(terminal);
  if (!def) throw new HttpError(400, `O terminal "${terminal}" não foi encontrado. Escolha outro em Preferências.`);
  // Um terminal que recusa os argumentos sai logo com erro; os que continuam abertos passam do intervalo.
  await launchDetached(def.command, linuxTerminalArgs(def, cwd, runner), { cwd, env: claudeEnv(null), detached: true, settle: 1500 }).catch(
    (error: unknown) => {
      throw new HttpError(500, `${describeSpawnError(error, `Não foi possível abrir o ${def.label}`)} Escolha outro terminal em Preferências.`);
    },
  );
}

/** Abre a pasta no gerenciador de arquivos do sistema. */
export async function revealFolder(folder: string): Promise<void> {
  requireFolder(folder);
  if (process.platform === 'win32') {
    // O explorer.exe sai com código 1 mesmo quando abre a pasta: aqui só conta se ele iniciou.
    // Por caminho absoluto: o nome solto seria procurado antes na pasta atual do Octo.
    const explorer = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    await launchDetached(explorer, [folder], { detached: true }).catch((error: unknown) => {
      throw new HttpError(500, describeSpawnError(error, 'Não foi possível abrir o Explorador de Arquivos'));
    });
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  await launchDetached(opener, [folder], { detached: true, env: baseEnv(), settle: 3000 }).catch((error: unknown) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' && opener === 'xdg-open';
    throw new HttpError(
      500,
      missing
        ? 'Não foi possível abrir o gerenciador de arquivos: o xdg-open não está instalado (pacote xdg-utils).'
        : describeSpawnError(error, 'Não foi possível abrir o gerenciador de arquivos'),
    );
  });
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
    return runPicker(windowsPowerShell(), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  }
  if (process.platform === 'darwin') {
    return runPicker('osascript', ['-e', 'POSIX path of (choose folder with prompt "Escolha a pasta raiz do workspace")']);
  }
  return runPicker('zenity', ['--file-selection', '--directory']);
}

function runPicker(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout: 10 * 60_000, env: baseEnv() }, (error, stdout) => {
      const picked = stdout?.trim();
      if (picked) return resolve(picked.replace(/\/$/, '') || picked);
      // Cancelar o diálogo também sai com erro no osascript/zenity.
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new HttpError(400, `O seletor de pastas (${path.basename(command)}) não está instalado. Digite ou cole o caminho da pasta.`));
      }
      resolve(null);
    });
  });
}
