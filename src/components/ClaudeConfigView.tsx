import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Blocks, Bot, Braces, Copy, FolderOpen, Plug, Plus, Power, RefreshCw, Search, Server, SlidersHorizontal, Sparkles, SquareSlash, Trash2,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { EFFORTS, type AccountConfig, type AvailablePlugin, type ClaudeAccount, type ClaudeItem, type ClaudeItemKind } from '../../shared/types.ts';
import { api } from '../api.ts';
import { invalidateAccountConfig, setting, useAccountConfig } from '../claudeConfig.ts';
import { defaultAccountId, toast, useStore } from '../store.ts';
import { AccountAvatar } from './icons.tsx';
import { EffortPicker, ModelPicker } from './SessionSettings.tsx';
import { Field, Menu, Modal } from './ui.tsx';

type Tab = 'general' | ClaudeItemKind | 'mcp' | 'plugins' | 'settings';

const KIND: Record<ClaudeItemKind, { one: string; many: string; create: string; icon: typeof Sparkles; about: string }> = {
  skill: {
    one: 'skill', many: 'Skills', create: 'Nova skill', icon: Sparkles,
    about: 'Instruções e recursos que o Claude carrega quando a tarefa pede, ou quando você chama /nome. Ficam em skills/<nome>/SKILL.md.',
  },
  agent: {
    one: 'agente', many: 'Agentes', create: 'Novo agente', icon: Bot,
    about: 'Subagentes com prompt, ferramentas e modelo próprios. O Claude delega a eles, e você pode usar um como agente principal da sessão.',
  },
  command: {
    one: 'comando', many: 'Comandos', create: 'Novo comando', icon: SquareSlash,
    about: 'Prompts prontos chamados com /nome. $ARGUMENTS recebe o que você digitar depois do comando.',
  },
};

