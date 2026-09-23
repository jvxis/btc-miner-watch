# BTC MINER WATCH

Painel de monitoração para fazendas de mineração Bitcoin na pool **ViaBTC**, com
estética de terminal CRT de fósforo. Desktop e mobile.

Acompanha cada máquina individualmente, o custo de energia, a receita paga pela
pool e o resultado da operação — tudo apurado em satoshis, com leitura em BRL e
USD pela cotação corrente.

---

## Por que existe

A interface da ViaBTC mostra hashrate e saldo, mas não responde o que importa
para quem opera: *quanto cada máquina está custando, quanto sobrou depois da
energia, e a partir de que preço do bitcoin a operação vira prejuízo.*

Além disso, a API da pool tem limitações que só aparecem na prática — descritas
no fim deste documento. Este projeto contorna todas elas com um coletor local.

## Recursos

- **Painel** com instrumentos analógicos: hashrate contra o nominal, eficiência
  em J/TH, disponibilidade, margem
- **Por máquina**: série temporal própria, uptime, índice de saúde, resultado
  individual e break-even
- **Energia** por tarifa de kWh **ou** contrato fechado em USD, com valor
  distinto por máquina e período de cortesia contado do primeiro hash
- **Indisponibilidade**: detecta quedas, calcula o crédito proporcional e gera
  relatório datado para negociar com o fornecedor
- **P&L** por competência, em satoshis, com o preço efetivo da energia por kWh
- **Cobrança adiantada**: prévia do mês seguinte já com o desconto das paradas
  do mês corrente, pronta para enviar ao fornecedor
- **Payback por máquina**: preço pago, quanto já voltou em satoshis e a
  previsão de quitação no ritmo atual
- **Avisos no Telegram** em três níveis — crítico (máquina parada, fazenda
  parada, falha na pool), degradação prolongada e problema crônico
- **Simulador** de preço do BTC, tarifa e dificuldade
- Três tons de fósforo: P4 branco, P3 âmbar, P1 verde

## Rodando

Requer **Node 24+** — usa o módulo `node:sqlite` nativo, sem dependência de
compilação.

```bash
npm install
cp .env.example .env.local     # preencha a chave da ViaBTC
npm run dev                    # http://localhost:3000
npm run dev:lan                # acessível na rede local
```

Produção:

```bash
npm run build
npm start
```

Deixe rodando: um coletor grava um snapshot de todas as máquinas a cada 60
segundos em SQLite local. É esse histórico que alimenta médias, uptime, detecção
de quedas e gráficos de alta resolução.

### Configuração

`.env.local`:

| Variável | Para que serve |
|---|---|
| `VIABTC_API_KEY` | chave da API, criada na página de configurações da ViaBTC |
| `VIABTC_SECRET_KEY` | usada nos endpoints que exigem assinatura HMAC |
| `VIABTC_BASE_URL` | `https://www.viabtc.net` |
| `VIABTC_COIN` | `BTC` |
| `POLL_INTERVAL_SECONDS` | intervalo do coletor, mínimo 30 |
| `DB_PATH` | caminho do banco SQLite |

> **Whitelist de IP**: a ViaBTC só responde a chamadas vindas de IPs liberados na
> página de configurações de mineração. Sem isso a API retorna erro `12004`.

Tarifa de energia, consumo em watts, hashrate nominal, apelidos e limites de
alerta ficam na página de configurações, gravados no banco local.

### Avisos no Telegram

Crie um bot no `@BotFather`, pegue o token e descubra o seu chat id em
`https://api.telegram.org/bot<TOKEN>/getUpdates` depois de mandar qualquer
mensagem ao bot. Os dois campos ficam na página de configurações, com um botão
de teste. Não há interruptor separado: preenchidos os dois, os avisos estão
ligados; para silenciar, apague o chat id.

Cada condição avisa uma vez quando começa e outra quando normaliza — repetir a
cada leitura ensinaria o operador a ignorar o canal. Pelo mesmo motivo,
condições que começam no mesmo ciclo vão numa mensagem só: uma queda geral não
deve render uma notificação por máquina.

São três níveis, do mais urgente ao mais silencioso:

| nível | dispara quando |
|---|---|
| crítico | máquina sem produzir, fazenda inteira parada, sem contato com a pool |
| degradação | uma máquina abaixo do esperado **e** a fazenda abaixo do limite dela, ambos além do tempo configurado |
| crônico | a média da janela (24h por padrão) abaixo do limite da fazenda, com alguma máquina degradada há o mesmo tempo |

