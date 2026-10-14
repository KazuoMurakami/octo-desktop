// Gera a interface (dist/) e empacota o processo principal do Electron, com o servidor que
// ele importa, num único arquivo (dist-electron/main.js). O electron-builder parte daqui.
import { copyFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';

// Começa do zero para não levar ao instalador arquivos de builds anteriores.
// (fs.rmSync do Node 24 anterior ao 24.21 ignora caminhos com acento no Windows; o rm assíncrono não.)
for (const dir of ['dist', 'dist-electron']) await rm(dir, { recursive: true, force: true });

// O instalador leva o código das bibliotecas da interface (React, react-markdown, lucide…), então
// leva também os avisos de licença delas: o Vite junta o texto da licença de cada pacote que
// entrou no bundle.
await buildWeb({ build: { license: { fileName: 'licenses/THIRD_PARTY_NOTICES.md' } } });

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
// Imagem da tela "Iniciando o Octo…", mostrada enquanto o servidor sobe (electron/main.ts).
copyFileSync('src/assets/octo-mark.png', 'dist-electron/splash-mark.png');

mkdirSync('dist/licenses', { recursive: true });
// A licença do próprio Octo (MIT) acompanha o instalador.
copyFileSync('LICENSE', 'dist/licenses/LICENSE-Octo.txt');
// As fontes vão junto com o app; a licença delas (SIL OFL 1.1) exige que o texto as acompanhe.
for (const font of ['hanken-grotesk', 'jetbrains-mono']) {
  copyFileSync(`node_modules/@fontsource-variable/${font}/LICENSE`, `dist/licenses/${font}-OFL.txt`);
}
