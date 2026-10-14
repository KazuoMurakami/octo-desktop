import { useState } from 'react';
import { LogIn, Plus, RefreshCw, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { AccountStatus, ClaudeAccount } from '../../shared/types.ts';
import { api } from '../api.ts';
import { toast, useStore, useWorkspace } from '../store.ts';
import { money } from '../util.ts';
import { AccountAvatar } from './icons.tsx';
import { ConfirmDialog } from './modals.tsx';

const PLAN: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

// ---------------------------------------------------------------- login e plano (usados também por outras telas)

/** Estado de login em poucas palavras, para os menus de conta. */
export function loginHint(status: AccountStatus | undefined): string {
  if (!status) return 'verificando…';
  if (status.loggedIn) return status.email ?? 'conectada';
  return status.error ? 'não verificada' : 'sem login';
}

/** Conta com assinatura (Pro, Max, Team…): o uso entra no plano, sem cobrança por sessão. */
export function usesSubscription(status: AccountStatus | undefined): boolean {
  return Boolean(status?.subscriptionType && status.subscriptionType !== 'free');
}

/**
 * Custo em US$ que o Claude Code calcula pelos tokens. Para quem usa assinatura é só uma estimativa
 * (aparece com ≈ e esmaecido); para quem usa chave de API, é o que vai para a fatura.
 */
export function Cost({ usd, subscription }: { usd: number; subscription: boolean }) {
  if (!usd) return <span className="dim">—</span>;
  return subscription ? (
    <span className="cost is-estimate" title="Custo estimado em preço de API. Esta conta usa assinatura: você não paga por sessão, o uso conta no limite do plano.">
      ≈ {money(usd)}
    </span>
  ) : (
    <span className="cost" title="Custo estimado informado pelo Claude Code, em preço de API.">{money(usd)}</span>
  );
}

const loginWatches = new Map<string, () => void>();
const LOGIN_DELAYS = [5, 10, 15, 20, 30]; // segundos; depois disso, a cada 30 s
const LOGIN_LIMIT = 5 * 60_000;

/**
 * Depois de abrir o login no terminal, confere a conta de tempos em tempos (e quando você volta
 * para a janela do Octo) até ela aparecer logada. Cada conferência roda `claude auth status`,
 * por isso o intervalo cresce e a vigília termina em 5 minutos.
 */
export function watchLogin(account: ClaudeAccount): void {
  loginWatches.get(account.id)?.();
  const before = useStore.getState().accountStatus[account.id];
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let checking = false;
  let stopped = false;
  let lastCheck = 0;

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    if (loginWatches.get(account.id) === stop) loginWatches.delete(account.id);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    if (Date.now() - startedAt > LOGIN_LIMIT) return stop();
    timer = setTimeout(() => void check(), (LOGIN_DELAYS[attempt++] ?? 30) * 1000);
  };
  const check = async () => {
    if (checking || stopped) return;
    checking = true;
    lastCheck = Date.now();
    const status = await api.refreshAccount(account.id, true).catch(() => null);
    checking = false;
    if (stopped) return; // outra vigília (um novo "Fazer login") assumiu
    if (!status) return stop(); // conta removida ou Octo fora do ar: não insiste
    // "Trocar login" parte de uma conta já logada: só conta como feito se o e-mail mudou.
    if (status.loggedIn && (!before?.loggedIn || status.email !== before.email)) {
      stop();
      toast(`Conta "${account.name}" conectada${status.email ? ` como ${status.email}` : ''}.`, 'success');
      return;
    }
    schedule();
  };
  const onFocus = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > 3000) void check();
  };

  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  loginWatches.set(account.id, stop);
  schedule();
}

/** Abre o `claude auth login` da conta num terminal e fica de olho até o login aparecer. */
export async function startLogin(account: ClaudeAccount): Promise<void> {
  await api.login(account.id);
  watchLogin(account);
  toast('Conclua o login no terminal que abriu. O Octo percebe sozinho quando terminar.');
}

// ---------------------------------------------------------------- tela

