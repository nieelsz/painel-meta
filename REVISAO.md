# Revisão do painel — 15/11/2026

Leitura completa do código + testes no modo demo pela API. **Nenhum código foi alterado.**

## Pendências antes de continuar

- **Instalação no Windows:** `npm install` normal falha (o npm tenta compilar o `better-sqlite3`, que já vem pronto para Windows, e falta o Windows SDK). Use `npm install --ignore-scripts`.
- **`.env`:** `APP_PASSWORD`, `SESSION_SECRET` e `WEBHOOK_SECRET` ainda estão com os valores do `.env.example`. Trocar antes do modo real.
- **Banco demo sujo:** os testes deixaram vendas `TESTE-1..4`, `kw1`, `HP1` e registros no histórico. Para zerar: apague `data/demo.db`.

## Testes feitos (todos ok)

| Teste | Resultado |
|---|---|
| Login errado / sem login | Bloqueado |
| Login certo | OK |
| `/api/dashboard` 7 dias | Líquido R$ 35,6 mil, gasto R$ 15,6 mil, ROAS 2,28 |
| Listar campanhas | 9 campanhas em 3 contas |
| Pausar / ativar | OK, registrado no histórico |
| Orçamento R$ 400 → R$ 480 | OK; abaixo de R$ 1,00 é recusado |
| Venda genérica, depois reembolso do mesmo pedido | Atualizou sem duplicar |
| Exemplos Kiwify e Hotmart | Entraram (ver ressalvas) |

## Como funciona o fluxo

1. **Token da Meta** (um por Business Manager) → painel importa todas as contas que o token enxerga.
2. **Contas → campanhas:** gastos, cliques e ICs são buscados na Meta a cada tela aberta (guardados por 60 s).
3. **Vendas:** o checkout avisa o painel em `/webhook/SEGREDO/plataforma`. Cada pedido é gravado uma vez; avisos repetidos só atualizam o status.
4. **Venda ↔ anúncio:** números com 6 dígitos ou mais nas UTMs (`utm_campaign=Nome|ID` etc.) ligam a venda à campanha, ao conjunto e ao anúncio.
5. **Dashboard:** gastos e funil vêm da Meta; faturamento vem das vendas.

## Métricas

- **Líquido:** soma da sua comissão nas vendas aprovadas.
- **Bruto:** o mesmo, com o valor cheio pago pelo cliente.
- **Lucro:** líquido − gastos − impostos (% de Configurações sobre o líquido).
- **ROAS:** líquido ÷ gasto.
- **ROI:** lucro ÷ gasto.
- **Margem:** lucro ÷ líquido.
- **CPA:** gasto ÷ vendas aprovadas.
- **CPI:** gasto ÷ ICs.
- **Funil:** Cliques, Vis. Página e ICs vêm da Meta. Vendas Inic. = todos os pedidos. Vendas Apr. = aprovados. Cada % é calculada sobre a etapa anterior.

## Passos para o modo real

1. Trocar as 3 senhas do `.env` (gerar com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
2. `DEMO_MODE=false` e reiniciar (usa `data/painel.db`).
3. Token de Usuário do Sistema em cada BM (`ads_management` + `ads_read`, validade "Nunca") → Integrações.
4. Cadastrar a URL do webhook no Kiwify e/ou Hotmart.
5. Padrão de UTMs (está em Integrações) em todos os anúncios.
6. Uma venda real de teste para conferir valor, status, estado e campanha.
7. VPS: HTTPS, `COOKIE_SECURE=true`, `TRUST_PROXY=true`.

## Bugs e riscos

🔴 = grave · 🟠 = importante · 🟡 = menor

### Webhooks
1. 🔴 **Status "não pago" vira aprovado:** `unpaid`, `not_paid` e `incomplete` são gravados como aprovados, porque a regex procura "paid" (`status()` em `server/sales.js`). Confirmado.
2. 🔴 **Data com fuso derruba a venda:** se a Kiwify mandar `2026-11-15T14:00:00+00:00`, a resposta é erro 500 e a venda **não é gravada** (o código junta `-03:00` ao final). Confirmado. O mesmo vale para uma data inválida da Hotmart.
3. 🟠 **Valor no formato brasileiro vira R$ 0:** `"1.234,56"` no webhook genérico é gravado como 0 (função `cents()`).
4. 🟠 **Avisos fora de ordem desfazem o status:** o último aviso sempre vence. Um "aguardando" reenviado depois do "pago" volta a venda para pendente.
5. 🟠 **Kiwify sem validação real:** o código supõe valores em centavos (se vier `"97.00"`, fica 100 vezes menor) e não confere a assinatura da Kiwify.
6. 🟠 **Hotmart com lacunas:**
   - Coprodutor ou afiliado: o líquido vira o valor cheio.
   - O estado do cliente quase nunca vem.
   - Disputa e protesto viram "pendente", não "chargeback".
   - As UTMs só chegam por `src`, `sck` e `xcod`.
7. 🟡 **Reembolso conta no dia da venda original**, não no dia do reembolso.

### Ações que mexem em dinheiro
8. 🔴 **Ligar/desligar não pede confirmação:** um clique sem querer pausa ou **ativa** a campanha real.
9. 🟠 **Orçamento sem limite de segurança:** digitar 5000 em vez de 50,00 manda R$ 5.000/dia sem aviso.
10. 🟡 **Duplicar campanha grande pode falhar** na Meta (cópia completa tem limite). Não testado com conta real.
11. 🟡 **Ações que falham não vão para o histórico.**

### Números do dashboard
12. 🔴 **Filtro por produto não filtra o gasto:** o gasto continua sendo de todas as contas, então ROAS, lucro e CPA saem errados. Confirmado: R$ 1.126,89 com e sem o filtro. Operações que só têm produtos têm o mesmo problema.
13. 🟠 **Sem filtro, entram todas as vendas** (orgânicas e sem UTM também), o que deixa o ROAS geral maior que o real.
14. 🟠 **Filtro por conta perde vendas** de campanhas arquivadas ou apagadas (só considera as ativas ou pausadas).
15. 🟡 **Contas em dólar** são somadas como se fossem reais.
16. 🟡 **Limite da Meta:** o Resumo consulta o período atual e o anterior a cada minuto, por conta.

### Instalação e servidor
17. 🔴 **README manda Node 20 na VPS, mas o `better-sqlite3` 13 exige Node 22 ou mais novo.** Não funciona na VPS do jeito que está.
18. 🟡 **Segredo padrão:** sem `SESSION_SECRET`, o painel usa um segredo conhecido. Os tokens da Meta ficam sem criptografia em `data/` (proteger backups).

## Próximo passo sugerido

Montar o plano de correção começando por **1, 2, 8, 12 e 17**: são os que podem gerar número errado, perder venda ou gastar dinheiro sem querer.

Regras:
- Mostrar o plano antes de mexer.
- Testar tudo primeiro em modo demo.
- Nunca subir `.env` nem `data/` para o git.
- Manter o visual (tema escuro azul, Manrope).
