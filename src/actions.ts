// Ações das telas que também ficam nos menus do botão direito: o mesmo comportamento (e os mesmos avisos) nos dois lugares.
import type { Issue, IssueStatus, Priority, Workspace } from '../shared/types.ts';
import { api } from './api.ts';
import { toast, useStore } from './store.ts';

/** Copia o texto e confirma com um aviso curto, ou avisa que não deu. */
export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Não foi possível copiar para a área de transferência.', 'error');
    return;
  }
  toast(done, 'success');
}

/** Procura os repositórios de novo e diz quantos achou. */
export async function rescan(workspace: Workspace): Promise<void> {
  const found = await api.scan(workspace.id);
  toast(`${found.length} ${found.length === 1 ? 'repositório encontrado' : 'repositórios encontrados'}.`, 'success');
}

/**
 * Muda o status ou a prioridade na hora, como ao arrastar o card, e confirma no servidor. Se ele recusar, a issue
 * volta como estava, a não ser que outra versão dela já tenha chegado por cima (essa é a que vale).
 */
export function updateIssueNow(issueId: string, changes: { status?: IssueStatus; priority?: Priority }): void {
  const s = useStore.getState();
  const before = s.issues.find((i) => i.id === issueId);
  if (!before) return;
  const optimistic: Issue = { ...before, ...changes };
  if (optimistic.status === before.status && optimistic.priority === before.priority) return;
  s.apply({ type: 'issue', issue: optimistic });
  api.updateIssue(issueId, changes).catch(() => {
    const now = useStore.getState();
    if (now.issues.find((i) => i.id === issueId) !== optimistic) return;
    // O card volta para a coluna de antes, recriado lá: com o foco nele (mudança pelo teclado), o foco volta junto.
    const card = document.getElementById(`issue-${issueId}`);
    const hadFocus = card !== null && card === document.activeElement;
    now.apply({ type: 'issue', issue: before });
    if (hadFocus) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!card.isConnected && (!active || active === document.body)) document.getElementById(`issue-${issueId}`)?.focus();
      });
    }
  });
}

/** Issues sendo excluídas agora: o painel aberto numa delas para de gravar o título e a descrição. */
const deleting = new Set<string>();

export function isDeleting(issueId: string): boolean {
  return deleting.has(issueId);
}

/**
 * Exclui a issue. O worktree dela sai antes, e as branches ficam; com alterações sem commit, o servidor recusa e
 * avisa, e aí ele sai antes por Mais ações › Remover worktree, que mostra o que se perde.
 */
export async function deleteIssue(issue: Issue): Promise<void> {
  deleting.add(issue.id);
  try {
    if (issue.worktree) await api.removeWorktree(issue.id, false);
    await api.deleteIssue(issue.id);
    // Sem esperar o evento do servidor: o painel aberto nela fecha na hora.
    useStore.getState().apply({ type: 'issue.deleted', id: issue.id });
  } finally {
    deleting.delete(issue.id);
  }
  toast(`${issue.identifier} excluída.`, 'success');
}

/** Desconecta a pasta: ela sai do Octo com as issues e as sessões dela. Nada é apagado do disco. */
export async function disconnectWorkspace(workspace: Workspace): Promise<void> {
  await api.deleteWorkspace(workspace.id);
  // O evento do servidor faz o mesmo e pode chegar antes ou depois da resposta: o primeiro troca de pasta, o outro não faz nada.
  useStore.getState().forgetWorkspace(workspace.id);
  toast(`Pasta "${workspace.name}" desconectada. Nada foi apagado do disco.`, 'success');
}

/** A configuração da pasta (no fim da tela Repositórios), já com ela aberta. */
export function openWorkspaceSettings(workspaceId: string): void {
  const s = useStore.getState();
  if (s.workspaceId !== workspaceId) s.selectWorkspace(workspaceId);
  s.set({ view: 'repos' });
  // Depois que a tela aparece: rola até a configuração e põe o foco no título dela.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const heading = document.getElementById('workspace-settings');
      heading?.scrollIntoView({ block: 'start' });
      heading?.focus({ preventScroll: true });
    }),
  );
}

/** Terminou no terminal: traz o fim da conversa para o Octo e marca a sessão como concluída. */
export async function finishTerminalSession(sessionId: string): Promise<void> {
  await api.sync(sessionId).catch(() => undefined);
  await api.finish(sessionId);
  toast('Sessão marcada como concluída.', 'success');
}

/** Abre a mesma conversa no terminal (claude --resume), com a mesma conta e as mesmas opções. */
export async function resumeInTerminal(sessionId: string, terminal: string): Promise<void> {
  await api.resumeInTerminal(sessionId);
  toast(`Conversa aberta no ${terminal}.`, 'success');
}
