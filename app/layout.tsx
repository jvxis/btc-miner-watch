import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, VT323 } from 'next/font/google';
import './globals.css';
import { Nav } from '@/components/Nav';

const plex = IBM_Plex_Mono({
  variable: '--font-plex-mono',
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
});

const vt = VT323({
  variable: '--font-vt',
  subsets: ['latin'],
  weight: '400',
});

export const metadata: Metadata = {
  title: 'MINER-WATCH · Terminal de Monitoracao',
  description: 'Monitoracao da fazenda de mineracao Bitcoin na pool ViaBTC',
};

export const viewport: Viewport = {
  themeColor: '#060809',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-phosphor="white" className={`${plex.variable} ${vt.variable} h-full`}>
      {/* Extensoes do navegador (Grammarly e afins) injetam atributos no body
          antes da hidratacao. O supressor vale apenas para os atributos deste
          elemento — divergencias reais dentro da arvore continuam sendo avisadas. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* aplica o fosforo salvo antes da primeira pintura, sem piscar */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var p=localStorage.getItem('phosphor');if(p)document.documentElement.dataset.phosphor=p}catch(e){}`,
          }}
        />
        <div className="crt-overlay" aria-hidden />
        <div className="crt-sweep" aria-hidden />
        <div className="crt-flicker flex min-h-dvh flex-col">
          <Nav />
          <main className="mx-auto w-full max-w-[1800px] flex-1 px-3 py-4">{children}</main>
          <footer className="mx-auto w-full max-w-[1800px] px-3 pb-6 pt-2 text-[0.62rem] dimmer">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-phos/15 pt-2">
              <span>MINER-WATCH · TERMINAL DE MONITORACAO DE MINERACAO</span>
              <span className="hidden sm:inline">FONTE: VIABTC POOL API · MEMPOOL.SPACE · COINGECKO</span>
              <span className="ml-auto caret">PRONTO</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
