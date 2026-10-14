// Confere os fuses do Electron gravados no app empacotado contra o bloco electronFuses do
// electron-builder.yml. O workflow de release roda isto em cada sistema antes de publicar.
// Uso: node scripts/check-fuses.mjs <release/win-unpacked/Octo.exe | release/mac-arm64/Octo.app | release/linux-unpacked/octo>
// O @electron/fuses já vem instalado com o electron-builder.
import { readFileSync } from 'node:fs';
import fuses from '@electron/fuses';

const { FuseV1Options, getCurrentFuseWire } = fuses;
// No executável, cada fuse é um byte: o caractere '1' (ligado) ou '0' (desligado).
const ON = '1'.charCodeAt(0);
const OFF = '0'.charCodeAt(0);

const target = process.argv[2];
if (!target) {
  console.error('Uso: node scripts/check-fuses.mjs <caminho do app empacotado>');
  process.exit(2);
}

// O bloco tem uma chave por linha (`  runAsNode: true`), com comentários entre elas.
const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
const block = /^electronFuses:\r?\n((?:(?:[ \t]+.*)?\r?\n)+)/m.exec(config)?.[1] ?? '';
const expected = [...block.matchAll(/^[ \t]+(\w+):[ \t]*(true|false)[ \t]*$/gm)].map(([, key, value]) => ({ key, on: value === 'true' }));
if (!expected.length) {
  console.error('Não achei o bloco electronFuses no electron-builder.yml.');
  process.exit(1);
}

const wire = await getCurrentFuseWire(target);
let failed = false;
for (const { key, on } of expected) {
  const index = FuseV1Options[key[0].toUpperCase() + key.slice(1)];
  const state = index === undefined ? undefined : wire[index];
  const actual = state === ON ? true : state === OFF ? false : null;
  const ok = actual === on;
  const describe = (value) => (value === null ? 'ausente' : value ? 'ligado' : 'desligado');
  console.log(`${ok ? 'ok  ' : 'ERRO'} ${key}: ${describe(actual)}${ok ? '' : ` (esperado: ${describe(on)})`}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
