// Configuração do Claude Code de cada conta: settings.json, skills, agentes, comandos, MCP e plugins.
// Arquivos são lidos e escritos direto na pasta da conta; MCP e plugins passam pelo próprio `claude`,
// que conhece o formato e as regras de cada um.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  AccountConfig, AvailablePlugin, ClaudeAccount, ClaudeItem, ClaudeItemKind, ClaudeItemSource, McpServerInfo, PluginInfo,
} from '../shared/types.ts';
import { claudeEnv, requireClaude } from './claude.ts';
import { HttpError } from './model.ts';
import { DATA_DIR } from './paths.ts';
import { copyTree, describeSpawnError } from './system.ts';

export function configDir(account: ClaudeAccount): string {
  return account.configDir ?? path.join(homedir(), '.claude');
}

function settingsFile(account: ClaudeAccount): string {
  return path.join(configDir(account), 'settings.json');
}

/** Onde ficam os servidores MCP de escopo "user": ~/.claude.json, ou dentro do CLAUDE_CONFIG_DIR. */
function globalConfigFile(account: ClaudeAccount): string {
  return account.configDir ? path.join(account.configDir, '.claude.json') : path.join(homedir(), '.claude.json');
}

function samePath(a: string, b: string): boolean {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------------------------------------------------------------- CLI

function runClaude(account: ClaudeAccount, args: string[], timeout = 120_000): Promise<string> {
  const claude = requireClaude();
  return new Promise((resolve, reject) => {
    execFile(
      claude.command,
      [...claude.prefixArgs, ...args],
      { env: claudeEnv(account), cwd: homedir(), windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.toString());
        const output = `${stderr}\n${stdout}`.trim();
        const fallback = error.killed ? 'O Claude Code não respondeu a tempo.' : describeSpawnError(error, 'O Claude Code falhou');
        reject(new HttpError(400, output.split('\n').slice(-4).join('\n') || fallback));
      },
    );
  });
}

/** Nomes que vão como argumento para o `claude`: nunca começam com "-" (não viram opção). */
function cliName(value: unknown, what: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[\w][\w.@:/-]*$/.test(text)) throw new HttpError(400, `${what} inválido.`);
  return text;
}

// ---------------------------------------------------------------- settings.json

export function readSettings(account: ClaudeAccount): Pick<AccountConfig, 'settingsFile' | 'settingsRaw' | 'settings' | 'settingsError'> {
  const file = settingsFile(account);
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!raw.trim()) return { settingsFile: file, settingsRaw: raw, settings: {}, settingsError: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { settingsFile: file, settingsRaw: raw, settings: parsed, settingsError: null };
    return { settingsFile: file, settingsRaw: raw, settings: null, settingsError: 'O arquivo não contém um objeto JSON.' };
  } catch (error) {
    return { settingsFile: file, settingsRaw: raw, settings: null, settingsError: (error as Error).message };
  }
}

/** Guarda a versão anterior em ~/.octo/backups antes de sobrescrever (as 20 mais recentes por conta). */
function backup(account: ClaudeAccount, file: string): void {
  if (!existsSync(file)) return;
  const dir = path.join(DATA_DIR, 'backups');
  mkdirSync(dir, { recursive: true });
  const prefix = `settings-${account.id}-`;
  writeFileSync(path.join(dir, `${prefix}${Date.now()}.json`), readFileSync(file));
  const old = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort().slice(0, -20);
  for (const name of old) void rm(path.join(dir, name), { force: true });
}

/** Grava o settings.json; se o conteúdo não mudou, não toca no arquivo nem cria backup. */
function writeSettingsFile(account: ClaudeAccount, content: string): void {
  const file = settingsFile(account);
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return;
  mkdirSync(path.dirname(file), { recursive: true });
  backup(account, file);
  writeFileSync(file, content);
}

