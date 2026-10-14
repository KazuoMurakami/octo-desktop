import { useEffect, useState } from 'react';
import type { Integrations } from '../shared/types.ts';
import { api } from './api.ts';
import { useStore } from './store.ts';

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
