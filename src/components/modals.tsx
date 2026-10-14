import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Code2, FileDiff, FileText, FolderGit2, FolderSearch, Settings2, SquareTerminal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  PRIORITY_LABEL, STATUSES, STATUS_LABEL,
  type IssueStatus, type Priority, type SessionSettings, type Workspace,
} from '../../shared/types.ts';
import { api, settingsInput, type ContextInfo, type FolderInspection } from '../api.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { useIntegrations } from '../integrations.ts';
import { commonFolder, hue, relativeTo } from '../util.ts';
import { ChangesView } from './ChangesView.tsx';
import { AccountAvatar, PriorityIcon, StatusIcon } from './icons.tsx';
import { SessionSettingsForm } from './SessionSettings.tsx';
import { AutoTextarea, Field, Kbd, Menu, Modal, RepoChip } from './ui.tsx';

export function Modals() {
  const modal = useStore((s) => s.modal);
  const close = () => useStore.getState().set({ modal: null });
  if (!modal) return null;
  switch (modal.kind) {
    case 'new-issue':
      return <NewIssueModal status={modal.status} repoIds={modal.repoIds} onClose={close} />;
    case 'delegate':
      return <DelegateModal issueId={modal.issueId} mode={modal.mode} onClose={close} />;
    case 'workspace':
      return (
        <Modal title="Conectar uma pasta" onClose={close} width={620}>
          <WorkspaceConnect onDone={close} />
        </Modal>
      );
    case 'account':
      return <AccountModal onClose={close} />;
    case 'context':
      return <ContextModal dir={modal.dir} onClose={close} />;
    case 'preferences':
      return <PreferencesModal onClose={close} />;
    case 'changes':
      return <ChangesModal dir={modal.dir} title={modal.title} onClose={close} />;
  }
}

// ---------------------------------------------------------------- nova issue

