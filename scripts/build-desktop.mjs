// Gera a interface (dist/) e empacota o processo principal do Electron, com o servidor que
// ele importa, num único arquivo (dist-electron/main.js). O electron-builder parte daqui.
import { copyFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';

// Começa do zero para não levar ao instalador arquivos de builds anteriores.
// (fs.rmSync do Node 24 anterior ao 24.21 ignora caminhos com acento no Windows; o rm assíncrono não.)
for (const dir of ['dist', 'dist-electron']) await rm(dir, { recursive: true, force: true });

await buildWeb();

mkdirSync('dist-electron', { recursive: true });
await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // express e o próprio electron vêm de node_modules em tempo de execução.
  packages: 'external',
  logLevel: 'info',
});

// terminal.ts lê o launcher ao lado do bundle (ver import.meta.url lá).
copyFileSync('server/launcher.mjs', 'dist-electron/launcher.mjs');

// As fontes vão junto com o app; a licença delas (SIL OFL 1.1) exige que o texto as acompanhe.
mkdirSync('dist/licenses', { recursive: true });
for (const font of ['hanken-grotesk', 'jetbrains-mono']) {
  copyFileSync(`node_modules/@fontsource-variable/${font}/LICENSE`, `dist/licenses/${font}-OFL.txt`);
}
