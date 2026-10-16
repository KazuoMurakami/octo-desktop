// Processo principal do app desktop: sobe o servidor do Octo dentro do próprio app e abre a interface numa janela.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, Menu, powerMonitor, session, shell } from 'electron';
import { apiToken, findRunningServer } from '../server/instance.ts';
import { DATA_DIR } from '../server/paths.ts';

type Server = typeof import('../server/app.ts');
type Store = typeof import('../server/store.ts');

const PREFERRED_PORT = 4317;
/** O mesmo appId do electron-builder.yml: no Windows liga a janela ao atalho (barra de tarefas e notificações). */
const APP_ID = 'io.github.kazuomurakami.octo';
const REPO_URL = 'https://github.com/KazuoMurakami/octo-desktop';
/** Fundo da janela enquanto a interface carrega (o mesmo --bg da interface). */
const BACKGROUND = '#0b0b0d';
const SELF_TEST = process.argv.includes('--self-test');
/** DevTools só no desenvolvimento, ou no app instalado aberto com OCTO_DEVTOOLS=1 para investigar um problema. */
const DEVTOOLS = !app.isPackaged || process.env.OCTO_DEVTOOLS === '1';

let server: Server | null = null;
/** O banco do servidor deste processo: null antes de ele subir, ou quando a janela usa outro Octo. */
let store: Store | null = null;
let window: BrowserWindow | null = null;
let appUrl = '';
let quitting = false;
/** A primeira janela já foi criada: a partir daí, reabrir o app (Dock, segunda instância) cria outra se preciso. */
let started = false;

// ---------------------------------------------------------------- ambiente do shell

/**
 * Variáveis do shell que não são copiadas: as do próprio shell, as do Electron e a pasta de dados
 * (já definida quando o app abriu). Um CLAUDE_CONFIG_DIR exportado no shell é copiado de propósito:
 * as sessões trocam pelo da conta escolhida, e o terminal o desfaz na conta Principal, que fica
 * sempre no ~/.claude.
 */
const SHELL_ENV_SKIP = /^(PWD|OLDPWD|SHLVL|_|ELECTRON_\w*|OCTO_SHELL_ENV_\w*|OCTO_DATA_DIR)$/;
const SHELL_ENV_TIMEOUT = 10_000;

/**
 * Apps abertos pelo Finder (macOS) ou pelo menu (Linux) não recebem o ambiente do seu shell: ficam
 * sem o PATH (onde estão o `claude`, o `git` e o `node` do Homebrew, nvm etc.) e sem as variáveis
 * que o Claude Code e os comandos do agente usam (chave de API, Bedrock/Vertex, proxy,
 * certificados, AWS_PROFILE, JAVA_HOME…). Como o VS Code, o Octo copia o ambiente de um shell de
 * login, para que as sessões em segundo plano rodem como no seu terminal.
 * Devolve quantas variáveis vieram do shell.
 */
