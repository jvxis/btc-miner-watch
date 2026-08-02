'use client';

import { useSyncExternalStore } from 'react';
import useSWR from 'swr';
import type { OverviewPayload, Settings } from './types';

/* --------------------------------------------------------------- relogio
   Um unico relogio compartilhado, exposto como store externa. Assim o valor
   fica estavel dentro de um render (nada de Date.now() no corpo do componente)
   e o HTML do servidor nao diverge do cliente na hidratacao. */

let nowValue = 0;
const nowListeners = new Set<() => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;

function subscribeNow(cb: () => void) {
  nowListeners.add(cb);
  if (nowValue === 0) nowValue = Date.now();
  if (!nowTimer) {
    nowTimer = setInterval(() => {
      nowValue = Date.now();
      nowListeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    nowListeners.delete(cb);
    if (nowListeners.size === 0 && nowTimer) {
      clearInterval(nowTimer);
      nowTimer = null;
    }
  };
}

/** Timestamp corrente; 0 durante a renderizacao no servidor. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeNow,
    () => nowValue,
    () => 0,
  );
}

/* ------------------------------------------------------- tipo de fosforo
   O valor real mora no atributo data-phosphor do <html>, aplicado por um
   script inline antes da primeira pintura para nao piscar o tema errado. */

const phosListeners = new Set<() => void>();

function subscribePhosphor(cb: () => void) {
  phosListeners.add(cb);
  return () => phosListeners.delete(cb);
}

export function setPhosphor(id: string) {
  document.documentElement.dataset.phosphor = id;
  try {
    localStorage.setItem('phosphor', id);
  } catch {
    /* modo privativo */
  }
  phosListeners.forEach((l) => l());
}

export function usePhosphor(): string {
  return useSyncExternalStore(
    subscribePhosphor,
    () => document.documentElement.dataset.phosphor ?? 'white',
    () => 'white',
  );
}

export const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
};

export function useOverview() {
  return useSWR<OverviewPayload>('/api/overview', fetcher, {
    refreshInterval: 20_000,
    keepPreviousData: true,
    revalidateOnFocus: true,
  });
}

export function useSettings() {
  return useSWR<Settings>('/api/settings', fetcher, { revalidateOnFocus: false });
}

export function useWallet() {
  return useSWR('/api/wallet', fetcher, { refreshInterval: 60_000, keepPreviousData: true });
}

export function useMiner(worker: string, hours: number) {
  return useSWR(`/api/miners/${encodeURIComponent(worker)}?hours=${hours}`, fetcher, {
    refreshInterval: 30_000,
    keepPreviousData: true,
  });
}

export function useEnergyBills() {
  return useSWR('/api/energy-bills', fetcher, { revalidateOnFocus: false, keepPreviousData: true });
}

export function useEvents() {
  return useSWR('/api/events', fetcher, { refreshInterval: 30_000, keepPreviousData: true });
}
