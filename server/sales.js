// Vendas: recebimento por webhook (checkouts) e consultas
const { db } = require('./db');

const TZ = () => process.env.TZ_PAINEL || 'America/Sao_Paulo';

function localParts(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return localParts(new Date().toISOString());
  const day = d.toLocaleDateString('en-CA', { timeZone: TZ() });
  const hour = Number(d.toLocaleString('en-US', { timeZone: TZ(), hour: 'numeric', hour12: false })) % 24;
  return { day, hour };
}

const upsert = db.prepare(`
INSERT INTO sales (id, platform, order_id, status, payment_method, product, gross_cents, net_cents, customer_state,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at, day, hour, raw, updated_at)
VALUES (@id, @platform, @order_id, @status, @payment_method, @product, @gross_cents, @net_cents, @customer_state,
  @utm_source, @utm_medium, @utm_campaign, @utm_content, @utm_term, @created_at, @day, @hour, @raw, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET status=excluded.status, payment_method=COALESCE(excluded.payment_method, payment_method),
  gross_cents=CASE WHEN excluded.gross_cents>0 THEN excluded.gross_cents ELSE gross_cents END,
  net_cents=CASE WHEN excluded.net_cents>0 THEN excluded.net_cents ELSE net_cents END,
  utm_campaign=COALESCE(excluded.utm_campaign, utm_campaign), utm_content=COALESCE(excluded.utm_content, utm_content),
  raw=excluded.raw, updated_at=CURRENT_TIMESTAMP`);

function insertSale(s) {
  const created_at = s.created_at || new Date().toISOString();
  const { day, hour } = localParts(created_at);
  const row = {
    utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, customer_state: null, raw: null,
    ...s, id: `${s.platform}:${s.order_id}`, created_at, day, hour,
    customer_state: s.customer_state ? String(s.customer_state).toUpperCase().slice(0, 2) : null,
    gross_cents: Math.round(s.gross_cents || 0), net_cents: Math.round(s.net_cents || s.gross_cents || 0),
  };
  upsert.run(row);
  return row;
}

// ---------- normalizadores ----------
const cents = v => Math.round(Number(String(v ?? 0).replace(',', '.')) * 100) || 0;
function method(v) {
  v = String(v || '').toLowerCase();
  if (v.includes('pix')) return 'pix';
  if (v.includes('card') || v.includes('cart') || v.includes('credit')) return 'card';
  if (v.includes('bol') || v.includes('billet') || v.includes('slip')) return 'boleto';
  return v ? 'other' : null;
}
function status(v) {
  v = String(v || '').toLowerCase();
  if (/charge/.test(v)) return 'chargeback';
  if (/refund|reembol|estorn/.test(v)) return 'refunded';
  if (/(paid|approved|aprovad|complete|pago|confirm)/.test(v)) return 'approved';
  if (/(refus|recus|declin|cancel|expired|expir)/.test(v)) return 'canceled';
  return 'pending';
}

const normalizers = {
  // Formato próprio (recomendado — use com n8n/Make ou qualquer checkout que permita montar o JSON)
  generic(b) {
    return {
      order_id: b.order_id || b.id, status: status(b.status), payment_method: method(b.payment_method),
      product: b.product || b.product_name, gross_cents: cents(b.amount), net_cents: cents(b.net_amount ?? b.amount),
      customer_state: b.state || b.customer_state,
      utm_source: b.utm_source, utm_medium: b.utm_medium, utm_campaign: b.utm_campaign, utm_content: b.utm_content, utm_term: b.utm_term,
      created_at: b.created_at,
    };
  },
  kiwify(b) {
    const t = b.TrackingParameters || {};
    const c = b.Commissions || {};
    return {
      order_id: b.order_id, status: status(b.order_status), payment_method: method(b.payment_method),
      product: (b.Product && b.Product.product_name) || 'Produto',
      gross_cents: Number(c.charge_amount || c.product_base_price || 0),          // Kiwify envia em centavos
      net_cents: Number(c.my_commission || c.charge_amount || 0),
      customer_state: b.Customer && b.Customer.state,
      utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign, utm_content: t.utm_content, utm_term: t.utm_term,
      created_at: b.created_at ? new Date(b.created_at.replace(' ', 'T') + (b.created_at.includes('Z') ? '' : '-03:00')).toISOString() : undefined,
    };
  },
  hotmart(b) {
    const d = b.data || {}; const p = d.purchase || {}; const o = p.origin || {};
    const prod = (d.commissions || []).find(x => x.source === 'PRODUCER');
    return {
      order_id: p.transaction, status: status(b.event === 'PURCHASE_COMPLETE' ? 'approved' : (p.status || b.event)),
      payment_method: method(p.payment && p.payment.type), product: d.product && d.product.name,
      gross_cents: cents(p.price && p.price.value), net_cents: cents(prod ? prod.value : p.price && p.price.value),
      customer_state: d.buyer && d.buyer.address && d.buyer.address.state,
      utm_source: o.src, utm_campaign: o.sck, utm_content: o.xcod,
      created_at: p.order_date ? new Date(p.order_date).toISOString() : undefined,
    };
  },
};

function webhookRoute(app) {
  app.post('/webhook/:secret/:platform', (req, res) => {
    if (!process.env.WEBHOOK_SECRET || req.params.secret !== process.env.WEBHOOK_SECRET) return res.status(403).json({ error: 'forbidden' });
    const norm = normalizers[req.params.platform];
    if (!norm) return res.status(404).json({ error: 'plataforma não suportada' });
    try {
      const s = norm(req.body || {});
      if (!s.order_id) return res.status(400).json({ error: 'order_id ausente' });
      const row = insertSale({ ...s, order_id: String(s.order_id), platform: req.params.platform, raw: JSON.stringify(req.body).slice(0, 20000) });
      res.json({ ok: true, id: row.id, status: row.status });
    } catch (e) {
      console.error('webhook', e);
      res.status(500).json({ error: 'erro ao processar' });
    }
  });
}

// ---------- consultas ----------
function salesQuery({ from, to, products }) {
  let sql = 'SELECT * FROM sales WHERE day BETWEEN ? AND ?';
  const args = [from, to];
  if (products && products.length) { sql += ` AND product IN (${products.map(() => '?').join(',')})`; args.push(...products); }
  return db.prepare(sql + ' ORDER BY created_at DESC').all(...args);
}

// encontra o id (campanha/conjunto/anúncio) no UTM — formato "Nome|ID" (padrão Utmify) ou só ID
function idsInUtm(s) {
  const ids = new Set();
  for (const f of ['utm_campaign', 'utm_medium', 'utm_content', 'utm_term', 'utm_source']) {
    const v = s[f]; if (!v) continue;
    for (const m of String(v).matchAll(/\d{6,}/g)) ids.add(m[0]);
  }
  return ids;
}

module.exports = { insertSale, webhookRoute, salesQuery, idsInUtm, localParts };
