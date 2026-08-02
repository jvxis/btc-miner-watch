'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { setPhosphor, useNow, usePhosphor } from '@/lib/client';

const LINKS = [
  { href: '/', label: 'PAINEL', key: 'F1' },
  { href: '/miners', label: 'MAQUINAS', key: 'F2' },
  { href: '/wallet', label: 'CARTEIRA', key: 'F3' },
  { href: '/pnl', label: 'P&L', key: 'F4' },
  { href: '/network', label: 'REDE', key: 'F5' },
  { href: '/settings', label: 'CONFIG', key: 'F6' },
];

const PHOSPHORS = [
  { id: 'white', label: 'P4 BRANCO' },
  { id: 'amber', label: 'P3 AMBAR' },
  { id: 'green', label: 'P1 VERDE' },
];

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const now = useNow();
  const phos = usePhosphor();

  // Atalhos F1..F5, como nos terminais de verdade.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const link = LINKS.find((l) => l.key === e.key);
      if (link) {
        e.preventDefault();
        router.push(link.href);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return (
    <header className="sticky top-0 z-50 border-b border-phos/30 bg-[rgb(var(--bg))]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1800px] items-center gap-3 px-3 py-2">
        <Link href="/" className="flex items-baseline gap-2 shrink-0">
          <span className="font-display text-xl hot leading-none">MINER-WATCH</span>
          <span className="hidden text-[0.6rem] dimmer sm:inline">v1.0 · VIABTC</span>
        </Link>

        <div className="ml-auto flex items-center gap-3 text-[0.68rem]">
          <select
            value={phos}
            onChange={(e) => setPhosphor(e.target.value)}
            className="!w-auto !py-[2px] !text-[0.6rem] hidden sm:block"
            aria-label="Tipo de fosforo"
          >
            {PHOSPHORS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="dim tabular-nums">
            {now === 0 ? '--:--:--' : new Date(now).toLocaleTimeString('pt-BR')}
          </span>
        </div>
      </div>

      <nav className="mx-auto max-w-[1800px] overflow-x-auto px-3 pb-0">
        <ul className="flex min-w-max gap-0 text-[0.7rem]">
          {LINKS.map((l) => {
            const active = l.href === '/' ? path === '/' : path.startsWith(l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={`block border-x border-t px-4 py-[6px] tracking-[0.18em] transition-colors ${
                    active
                      ? 'inverse border-phos'
                      : 'border-phos/20 dim hover:text-[rgb(var(--phos-hot))] hover:border-phos/50'
                  }`}
                >
                  <span className="dimmer mr-1 hidden sm:inline">{l.key}</span>
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
