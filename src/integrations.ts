import { useEffect, useState } from 'react';
import type { Integrations } from '../shared/types.ts';
import { api } from './api.ts';
import { defaultAccountId, toast, useStore } from './store.ts';

// Terminais e editores detectados pelo servidor mudam pouco: a lista fica guardada e só é
// pedida de novo quando as preferências mudam (o terminal/editor efetivo pode mudar junto).
let cached: { key: string; promise: Promise<Integrations> } | null = null;

function load(key: string): Promise<Integrations> {
  if (!cached || cached.key !== key) {
    const promise = api.integrations();
    cached = { key, promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
  }
  return cached.promise;
}

export function useIntegrations(): Integrations | null {
  const key = useStore((s) => `${s.preferences.terminal}|${s.preferences.editor}`);
  const [value, setValue] = useState<Integrations | null>(null);

  useEffect(() => {
    let alive = true;
    load(key)
      .then((next) => alive && setValue(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);

  return value;
}

export function terminalLabel(integrations: Integrations | null): string {
  return integrations?.terminals.find((t) => t.id === integrations.terminal)?.label ?? 'terminal';
}

const launched = new Map<string, number>();

/**
 * Abre um terminal com o Claude na pasta (a raiz do workspace, se nenhuma for dada), com a
 * conta padrão, e avisa quando abriu. Cliques repetidos em poucos segundos não abrem outra
 * janela nem registram outra sessão.
 */
export async function openClaudeIn(workspaceId: string, dir?: string): Promise<void> {
  const key = `${workspaceId}:${dir ?? ''}`;
  if (Date.now() - (launched.get(key) ?? 0) < 3000) return;
  launched.set(key, Date.now());
  try {
    await api.openTerminal(workspaceId, { accountId: defaultAccountId(), dir });
    toast('Terminal aberto com o Claude.', 'success');
  } catch {
    launched.delete(key); // o erro já virou aviso em api.ts
  }
}
