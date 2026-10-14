// Processo principal do app desktop: sobe o servidor do Octo dentro do próprio app e abre a interface numa janela.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { apiToken, findRunningServer } from '../server/instance.ts';

type Server = typeof import('../server/app.ts');

const PREFERRED_PORT = 4317;

let server: Server | null = null;
let window: BrowserWindow | null = null;
let appUrl = '';
let quitting = false;

/**
 * Apps abertos pelo Finder (macOS) ou pelo menu (Linux) não herdam o PATH do seu shell,
 * e é nele que estão o `claude`, o `git` e o `node` instalados por Homebrew, nvm etc.
 */
function loadShellPath(): void {
  if (process.platform === 'win32') return;
  const extra = [path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  try {
    const shellBin = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    const output = execFileSync(shellBin, ['-ilc', 'printf "__OCTO_PATH__%s__OCTO_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const shellPath = /__OCTO_PATH__(.*)__OCTO_PATH__/.exec(output)?.[1];
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    /* sem shell utilizável: fica com o PATH do sistema */
  }
  const current = (process.env.PATH ?? '').split(path.delimiter);
  process.env.PATH = [...current, ...extra.filter((dir) => !current.includes(dir))].join(path.delimiter);
}

/** Primeira sugestão de pasta raiz no onboarding: onde as pessoas costumam guardar projetos. */
function guessProjectsRoot(): string {
  const home = homedir();
  const candidates = ['Projects', 'projects', 'Developer', 'dev', 'code', 'Code', 'repos', 'src', 'workspace', 'Documents/GitHub', 'source/repos'];
  return candidates.map((dir) => path.join(home, dir)).find((dir) => existsSync(dir)) ?? home;
}

async function pickFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Escolha a pasta raiz do workspace',
    buttonLabel: 'Usar esta pasta',
    properties: ['openDirectory'],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function startBackend(): Promise<string> {
  // Outro Octo (ex.: `npm start`) já usa esta pasta de dados: a janela se conecta a ele.
  const running = await findRunningServer();
  if (running) return running;
  loadShellPath();
  // Importado só depois de ajustar o PATH: o módulo procura o `claude` ao carregar.
  server = await import('../server/app.ts');
  const { url } = await server.startServer({
    port: PREFERRED_PORT,
    anyPortIfBusy: true,
    suggestedRoot: guessProjectsRoot(),
    pickFolder,
  });
  console.log(server.describeServer(url));
  return url;
}

function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** Confirma antes de interromper agentes que ainda estão trabalhando em segundo plano. */
function confirmQuit(): boolean {
  const running = server?.runningSessionCount() ?? 0;
  if (!running) return true;
  const options: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Sair e interromper', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    message: running === 1 ? 'Um agente ainda está trabalhando.' : `${running} agentes ainda estão trabalhando.`,
    detail: 'Sair do Octo interrompe as sessões em segundo plano. As sessões abertas no terminal continuam.',
  };
  const choice = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
  return choice === 0;
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 880,
    minHeight: 560,
    title: 'Octo',
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  window.once('ready-to-show', () => window?.show());

  // Links das respostas do agente abrem no navegador, nunca dentro do app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === new URL(appUrl).origin) return;
    event.preventDefault();
    openExternal(url);
  });

  window.on('close', (event) => {
    // No macOS fechar a janela não encerra o app (os agentes seguem); a confirmação fica para o Cmd+Q.
    if (process.platform === 'darwin' || quitting) return;
    if (!confirmQuit()) event.preventDefault();
    else quitting = true;
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(`${appUrl}/?token=${apiToken()}`);
}

/**
 * `--self-test`: sobe o servidor como o app faria, confere a API (com e sem o token) e a
 * interface empacotada, e sai com código 0 ou 1. O CI roda isto em cada instalador.
 */
async function selfTest(): Promise<void> {
  const timer = setTimeout(() => failSelfTest(new Error('tempo esgotado')), 60_000);
  const url = await startBackend();
  const expect = (condition: unknown, what: string) => {
    if (!condition) throw new Error(`falhou: ${what}`);
  };
  const health = (await (await fetch(`${url}/api/health`)).json()) as { app?: string };
  expect(health.app === 'octo', 'health check');
  expect((await fetch(`${url}/api/state`)).status === 401, 'a API recusa quem não tem o token');
  expect((await fetch(`${url}/api/state`, { headers: { 'x-octo-token': apiToken() } })).ok, 'a API aceita o token');
  const html = await (await fetch(`${url}/`)).text();
  const bundle = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(bundle, 'index.html da interface');
  expect((await fetch(`${url}${bundle}`)).ok, 'bundle da interface');
  clearTimeout(timer);
  console.log(`[octo] autoteste ok · ${process.platform}-${process.arch} · Electron ${process.versions.electron}`);
  server?.shutdown();
  app.exit(0);
}

function failSelfTest(error: unknown): void {
  console.error('[octo] autoteste falhou:', error);
  app.exit(1);
}

if (process.argv.includes('--self-test')) {
  app.whenReady().then(selfTest).catch(failSelfTest);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Octo');
  if (process.platform === 'win32') app.setAppUserModelId('dev.octo.app');

  app.on('second-instance', () => {
    if (!appUrl) return;
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!confirmQuit()) return event.preventDefault();
    quitting = true;
  });

  app.on('will-quit', () => server?.shutdown());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (!window && appUrl) createWindow();
  });

  app
    .whenReady()
    .then(startBackend)
    .then((url) => {
      appUrl = url;
      createWindow();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox('Não foi possível iniciar o Octo', error instanceof Error ? (error.stack ?? error.message) : String(error));
      app.exit(1);
    });
}