A degradação de uma máquina isolada não vira mensagem: uma unidade oscilando é
rotina e fica no painel. O que interrompe alguém é o conjunto caindo. O aviso
crônico existe porque os outros dois reagem a mudança — nenhum dispara quando a
fazenda simplesmente vive abaixo do contratado por dias, que é o caso que mais
custa dinheiro justamente por não acordar ninguém.

## Páginas

| Rota | Atalho | Conteúdo |
|---|---|---|
| `/` | F1 | Painel geral, grade de máquinas, alertas |
| `/miners` | F2 | Tabela ordenável, filtros, ranking |
| `/miners/[worker]` | | Ficha individual com série temporal |
| `/wallet` | F3 | Saldo, pagamentos, contas de energia, recibos |
| `/pnl` | F4 | Resultado por competência, com gráficos |
| `/network` | F5 | Dificuldade, halving, taxas, simulador |
| `/settings` | F6 | Energia, alertas, parâmetros por máquina |

## Arquitetura

```
app/api/*        rotas internas — a chave da pool nunca chega ao navegador
lib/viabtc.ts    cliente da ViaBTC, com assinatura HMAC e tradução de erros
lib/db.ts        SQLite via node:sqlite, sem dependência externa
lib/poller.ts    coletor de snapshots e detecção de quedas
lib/metrics.ts   motor de cálculo: energia, receita, lucro, saúde, alertas
lib/health.ts    critérios de parada e degradação, um só para coletor e tela
lib/notify.ts    avisos no Telegram, com memória do que já foi avisado
lib/payback.ts   retorno do investimento por máquina, rateado pelo hashrate
lib/market.ts    preço (CoinGecko) e rede (mempool.space), com cache e fallback
```

## Limitações da API da ViaBTC que este projeto contorna

Descobertas medindo em produção. Nenhuma está na documentação oficial.

**Os campos de 24h por máquina são inconsistentes.** Numa mesma leitura, uma
máquina reporta 837 TH/s enquanto outras reportam 26 TH/s. E o histórico diário
por worker devolve o hashrate da conta inteira, não o da máquina. Apenas
`hashrate_10min` e `hashrate_1hour` são confiáveis — as médias de 24h, o uptime
e os gráficos por máquina saem dos snapshots locais.

**O histórico diário de receita guarda ~30 dias.** Filtrar por data não recupera
nada além disso. O histórico de pagamentos alcança mais longe e serve de fonte
alternativa para meses anteriores.

**A série diária de hashrate vem com padding.** `interval=day&period=90` devolve
90 pontos, mas só cerca de 31 têm dado real; o restante vem zerado. Tratar esses
zeros como queda geraria alarme falso e, num cálculo de crédito, valor indevido.

**`last_active` é republicado a cada ~5 minutos.** Medir parada comparando
coletas de 1 minuto acusaria queda em 4 de cada 5 intervalos. A detecção usa o
intervalo entre shares, com tolerância acima do período de republicação.

**O `worker_status` vira `unactive` com ~10 minutos sem share**, mesmo com a
máquina produzindo normalmente — intervalo de 10 minutos entre shares acontece.
Usar esse campo como critério de parada gera enxurradas de alerta crítico com o
hashrate intacto. Ele não entra na conta.

**A cadência de publicação do `last_active` muda sem aviso.** O normal é a cada
~5 minutos, mas já foi observada em 10 minutos por vários dias seguidos. Um
limite de parada calibrado para a cadência antiga passa a ver a fazenda inteira
"parada" nos minutos antes de cada atualização, e o mês enche de quedas de 1 a 2
minutos que nunca existiram. Por isso **parada exige duas evidências**: o
`last_active` diz *quando* a máquina parou de enviar share, e o hashrate diz
*se* ela realmente parou. Ajustar o limite à cadência medida foi tentado e
descartado — a pool volta a mudar, e o hashrate é a única verdade independente.

**A média de 1 hora demora até 60 minutos para se limpar depois de uma queda.**
Usá-la para status manteria a fazenda inteira marcada como degradada por quase
uma hora depois de já ter voltado. O status usa a mediana das leituras recentes
de 10 minutos, que reage em minutos sem tremer com o ruído.

## Deploy

Roda em qualquer máquina com Node 24. Para um servidor dedicado, a receita é
`npm ci && npm run build && npm start` sob um supervisor — systemd, PM2 ou
equivalente — com um usuário de sistema sem privilégios e permissão de escrita
apenas no diretório de dados.

Se o painel não precisa estar exposto na internet, vale servi-lo apenas numa
interface de rede privada (VPN, Tailscale ou similar) em vez de abrir porta no
firewall.

## Licença

[MIT](LICENSE) — use, modifique e distribua à vontade, mantendo o aviso de
copyright. Sem garantia de qualquer espécie.
