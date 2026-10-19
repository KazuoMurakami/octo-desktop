// Integração de baixo nível com o sistema: achar programas no PATH, montar o ambiente dos
// processos filhos, abrir programas destacados (terminal, editor, explorador) e copiar pastas.
// Sem dependências do resto do servidor: é usado por claude.ts, terminal.ts, integrations.ts, index.ts,
// agent.ts e store.ts (cutPoint, shrinkToFit) e gitSafe.ts.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, type Stats } from 'node:fs';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!WINDOWS) accessSync(file, constants.X_OK);
    return true;
  } catch (error) {
    // Alias de execução de app da Microsoft Store (em WindowsApps, como o pwsh.exe do PowerShell 7
    // instalado pela Store): o stat não abre esse tipo de link e falha com EACCES, mas o programa existe.
    return WINDOWS && (error as NodeJS.ErrnoException).code === 'EACCES' && isLink(file);
  }
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** No Windows o nome vem sem extensão (claude → claude.exe, claude.cmd…), na ordem do PATHEXT. */
function pathExtensions(command: string): string[] {
  if (!WINDOWS || path.extname(command)) return [''];
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim().toLowerCase()).filter(Boolean);
}

/**
 * Todos os caminhos de um comando no PATH, na ordem em que o shell os acharia. A busca é feita
 * aqui, e não com `where`/`which`: o `where` escreve na página de código do console (acentos viram
 * "�" e o caminho deixa de existir) e o `which` nem sempre vem instalado no Linux.
 */
export function findAllOnPath(command: string, extensions = pathExtensions(command)): string[] {
  if (path.isAbsolute(command)) return isExecutableFile(command) ? [command] : [];
  const dirs = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    // Entradas relativas dependeriam da pasta atual do processo.
    .filter((dir) => dir && path.isAbsolute(dir));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const extension of extensions) {
      const file = path.join(dir, command + extension);
      const key = WINDOWS ? file.toLowerCase() : file;
      if (seen.has(key) || !isExecutableFile(file)) continue;
      seen.add(key);
      found.push(file);
    }
  }
  return found;
}

/** Mesmo caminho? No Windows e no macOS o sistema de arquivos costuma ignorar maiúsculas. */
export function samePath(a: string, b: string): boolean {
  const normal = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  return normal(a) === normal(b);
}

/** Primeiro caminho de um comando no PATH, ou null. */
export function findOnPath(command: string): string | null {
  return findAllOnPath(command)[0] ?? null;
}

/**
 * Caminho absoluto de um programa, para o spawn sem shell. Um nome solto não serve quando a pasta
 * do processo filho é conteúdo do usuário: no Windows o spawn procura primeiro nessa pasta, e um
 * git.exe dentro de um repositório rodaria no lugar do Git. No Windows só valem .com e .exe, como
 * no próprio spawn (um .cmd ou .bat exige shell: o spawn lança EINVAL).
 */
export function findProgram(command: string): string | null {
  const extensions = WINDOWS && !path.extname(command) ? ['.com', '.exe'] : undefined;
  return findAllOnPath(command, extensions).find((file) => !WINDOWS || /\.(exe|com)$/i.test(file)) ?? null;
}

let git: string | null = null;

/**
 * O git do PATH, por caminho absoluto (ver findProgram). Procurado no primeiro uso, não ao carregar
 * o módulo: o app desktop completa o PATH antes. Sem git, lança um erro ENOENT (o mesmo do spawn
 * que não acha o programa) e nada fica guardado: a próxima chamada procura de novo, e um git
 * instalado depois é achado.
 */
export function gitPath(): string {
  if (!git || !existsSync(git)) git = findProgram('git');
  if (git) return git;
  throw Object.assign(new Error('git não encontrado no PATH'), { code: 'ENOENT' });
}

/** O cmd.exe por caminho absoluto (ver findProgram): o do ComSpec, se for um caminho completo que existe. */
export function windowsCmd(): string {
  const comspec = process.env.ComSpec;
  if (comspec && path.isAbsolute(comspec) && existsSync(comspec)) return comspec;
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
}

/** Listas de caminhos em que o AppImage põe pastas de dentro do próprio app. */
const APPIMAGE_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR'];

/**
 * Ambiente para programas abertos pelo Octo (git, Claude Code, terminal, editor). Dentro de um
 * AppImage, tira o que aponta para o app montado em /tmp: bibliotecas do Octo no LD_LIBRARY_PATH
 * quebrariam os programas do usuário, e o ARGV0 muda o nome dos comandos no zsh.
 */
export function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.APPIMAGE) {
    const appDir = process.env.APPDIR;
    for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[key];
    if (appDir) {
      for (const key of APPIMAGE_LISTS) {
        const value = env[key];
        if (value === undefined) continue;
        const kept = value.split(':').filter((entry) => entry && !entry.startsWith(appDir));
        if (kept.length) env[key] = kept.join(':');
        else delete env[key];
      }
    }
  }
  return env;
}

export interface LaunchOptions extends SpawnOptions {
  /**
   * Espera até este tempo (ms) e falha se o programa sair com código diferente de 0 nesse
   * intervalo: pega um terminal que recusou os argumentos ou um `start` que não achou o programa.
   */
  settle?: number;
}

/**
 * Abre um programa que segue a vida sozinho (terminal, editor, explorador de arquivos).
 * Resolve quando ele de fato iniciou e rejeita se não iniciou: sem o listener de 'error', um
 * executável ausente ou uma pasta que sumiu derrubariam o servidor inteiro.
 */