const TEMPLATE: Record<ClaudeItemKind, (name: string, description: string) => string> = {
  skill: (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nO que o Claude deve fazer quando esta skill for usada.\n`,
  agent: (name, description) => `---\nname: ${name}\ndescription: ${description}\nmodel: inherit\n---\n\nVocê é um especialista em… (prompt de sistema do subagente)\n`,
  command: (_name, description) => `---\ndescription: ${description}\n---\n\nFaça o seguinte com $ARGUMENTS:\n`,
};

/** Tudo o que o Claude Code de uma conta usa: os mesmos arquivos que o CLI lê. */
export function ClaudeConfigView() {
  const { accounts, accountStatus, configAccountId, set } = useStore(
    useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, configAccountId: s.configAccountId, set: s.set })),
  );
  const account = accounts.find((a) => a.id === configAccountId) ?? accounts.find((a) => a.id === defaultAccountId()) ?? accounts[0];
  const { config, loading } = useAccountConfig(account?.id);
  const [tab, setTab] = useState<Tab>('general');
  if (!account) return null;

  const count = (kind: ClaudeItemKind) => config?.items.filter((i) => i.kind === kind).length;
  const tabs: { id: Tab; label: string; icon: typeof Sparkles; count?: number }[] = [
    { id: 'general', label: 'Geral', icon: SlidersHorizontal },
    { id: 'skill', label: 'Skills', icon: Sparkles, count: count('skill') },
    { id: 'agent', label: 'Agentes', icon: Bot, count: count('agent') },
    { id: 'command', label: 'Comandos', icon: SquareSlash, count: count('command') },
    { id: 'mcp', label: 'MCP', icon: Server, count: config?.mcpServers.length },
    { id: 'plugins', label: 'Plugins', icon: Plug, count: config?.plugins.length },
    { id: 'settings', label: 'settings.json', icon: Braces },
  ];

  return (
    <section className="view">
      <header className="view-head">
        <h1>Configuração do Claude</h1>
        <Menu
          className="prop-btn"
          width={280}
          trigger={<><AccountAvatar account={account} status={accountStatus[account.id]} size={16} /> {account.name}</>}
          items={accounts.map((a) => ({
            key: a.id, label: a.name, hint: accountStatus[a.id]?.email ?? '', icon: <AccountAvatar account={a} size={16} />,
            selected: a.id === account.id, onSelect: () => set({ configAccountId: a.id }),
          }))}
        />
        <span className="mono dim root-path" title={config?.configDir}>{config?.configDir}</span>
        <div className="view-tools">
          <button className="ghost-btn" onClick={() => api.revealConfig(account.id)}><FolderOpen size={14} /> Abrir pasta</button>
          <button className="ghost-btn" onClick={() => invalidateAccountConfig(account.id, true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Recarregar
          </button>
        </div>
      </header>
      <nav className="tabs">
        {tabs.map(({ id, label, icon: Icon, count: n }) => (
          <button key={id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
            <Icon size={14} /> {label} {n !== undefined && <em>{n}</em>}
          </button>
        ))}
      </nav>
      <div className="config-body">
        {!config ? (
          <div className="feed-loading">{loading ? 'Lendo a configuração…' : 'Não foi possível ler a configuração desta conta.'}</div>
        ) : (
          <>
            {tab === 'general' && <GeneralTab account={account} config={config} goTo={setTab} />}
            {(tab === 'skill' || tab === 'agent' || tab === 'command') && <ItemsTab key={tab} kind={tab} account={account} config={config} accounts={accounts} />}
            {tab === 'mcp' && <McpTab account={account} config={config} />}
            {tab === 'plugins' && <PluginsTab account={account} config={config} />}
            {tab === 'settings' && <SettingsTab key={account.id} account={account} config={config} />}
          </>
        )}
      </div>
    </section>
  );
}

async function act(accountId: string, action: () => Promise<unknown>, message?: string): Promise<boolean> {
  try {
    await action();
    if (message) toast(message, 'success');
    return true;
  } catch {
    return false; // o erro já virou toast em api.ts
  } finally {
    invalidateAccountConfig(accountId);
  }
}

// ---------------------------------------------------------------- geral

function GeneralTab({ account, config, goTo }: { account: ClaudeAccount; config: AccountConfig; goTo: (tab: Tab) => void }) {
  const settings = config.settings ?? {};
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? Object.keys(settings.hooks) : [];
  const permissions = (settings.permissions ?? {}) as { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] };
  const patch = (body: Parameters<typeof api.patchSettings>[1]) => act(account.id, () => api.patchSettings(account.id, body), 'Configuração salva.');

  const cards: { label: string; value: ReactNode; tab: Tab }[] = [
    { label: 'Skills', value: config.items.filter((i) => i.kind === 'skill').length, tab: 'skill' },
    { label: 'Agentes', value: config.items.filter((i) => i.kind === 'agent').length, tab: 'agent' },
    { label: 'Comandos', value: config.items.filter((i) => i.kind === 'command').length, tab: 'command' },
    { label: 'Servidores MCP', value: config.mcpServers.length, tab: 'mcp' },
    { label: 'Plugins ativos', value: `${config.plugins.filter((p) => p.enabled).length}/${config.plugins.length}`, tab: 'plugins' },
    { label: 'Hooks', value: hooks.length ? `${hooks.length} eventos` : 'nenhum', tab: 'settings' },
    { label: 'Regras de permissão', value: (permissions.allow?.length ?? 0) + (permissions.deny?.length ?? 0) + (permissions.ask?.length ?? 0), tab: 'settings' },
  ];

  return (
    <div className="config-pane">
      {config.settingsError && (
        <div className="config-warning">
          O settings.json desta conta tem um erro e o Claude Code está ignorando-o: <code>{config.settingsError}</code>.{' '}
          <button className="link-btn" onClick={() => goTo('settings')}>Corrigir</button>
        </div>
      )}
      <p className="config-about">
        Estes são os padrões da conta <strong>{account.name}</strong>, os mesmos do <code>claude</code> no terminal: valem para toda sessão
        que não escolher outro valor, aqui ou no CLI.
      </p>
      <div className="settings-row">
        <Field label="Modelo padrão" hint="Chave model do settings.json.">
          <ModelPicker key={account.id} value={setting(config, 'model')} onChange={(model) => patch({ model: model ?? '' })} accountDefault={null} />
        </Field>
        <Field label="Pensamento estendido" hint="Chave alwaysThinkingEnabled.">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.alwaysThinkingEnabled === true}
              onChange={(e) => patch({ alwaysThinkingEnabled: e.target.checked ? true : null })}
            />
            Sempre pensar antes de responder
          </label>
        </Field>
      </div>
      <Field label="Esforço padrão (effort)" hint="Chave effortLevel. Ajustes por modelo ficam em modelSettings, na aba settings.json.">
        <EffortPicker value={EFFORTS.find((e) => e === setting(config, 'effortLevel')) ?? null} onChange={(effort) => patch({ effortLevel: effort ?? '' })} accountDefault={null} />
      </Field>

      <div className="config-cards">
        {cards.map((card) => (
          <button key={card.label} className="config-card" onClick={() => goTo(card.tab)}>
            <strong>{card.value}</strong>
            <span>{card.label}</span>
          </button>
        ))}
      </div>
      {config.pluginsError && <p className="dim">Não foi possível listar os plugins: {config.pluginsError}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- skills, agentes e comandos

function ItemsTab({ kind, account, config, accounts }: { kind: ClaudeItemKind; account: ClaudeAccount; config: AccountConfig; accounts: ClaudeAccount[] }) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const meta = KIND[kind];
  const items = config.items
    .filter((i) => i.kind === kind)
    .filter((i) => !query || `${i.name} ${i.description}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups: { title: string; items: ClaudeItem[] }[] = [
    { title: 'Da conta', items: items.filter((i) => i.source === 'user') },
    { title: 'De plugins', items: items.filter((i) => i.source === 'plugin') },
    { title: 'Do projeto', items: items.filter((i) => i.source === 'project') },
  ].filter((g) => g.items.length);

  return (
    <div className="config-pane">
      <p className="config-about">{meta.about}</p>
      <div className="config-toolbar">
        <label className="search">
          <Search size={14} />
          <input placeholder={`Buscar ${meta.many.toLowerCase()}…`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="primary-btn" onClick={() => setCreating(true)}><Plus size={14} /> {meta.create}</button>
      </div>
      {groups.map((group) => (
        <div key={group.title} className="item-group">
          <div className="item-group-head">{group.title} <em>{group.items.length}</em></div>
          {group.items.map((item) => (
            <button key={item.path} className="item-row" onClick={() => setEditing(item.path)}>
              <span className="item-name mono">{item.userInvocable ? '/' : ''}{item.name}</span>
              <span className="item-desc">{item.description || <span className="dim">sem descrição</span>}</span>
              <span className="item-tags">
                {item.manualOnly && <span className="tag" title="disable-model-invocation: só roda quando você chama">só manual</span>}
                {item.model && <span className="tag">{item.model}</span>}
              </span>
            </button>
          ))}
        </div>
      ))}
      {!groups.length && <div className="config-empty">{query ? 'Nada encontrado.' : `Nenhum ${meta.one} nesta conta ainda.`}</div>}

      {creating && (
        <NewItemModal
          kind={kind}
          onClose={() => setCreating(false)}
          onCreate={async (name, description) => {
            const created = await api.createItem(account.id, kind, name, TEMPLATE[kind](name, description));
            invalidateAccountConfig(account.id);
            setCreating(false);
            setEditing(created.path);
          }}
        />
      )}
      {editing && <ItemEditor account={account} accounts={accounts} path={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function NewItemModal({ kind, onClose, onCreate }: { kind: ClaudeItemKind; onClose: () => void; onCreate: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const slug = name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const submit = async () => {
    if (!slug || busy) return;
    setBusy(true);
    try {
      await onCreate(slug, description.trim() || `Descreva quando o Claude deve usar ${slug}.`);
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={KIND[kind].create}
      onClose={onClose}
      footer={<button className="primary-btn" onClick={submit} disabled={!slug || busy}>Criar e editar</button>}
    >
      <div className="stack-form" onKeyDown={(e) => e.key === 'Enter' && void submit()}>
        <Field label="Nome" hint={slug ? <>Vai ser chamado como <code>{kind === 'agent' ? slug : `/${slug}`}</code></> : 'Letras minúsculas, números e hífens.'}>
          <input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: revisar-pr" />
        </Field>
        <Field label="Descrição" hint="O Claude lê a descrição para decidir quando usar. Seja específico.">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex.: Revisa um pull request procurando bugs e riscos" />
        </Field>
      </div>
    </Modal>
  );
}

function ItemEditor({ account, accounts, path, onClose }: { account: ClaudeAccount; accounts: ClaudeAccount[]; path: string; onClose: () => void }) {
  const [item, setItem] = useState<ClaudeItem | null>(null);
  const [original, setOriginal] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.readItem(account.id, path).then(({ item: loaded, content: text }) => {
      setItem(loaded);
      setOriginal(text);
      setContent(text);
    }).catch(onClose);
  }, [account.id, path]);

  const readOnly = item?.source === 'plugin';
  const dirty = content !== original;
  const save = async () => {
    setBusy(true);
    if (await act(account.id, () => api.saveItem(account.id, path, content), 'Salvo. Vale a partir das próximas sessões.')) setOriginal(content);
    setBusy(false);
  };
  const remove = async () => {
    if (!item || !confirm(`Excluir "${item.name}"? O item vai para a lixeira do Octo (~/.octo/trash), de onde dá para recuperar.`)) return;
    if (await act(account.id, () => api.deleteItem(account.id, path), 'Movido para a lixeira do Octo.')) onClose();
  };
  const targets = accounts.filter((a) => readOnly || a.id !== account.id);

  return (
    <Modal
      width={860}
      title={<>{item ? <><span className="mono">{item.userInvocable ? '/' : ''}{item.name}</span> <span className="dim">· {KIND[item.kind].one}</span></> : 'Carregando…'}</>}
      onClose={() => (!dirty || confirm('Descartar as alterações?')) && onClose()}
      footer={
        <>
          <span className="foot-hint mono dim" title={path}>{path}</span>
          {targets.length > 0 && (
            <Menu
              className="ghost-btn"
              align="end"
              trigger={<><Copy size={13} /> Copiar para…</>}
              items={targets.map((a) => ({
                key: a.id, label: a.id === account.id ? `${a.name} (editável)` : a.name, icon: <AccountAvatar account={a} size={16} />,
                onSelect: () => void act(account.id, () => api.copyItem(account.id, path, a.id), `Copiado para ${a.name}.`).then(() => invalidateAccountConfig(a.id)),
              }))}
            />
          )}
          {!readOnly && <button className="ghost-btn is-danger" onClick={remove}><Trash2 size={13} /> Excluir</button>}
          {!readOnly && <button className="primary-btn" onClick={save} disabled={!dirty || busy}>Salvar</button>}
        </>
      }
    >
      {readOnly && <div className="config-note">Vem do plugin <code>{item?.plugin}</code> e é somente leitura. Copie para uma conta para personalizar.</div>}
      <CodeEditor value={content} onChange={setContent} readOnly={readOnly} onSave={save} />
    </Modal>
  );
}

/** Textarea para Markdown/JSON: Tab indenta, Ctrl+S salva. */
function CodeEditor({ value, onChange, readOnly = false, onSave, rows = 22 }: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  onSave?: () => void;
  rows?: number;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
    } else if (e.key === 'Tab' && !readOnly) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
    }
  };
  return <textarea className="code-editor" spellCheck={false} rows={rows} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

// ---------------------------------------------------------------- MCP

const MCP_EXAMPLES: Record<string, string> = {
  http: '{\n  "type": "http",\n  "url": "https://exemplo.com/mcp",\n  "headers": { "Authorization": "Bearer SEU_TOKEN" }\n}',
  stdio: '{\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "pacote-do-servidor"],\n  "env": { "API_KEY": "..." }\n}',
};

function McpTab({ account, config }: { account: ClaudeAccount; config: AccountConfig }) {
  const [name, setName] = useState('');
  const [json, setJson] = useState(MCP_EXAMPLES.http);
  const [busy, setBusy] = useState(false);
  const user = config.mcpServers.filter((s) => s.scope === 'user');
  const fromPlugins = config.mcpServers.filter((s) => s.scope === 'plugin');

  const add = async () => {
    setBusy(true);
    if (await act(account.id, () => api.addMcp(account.id, name.trim(), json), `Servidor ${name.trim()} adicionado.`)) setName('');
    setBusy(false);
  };

  return (
    <div className="config-pane">
      <p className="config-about">
        Servidores MCP dão ferramentas extras ao Claude (bancos, APIs, navegador…). Os daqui são de escopo <code>user</code>: valem em todas as
        pastas desta conta. Para um servidor só de um repositório, use um <code>.mcp.json</code> nele.
      </p>
      <div className="item-group">
        <div className="item-group-head">Da conta <em>{user.length}</em></div>
        {user.map((server) => (
          <div key={server.name} className="item-row is-static">
            <span className="item-name mono">{server.name}</span>
            <span className="item-desc mono">{server.target}</span>
            <span className="item-tags">
              <span className="tag">{server.type}</span>
              <button
                className="icon-btn is-danger"
                title="Remover"
                onClick={() => confirm(`Remover o servidor MCP "${server.name}"?`) && void act(account.id, () => api.removeMcp(account.id, server.name), 'Servidor removido.')}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        ))}
        {!user.length && <div className="config-empty">Nenhum servidor na conta.</div>}
      </div>
      {fromPlugins.length > 0 && (
        <div className="item-group">
          <div className="item-group-head">De plugins <em>{fromPlugins.length}</em></div>
          {fromPlugins.map((server) => (
            <div key={`${server.plugin}:${server.name}`} className="item-row is-static">
              <span className="item-name mono">{server.name}</span>
              <span className="item-desc mono">{server.target}</span>
              <span className="item-tags"><span className="tag">{server.plugin?.split('@')[0]}</span></span>
            </div>
          ))}
        </div>
      )}

      <h3 className="config-subtitle">Adicionar servidor</h3>
      <div className="stack-form">
        <div className="settings-row">
          <Field label="Nome">
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: github" />
          </Field>
          <Field label="Exemplo">
            <div className="segmented">
              {Object.keys(MCP_EXAMPLES).map((type) => (
                <button key={type} type="button" onClick={() => setJson(MCP_EXAMPLES[type])}>{type}</button>
              ))}
            </div>
          </Field>
        </div>
        <Field label="Configuração (JSON)" hint={<>Igual a <code>claude mcp add-json</code>. Tokens ficam só no arquivo de configuração da conta.</>}>
          <CodeEditor value={json} onChange={setJson} rows={8} />
        </Field>
        <div><button className="primary-btn" onClick={add} disabled={!name.trim() || busy}><Plus size={14} /> Adicionar</button></div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- plugins

function PluginsTab({ account, config }: { account: ClaudeAccount; config: AccountConfig }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const [query, setQuery] = useState('');
  const installed = useMemo(() => new Set(config.plugins.map((p) => p.id)), [config.plugins]);

  const run = async (action: 'install' | 'uninstall' | 'enable' | 'disable', id: string, message: string) => {
    setBusy(id);
    await act(account.id, () => api.pluginAction(account.id, action, id), message);
    setBusy(null);
  };
  const loadAvailable = async () => {
    setLoadingAvailable(true);
    try {
      setAvailable(await api.availablePlugins(account.id));
    } finally {
      setLoadingAvailable(false);
    }
  };
  const shown = (available ?? [])
    .filter((p) => !query || `${p.name} ${p.description}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 60);

  return (
    <div className="config-pane">
      <p className="config-about">
        Plugins empacotam skills, agentes, comandos, hooks e servidores MCP. Instalar, ativar e desativar usa o <code>claude plugin</code> desta
        conta; as mudanças valem a partir das próximas sessões.
      </p>
      {config.pluginsError && <div className="config-warning">Não foi possível listar os plugins: {config.pluginsError}</div>}
      <div className="item-group">
        <div className="item-group-head">Instalados <em>{config.plugins.length}</em></div>
        {config.plugins.map((plugin) => (
          <div key={plugin.id} className={`item-row is-static${plugin.enabled ? '' : ' is-off'}`}>
            <span className="item-name mono">{plugin.id.split('@')[0]}</span>
            <span className="item-desc">
              <span className="dim">{plugin.id.split('@')[1]}</span>
              {plugin.version && <span className="dim"> · {plugin.version}</span>}
              {plugin.mcpServers.length > 0 && <span className="dim"> · MCP: {plugin.mcpServers.join(', ')}</span>}
            </span>
            <span className="item-tags">
              <button
                className={`ghost-btn is-small${plugin.enabled ? '' : ' is-muted'}`}
                disabled={busy === plugin.id}
                onClick={() => run(plugin.enabled ? 'disable' : 'enable', plugin.id, plugin.enabled ? 'Plugin desativado.' : 'Plugin ativado.')}
              >
                <Power size={13} /> {plugin.enabled ? 'Ativo' : 'Desativado'}
              </button>
              <button
                className="icon-btn is-danger"
                title="Desinstalar"
                disabled={busy === plugin.id}
                onClick={() => confirm(`Desinstalar ${plugin.id}?`) && void run('uninstall', plugin.id, 'Plugin desinstalado.')}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        ))}
        {!config.plugins.length && !config.pluginsError && <div className="config-empty">Nenhum plugin instalado.</div>}
      </div>

      <h3 className="config-subtitle">Instalar</h3>
      {!available ? (
        <button className="ghost-btn" onClick={loadAvailable} disabled={loadingAvailable}>
          <Blocks size={14} className={loadingAvailable ? 'spin' : ''} /> {loadingAvailable ? 'Buscando nos marketplaces…' : 'Ver plugins disponíveis'}
        </button>
      ) : (
        <>
          <label className="search">
            <Search size={14} />
            <input autoFocus placeholder={`Buscar entre ${available.length} plugins…`} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="item-group">
            {shown.map((plugin) => (
              <div key={plugin.id} className="item-row is-static">
                <span className="item-name mono">{plugin.name}</span>
                <span className="item-desc">{plugin.description}</span>
                <span className="item-tags">
                  <span className="tag">{plugin.marketplace}</span>
                  {installed.has(plugin.id) ? (
                    <span className="tag is-claude">instalado</span>
                  ) : (
                    <button className="ghost-btn is-small" disabled={busy === plugin.id} onClick={() => run('install', plugin.id, `${plugin.name} instalado.`)}>
                      {busy === plugin.id ? <RefreshCw size={13} className="spin" /> : <Plus size={13} />} Instalar
                    </button>
                  )}
                </span>
              </div>
            ))}
            {!shown.length && <div className="config-empty">Nada encontrado.</div>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings.json

function SettingsTab({ account, config }: { account: ClaudeAccount; config: AccountConfig }) {
  const original = config.settingsRaw || '{\n}\n';
  const [raw, setRaw] = useState(original);
  const [base, setBase] = useState(original);
  const [busy, setBusy] = useState(false);

  // O arquivo mudou (pela aba Geral ou por fora): acompanha, a menos que haja edição sua pendente.
  if (base !== original) {
    if (raw === base) setRaw(original);
    setBase(original);
  }

  const error = useMemo(() => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? null : 'Precisa ser um objeto JSON ({ … }).';
    } catch (e) {
      return (e as Error).message;
    }
  }, [raw]);

  const save = async () => {
    if (error || raw === original) return;
    setBusy(true);
    await act(account.id, () => api.saveSettingsRaw(account.id, raw), 'settings.json salvo. A versão anterior ficou em ~/.octo/backups.');
    setBusy(false);
  };

  return (
    <div className="config-pane is-wide">
      <p className="config-about">
        O arquivo completo, com tudo que o Claude Code aceita: <code>permissions</code>, <code>hooks</code>, <code>env</code>,{' '}
        <code>modelSettings</code>, <code>statusLine</code>, <code>enabledPlugins</code> e o resto.{' '}
        <a href="https://docs.claude.com/en/docs/claude-code/settings" target="_blank" rel="noreferrer">Referência das configurações</a>
      </p>
      <CodeEditor value={raw} onChange={setRaw} onSave={save} rows={26} />
      <div className="config-toolbar">
        <span className={error ? 'is-error' : 'dim'}>{error ? `JSON inválido: ${error}` : raw === original ? 'Sem alterações.' : 'Alterações não salvas.'}</span>
        <div className="view-tools">
          <button className="ghost-btn" onClick={() => setRaw(original)} disabled={raw === original}>Desfazer</button>
          <button className="primary-btn" onClick={save} disabled={Boolean(error) || raw === original || busy}>Salvar</button>
        </div>
      </div>
      <p className="dim config-foot">
        Em segundo plano (<code>claude -p</code>) um settings.json inválido é ignorado em silêncio; por isso o Octo só salva JSON válido.
        Arquivo: <span className="mono">{config.settingsFile}</span>
      </p>
    </div>
  );
}