function NewIssueModal({ status: initialStatus, repoIds: initialRepos, onClose }: { status?: IssueStatus; repoIds?: string[]; onClose: () => void }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const accounts = useStore((s) => s.accounts);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<IssueStatus>(initialStatus ?? 'todo');
  const [priority, setPriority] = useState<Priority>(0);
  const [repoIds, setRepoIds] = useState<string[]>(initialRepos ?? []);
  const [delegateId, setDelegateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!workspace) return null;
  const selected = repos.filter((r) => repoIds.includes(r.id));
  const delegate = accounts.find((a) => a.id === delegateId);

  const submit = async (thenDelegate: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const issue = await api.createIssue(workspace.id, { title, description, status, priority, repoIds, delegateAccountId: delegateId });
      useStore.getState().set({ modal: thenDelegate ? { kind: 'delegate', issueId: issue.id, mode: 'headless' } : null, openIssueId: thenDelegate ? issue.id : null });
      toast(`${issue.identifier} criada.`, 'success');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      width={680}
      title={<><span className="ws-mark is-small">{workspace.key.slice(0, 2)}</span> Nova issue</>}
      onClose={onClose}
      footer={
        <>
          <span className="dim foot-hint"><Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> para criar</span>
          <button className="ghost-btn" onClick={() => submit(true)} disabled={!title.trim() || busy}><Bot size={14} /> Criar e delegar</button>
          <button className="primary-btn" onClick={() => submit(false)} disabled={!title.trim() || busy}>Criar issue</button>
        </>
      }
    >
      <div
        className="new-issue"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit(false);
          }
        }}
      >
        <input autoFocus className="title-input" placeholder="Título da issue" value={title} onChange={(e) => setTitle(e.target.value)} />
        <AutoTextarea
          className="desc-input"
          minRows={5}
          placeholder="Descreva o que precisa ser feito… (vira o prompt do Claude)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="chip-row">
          <Menu
            className="prop-btn"
            trigger={<><StatusIcon status={status} /> {STATUS_LABEL[status]}</>}
            items={STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} />, selected: s === status, onSelect: () => setStatus(s) }))}
          />
          <Menu
            className="prop-btn"
            trigger={<><PriorityIcon priority={priority} /> {PRIORITY_LABEL[priority]}</>}
            items={([0, 1, 2, 3, 4] as Priority[]).map((p) => ({ key: String(p), label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} />, selected: p === priority, onSelect: () => setPriority(p) }))}
          />
          <Menu
            className="prop-btn is-wrap"
            multi
            filter
            width={320}
            trigger={selected.length ? selected.map((r) => <RepoChip key={r.id} repo={r} />) : <><FolderGit2 size={13} /> Repositórios</>}
            items={repos.map((r) => ({
              key: r.name,
              label: r.name,
              icon: <i className="dot" style={{ background: hue(r.name) }} />,
              selected: repoIds.includes(r.id),
              onSelect: () => setRepoIds((ids) => (ids.includes(r.id) ? ids.filter((id) => id !== r.id) : [...ids, r.id])),
            }))}
          />
          <Menu
            className="prop-btn"
            trigger={<><AccountAvatar account={delegate} size={16} /> {delegate?.name ?? 'Delegado'}</>}
            items={[
              { key: 'none', label: 'Ninguém', selected: !delegate, onSelect: () => setDelegateId(null) },
              ...accounts.map((a) => ({ key: a.id, label: a.name, icon: <AccountAvatar account={a} size={16} />, selected: a.id === delegateId, onSelect: () => setDelegateId(a.id) })),
            ]}
          />
        </div>
        {selected.length > 0 && (
          <div className="cwd-hint">
            O agente vai rodar em <code>{relativeTo(workspace.rootPath, commonFolder(workspace, selected))}</code>
            {selected.length > 1 ? `, com o contexto de ${selected.length} repositórios.` : '.'}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- delegar

/** Padrões do workspace para uma sessão nova. */
export function workspaceSettings(workspace: Workspace | null): SessionSettings {
  return {
    permissionMode: workspace?.defaultPermissionMode ?? 'acceptEdits',
    model: workspace?.defaultModel ?? null,
    effort: workspace?.defaultEffort ?? null,
    agent: null,
    fallbackModel: null,
    addDirs: [],
    maxBudgetUsd: null,
  };
}

function DelegateModal({ issueId, mode: initialMode, onClose }: { issueId: string; mode: 'headless' | 'terminal'; onClose: () => void }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { accounts, accountStatus } = useStore(useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus })));
  const issue = useStore((s) => s.issues.find((i) => i.id === issueId));
  const [accountId, setAccountId] = useState(issue?.delegateAccountId ?? workspace?.defaultAccountId ?? accounts[0]?.id ?? '');
  const [mode, setMode] = useState(initialMode);
  const [settings, setSettings] = useState(() => workspaceSettings(workspace));
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);

  if (!workspace || !issue) return null;
  const account = accounts.find((a) => a.id === accountId);
  const status = account ? accountStatus[account.id] : undefined;
  const selected = repos.filter((r) => issue.repoIds.includes(r.id));
  const cwd = commonFolder(workspace, selected);

  const go = async () => {
    setBusy(true);
    try {
      await api.delegate(issue.id, { accountId, ...settingsInput(settings), instructions, mode });
      useStore.getState().set({ modal: null, openIssueId: issue.id });
      toast(mode === 'terminal' ? 'Terminal aberto com o Claude.' : `${account?.name} começou a trabalhar em ${issue.identifier}.`, 'success');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      width={600}
      title={<>Delegar <span className="ident">{issue.identifier}</span></>}
      onClose={onClose}
      footer={
        <>
          {status && !status.loggedIn && <span className="foot-hint is-error">Esta conta não está logada.</span>}
          <button className="primary-btn" onClick={go} disabled={busy || !accountId}>
            {mode === 'terminal' ? <><SquareTerminal size={14} /> Abrir no terminal</> : <><Bot size={14} /> Delegar</>}
          </button>
        </>
      }
    >
      <div className="delegate">
        <div className="mode-pick">
          <button className={mode === 'headless' ? 'is-on' : ''} onClick={() => setMode('headless')}>
            <Bot size={16} />
            <strong>Em segundo plano</strong>
            <span>Acompanhe pensamentos, ações e a resposta aqui na issue.</span>
          </button>
          <button className={mode === 'terminal' ? 'is-on' : ''} onClick={() => setMode('terminal')}>
            <SquareTerminal size={16} />
            <strong>No terminal</strong>
            <span>Abre uma janela com o Claude interativo, como você já faz.</span>
          </button>
        </div>

        <div className="cwd-hint">
          Pasta: <code>{relativeTo(workspace.rootPath, cwd)}</code>
          {selected.length > 1 ? ` · contexto de ${selected.map((r) => r.name.split('/').at(-1)).join(' + ')}` : ''}
        </div>

        <Field label="Conta">
          <Menu
            className="prop-btn"
            trigger={<><AccountAvatar account={account} status={status} size={16} /> {account?.name ?? 'Escolher'}</>}
            items={accounts.map((a) => ({
              key: a.id, label: a.name, hint: accountStatus[a.id]?.email ?? 'sem login', icon: <AccountAvatar account={a} size={16} />,
              selected: a.id === accountId,
              onSelect: () => {
                setAccountId(a.id);
                setSettings((s) => ({ ...s, agent: null }));
              },
            }))}
          />
        </Field>

        {accountId && (
          <SessionSettingsForm
            settings={settings}
            onChange={(changes) => setSettings((s) => ({ ...s, ...changes }))}
            accountId={accountId}
            cwd={cwd}
            mode={mode}
          />
        )}

        <Field label="Instruções adicionais" hint="Opcional. Vai junto com o título e a descrição da issue. Para usar uma skill, cite o nome dela (ex.: use a skill code-review).">
          <AutoTextarea minRows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Ex.: comece pela loja-api e rode os testes no final." />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- conectar pasta

export function WorkspaceConnect({ onDone }: { onDone?: () => void }) {
  const meta = useStore((s) => s.meta);
  const [rootPath, setRootPath] = useState(meta?.suggestedRoot ?? '');
  const [depth, setDepth] = useState(3);
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!rootPath.trim()) return setInspection(null);
    setInspecting(true);
    let current = true;
    // fetch direto (e não api.*) para não exibir um toast de erro a cada tecla digitada.
    const timer = setTimeout(() => {
      fetch('/api/fs/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rootPath, scanDepth: depth }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: FolderInspection | null) => {
          if (!current) return;
          setInspection(data);
          if (data) {
            setName((n) => n || data.name);
            setKey((k) => k || data.name.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase());
          }
        })
        .catch(() => current && setInspection(null))
        .finally(() => current && setInspecting(false));
    }, 350);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [rootPath, depth]);

  const pick = async () => {
    setPicking(true);
    try {
      const { path } = await api.pickFolder();
      if (path) {
        setName('');
        setKey('');
        setRootPath(path);
      }
    } finally {
      setPicking(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    try {
      const workspace = await api.createWorkspace({ rootPath, name, key, scanDepth: depth });
      useStore.getState().selectWorkspace(workspace.id);
      useStore.getState().set({ view: 'issues' });
      toast(`Workspace "${workspace.name}" conectado.`, 'success');
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <Field label="Pasta raiz" hint="A pasta que contém seus repositórios — a mesma em que você abriria o cmd para rodar o claude.">
        <div className="input-row">
          <input className="input mono" value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="C:\Users\voce\projetos" />
          <button className="ghost-btn" onClick={pick} disabled={picking}><FolderSearch size={14} /> {picking ? 'Aguardando…' : 'Escolher…'}</button>
        </div>
      </Field>

      <div className="connect-preview">
        {inspection ? (
          <>
            <div className="connect-count"><strong>{inspection.repos.length}</strong> repositórios git encontrados</div>
            <div className="connect-repos">
              {inspection.repos.slice(0, 40).map((r) => (
                <span key={r} className="repo-chip"><i style={{ background: hue(r) }} />{r === '.' ? '(a própria pasta)' : r}</span>
              ))}
              {inspection.repos.length > 40 && <span className="dim">+{inspection.repos.length - 40}</span>}
            </div>
          </>
        ) : (
          <span className="dim">
            {!rootPath.trim() ? 'Escolha uma pasta para ver os repositórios.' : inspecting ? 'Procurando repositórios…' : 'Pasta não encontrada.'}
          </span>
        )}
      </div>

      <div className="settings-row">
        <Field label="Nome"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Prefixo"><input className="input mono" value={key} maxLength={6} onChange={(e) => setKey(e.target.value.toUpperCase())} /></Field>
        <Field label="Profundidade"><input className="input" type="number" min={1} max={6} value={depth} onChange={(e) => setDepth(Number(e.target.value) || 3)} /></Field>
      </div>
      <div className="connect-actions">
        <button className="primary-btn" onClick={connect} disabled={busy || inspecting || !inspection}>
          {busy ? 'Escaneando…' : 'Conectar workspace'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- conta

function AccountModal({ onClose }: { onClose: () => void }) {
  const home = useStore((s) => s.meta?.home ?? '~');
  const [name, setName] = useState('');
  const [configDir, setConfigDir] = useState('');
  const [inherit, setInherit] = useState(true);
  const [busy, setBusy] = useState(false);
  const slug = name.normalize('NFD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'trabalho';
  const sep = home.includes('\\') ? '\\' : '/';

  const create = async (login: boolean) => {
    setBusy(true);
    try {
      const account = await api.createAccount({ name, configDir, inherit });
      if (login) await api.login(account.id);
      toast(login ? 'Conclua o login no terminal que abriu.' : `Conta "${account.name}" adicionada.`, 'success');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Adicionar conta do Claude"
      onClose={onClose}
      footer={
        <>
          <button className="ghost-btn" onClick={() => create(false)} disabled={!name.trim() || busy}>Só adicionar</button>
          <button className="primary-btn" onClick={() => create(true)} disabled={!name.trim() || busy}>Adicionar e fazer login</button>
        </>
      }
    >
      <div className="stack-form">
        <Field label="Nome"><input autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Trabalho" /></Field>
        <Field label="Pasta de configuração" hint="Deixe em branco para criar uma nova. Aponte para uma existente se você já usa CLAUDE_CONFIG_DIR.">
          <input className="input mono" value={configDir} onChange={(e) => setConfigDir(e.target.value)} placeholder={`${home}${sep}.claude-${slug}`} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
          <span>Copiar minhas preferências da conta principal (settings.json, CLAUDE.md, agents, commands, skills). Credenciais e histórico não são copiados.</span>
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- preferências

/** Onde o Claude abre (terminal) e onde o projeto abre (editor). Só lista o que está instalado. */
function PreferencesModal({ onClose }: { onClose: () => void }) {
  const integrations = useIntegrations();
  const platform = useStore((s) => s.meta?.platform);
  const version = useStore((s) => s.meta?.version);
  const checkUpdates = useStore((s) => s.preferences.checkUpdates);
  const choose = (body: { terminal?: string; editor?: string }) => void api.setPreferences(body).then(() => toast('Preferência salva.', 'success'));

  return (
    <Modal
      width={620}
      title={<><Settings2 size={15} /> Preferências</>}
      onClose={onClose}
      footer={<span className="foot-hint dim">Octo {version} · <a href="https://github.com/KazuoMurakami/octo-desktop/releases" target="_blank" rel="noreferrer">novidades</a></span>}
    >
      <div className="stack-form">
        <Field
          label="Terminal"
          hint={platform === 'win32'
            ? 'A janela abre no app de terminal padrão do Windows (Windows Terminal ou o console clássico). Para trocar: Configurações › Sistema › Para desenvolvedores › Terminal.'
            : 'Onde o Claude interativo e o "Terminal aqui" abrem.'}
        >
          <div className="choice-list">
            {(integrations?.terminals ?? []).map((t) => (
              <button key={t.id} type="button" className={`choice${integrations?.terminal === t.id ? ' is-on' : ''}`} onClick={() => choose({ terminal: t.id })}>
                <SquareTerminal size={15} />
                <strong>{t.label}</strong>
                {t.hint && <span className="mono dim">{t.hint}</span>}
              </button>
            ))}
            {!integrations && <span className="dim">Procurando terminais…</span>}
          </div>
        </Field>
        <Field label="Atualizações" hint="Consulta a página de releases do GitHub no máximo a cada 6 horas. É a única conexão que o Octo faz por conta própria.">
          <label className="check">
            <input type="checkbox" checked={checkUpdates} onChange={(e) => void api.setPreferences({ checkUpdates: e.target.checked })} />
            Avisar quando sair uma versão nova do Octo
          </label>
        </Field>
        <Field label="Editor" hint="Usado em “Abrir em…”. Com vários repositórios, o Octo abre um workspace com todos eles, e a aba de controle de versão do editor mostra as mudanças de cada um.">
          <div className="choice-list">
            {(integrations?.editors ?? []).map((e) => (
              <button key={e.id} type="button" className={`choice${integrations?.editor === e.id ? ' is-on' : ''}`} onClick={() => choose({ editor: e.id })}>
                <Code2 size={15} />
                <strong>{e.label}</strong>
              </button>
            ))}
            {integrations && !integrations.editors.length && (
              <span className="dim">Nenhum editor encontrado. O Octo procura VS Code, Cursor, Windsurf e Zed.</span>
            )}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- mudanças de uma pasta

function ChangesModal({ dir, title, onClose }: { dir: string; title: string; onClose: () => void }) {
  const workspace = useWorkspace();
  const fetcher = useCallback(() => api.folderChanges(workspace?.id ?? '', dir), [workspace?.id, dir]);
  if (!workspace) return null;
  return (
    <Modal width={900} title={<><FileDiff size={15} /> Mudanças · {title}</>} onClose={onClose}>
      <ChangesView fetcher={fetcher} target={{ kind: 'folder', workspaceId: workspace.id, dir }} emptyText="Nenhuma mudança desde o último commit." />
    </Modal>
  );
}

// ---------------------------------------------------------------- CLAUDE.md

function ContextModal({ dir, onClose }: { dir?: string; onClose: () => void }) {
  const workspace = useWorkspace();
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (workspace) void api.context(workspace.id, dir).then(setInfo);
  }, [workspace, dir]);
  const where = useMemo(() => (workspace && dir ? relativeTo(workspace.rootPath, dir) : 'raiz'), [workspace, dir]);
  if (!workspace) return null;

  const write = async () => {
    setBusy(true);
    try {
      const { file } = await api.writeContext(workspace.id, dir);
      toast(`Contexto salvo em ${file}`, 'success');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      width={760}
      title={<><FileText size={15} /> CLAUDE.md · {where}</>}
      onClose={onClose}
      footer={
        <>
          <span className="foot-hint dim">
            {info?.exists ? (info.managed ? 'Atualiza só o bloco do Octo no arquivo existente.' : 'Acrescenta o bloco ao fim do seu CLAUDE.md, sem apagar nada.') : 'Cria o arquivo.'}
          </span>
          <button className="primary-btn" onClick={write} disabled={busy || !info}>{info?.managed ? 'Atualizar' : 'Gravar'} CLAUDE.md</button>
        </>
      }
    >
      <p className="block-sub">
        Com este arquivo na pasta, qualquer <code>claude</code> aberto ali (inclusive pelo seu “cmd → claude” de sempre) já sabe quais
        repositórios existem, onde ficam e como rodar cada um.
      </p>
      <pre className="context-preview">{info?.preview ?? 'Gerando…'}</pre>
    </Modal>
  );
}
