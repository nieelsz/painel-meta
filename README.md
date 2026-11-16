# Track+ — painel de anúncios (multi-contas Meta)

Dashboard de vendas e gestão de anúncios do Facebook/Meta no estilo da Utmify, porém com **várias contas de anúncio e vários Business Managers** ao mesmo tempo.

- **Resumo:** faturamento líquido/bruto, gastos, ROAS, lucro, ROI, margem, CPA, vendas pendentes, reembolsos, impostos, vendas por pagamento (Pix/Cartão/Boleto), **funil de conversão** (Cliques → Vis. Página → ICs → Vendas Inic. → Vendas Apr.), **mapa de vendas por estado**, vendas por horário, faturamento × gastos por dia e top produtos.
- **Meta Ads:** contas, campanhas, conjuntos e anúncios com gastos, vendas, faturamento, lucro, ROAS, CPA, ICs, CPI, CPC, CTR e CPM. **Ligar/desligar**, **aumentar/diminuir orçamento** (botões de ±20% ou valor exato) e **duplicar** (a cópia nasce pausada).
- **Operações:** agrupe contas + produtos e filtre o Resumo por operação.
- **Senha de acesso**, histórico de todas as ações feitas nos anúncios.

## 1. Rodar local (teste)

Precisa do **Node.js 22 ou mais novo** (https://nodejs.org).

```bash
cd painel
npm install              # no Windows: npm install --ignore-scripts (o banco já vem pronto; sem isso o npm tenta compilar e falha)
cp .env.example .env     # no Windows: copy .env.example .env
npm start
```

Abra **http://localhost:3000** e entre com a senha do `.env` (`APP_PASSWORD`).

O `.env.example` já vem com `DEMO_MODE=true`: o painel abre com **dados fictícios** (3 contas, campanhas e 60 dias de vendas) para você testar tudo, inclusive pausar e mudar orçamento, sem mexer em nada real.

## 2. Usar com seus dados reais

1. No `.env`: troque `DEMO_MODE=false`, defina `APP_PASSWORD`, `SESSION_SECRET` e `WEBHOOK_SECRET` (strings longas e aleatórias). Gerador:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Reinicie (`npm start`). O modo real usa outro banco (`data/painel.db`), separado do demo.
3. **Token da Meta** (um por Business Manager):
   - Business Manager → Configurações do negócio → **Usuários do sistema** → Adicionar (Admin).
   - Atribua os **ativos** (as contas de anúncio) com controle total.
   - **Gerar token** → escolha seu app → permissões `ads_management` e `ads_read` → validade **Nunca**.
   - No painel: **Integrações → Adicionar token**. Todas as contas que o token enxerga são importadas; desligue as que não quiser.
4. **Vendas (webhook do checkout):** em Integrações copie a URL da sua plataforma e cadastre no checkout:
   - Kiwify: Apps → Webhooks → todos os eventos de compra/reembolso.
   - Hotmart: Ferramentas → Webhook (versão 2.0).
   - Outro checkout: use a URL **generic** com o JSON mostrado na tela (dá para montar via n8n/Make).
5. **UTMs nos anúncios** (para ligar venda → campanha/conjunto/anúncio): cole em *Parâmetros de URL* de cada anúncio:
   ```
   utm_source=FB&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_medium={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}&utm_term={{placement}}
   ```
   Seu checkout precisa repassar as UTMs da página de vendas para o pedido (se você já usa a Utmify, isso já está configurado).

> Os normalizadores da Kiwify e da Hotmart seguem os formatos documentados por elas. Se algum campo vier diferente, veja o JSON bruto da venda na tabela `sales` (coluna `raw`) e ajuste em `server/sales.js`.

## 3. Hospedar na VPS (Ubuntu)

```bash
# Node 22 + PM2 + Nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx build-essential
sudo npm i -g pm2

# envie a pasta (scp/git) e instale
cd /opt/painel && npm install --omit=dev
nano .env      # DEMO_MODE=false, COOKIE_SECURE=true, TRUST_PROXY=true, HOST=127.0.0.1
pm2 start server/index.js --name painel && pm2 save && pm2 startup
```

Nginx (`/etc/nginx/sites-available/painel`):

```nginx
server {
  server_name painel.seudominio.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/painel /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d painel.seudominio.com
```

**HTTPS é obrigatório** em produção (senha e token trafegam). Faça backup da pasta `data/` (é onde ficam tokens e vendas).

## Estrutura

```
server/index.js    rotas da API e cálculo do dashboard
server/meta.js     integração com a Marketing API (insights, status, orçamento, duplicar)
server/sales.js    webhooks de venda (Kiwify, Hotmart, genérico) e consultas
server/auth.js     login por senha (cookie assinado, limite de tentativas)
server/db.js       banco SQLite (data/)
server/demo.js     dados fictícios do modo demo
public/            interface (HTML/CSS/JS + ECharts)
```

## Como os números são calculados

| Métrica | Fórmula |
|---|---|
| Faturamento líquido | soma do valor líquido (sua comissão) das vendas **aprovadas** |
| Lucro | líquido − gastos com anúncios − impostos |
| ROAS | líquido ÷ gastos |
| ROI | lucro ÷ gastos |
| CPA | gastos ÷ vendas aprovadas |
| Funil | Cliques, Vis. Página e ICs vêm da Meta; Vendas Inic. = todos os pedidos; Vendas Apr. = aprovados |

Os dados da Meta ficam em cache por 60 s para não estourar o limite da API; o Resumo se atualiza sozinho a cada minuto.
