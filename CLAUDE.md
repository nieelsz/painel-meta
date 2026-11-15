# Painel de Anúncios — contexto para o Claude Code

Painel web para gerenciar **várias contas de anúncio da Meta** (vários Business Managers) e acompanhar vendas, no estilo da Utmify (que só aceita uma conta). Uso pessoal do dono, protegido por senha, roda local e depois numa VPS.

Responda e escreva textos de interface em **português do Brasil**.

## Comandos

```bash
npm install
cp .env.example .env   # primeira vez; ajuste APP_PASSWORD
npm start              # http://localhost:3000
npm run dev            # reinicia ao salvar (node --watch)
```

`DEMO_MODE=true` no `.env` usa dados fictícios (banco `data/demo.db`). Com `false`, usa `data/painel.db` e a API real da Meta. Para recriar os dados de demonstração: apague `data/demo.db`.

## Stack

- Node.js 18+ (usa `fetch` nativo), Express, better-sqlite3, dotenv. Sem framework no frontend.
- Frontend: HTML/CSS/JS puro em `public/`, gráficos com ECharts (servido de `node_modules`), mapa do Brasil em `public/vendor/brazil-states.json`, fonte Manrope local em `public/vendor/manrope.woff2`.

## Estrutura

| Arquivo | Papel |
|---|---|
| `server/index.js` | Rotas da API (`/api/*`), cálculo do dashboard, seed do demo |
| `server/meta.js` | Marketing API: insights por dia, listar campanhas/conjuntos/anúncios com métricas, mudar status, orçamento, duplicar. Cache de 60 s |
| `server/demo.js` | Árvore fictícia de contas/campanhas e geração de vendas coerentes |
| `server/sales.js` | Webhooks de venda (`/webhook/:secret/:platform` — kiwify, hotmart, generic), upsert e consultas |
| `server/auth.js` | Login por senha única (`APP_PASSWORD`), cookie HMAC, limite de 5 tentativas/15 min |
| `server/db.js` | Schema SQLite: tokens, ad_accounts, sales, operations, settings, action_log |
| `public/app.js` | SPA com roteamento por hash: resumo, meta, vendas, operacoes, integracoes, config |
| `public/style.css` | Tema escuro azul-marinho (tokens em `:root`) |

## Regras de negócio

- Valores de venda ficam em **centavos** no banco (`gross_cents`, `net_cents`). Orçamentos da Meta também vêm em centavos; gastos (`spend`) vêm em reais.
- Venda ↔ anúncio: IDs numéricos (6+ dígitos) encontrados nas UTMs (`utm_campaign=Nome|ID` etc., padrão Utmify) — ver `idsInUtm` em `sales.js`.
- Dashboard: líquido = soma `net_cents` das aprovadas; lucro = líquido − gastos − impostos (`tax_pct` em settings); ROAS = líquido ÷ gastos; ROI = lucro ÷ gastos.
- Funil: Cliques (inline_link_clicks) → Vis. Página (landing_page_view) → ICs (initiate_checkout) vêm da Meta; Vendas Inic. = todos os pedidos; Vendas Apr. = aprovados.
- Operação = grupo de contas + produtos, usada como filtro no Resumo.
- Toda alteração em anúncio (status, orçamento, duplicar) é registrada em `action_log`.
- Datas do dashboard usam o fuso `TZ_PAINEL` (padrão America/Sao_Paulo); cada venda guarda `day` e `hour` locais.

## Cuidados

- Ações de status/orçamento mexem em dinheiro real quando `DEMO_MODE=false`. Teste mudanças primeiro no modo demo.
- Nunca commitar `.env` nem `data/` (tokens da Meta e vendas ficam lá).
- Normalizadores de Kiwify/Hotmart seguem a documentação pública, ainda não validados com webhook real; a coluna `sales.raw` guarda o JSON recebido para ajustar.
- Toda função nova do modo real em `meta.js` precisa de equivalente em `demo.js`.

## Possíveis próximos passos

- Validar webhooks com vendas reais do checkout do usuário.
- Regras automáticas (ex.: pausar se CPA > X, escalar se ROAS > Y).
- Despesas extras e taxas por plataforma no cálculo de lucro.
- Deploy na VPS (instruções no README: PM2 + Nginx + Certbot).
