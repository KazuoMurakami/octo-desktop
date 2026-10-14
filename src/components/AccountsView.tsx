import { useState } from 'react';
import { LogIn, Plus, RefreshCw, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api.ts';
import { toast, useStore, useWorkspace } from '../store.ts';
import { AccountAvatar } from './icons.tsx';

const PLAN: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

export function AccountsView() {
  const workspace = useWorkspace();
  const { accounts, accountStatus, sessions, meta, set } = useStore(
    useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, sessions: s.sessions, meta: s.meta, set: s.set })),
  );
  const [checking, setChecking] = useState<string | null>(null);

  const refresh = async (id: string) => {
    setChecking(id);
    try {
      await api.refreshAccount(id);
    } finally {
      setChecking(null);
    }
  };

  return (
    <section className="view view-scroll">
      <header className="view-head">
        <h1>Contas Claude</h1>
        <div className="view-tools">
          <button className="primary-btn" onClick={() => set({ modal: { kind: 'account' } })}><Plus size={14} /> Adicionar conta</button>
        </div>
      </header>
      <p className="block-sub wide">
        Cada conta é um <code>CLAUDE_CONFIG_DIR</code> separado, com login, histórico e configurações isolados. Assim você
        alterna entre assinaturas (pessoal, trabalho, cliente) por issue ou por workspace, sem fazer logout.
      </p>

      <div className="accounts">
        {accounts.map((account) => {
          const status = accountStatus[account.id];
          const runs = sessions.filter((s) => s.accountId === account.id);
          const isDefault = workspace?.defaultAccountId === account.id;
          return (
            <div key={account.id} className="account-card" style={{ ['--acc' as string]: account.color }}>
              <div className="account-top">
                <AccountAvatar account={account} status={status} size={36} />
                <div className="account-id">
                  <input
                    className="account-name"
                    defaultValue={account.name}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== account.name && api.updateAccount(account.id, { name: e.target.value })}
                  />
                  <div className="dim">
                    {status ? (status.loggedIn ? status.email : 'Não conectada') : 'Verificando…'}
                    {status?.subscriptionType && <span className="plan">{PLAN[status.subscriptionType] ?? status.subscriptionType}</span>}
                  </div>
                </div>
                {isDefault && <span className="tag is-claude"><Star size={11} /> padrão</span>}
              </div>
              <dl className="account-facts">
                <dt>Pasta de config</dt>
                <dd className="mono">{status?.configDirectory ?? account.configDir ?? '~/.claude'}</dd>
                {status?.orgName && (<><dt>Organização</dt><dd>{status.orgName}</dd></>)}
                <dt>Sessões</dt>
                <dd>{runs.length} · US$ {runs.reduce((sum, s) => sum + s.costUsd, 0).toFixed(2)}</dd>
                {status?.error && (<><dt>Erro</dt><dd className="is-error">{status.error}</dd></>)}
              </dl>
              <div className="account-actions">
                {!status?.loggedIn && (
                  <button className="primary-btn is-small" onClick={() => api.login(account.id).then(() => toast('Conclua o login no terminal que abriu e depois clique em Verificar.'))}>
                    <LogIn size={13} /> Fazer login
                  </button>
                )}
                <button className="ghost-btn is-small" onClick={() => set({ view: 'claude', configAccountId: account.id })} title="Modelo, effort, skills, agentes, MCP, plugins e settings.json desta conta">
                  <SlidersHorizontal size={13} /> Configurar
                </button>
                <button className="ghost-btn is-small" onClick={() => refresh(account.id)} disabled={checking === account.id}>
                  <RefreshCw size={13} className={checking === account.id ? 'spin' : ''} /> Verificar
                </button>
                {workspace && !isDefault && (
                  <button className="ghost-btn is-small" onClick={() => api.updateWorkspace(workspace.id, { defaultAccountId: account.id })}>
                    <Star size={13} /> Usar como padrão
                  </button>
                )}
                {status?.loggedIn && (
                  <button className="ghost-btn is-small" onClick={() => api.login(account.id)} title="Entrar com outra conta nesta pasta de config">
                    <LogIn size={13} /> Trocar login
                  </button>
                )}
                {accounts.length > 1 && (
                  <button
                    className="icon-btn is-danger"
                    title="Remover do Octo (a pasta de config não é apagada)"
                    onClick={() => confirm(`Remover "${account.name}" do Octo?`) && api.deleteAccount(account.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {meta && (
        <p className="block-sub wide dim">
          Claude Code {meta.claudeVersion ?? '?'} · <span className="mono">{meta.claudeBin ?? 'não encontrado no PATH'}</span> · dados do Octo em{' '}
          <span className="mono">{meta.dataDir}</span>
        </p>
      )}
    </section>
  );
}
