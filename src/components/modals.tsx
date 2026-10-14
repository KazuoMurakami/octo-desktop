import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Code2, FileDiff, FileText, FolderGit2, FolderSearch, LogIn, Settings2, SquareTerminal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import {
  PRIORITY_LABEL, STATUSES, STATUS_LABEL,
  type IssueStatus, type Priority, type SessionSettings, type Workspace,
} from '../../shared/types.ts';
import { api, settingsInput, type ContextInfo, type FolderInspection } from '../api.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { useIntegrations } from '../integrations.ts';
import { commonFolder, hue, modKey, relativeTo } from '../util.ts';
import { loginHint, startLogin } from './AccountsView.tsx';
import { ChangesView } from './ChangesView.tsx';
import { AccountAvatar, PriorityIcon, StatusIcon } from './icons.tsx';
import { folderLabel } from './OpenMenu.tsx';
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

// ---------------------------------------------------------------- confirmação de ações destrutivas

/**
 * Pergunta antes de uma ação que não dá para desfazer, dizendo o que vai acontecer. O foco começa
 * em "Cancelar": um Enter distraído não apaga nada. Aberta sobre outro modal ou sobre o painel da
 * issue, o Esc fecha só ela (é a camada de cima).
 */
export function ConfirmDialog({ title, children, confirmLabel, busyLabel = 'Aguarde…', tone = 'danger', onConfirm, onClose }: {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: 'danger' | 'primary';
  /** Pode ser assíncrona: o diálogo espera e só fecha se der certo (o erro já vira aviso em api.ts). */
  onConfirm: () => unknown;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      setBusy(false);
      return;
    }
    onClose();
  };

  return (
    <Modal
      width={480}
      title={title}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="ghost-btn" autoFocus onClick={onClose} disabled={busy}>Cancelar</button>
          <button className={tone === 'danger' ? 'danger-btn' : 'primary-btn'} onClick={() => void confirm()} disabled={busy}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{children}</div>
    </Modal>
  );
}

// ---------------------------------------------------------------- nova issue