async function loadShellEnv(): Promise<number> {
  if (process.platform === 'win32') return 0;
  let imported = 0;
  const mark = randomUUID().replaceAll('-', '');
  const shellBin = process.env.SHELL || accountShell() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const result = await runLoginShell(shellBin, shellEnvCommand(shellBin, mark), {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OCTO_SHELL_ENV_NODE: process.execPath,
    });
    const json = result.output.split(mark)[1];
    if (!json) throw new Error(`o shell terminou (${result.exit}) sem devolver o ambiente${result.error ? `: ${result.error}` : ''}`);
    const shellEnv = JSON.parse(json) as Record<string, unknown>;
    // O NODE_OPTIONS do JSON é o vazio que o comando pôs; o do shell veio à parte.
    const nodeOptions = shellEnv.OCTO_SHELL_ENV_NODE_OPTIONS;
    delete shellEnv.NODE_OPTIONS;
    if (typeof nodeOptions === 'string' && nodeOptions) shellEnv.NODE_OPTIONS = nodeOptions;
    for (const [key, value] of Object.entries(shellEnv)) {
      if (typeof value !== 'string' || SHELL_ENV_SKIP.test(key) || process.env[key] === value) continue;
      process.env[key] = value;
      imported++;
    }
  } catch (error) {
    // Shell lento ou quebrado: fica com o ambiente que o sistema deu ao app, e o motivo vai para o log.
    console.warn(`[octo] o ambiente do shell (${shellBin}) não foi carregado: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Onde os instaladores costumam pôr o `claude`, mesmo que o shell não diga.
  const extra = [path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [...current, ...extra.filter((dir) => !current.includes(dir))].join(path.delimiter);
  return imported;
}

/** O shell cadastrado para o seu usuário no sistema (quando o app não recebeu $SHELL). */
function accountShell(): string | null {
  try {
    return userInfo().shell;
  } catch {
    return null;
  }
}

/**
 * O comando que imprime o ambiente: o próprio executável do Octo, rodando como Node, imprime o JSON
 * entre marcas (o que os arquivos de inicialização do shell escreverem na tela fica de fora).
 * Ele roda com o NODE_OPTIONS vazio: uma opção que o Node do Electron recusa (como
 * --openssl-legacy-provider) faria ele sair sem imprimir nada. O valor do shell vem à parte, em
 * OCTO_SHELL_ENV_NODE_OPTIONS, lido do jeito de cada shell: no csh e no tcsh uma variável que não
 * existe é erro, e o fish não aceita ${VAR-}.
 */
function shellEnvCommand(shellBin: string, mark: string): string {
  const name = path.basename(shellBin);
  const nodeOptions = /^t?csh$/.test(name) ? '"`printenv NODE_OPTIONS`"' : name === 'fish' ? '"$NODE_OPTIONS"' : '"${NODE_OPTIONS-}"';
  return `/usr/bin/env OCTO_SHELL_ENV_NODE_OPTIONS=${nodeOptions} NODE_OPTIONS= "$OCTO_SHELL_ENV_NODE" -p '"${mark}" + JSON.stringify(process.env) + "${mark}"'`;
}

interface ShellResult {
  output: string;
  /** Como o shell terminou ("código 0", "sinal SIGSEGV"). */
  exit: string;
  /** A última linha que ele escreveu no stderr, para explicar uma falha no log. */
  error: string;
}

function runLoginShell(shellBin: string, command: string, env: NodeJS.ProcessEnv): Promise<ShellResult> {
  // Shell interativo de login, para ler os mesmos arquivos que o seu terminal lê (csh e tcsh não aceitam -l junto).
  const args = /^t?csh$/.test(path.basename(shellBin)) ? ['-ic', command] : ['-i', '-l', '-c', command];
  return new Promise((resolve, reject) => {
    // Grupo de processos próprio (detached): se o shell travar, encerra ele e o que ele abriu.
    const child = spawn(shellBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let errors = '';
    let exit: string | null = null;
    let drained = false;
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* já terminou */
      }
      reject(new Error('o shell demorou demais para responder'));
    }, SHELL_ENV_TIMEOUT);
    // Pronto quando o shell sai e a saída dele termina. O stderr fica fora dessa conta (e continua
    // sendo lido): algo que o shell deixou rodando em segundo plano pode seguir com ele aberto.
    const finish = () => {
      if (exit === null || !drained) return;
      clearTimeout(timer);
      resolve({ output, exit, error: lastErrorLine(errors) });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stdout.once('close', () => {
      drained = true;
      finish();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-4000);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exit = code === null ? `sinal ${signal}` : `código ${code}`;
      finish();
    });
  });
}

/** A última linha do stderr, sem os avisos de controle de jobs que o bash e o tcsh dão quando não há terminal. */
function lastErrorLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim());
  return lines.filter((line) => line && !/job control|terminal process group|access to tty/i.test(line)).pop() ?? '';
}

// ---------------------------------------------------------------- servidor

/**
 * Sugestão de pasta raiz no primeiro uso: só pastas comuns de projetos que existam. Sem nenhuma,
 * não sugere nada (null): a tela inicial fica com o campo vazio e o botão "Escolher…", em vez de
 * varrer a home inteira. No macOS não olha dentro de Documentos, Mesa nem Transferências: só
 * consultar essas pastas já faz o sistema pedir permissão.
 */
function guessProjectsRoot(): string | null {
  const home = homedir();
  const candidates = ['Projects', 'projects', 'Developer', 'dev', 'code', 'Code', 'src', 'repos', 'git', 'GitHub', 'workspace'].map((dir) =>
    path.join(home, dir),
  );
  if (process.platform === 'win32') {
    // Padrões do Visual Studio e do GitHub Desktop (a pasta Documentos pode estar no OneDrive).
    candidates.push(path.join(home, 'source', 'repos'));
    try {
      candidates.push(path.join(app.getPath('documents'), 'GitHub'));
    } catch {
      /* sem pasta Documentos */
    }
  }
  return candidates.find((dir) => existsSync(dir)) ?? null;
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

let shellVariables = 0;

async function startBackend(): Promise<string> {
  // Outro Octo (ex.: `npm start`) já usa esta pasta de dados: a janela se conecta a ele.
  const running = await findRunningServer();
  if (running) return running;
  shellVariables = await loadShellEnv();
  // Importado só depois de ajustar o ambiente: o módulo procura o `claude` ao carregar.
  server = await import('../server/app.ts');
  const { url } = await server.startServer({
    port: PREFERRED_PORT,
    anyPortIfBusy: true,
    suggestedRoot: guessProjectsRoot(),
    pickFolder,
  });
  // Só com o servidor no ar a pasta de dados é deste processo: a partir daqui o desligamento grava o banco.
  store = await import('../server/store.ts'); // já carregado pelo app.ts
  console.log(server.describeServer(url));
  return url;
}

/**
 * Grava o banco na hora quando o sistema encerra o app: no logoff e no desligamento do Windows o
 * Electron não emite o will-quit, e no desligamento do macOS e do Linux ele pode não chegar.
 * Antes de o servidor subir neste processo, não há o que gravar.
 */
function flushOnSystemExit(): void {
  store?.flush();
}

// ---------------------------------------------------------------- janela

function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** A URL é da própria interface do Octo (o servidor local que este app abriu)? */
function isAppOrigin(url: string | undefined): boolean {
  if (!url || !appUrl) return false;
  try {
    return new URL(url).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
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

/** Tela mostrada enquanto o servidor sobe (o mesmo visual da tela de carregamento da interface). */
function splashUrl(): string {
  let mark = '';
  try {
    const png = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'splash-mark.png')).toString('base64');
    mark = `<img src="data:image/png;base64,${png}" alt="">`;
  } catch {
    /* sem a imagem, fica só o texto */
  }
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Octo</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
html, body { height: 100%; margin: 0; }
body { background: ${BACKGROUND}; color: #6c6c78; font: 13.5px/1.45 system-ui, sans-serif; display: grid; place-content: center; justify-items: center; gap: 14px; user-select: none; cursor: default; }
img { width: 72px; height: 72px; border-radius: 18px; mix-blend-mode: lighten; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) { img { animation: none; } }
</style></head><body>${mark}<span>Iniciando o Octo…</span></body></html>`;
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}

function interfaceUrl(): string {
  return `${appUrl}/?token=${apiToken()}`;
}

/** Abre a janela já com a interface ou, se o servidor ainda está subindo, com a tela de carregamento. */
function createWindow(): void {
  const created = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 880,
    minHeight: 560,
    title: 'Octo',
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  window = created;
  created.once('ready-to-show', () => created.show());

  // Links das respostas do agente abrem no navegador, nunca dentro do app.
  created.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  created.on('close', (event) => {
    // No macOS fechar a janela não encerra o app (os agentes seguem); a confirmação fica para o Cmd+Q.
    if (process.platform === 'darwin' || quitting) return;
    if (!confirmQuit()) event.preventDefault();
    else quitting = true;
  });
  created.on('closed', () => {
    if (window === created) window = null;
  });
  created.on('session-end', flushOnSystemExit);
  void created.loadURL(appUrl ? interfaceUrl() : splashUrl());
}

/** O servidor subiu: troca a tela de carregamento pela interface (ou abre a janela, se foi fechada). */
function showInterface(): void {
  if (quitting) return;
  if (!window || window.isDestroyed()) return createWindow();
  void window.loadURL(interfaceUrl());
}

// ---------------------------------------------------------------- permissões

/**
 * Liberadas só para a própria interface: avisos de agentes, os botões de copiar e a leitura da área
 * de transferência, que o Alt+V usa para anexar a imagem copiada mesmo com texto junto.
 */
const ALLOWED_PERMISSIONS = new Set<string>(['notifications', 'clipboard-sanitized-write', 'clipboard-read']);

/**
 * Sem um handler, o Electron aprova sozinho pedidos de câmera, microfone, localização etc. A janela
 * só mostra a interface local, então todo o resto é negado (defesa extra caso algum conteúdo de
 * fora consiga carregar nela).
 */
function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(requestingOrigin));
  ses.setDevicePermissionHandler(() => false);
}