export function AccountsView() {
  const workspace = useWorkspace();
  const { accounts, accountStatus, sessions, meta, set } = useStore(
    useShallow((s) => ({ accounts: s.accounts, accountStatus: s.accountStatus, sessions: s.sessions, meta: s.meta, set: s.set })),
  );
  const [checking, setChecking] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ClaudeAccount | null>(null);

  const refresh = async (account: ClaudeAccount) => {
    setChecking(account.id);
    try {
      const status = await api.refreshAccount(account.id);
      if (status.loggedIn) toast(`"${account.name}" está conectada${status.email ? ` como ${status.email}` : ''}.`, 'success');
      else if (status.error) toast(`Não foi possível verificar "${account.name}": ${status.error}`, 'error');
      else toast(`"${account.name}" ainda não fez login.`);
    } catch {
      /* o aviso de erro já apareceu (api.ts) */
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
        A conta <strong>Principal</strong> é o seu Claude Code de sempre, com o login que você já usa no terminal. Só adicione outra se usar
        mais de uma assinatura (pessoal e trabalho, por exemplo): cada conta tem login, histórico e configurações separados, e você escolhe
        qual usar em cada issue ou workspace, sem fazer logout.
      </p>
      <details className="block-sub accounts-more">
        <summary>Como funciona</summary>
        Cada conta é uma pasta de configuração do Claude Code (a variável <code>CLAUDE_CONFIG_DIR</code>). A Principal usa a pasta padrão,{' '}
        <code>~/.claude</code>; as outras ganham uma pasta própria, e o Octo abre o Claude já apontando para ela.
      </details>

      <div className="accounts">
        {accounts.map((account) => {
          const status = accountStatus[account.id];
          const runs = sessions.filter((s) => s.accountId === account.id);
          const cost = runs.reduce((sum, s) => sum + s.costUsd, 0);
          const isDefault = workspace?.defaultAccountId === account.id;
          return (
            <div key={account.id} className="account-card" style={{ ['--acc' as string]: account.color }}>
              <div className="account-top">
                <AccountAvatar account={account} status={status} size={36} />
                <div className="account-id">
                  <input
                    className="account-name"
                    aria-label="Nome da conta"
                    defaultValue={account.name}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== account.name) void api.updateAccount(account.id, { name: e.target.value }).catch(() => undefined);
                    }}
                  />
                  <div className="dim">
                    {!status ? 'Verificando…' : status.loggedIn ? (status.email ?? 'Conectada') : status.error ? 'Não foi possível verificar' : 'Sem login'}
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
                <dd>
                  {runs.length}
                  {cost > 0 && (
                    <>
                      {' · '}<Cost usd={cost} subscription={usesSubscription(status)} />
                      <span className="dim">{usesSubscription(status) ? ' estimado (pago pela assinatura)' : ' custo estimado'}</span>
                    </>
                  )}
                </dd>
                {status?.error && (<><dt>Erro</dt><dd className="is-error">{status.error}</dd></>)}
              </dl>
              <div className="account-actions">
                {!status?.loggedIn && (
                  <button className="primary-btn is-small" onClick={() => void startLogin(account).catch(() => undefined)}>
                    <LogIn size={13} /> Fazer login
                  </button>
                )}
                <button className="ghost-btn is-small" onClick={() => set({ view: 'claude', configAccountId: account.id })} title="Modelo, effort, skills, agentes, MCP, plugins e settings.json desta conta">
                  <SlidersHorizontal size={13} /> Configurar
                </button>
                <button className="ghost-btn is-small" onClick={() => refresh(account)} disabled={checking === account.id}>
                  <RefreshCw size={13} className={checking === account.id ? 'spin' : ''} /> Verificar
                </button>
                {workspace && !isDefault && (
                  <button className="ghost-btn is-small" onClick={() => void api.updateWorkspace(workspace.id, { defaultAccountId: account.id }).catch(() => undefined)}>
                    <Star size={13} /> Usar como padrão
                  </button>
                )}
                {status?.loggedIn && (
                  <button className="ghost-btn is-small" onClick={() => void startLogin(account).catch(() => undefined)} title="Entrar com outra conta nesta pasta de config">
                    <LogIn size={13} /> Trocar login
                  </button>
                )}
                {accounts.length > 1 && (
                  <button className="icon-btn is-danger" title="Remover do Octo (a pasta de config não é apagada)" aria-label={`Remover ${account.name}`} onClick={() => setRemoving(account)}>
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

      {removing && <RemoveAccountDialog account={removing} onClose={() => setRemoving(null)} />}
    </section>
  );
}

function RemoveAccountDialog({ account, onClose }: { account: ClaudeAccount; onClose: () => void }) {
  const { issues, workspaces, status } = useStore(
    useShallow((s) => ({ issues: s.issues, workspaces: s.workspaces, status: s.accountStatus[account.id] })),
  );
  const delegated = issues.filter((i) => i.delegateAccountId === account.id).length;
  const isDefault = workspaces.some((w) => w.defaultAccountId === account.id);
  const dir = status?.configDirectory ?? account.configDir ?? '~/.claude';
  return (
    <ConfirmDialog
      title={`Remover "${account.name}" do Octo?`}
      confirmLabel="Remover conta"
      busyLabel="Removendo…"
      onConfirm={() => api.deleteAccount(account.id)}
      onClose={onClose}
    >
      <p>
        A pasta <code>{dir}</code> não é apagada: o login, o histórico e as configurações continuam lá, e dá para adicionar a conta de novo depois.
      </p>
      {(delegated > 0 || isDefault) && (
        <p>
          {delegated > 0 && `${delegated === 1 ? 'Uma issue usava' : `${delegated} issues usavam`} esta conta e ${delegated === 1 ? 'fica' : 'ficam'} sem conta definida. `}
          {isDefault && 'Os workspaces que a usavam como padrão passam a usar outra conta.'}
        </p>
      )}
    </ConfirmDialog>
  );
}