function NewIssueModal({ status: initialStatus, repoIds: initialRepos, onClose }: { status?: IssueStatus; repoIds?: string[]; onClose: () => void }) {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const { accounts, accountStatus } = useStore(useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus })));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<IssueStatus>(initialStatus ?? 'todo');
  const [priority, setPriority] = useState<Priority>(0);
  const [repoIds, setRepoIds] = useState<string[]>(initialRepos ?? []);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!workspace) return null;
  const selected = repos.filter((r) => repoIds.includes(r.id));
  const account = accounts.find((a) => a.id === accountId);
  const workspaceAccount = accounts.find((a) => a.id === workspace.defaultAccountId) ?? accounts[0];

  const submit = async (thenDelegate: boolean) => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const issue = await api.createIssue(workspace.id, { title, description, status, priority, repoIds, delegateAccountId: accountId });
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
      dirty={Boolean(title.trim() || description.trim())}
      footer={
        <>
          <span className="dim foot-hint"><Kbd>{modKey()}</Kbd> <Kbd>Enter</Kbd> para criar</span>
          <button className="ghost-btn" onClick={() => submit(true)} disabled={!title.trim() || busy}>
            <Bot size={14} /> {account ? `Criar e delegar a ${account.name}` : 'Criar e delegar'}
          </button>
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
        <input autoFocus className="title-input" placeholder="Título da issue" aria-label="Título da issue" value={title} onChange={(e) => setTitle(e.target.value)} />
        <AutoTextarea
          className="desc-input"
          minRows={5}
          placeholder="Descreva o que precisa ser feito… (vira o prompt do Claude)"
          aria-label="Descrição"
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
          {/* Só escolhe a conta usada ao delegar; quem inicia o trabalho é "Criar e delegar". */}
          <span className="has-tooltip" title="A conta do Claude que vai trabalhar nesta issue quando você delegar. Escolher aqui não inicia nada: para o Claude começar, use “Criar e delegar”.">
            <Menu
              className="prop-btn"
              width={300}
              trigger={<><AccountAvatar account={account} size={16} /> {account ? account.name : 'Conta'}</>}
              items={[
                { key: 'default', label: 'Padrão do workspace', hint: workspaceAccount?.name ?? '', selected: !account, onSelect: () => setAccountId(null) },
                ...accounts.map((a) => ({
                  key: a.id, label: a.name, hint: loginHint(accountStatus[a.id]), icon: <AccountAvatar account={a} size={16} />,
                  selected: a.id === accountId, onSelect: () => setAccountId(a.id),
                })),
              ]}
            />
          </span>
        </div>
        {selected.length > 0 && (
          <div className="cwd-hint">
            O agente vai rodar em <code>{folderLabel(workspace, commonFolder(workspace, selected))}</code>
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
  const [checking, setChecking] = useState(false);

  if (!workspace || !issue) return null;
  const account = accounts.find((a) => a.id === accountId);
  const status = account ? accountStatus[account.id] : undefined;
  const selected = repos.filter((r) => issue.repoIds.includes(r.id));
  const cwd = commonFolder(workspace, selected);
  // Sem login confirmado pelo `claude auth status`. Se a verificação falhou, não dá para afirmar nada.
  const needsLogin = Boolean(account && status && !status.loggedIn && !status.error);
  const headlessWithoutLogin = needsLogin && mode === 'headless';

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

  const verify = async () => {
    if (!account) return;
    setChecking(true);
    try {
      const next = await api.refreshAccount(account.id);
      if (!next.loggedIn) toast(next.error ? `Não foi possível verificar: ${next.error}` : 'Ainda sem login nesta conta.');
    } catch {
      /* o aviso de erro já apareceu */
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal
      width={600}
      title={<>Delegar <span className="ident">{issue.identifier}</span></>}
      onClose={onClose}
      dirty={Boolean(instructions.trim())}
      footer={
        <>
          {account && !status && <span className="foot-hint dim">Verificando o login da conta…</span>}
          {status?.error && !status.loggedIn && (
            <span className="foot-hint is-warn" title={status.error}>Não foi possível verificar o login desta conta.</span>
          )}
          <button className={headlessWithoutLogin ? 'ghost-btn' : 'primary-btn'} onClick={go} disabled={busy || !accountId}>
            {mode === 'terminal'
              ? <><SquareTerminal size={14} /> Abrir no terminal</>
              : <><Bot size={14} /> {headlessWithoutLogin ? 'Delegar mesmo assim' : 'Delegar'}</>}
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
          Pasta: <code>{folderLabel(workspace, cwd)}</code>
          {selected.length > 1 ? ` · contexto de ${selected.map((r) => r.name.split('/').at(-1)).join(' + ')}` : ''}
        </div>

        <Field label="Conta">
          <Menu
            className="prop-btn"
            trigger={<><AccountAvatar account={account} status={status} size={16} /> {account?.name ?? 'Escolher'}</>}
            items={accounts.map((a) => ({
              key: a.id, label: a.name, hint: loginHint(accountStatus[a.id]), icon: <AccountAvatar account={a} size={16} />,
              selected: a.id === accountId,
              onSelect: () => {
                setAccountId(a.id);
                setSettings((s) => ({ ...s, agent: null }));
              },
            }))}
          />
        </Field>

        {needsLogin && account && (
          <div className="login-needed" role="status">
            <LogIn size={15} />
            <div>
              <strong>{account.name} ainda não fez login no Claude Code.</strong>
              <span>
                {mode === 'headless'
                  ? 'Em segundo plano, a sessão para logo no começo sem o login.'
                  : 'No terminal, o próprio Claude pede o login ao abrir.'}
              </span>
              <div className="login-needed-actions">
                <button className="primary-btn is-small" onClick={() => void startLogin(account).catch(() => undefined)}>Fazer login</button>
                <button className="ghost-btn is-small" onClick={() => void verify()} disabled={checking}>{checking ? 'Verificando…' : 'Já fiz, verificar'}</button>
              </div>
            </div>
          </div>
        )}

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

const samePath = (a: string, b: string) =>
  a.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === b.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/**
 * Raiz do disco, uma pasta logo abaixo dela (C:\Users, /home) ou a pasta pessoal: varrer isso
 * leva tempo (passa por AppData, Library…) e raramente é o que se quer. Só a pedido.
 */
function isBroadPath(input: string, home: string | undefined): boolean {
  const raw = input.trim();
  if (!raw) return false;
  if (/^[\\/]+$/.test(raw)) return true;
  if (home && samePath(raw, home)) return true;
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts.length <= (/^[a-z]:$/i.test(parts[0] ?? '') ? 2 : 1);
}

const DEPTHS = [1, 2, 3, 4, 5, 6];

export function WorkspaceConnect({ onDone }: { onDone?: () => void }) {
  const meta = useStore((s) => s.meta);
  const workspaces = useStore((s) => s.workspaces);
  const home = meta?.home;
  const sep = home?.includes('\\') ? '\\' : '/';
  // Quando o Octo não acha uma pasta de projetos, a sugestão cai na pasta pessoal: aí é melhor não
  // sugerir nada. Também não sugere uma pasta que já está conectada.
  const [rootPath, setRootPath] = useState(() => {
    const suggested = meta?.suggestedRoot ?? '';
    const taken = useStore.getState().workspaces.some((w) => samePath(w.rootPath, suggested));
    return !suggested || taken || (home && samePath(suggested, home)) ? '' : suggested;
  });
  const [depth, setDepth] = useState(3);
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  /** Caminho amplo que você pediu para varrer mesmo assim. */
  const [forced, setForced] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  /** Nome e prefixo digitados por você não são trocados pela sugestão da pasta. */
  const edited = useRef({ name: false, key: false });
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const path = rootPath.trim();
  const broad = isBroadPath(path, home);
  const waiting = broad && forced !== path;
  const existing = path ? workspaces.find((w) => samePath(w.rootPath, path)) : undefined;

  const openExisting = (workspace: Workspace) => {
    useStore.getState().selectWorkspace(workspace.id);
    useStore.getState().set({ view: 'issues' });
    onDone?.();
  };

  const connected = Boolean(existing);
  useEffect(() => {
    setInspection(null);
    setInspectError(null);
    if (!path || waiting || connected) return setInspecting(false);
    setInspecting(true);
    const controller = new AbortController();
    // Espera uma pausa na digitação e cancela a busca anterior quando o caminho muda.
    const timer = setTimeout(() => {
      api.inspectFolder(path, depth, controller.signal)
        .then((data) => {
          setInspection(data);
          if (!edited.current.name) setName(data.name);
          if (!edited.current.key) setKey(data.name.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase());
        })
        .catch((error: Error) => {
          if (error.name !== 'AbortError') setInspectError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setInspecting(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [path, depth, waiting, connected]);

  const pick = async () => {
    setPicking(true);
    try {
      const { path: chosen } = await api.pickFolder();
      if (chosen) {
        edited.current = { name: false, key: false };
        setForced(chosen.trim()); // escolhida no diálogo: é a pasta que você quer, mesmo se for ampla
        setRootPath(chosen);
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
      toast(`Pasta "${workspace.name}" conectada.`, 'success');
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const levels = `${depth} ${depth === 1 ? 'nível' : 'níveis'}`;
  const found = inspection?.repos.length ?? 0;
  const prefix = key || 'OCT';

  return (
    <div className="connect">
      <Field label="Pasta raiz" hint="A pasta que contém seus repositórios: a mesma em que você abriria o terminal para rodar o claude.">
        <div className="input-row">
          <input
            className="input mono"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && path && setForced(path)}
            placeholder={home ? `${home}${sep}projetos` : 'Caminho da pasta'}
            aria-label="Pasta raiz"
          />
          <button className="ghost-btn" onClick={pick} disabled={picking}><FolderSearch size={14} /> {picking ? 'Aguardando…' : 'Escolher…'}</button>
        </div>
      </Field>

      <div className="connect-preview" aria-live="polite">
        {existing ? (
          <div className="connect-broad">
            <span>Esta pasta já está conectada como “{existing.name}”.</span>
            <button className="ghost-btn is-small" onClick={() => openExisting(existing)}>Abrir “{existing.name}”</button>
          </div>
        ) : inspection ? (
          <>
            <div className="connect-count"><strong>{found}</strong> {found === 1 ? 'repositório git encontrado' : 'repositórios git encontrados'}</div>
            {found === 0 ? (
              <p className="connect-empty">
                Nenhum repositório git até {levels} abaixo desta pasta. Escolha a pasta que contém seus projetos ou aumente a profundidade.
              </p>
            ) : (
              <div className="connect-repos">
                {inspection.repos.slice(0, 40).map((r) => (
                  <span key={r} className="repo-chip"><i style={{ background: hue(r) }} />{r === '.' ? '(a própria pasta)' : r}</span>
                ))}
                {inspection.repos.length > 40 && <span className="dim">+{inspection.repos.length - 40}</span>}
              </div>
            )}
            {inspection.partial && (
              <p className="connect-empty">
                A busca parou no limite de pastas, então a lista pode estar incompleta. Escolha uma pasta mais específica ou diminua a profundidade.
              </p>
            )}
          </>
        ) : !path ? (
          <span className="dim">Escolha uma pasta para ver os repositórios.</span>
        ) : waiting ? (
          <div className="connect-broad">
            <span>
              {home && samePath(path, home) ? 'Esta é a sua pasta pessoal' : 'Esta pasta é muito ampla'}: procurar repositórios nela pode demorar.
              Escolha a pasta onde ficam seus projetos ou procure assim mesmo.
            </span>
            <button className="ghost-btn is-small" onClick={() => setForced(path)}>Procurar assim mesmo</button>
          </div>
        ) : inspecting ? (
          <span className="dim">Procurando repositórios…</span>
        ) : (
          <span className="dim">{inspectError ?? 'Pasta não encontrada.'}</span>
        )}
      </div>

      <div className="settings-row">
        <Field label="Nome" hint="Como a pasta aparece no Octo.">
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); edited.current.name = true; }} />
        </Field>
        <Field label="Prefixo" hint={`Vira o ID das issues: ${prefix}-1, ${prefix}-2…`}>
          <input
            className="input mono"
            value={key}
            maxLength={6}
            onChange={(e) => { setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); edited.current.key = true; }}
          />
        </Field>
        <Field label="Profundidade" hint="Quantos níveis de subpastas procurar (3 = pasta › grupo › repositório).">
          <select className="input" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            {DEPTHS.map((n) => <option key={n} value={n}>{n} {n === 1 ? 'nível' : 'níveis'}</option>)}
          </select>
        </Field>
      </div>
      <div className="connect-actions">
        <button className="primary-btn" onClick={connect} disabled={busy || inspecting || !inspection || Boolean(existing)}>
          {busy ? 'Escaneando…' : found === 0 && inspection ? 'Conectar mesmo assim' : 'Conectar pasta'}
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
      // A conta já existe: o modal fecha mesmo que o terminal do login não abra (dá para tentar em Contas).
      onClose();
      if (login) await startLogin(account).catch(() => undefined);
      else toast(`Conta "${account.name}" adicionada.`, 'success');
    } catch {
      setBusy(false); // o aviso de erro já apareceu (api.ts)
    }
  };

  return (
    <Modal
      title="Adicionar conta do Claude"
      onClose={onClose}
      dirty={Boolean(name.trim() || configDir.trim())}
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
  const fetcher = useCallback(() => api.folderChanges(workspace?.id ?? '', dir, true), [workspace?.id, dir]);
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
  const workspaceId = workspace?.id;
  const [info, setInfo] = useState<ContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  // Depende só do id: o workspace muda a cada issue criada, e a prévia não precisa ser refeita por isso.
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setError(null);
    api.context(workspaceId, dir, true)
      .then((next) => alive && setInfo(next))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [workspaceId, dir, attempt]);
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
        Com este arquivo na pasta, qualquer <code>claude</code> aberto ali (inclusive o que você abre no terminal, como sempre) já sabe quais
        repositórios existem, onde ficam e como rodar cada um.
      </p>
      {error && !info ? (
        <div className="inline-error">
          Não foi possível gerar a prévia: {error}{' '}
          <button className="link-btn" onClick={() => setAttempt((n) => n + 1)}>Tentar de novo</button>
        </div>
      ) : (
        <pre className="context-preview">{info?.preview ?? 'Gerando…'}</pre>
      )}
    </Modal>
  );
}