// ---------------------------------------------------------------- menu

function systemSummary(): string {
  const system = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return `${system} ${process.getSystemVersion()} (${process.arch}) · Electron ${process.versions.electron}`;
}

function diagnostics(): string {
  return [`Octo ${app.getVersion()}`, systemSummary(), `Chromium ${process.versions.chrome} · Node ${process.versions.node}`].join('\n');
}

/** Nova issue no GitHub com o modelo de bug e a versão e o sistema já preenchidos. */
function reportProblemUrl(): string {
  const query = new URLSearchParams({ template: 'bug_report.yml', version: app.getVersion(), system: systemSummary() });
  return `${REPO_URL}/issues/new?${query}`;
}

async function showAbout(): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: 'Sobre o Octo',
    message: `Octo ${app.getVersion()}`,
    detail: `${diagnostics()}\n\nCódigo aberto sob a licença MIT.\n${REPO_URL}`,
    buttons: ['Fechar', 'Copiar informações', 'Abrir no GitHub'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  if (response === 1) clipboard.writeText(diagnostics());
  if (response === 2) openExternal(REPO_URL);
}

/**
 * Pede à interface para abrir uma tela. Ela recebe o evento `octo:menu` (e chama preventDefault
 * quando trata o pedido); se nenhuma parte da interface tratar, usa o botão de Preferências da barra lateral.
 */
