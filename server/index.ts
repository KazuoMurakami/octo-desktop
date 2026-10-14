// Octo pela linha de comando (`npm start`, `npm run dev`): o mesmo servidor do app desktop, aberto no navegador.
import { spawn } from 'node:child_process';
import { apiToken, findRunningServer } from './instance.ts';

const open = process.argv.includes('--open');
const dev = process.argv.includes('--dev');

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(command as string, args as string[], { stdio: 'ignore', detached: true }).unref();
}

const running = await findRunningServer();
if (running) {
  console.log(`\n  O Octo já está rodando em ${running} (app desktop ou outro terminal).`);
  if (open) {
    openBrowser(`${running}/?token=${apiToken()}`);
    process.exit(0);
  }
  console.log('  Feche-o antes, ou use OCTO_DATA_DIR para rodar com outra pasta de dados.\n');
  process.exit(1);
}

// Importado só agora: carregar o app já lê o banco e consulta as contas do Claude.
const { authUrl, describeServer, shutdown, startServer } = await import('./app.ts');

try {
  const { url } = await startServer({ port: Number(process.env.OCTO_PORT ?? 4317), devOrigin: dev });
  console.log(`\n${describeServer(url)}`);
  // O link leva o token de acesso: só funciona para quem consegue ler a pasta de dados.
  console.log(`  Abra: ${dev ? authUrl(url).replace(url, 'http://localhost:5173') : authUrl(url)}\n`);
  if (open) openBrowser(authUrl(url));
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? '\n  A porta já está em uso. Defina outra com OCTO_PORT.\n' : error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