export function launchDetached(command: string, args: string[], options: LaunchOptions = {}): Promise<void> {
  const { settle = 0, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { stdio: 'ignore', ...spawnOptions });
    } catch (error) {
      reject(error);
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('spawn', () => {
      child.unref();
      if (!settle) return resolve();
      timer = setTimeout(resolve, settle);
      child.once('exit', (code) => {
        if (timer) clearTimeout(timer);
        if (code) reject(new Error(`${path.basename(command)} saiu com o código ${code}.`));
        else resolve();
      });
    });
  });
}

/** Um argumento entre aspas simples para o sh (cada aspa simples interna vira '\''). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Mensagem clara para uma falha ao iniciar um programa (em vez de "spawn ENOENT"). */
export function describeSpawnError(error: unknown, what: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOENT':
      return `${what}: o programa ou a pasta não foi encontrado.`;
    case 'EACCES':
    case 'EPERM':
      return `${what}: sem permissão para executar o programa.`;
    case 'ENAMETOOLONG':
    case 'E2BIG':
      return `${what}: a linha de comando ficou longa demais para o sistema.`;
    case 'EINVAL':
      return `${what}: o executável não é válido (no Windows, use o .exe, não um .cmd).`;
    default:
      return `${what}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Copia uma pasta (ou um arquivo) recursivamente, arquivo a arquivo. O fs.cpSync do Node 24
 * anterior ao 24.21 derruba o processo ou não copia nada com caminhos acentuados no Windows.
 * `parents`: pastas (caminho real) sendo copiadas acima desta, para um link não virar um laço.
 */
export function copyTree(from: string, to: string, parents = new Set<string>()): void {
  if (!statSync(from).isDirectory()) {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    return;
  }
  const real = realpathSync(from);
  if (parents.has(real)) return;
  parents.add(real);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, parents);
    else if (entry.isFile()) copyFileSync(source, target);
    else if (entry.isSymbolicLink()) copyLink(source, target, parents);
  }
  parents.delete(real);
}

/**
 * Link para arquivo vira cópia do arquivo. Link para pasta (ex.: skills instaladas pelo `npx skills`,
 * que apontam para uma cópia compartilhada) é recriado apontando para o mesmo lugar, como junction
 * no Windows (não exige permissão de administrador); se o sistema não deixar criar o link (ex.: um
 * disco FAT), a pasta é copiada. Link quebrado fica de fora. No Windows o readdir também chama de
 * link o que só está na nuvem do OneDrive, sem ser link: essas pastas são copiadas.
 */
function copyLink(source: string, target: string, parents: Set<string>): void {
  let info: Stats;
  try {
    info = statSync(source);
  } catch {
    return; // link quebrado
  }
  if (!info.isDirectory()) {
    if (info.isFile()) copyFileSync(source, target);
    return;
  }
  if (isLink(source)) {
    try {
      symlinkSync(realpathSync(source), target, WINDOWS ? 'junction' : 'dir');
      return;
    } catch {
      /* sem link: copia a pasta */
    }
  }
  copyTree(source, target, parents);
}

// ---------------------------------------------------------------- limite da linha de comando

/** O Windows aceita até 32.767 caracteres na linha de comando inteira; fica uma folga. */
const WINDOWS_COMMAND_LINE = 32_000;
/** Linux: até 128 KiB por argumento; macOS: ~1 MiB somando tudo (inclusive o ambiente). */
const POSIX_ARG = 100_000;
const POSIX_TOTAL = 600_000;

/** Tamanho de um argumento depois das aspas e escapes que o Node (libuv) aplica no Windows. */
function windowsArgLength(arg: string): number {
  if (!arg) return 2;
  if (!/[\s"]/.test(arg)) return arg.length;
  let extra = 2;
  for (const char of arg) if (char === '"' || char === '\\') extra++;
  return arg.length + extra;
}

/** O comando cabe no limite do sistema? Acima dele o spawn falha (ENAMETOOLONG/E2BIG). */
export function fitsCommandLine(command: string, args: string[]): boolean {
  if (WINDOWS) return [command, ...args].reduce((sum, arg) => sum + windowsArgLength(arg) + 1, 0) <= WINDOWS_COMMAND_LINE;
  let total = 0;
  for (const arg of [command, ...args]) {
    const bytes = Buffer.byteLength(arg);
    if (bytes > POSIX_ARG) return false;
    total += bytes + 1;
  }
  return total <= POSIX_TOTAL;
}

/**
 * Onde cortar `text` para ficar com até `end` unidades sem separar um par substituto (emoji e outros
 * caracteres fora do plano básico): metade de um par viraria "�" no processo filho.
 */
export function cutPoint(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return end > 0 && end < text.length && code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Corta `text` pelo fim (acrescentando `notice`) até `build(text)` caber na linha de comando.
 * Devolve null se nem com `minLength` caracteres couber.
 */
export function shrinkToFit(command: string, build: (text: string) => string[], text: string, notice: string, minLength = 0): string | null {
  if (fitsCommandLine(command, build(text))) return text;
  let low = cutPoint(text, Math.min(minLength, text.length));
  if (!fitsCommandLine(command, build(text.slice(0, low) + notice))) return null;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fitsCommandLine(command, build(text.slice(0, middle) + notice))) low = middle;
    else high = middle - 1;
  }
  // Um corte um pouco mais curto sempre cabe.
  return text.slice(0, cutPoint(text, low)) + notice;
}