function sendToInterface(command: 'preferences'): void {
  if (!window || window.isDestroyed() || !appUrl) return;
  window.show();
  const script = `window.dispatchEvent(new CustomEvent('octo:menu', { detail: ${JSON.stringify(command)}, cancelable: true }))
    && document.querySelector('.launch-prefs')?.click();`;
  void window.webContents.executeJavaScript(script).catch(() => undefined);
}

/** Menu em português; no Windows e no Linux ele aparece com Alt. */
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const separator: Electron.MenuItemConstructorOptions = { type: 'separator' };
  const about: Electron.MenuItemConstructorOptions = isMac
    ? { role: 'about', label: 'Sobre o Octo' }
    : { label: 'Sobre o Octo', click: () => void showAbout() };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Octo',
      submenu: [
        about,
        separator,
        { label: 'Preferências…', accelerator: 'CmdOrCtrl+,', click: () => sendToInterface('preferences') },
        ...(isMac
          ? ([
              separator,
              { role: 'services', label: 'Serviços' },
              separator,
              { role: 'hide', label: 'Ocultar o Octo' },
              { role: 'hideOthers', label: 'Ocultar os outros' },
              { role: 'unhide', label: 'Mostrar tudo' },
            ] satisfies Electron.MenuItemConstructorOptions[])
          : []),
        separator,
        { role: 'quit', label: isMac ? 'Sair do Octo' : 'Sair' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        separator,
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        ...(DEVTOOLS ? ([{ role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' }] satisfies Electron.MenuItemConstructorOptions[]) : []),
        separator,
        { role: 'resetZoom', label: 'Tamanho original' },
        { role: 'zoomIn', label: 'Aumentar' },
        { role: 'zoomOut', label: 'Diminuir' },
        separator,
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
    ...(isMac
      ? ([
          {
            label: 'Janela',
            role: 'window',
            submenu: [
              { role: 'minimize', label: 'Minimizar' },
              { role: 'zoom', label: 'Zoom' },
              separator,
              { role: 'front', label: 'Trazer tudo para a frente' },
            ],
          },
        ] satisfies Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'Ajuda',
      role: 'help',
      submenu: [
        { label: 'Documentação', click: () => openExternal(`${REPO_URL}#readme`) },
        { label: 'Novidades desta versão', click: () => openExternal(`${REPO_URL}/releases/tag/v${app.getVersion()}`) },
        { label: 'Reportar um problema…', click: () => openExternal(reportProblemUrl()) },
        separator,
        { label: `Versão ${app.getVersion()}`, enabled: false },
        { label: 'Copiar informações do sistema', click: () => clipboard.writeText(diagnostics()) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (isMac) {
    app.setAboutPanelOptions({
      applicationName: 'Octo',
      applicationVersion: app.getVersion(),
      version: `Electron ${process.versions.electron}`,
      copyright: 'Copyright © 2026 Octo contributors · licença MIT',
    });
  }
}

// ---------------------------------------------------------------- autoteste

/** O executável ainda roda como Node? O terminal do Octo depende disso (fuse runAsNode). */
function runsAsNode(): Promise<boolean> {
  return new Promise((resolve) => {
    // Com o NODE_OPTIONS vazio, como todo Node que o Octo roda com o próprio executável: uma opção
    // do seu shell que o Node do Electron recusa derrubaria o teste.
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(40 + 2))'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0 && output === '42'));
  });
}

/** Carrega a interface numa janela oculta, com o mesmo sandbox e as mesmas permissões do app. */
async function checkInterface(): Promise<void> {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const problems: string[] = [];
  probe.webContents.on('console-message', (event) => {
    if (event.level !== 'error') return;
    // Algo bloqueado pela Content-Security-Policy quebra a interface; outros erros ficam no log.
    if (/Content Security Policy/i.test(event.message)) problems.push(event.message);
    else console.warn(`[octo] erro na interface durante o autoteste: ${event.message}`);
  });
  probe.webContents.on('render-process-gone', (_event, details) => problems.push(`a página caiu (${details.reason})`));
  try {
    await probe.loadURL(interfaceUrl());
    const rendered: unknown = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (document.querySelector('#root')?.childElementCount) resolve(true);
        else if (Date.now() - started > 20000) resolve(false);
        else setTimeout(check, 100);
      };
      check();
    })`);
    if (rendered !== true) problems.push('a interface não apareceu em 20 s');
  } finally {
    probe.destroy();
  }
  if (problems.length) throw new Error(`falhou: interface na janela\n  ${problems.join('\n  ')}`);
}

/**
 * `--self-test`: sobe o servidor como o app faria, confere a API (com e sem o token), o executável
 * rodando como Node (usado pelo terminal) e a interface carregando numa janela oculta, e sai com
 * código 0 ou 1. O CI roda isto em cada instalador antes de publicar.
 */
async function selfTest(): Promise<void> {
  const timer = setTimeout(() => failSelfTest(new Error('tempo esgotado')), 120_000);
  const url = await startBackend();
  appUrl = url;
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
  expect(await runsAsNode(), 'o executável roda como Node (ELECTRON_RUN_AS_NODE), de que o terminal depende');
  lockDownSession();
  await checkInterface();
  clearTimeout(timer);
  const shellNote = process.platform === 'win32' ? '' : ` · ${shellVariables} variáveis do shell`;
  console.log(`[octo] autoteste ok · ${process.platform}-${process.arch} · Electron ${process.versions.electron}${shellNote}`);
  server?.shutdown();
  app.exit(0);
}

function failSelfTest(error: unknown): void {
  console.error('[octo] autoteste falhou:', error);
  app.exit(1);
}

// ---------------------------------------------------------------- início

/**
 * Uma instância por pasta de dados. Com outra pasta (OCTO_DATA_DIR, como nas capturas de tela com
 * dados de exemplo), o Chromium usa um perfil à parte, dentro da pasta do app: assim esta janela
 * abre mesmo com o Octo instalado aberto, em vez de trazer para a frente a dele, com os dados reais.
 */
function lockInstance(): boolean {
  const comparable = (dir: string) => (process.platform === 'win32' ? dir.toLowerCase() : dir);
  if (comparable(DATA_DIR) !== comparable(path.join(homedir(), '.octo'))) {
    const id = createHash('sha256').update(comparable(DATA_DIR)).digest('hex').slice(0, 12);
    app.setPath('userData', path.join(app.getPath('userData'), 'data-dirs', id));
  }
  if (app.requestSingleInstanceLock()) return true;
  console.error(`[octo] O Octo já está aberto com a pasta de dados ${DATA_DIR}: a janela dele vem para a frente.`);
  return false;
}

if (SELF_TEST) {
  // Perfil descartável: o autoteste não mexe nos dados do Chromium do app instalado.
  app.setPath('userData', path.join(tmpdir(), `octo-selftest-${process.pid}`));
  app.whenReady().then(selfTest).catch(failSelfTest);
} else if (!lockInstance()) {
  app.quit();
} else {
  app.setName('Octo');
  // Fora do pacote (npm run desktop) o id é outro: ao notificar, o Windows cria um atalho
  // "Electron" no Menu Iniciar para o electron.exe com esse id, e com o id do app instalado ele
  // tomaria o lugar do atalho do Octo na busca e na barra de tarefas.
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);

  app.on('second-instance', () => {
    if (!started) return;
    if (!window || window.isDestroyed()) return createWindow();
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
    if (started && (!window || window.isDestroyed())) createWindow();
  });

  app
    .whenReady()
    .then(async () => {
      lockDownSession();
      buildMenu();
      powerMonitor.on('shutdown', flushOnSystemExit);
      // A janela abre na hora, com a tela de carregamento; o servidor sobe enquanto isso.
      started = true;
      createWindow();
      appUrl = await startBackend();
      showInterface();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox('Não foi possível iniciar o Octo', error instanceof Error ? (error.stack ?? error.message) : String(error));
      app.exit(1);
    });
}