export function writeSettingsRaw(account: ClaudeAccount, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, `JSON inválido: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'O settings.json precisa ser um objeto JSON ({ ... }).');
  // Grava o texto exatamente como você escreveu (formatação e ordem das chaves).
  writeSettingsFile(account, raw);
}

/** Altera chaves do settings.json preservando as demais; null remove a chave. */
export function patchSettings(account: ClaudeAccount, patch: Record<string, unknown>): void {
  const current = readSettings(account);
  if (!current.settings) throw new HttpError(400, `O settings.json desta conta tem um erro (${current.settingsError}). Corrija-o na aba settings.json.`);
  const next = { ...current.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  // Nada mudou de fato: preserva o arquivo como está (formatação, comentários de ordem etc.).
  if (JSON.stringify(next) === JSON.stringify(current.settings)) return;
  writeSettingsFile(account, `${JSON.stringify(next, null, 2)}\n`);
}

// ---------------------------------------------------------------- skills, agentes e comandos

/** Lê o frontmatter YAML simples dos .md do Claude Code (chave: valor, inclusive blocos > e |). */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const data: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!entry) continue;
    let value = entry[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else {
      value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    data[entry[1]] = value;
  }
  return data;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function makeItem(kind: ClaudeItemKind, fallbackName: string, file: string, source: ClaudeItemSource, plugin: string | null): ClaudeItem {
  let data: Record<string, string> = {};
  try {
    data = frontmatter(readFileSync(file, 'utf8'));
  } catch {
    /* arquivo ilegível: lista só pelo nome */
  }
  const base = data.name || fallbackName;
  return {
    kind,
    name: plugin ? `${plugin.split('@')[0]}:${base}` : base,
    description: data.description ?? '',
    source,
    plugin,
    path: file,
    userInvocable: kind !== 'agent' && data['user-invocable'] !== 'false',
    manualOnly: data['disable-model-invocation'] === 'true',
    model: data.model || null,
  };
}

/** skills/<nome>/SKILL.md, agents/*.md e commands/**.md de uma pasta de configuração (conta, plugin ou projeto). */
function scanItems(base: string, source: ClaudeItemSource, plugin: string | null): ClaudeItem[] {
  const items: ClaudeItem[] = [];
  for (const dir of entries(path.join(base, 'skills'))) {
    const file = path.join(base, 'skills', dir, 'SKILL.md');
    if (existsSync(file)) items.push(makeItem('skill', dir, file, source, plugin));
  }
  for (const kind of ['agent', 'command'] as const) {
    const root = path.join(base, kind === 'agent' ? 'agents' : 'commands');
    // Um nível de subpastas: os comandos costumam ser organizados assim.
    for (const name of entries(root)) {
      const file = path.join(root, name);
      if (name.endsWith('.md')) items.push(makeItem(kind, name.slice(0, -3), file, source, plugin));
      else if (isDir(file)) for (const inner of entries(file)) if (inner.endsWith('.md')) items.push(makeItem(kind, inner.slice(0, -3), path.join(file, inner), source, plugin));
    }
  }
  return items;
}

// ---------------------------------------------------------------- plugins

interface RawPlugin {
  id?: string;
  version?: string;
  enabled?: boolean;
  scope?: string;
  installPath?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
}

const pluginCache = new Map<string, { at: number; raw: RawPlugin[] }>();

async function rawPlugins(account: ClaudeAccount, maxAge = 60_000): Promise<RawPlugin[]> {
  const cached = pluginCache.get(account.id);
  if (cached && Date.now() - cached.at < maxAge) return cached.raw;
  const parsed = JSON.parse(await runClaude(account, ['plugin', 'list', '--json'])) as unknown;
  const raw = Array.isArray(parsed) ? (parsed as RawPlugin[]) : [];
  pluginCache.set(account.id, { at: Date.now(), raw });
  return raw;
}

const availableCache = new Map<string, { at: number; list: AvailablePlugin[] }>();

export async function availablePlugins(account: ClaudeAccount): Promise<AvailablePlugin[]> {
  const cached = availableCache.get(account.id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.list;
  const parsed = JSON.parse(await runClaude(account, ['plugin', 'list', '--available', '--json'])) as { available?: Record<string, unknown>[] };
  const list = (parsed.available ?? []).map((p) => ({
    id: String(p.pluginId ?? p.id ?? ''),
    name: String(p.name ?? p.pluginId ?? ''),
    description: String(p.description ?? ''),
    marketplace: String(p.marketplaceName ?? ''),
    installs: typeof p.installCount === 'number' ? p.installCount : typeof p.installs === 'number' ? p.installs : null,
  })).filter((p) => p.id);
  availableCache.set(account.id, { at: Date.now(), list });
  return list;
}

export async function pluginAction(account: ClaudeAccount, action: unknown, id: unknown): Promise<void> {
  if (!['install', 'uninstall', 'enable', 'disable'].includes(action as string)) throw new HttpError(400, 'Ação de plugin inválida.');
  await runClaude(account, ['plugin', action as string, cliName(id, 'Plugin')], 5 * 60_000);
  pluginCache.delete(account.id);
}

// ---------------------------------------------------------------- MCP

function describeMcp(name: string, config: Record<string, unknown>, scope: McpServerInfo['scope'], plugin: string | null): McpServerInfo {
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  return {
    name,
    scope,
    plugin,
    type: String(config.type ?? (config.command ? 'stdio' : 'http')),
    target: typeof config.url === 'string' ? config.url.replace(/\?.*$/, '') : [config.command, ...args].filter(Boolean).join(' '),
  };
}

function userMcpServers(account: ClaudeAccount): McpServerInfo[] {
  try {
    const global = JSON.parse(readFileSync(globalConfigFile(account), 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> };
    return Object.entries(global.mcpServers ?? {}).map(([name, config]) => describeMcp(name, config, 'user', null));
  } catch {
    return [];
  }
}

export async function addMcpServer(account: ClaudeAccount, name: unknown, config: unknown): Promise<void> {
  const serverName = cliName(name, 'Nome do servidor');
  let parsed = config;
  if (typeof config === 'string') {
    try {
      parsed = JSON.parse(config);
    } catch (error) {
      throw new HttpError(400, `JSON inválido: ${(error as Error).message}`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'A configuração do servidor precisa ser um objeto JSON.');
  await runClaude(account, ['mcp', 'add-json', serverName, JSON.stringify(parsed), '--scope', 'user']);
}

export async function removeMcpServer(account: ClaudeAccount, name: unknown): Promise<void> {
  await runClaude(account, ['mcp', 'remove', cliName(name, 'Nome do servidor'), '--scope', 'user']);
}

// ---------------------------------------------------------------- visão geral

/** `pluginMaxAge`: quanto tempo a lista de plugins (lenta, vem do CLI) pode ser reaproveitada. */
export async function readAccountConfig(account: ClaudeAccount, projectDir: string | null, pluginMaxAge = 60_000): Promise<AccountConfig> {
  let raw: RawPlugin[] = [];
  let pluginsError: string | null = null;
  try {
    raw = await rawPlugins(account, pluginMaxAge);
  } catch (error) {
    pluginsError = (error as Error).message;
  }
  const enabled = raw.filter((p) => p.enabled && p.id && p.installPath);
  const items = [
    ...scanItems(configDir(account), 'user', null),
    ...(projectDir ? scanItems(path.join(projectDir, '.claude'), 'project', null) : []),
    ...enabled.flatMap((p) => scanItems(p.installPath!, 'plugin', p.id!)),
  ];
  const mcpServers = [
    ...userMcpServers(account),
    ...enabled.flatMap((p) => Object.entries(p.mcpServers ?? {}).map(([name, config]) => describeMcp(name, config, 'plugin', p.id!))),
  ];
  const plugins: PluginInfo[] = raw.filter((p) => p.id).map((p) => ({
    id: p.id!,
    version: p.version ?? null,
    enabled: Boolean(p.enabled),
    scope: p.scope ?? 'user',
    installPath: p.installPath ?? null,
    mcpServers: Object.keys(p.mcpServers ?? {}),
  }));
  return { accountId: account.id, configDir: configDir(account), ...readSettings(account), items, mcpServers, plugins, pluginsError };
}

/** Só arquivos que aparecem na listagem podem ser lidos ou alterados pela API. */
async function findItem(account: ClaudeAccount, file: unknown, projectDir: string | null): Promise<ClaudeItem> {
  if (typeof file !== 'string' || !file) throw new HttpError(400, 'Informe o arquivo.');
  // Para validar o caminho, uma lista de plugins de até 30 min atrás basta.
  const { items } = await readAccountConfig(account, projectDir, 30 * 60_000);
  const item = items.find((i) => samePath(i.path, file));
  if (!item) throw new HttpError(404, 'Item não encontrado nesta conta.');
  return item;
}

export async function readItem(account: ClaudeAccount, file: unknown, projectDir: string | null): Promise<{ item: ClaudeItem; content: string }> {
  const item = await findItem(account, file, projectDir);
  return { item, content: readFileSync(item.path, 'utf8') };
}

export async function saveItem(account: ClaudeAccount, file: unknown, content: unknown, projectDir: string | null): Promise<void> {
  const item = await findItem(account, file, projectDir);
  if (item.source === 'plugin') throw new HttpError(400, 'Itens de plugin são somente leitura; copie para a sua conta para editar.');
  if (typeof content !== 'string') throw new HttpError(400, 'Conteúdo inválido.');
  writeFileSync(item.path, content);
}

const ITEM_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function newItemPath(base: string, kind: ClaudeItemKind, name: string): string {
  if (!ITEM_NAME.test(name)) throw new HttpError(400, 'Use só letras, números, ponto, hífen e sublinhado no nome (sem espaços).');
  return kind === 'skill' ? path.join(base, 'skills', name, 'SKILL.md') : path.join(base, kind === 'agent' ? 'agents' : 'commands', `${name}.md`);
}

export function createItem(account: ClaudeAccount, kind: unknown, name: unknown, content: unknown): string {
  if (!['skill', 'agent', 'command'].includes(kind as string)) throw new HttpError(400, 'Tipo inválido.');
  if (typeof content !== 'string') throw new HttpError(400, 'Conteúdo inválido.');
  const file = newItemPath(configDir(account), kind as ClaudeItemKind, String(name ?? '').trim());
  if (existsSync(file)) throw new HttpError(400, 'Já existe um item com esse nome.');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** O que um item ocupa no disco: a pasta inteira da skill (scripts, referências) ou o .md. */
function itemFootprint(item: ClaudeItem): string {
  return item.kind === 'skill' ? path.dirname(item.path) : item.path;
}

/** Excluir manda para ~/.octo/trash, para dar para recuperar. */
export async function deleteItem(account: ClaudeAccount, file: unknown, projectDir: string | null): Promise<string> {
  const item = await findItem(account, file, projectDir);
  if (item.source === 'plugin') throw new HttpError(400, 'Para remover itens de plugin, desative ou desinstale o plugin.');
  const from = itemFootprint(item);
  const trash = path.join(DATA_DIR, 'trash');
  mkdirSync(trash, { recursive: true });
  const to = path.join(trash, `${Date.now()}-${item.kind}-${path.basename(from)}`);
  try {
    renameSync(from, to);
  } catch {
    // Outro disco (ou arquivo preso): copia e só apaga o original se a cópia existir de fato.
    copyTree(from, to);
    if (!existsSync(to)) throw new HttpError(500, 'Não foi possível mover o item para a lixeira do Octo; nada foi apagado.');
    await rm(from, { recursive: true, force: true });
  }
  return to;
}

export async function copyItem(account: ClaudeAccount, file: unknown, target: ClaudeAccount, projectDir: string | null): Promise<void> {
  const item = await findItem(account, file, projectDir);
  const from = itemFootprint(item);
  const name = item.kind === 'skill' ? path.basename(from) : path.basename(from, '.md');
  const to = item.kind === 'skill' ? path.dirname(newItemPath(configDir(target), 'skill', name)) : newItemPath(configDir(target), item.kind, name);
  if (existsSync(to)) throw new HttpError(400, `A conta de destino já tem ${item.kind === 'skill' ? 'uma skill' : 'um item'} "${name}".`);
  mkdirSync(path.dirname(to), { recursive: true });
  copyTree(from, to);
}
