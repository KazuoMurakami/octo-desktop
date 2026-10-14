import { useEffect, useMemo, useState } from 'react';
import { Code2, ExternalLink, FileDiff, FileText, FolderOpen, GitBranch, Plus, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { Workspace } from '../../shared/types.ts';
import { api } from '../api.ts';
import { setting, useAccountConfig } from '../claudeConfig.ts';
import { openClaudeIn } from '../integrations.ts';
import { toast, useStore, useWorkspace, useWorkspaceRepos } from '../store.ts';
import { ago, hue, repoGroups, shortRepoName } from '../util.ts';
import { loginHint } from './AccountsView.tsx';
import { AccountAvatar } from './icons.tsx';
import { ConfirmDialog } from './modals.tsx';
import { OpenMenu, openInEditor } from './OpenMenu.tsx';
import { EffortPicker, ModelPicker, PermissionPicker } from './SessionSettings.tsx';
import { AutoTextarea, Field, Menu, RepoChip } from './ui.tsx';

const DEPTHS = [1, 2, 3, 4, 5, 6];

/** Procura os repositórios de novo e diz quantos achou. */
async function rescan(workspace: Workspace): Promise<void> {
  const found = await api.scan(workspace.id);
  toast(`${found.length} ${found.length === 1 ? 'repositório encontrado' : 'repositórios encontrados'}.`, 'success');
}

/** Muda a profundidade da busca; o servidor já procura os repositórios de novo antes de responder. */
async function changeScanDepth(workspace: Workspace, scanDepth: number): Promise<void> {
  await api.updateWorkspace(workspace.id, { scanDepth });
  toast(`Profundidade salva (${scanDepth} ${scanDepth === 1 ? 'nível' : 'níveis'}). Os repositórios foram procurados de novo.`, 'success');
}

export function ReposView() {
  const workspace = useWorkspace();
  const repos = useWorkspaceRepos();
  const set = useStore((s) => s.set);
  const [scanning, setScanning] = useState(false);
  const groups = useMemo(() => (workspace ? repoGroups(workspace, repos).filter((g) => g.repos.length > 1) : []), [workspace, repos]);

  if (!workspace) return null;
  const open = (dir?: string) => void openClaudeIn(workspace.id, dir);
  const scan = async (depth?: number) => {
    setScanning(true);
    try {
      if (depth === undefined) await rescan(workspace);
      else await changeScanDepth(workspace, depth);
    } catch {
      /* o aviso de erro já apareceu (api.ts) */
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="view view-scroll">
      <header className="view-head">
        <h1>Repositórios</h1>
        <span className="mono dim root-path" title={workspace.rootPath}>{workspace.rootPath}</span>
        <div className="view-tools">
          <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id }} className="ghost-btn" />
          <button className="ghost-btn" onClick={() => set({ modal: { kind: 'changes', dir: workspace.rootPath, title: workspace.name } })}><FileDiff size={14} /> Mudanças</button>
          <button className="ghost-btn" onClick={() => void scan()} disabled={scanning}><RefreshCw size={14} className={scanning ? 'spin' : ''} /> Reescanear</button>
          <button className="ghost-btn" onClick={() => set({ modal: { kind: 'context' } })}><FileText size={14} /> CLAUDE.md da raiz</button>
          <button className="primary-btn" onClick={() => open()}><SquareTerminal size={14} /> Abrir Claude na raiz</button>
        </div>
      </header>

      {groups.length > 0 && (
        <>
          <h2 className="block-title">Pastas que agrupam repositórios</h2>
          <p className="block-sub">Abrir o Claude numa destas pastas dá a ele o contexto de todos os repositórios dela, sem um Claude por repo.</p>
          <div className="groups">
            {groups.map((group) => (
              <div key={group.rel} className="group-card">
                <div className="group-name"><FolderOpen size={15} /> {group.rel}</div>
                <div className="group-repos">{group.repos.map((r) => <RepoChip key={r.id} repo={r} />)}</div>
                <div className="group-actions">
                  <button className="primary-btn is-small" onClick={() => open(group.dir)}><SquareTerminal size={13} /> Claude aqui</button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'new-issue', repoIds: group.repos.map((r) => r.id) } })}><Plus size={13} /> Issue</button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'context', dir: group.dir } })} title="Gerar CLAUDE.md desta pasta" aria-label="Gerar CLAUDE.md desta pasta"><FileText size={13} /></button>
                  <button className="ghost-btn is-small" onClick={() => set({ modal: { kind: 'changes', dir: group.dir, title: group.rel } })} title="Ver o que mudou nos repositórios desta pasta" aria-label="Ver mudanças desta pasta"><FileDiff size={13} /></button>
                  <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id, dir: group.dir, repoIds: group.repos.map((r) => r.id) }} trigger={<Code2 size={13} />} label="Abrir esta pasta em…" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="block-title">Todos os repositórios <span className="dim">{repos.length}</span></h2>
      {repos.length === 0 ? (
        <div className="repos-empty">
          <p>
            Nenhum repositório git até {workspace.scanDepth} {workspace.scanDepth === 1 ? 'nível' : 'níveis'} abaixo de{' '}
            <span className="mono">{workspace.rootPath}</span>. Se os projetos ficam mais fundo, aumente a profundidade; se a pasta acabou de
            receber repositórios, reescaneie.
          </p>
          <div className="empty-actions">
            <button className="ghost-btn" onClick={() => void scan()} disabled={scanning}><RefreshCw size={14} className={scanning ? 'spin' : ''} /> Reescanear</button>
            {workspace.scanDepth < 6 && (
              <button className="ghost-btn" onClick={() => void scan(workspace.scanDepth + 1)} disabled={scanning}>
                Procurar até {workspace.scanDepth + 1} níveis
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="repo-table">
          <div className="repo-tr is-head">
            <span>Repositório</span><span>Branch</span><span>Alterações</span><span>Stack</span><span>Último commit</span><span />
          </div>
          {repos.map((repo) => (
            <div key={repo.id} className="repo-tr">
              <span className="repo-name">
                <i style={{ background: hue(repo.name) }} />
                <span>
                  <strong>{shortRepoName(repo)}</strong>
                  {repo.name.includes('/') && <small className="dim mono">{repo.name.split('/').slice(0, -1).join('/')}/</small>}
                  {repo.description && <small className="dim repo-desc">{repo.description}</small>}
                </span>
              </span>
              <span className="mono">
                <GitBranch size={12} /> <span className="branch-name" title={repo.branch ?? ''}>{repo.branch ?? '—'}</span>
                {(repo.ahead ?? 0) > 0 && <em className="ahead" title={`${repo.ahead} commit(s) para enviar`}>↑{repo.ahead}</em>}
                {(repo.behind ?? 0) > 0 && <em className="behind" title={`${repo.behind} commit(s) para receber`}>↓{repo.behind}</em>}
              </span>
              <span>
                {repo.dirty === null ? '—' : repo.dirty === 0 ? <span className="dim">limpo</span> : (
                  <button className="dirty-btn" title="Ver as mudanças" onClick={() => set({ modal: { kind: 'changes', dir: repo.absPath, title: repo.name } })}>
                    <em className="dirty">{repo.dirty}</em>
                  </button>
                )}
              </span>
              <span className="stack">
                {repo.stack.slice(0, 4).map((s) => <span key={s} className="tag">{s}</span>)}
                {repo.hasClaudeMd && <span className="tag is-claude" title="Tem CLAUDE.md próprio">CLAUDE.md</span>}
              </span>
              <span className="dim" title={repo.lastCommitMessage ?? ''}>{ago(repo.lastCommitAt)}</span>
              <span className="repo-actions">
                <button className="icon-btn" title="Abrir o Claude neste repositório" aria-label={`Abrir o Claude em ${repo.name}`} onClick={() => open(repo.absPath)}><SquareTerminal size={14} /></button>
                <button className="icon-btn" title="Abrir no editor" aria-label={`Abrir ${repo.name} no editor`} onClick={() => void openInEditor({ kind: 'folder', workspaceId: workspace.id, dir: repo.absPath }).catch(() => undefined)}><Code2 size={14} /></button>
                <OpenMenu target={{ kind: 'folder', workspaceId: workspace.id, dir: repo.absPath }} className="icon-btn" trigger={<FolderOpen size={14} />} label={`Abrir ${repo.name} em…`} />
                {repo.remoteUrl?.startsWith('http') && (
                  <a className="icon-btn" title={repo.remoteUrl} aria-label={`Abrir ${repo.name} no navegador`} href={repo.remoteUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /></a>
                )}
                <button className="icon-btn" title="Nova issue neste repositório" aria-label={`Nova issue em ${repo.name}`} onClick={() => set({ modal: { kind: 'new-issue', repoIds: [repo.id] } })}><Plus size={14} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      <h2 className="block-title">Configuração do workspace</h2>
      {/* A key recria os campos ao trocar de workspace: nada digitado num vai parar no outro. */}
      <WorkspaceSettings key={workspace.id} workspace={workspace} />
    </section>
  );
}

function WorkspaceSettings({ workspace }: { workspace: Workspace }) {
  const { accounts, accountStatus, issues, sessions } = useStore(
    useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, issues: s.issues, sessions: s.sessions })),
  );
  const [guidance, setGuidance] = useState(workspace.guidance);
  const [prefix, setPrefix] = useState(workspace.key);
  const [rescanning, setRescanning] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const { config } = useAccountConfig(workspace.defaultAccountId);

  useEffect(() => setGuidance(workspace.guidance), [workspace.guidance]);
  useEffect(() => setPrefix(workspace.key), [workspace.key]);

  const defaultAccount = accounts.find((a) => a.id === workspace.defaultAccountId);
  const nextNumber = workspace.issueCounter + 1;

  const savePrefix = async () => {
    // Mesma regra do servidor: maiúsculas, letras e números, até 6.
    const next = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!next || next === workspace.key) return setPrefix(workspace.key);
    try {
      const saved = await api.updateWorkspace(workspace.id, { key: next });
      setPrefix(saved.key);
      toast(`Prefixo salvo. As próximas issues serão ${saved.key}-${saved.issueCounter + 1}, ${saved.key}-${saved.issueCounter + 2}…`, 'success');
    } catch {
      setPrefix(workspace.key);
    }
  };

  const changeDepth = async (scanDepth: number) => {
    setRescanning(true);
    try {
      await changeScanDepth(workspace, scanDepth);
    } catch {
      /* o aviso de erro já apareceu */
    } finally {
      setRescanning(false);
    }
  };

  const ownIssues = issues.filter((i) => i.workspaceId === workspace.id).length;
  const ownSessions = sessions.filter((s) => s.workspaceId === workspace.id);
  const running = ownSessions.filter((s) => s.state === 'active' || s.state === 'pending').length;
  const lost = [
    ownIssues ? (ownIssues === 1 ? 'a issue' : `as ${ownIssues} issues`) : '',
    ownSessions.length ? (ownSessions.length === 1 ? 'a sessão' : `as ${ownSessions.length} sessões`) : '',
  ].filter(Boolean).join(' e ');

  return (
    <div className="settings">
      <Field label="Diretrizes para o agente" hint="Instruções que todo agente deste workspace recebe (ex.: gerenciador de pacotes, padrão de commits). Também vão para o CLAUDE.md gerado.">
        <AutoTextarea
          minRows={4}
          value={guidance}
          placeholder={'Ex.: Use pnpm. Commits em português no padrão Conventional Commits.\nO front (loja-web) consome a loja-api.'}
          onChange={(e) => setGuidance(e.target.value)}
          onBlur={() => guidance !== workspace.guidance && void api.updateWorkspace(workspace.id, { guidance }).then(() => toast('Diretrizes salvas.', 'success'), () => undefined)}
        />
      </Field>
      <div className="settings-row">
        <Field label="Conta padrão">
          <Menu
            className="prop-btn"
            trigger={<><AccountAvatar account={defaultAccount} size={16} /> {defaultAccount?.name ?? 'Nenhuma'}</>}
            items={accounts.map((a) => ({
              key: a.id, label: a.name, hint: loginHint(accountStatus[a.id]), icon: <AccountAvatar account={a} size={16} />,
              selected: a.id === workspace.defaultAccountId, onSelect: () => void api.updateWorkspace(workspace.id, { defaultAccountId: a.id }).catch(() => undefined),
            }))}
          />
        </Field>
        <Field label="Permissões padrão">
          <PermissionPicker
            value={workspace.defaultPermissionMode}
            onChange={(m) => api.updateWorkspace(workspace.id, { defaultPermissionMode: m }).then(() => toast('Permissões padrão salvas.', 'success'))}
          />
        </Field>
        <Field label="Modelo padrão">
          <ModelPicker
            value={workspace.defaultModel}
            onChange={(model) => void api.updateWorkspace(workspace.id, { defaultModel: model }).catch(() => undefined)}
            accountDefault={setting(config, 'model')}
          />
        </Field>
        <Field label="Prefixo das issues" hint={`Vale para as próximas issues (${prefix || workspace.key}-${nextNumber}…).`}>
          <input
            className="input mono"
            value={prefix}
            maxLength={6}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onBlur={() => void savePrefix()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </Field>
        <Field label="Profundidade da busca" hint={rescanning ? 'Procurando os repositórios de novo…' : 'Quantos níveis de subpastas procurar. Ao mudar, o Octo procura de novo.'}>
          <select className="input" value={workspace.scanDepth} disabled={rescanning} onChange={(e) => void changeDepth(Number(e.target.value))}>
            {DEPTHS.map((n) => <option key={n} value={n}>{n} {n === 1 ? 'nível' : 'níveis'}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Esforço padrão (effort)" hint="Vale para as sessões novas deste workspace, inclusive o “Claude aqui”. Dá para trocar em cada delegação.">
        <EffortPicker
          value={workspace.defaultEffort}
          onChange={(effort) => void api.updateWorkspace(workspace.id, { defaultEffort: effort }).catch(() => undefined)}
          accountDefault={setting(config, 'effortLevel')}
        />
      </Field>
      <button className="ghost-btn is-danger" onClick={() => setConfirmDisconnect(true)}>
        <Trash2 size={14} /> Desconectar workspace
      </button>

      {confirmDisconnect && (
        <ConfirmDialog
          title={`Desconectar "${workspace.name}"?`}
          confirmLabel="Desconectar"
          busyLabel="Desconectando…"
          onConfirm={() => api.deleteWorkspace(workspace.id)}
          onClose={() => setConfirmDisconnect(false)}
        >
          <p>
            {lost ? `Apaga do Octo ${lost} deste workspace.` : 'O workspace sai do Octo (ele ainda não tem issues nem sessões).'}
            {running > 0 && <> <strong>{running === 1 ? 'O agente em execução será interrompido.' : `Os ${running} agentes em execução serão interrompidos.`}</strong></>}
          </p>
          <p>
            Nada é apagado de <span className="mono">{workspace.rootPath}</span> nem dos repositórios. Para usar de novo, é só conectar a pasta outra vez
            (as issues não voltam).
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
