import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
const { DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET, MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, BASE_URL = '', PAYER_EMAIL = 'pedidos@margourmet.com.br', PORT = 3000 } = process.env;
if (!DATABASE_URL || !ADMIN_PASSWORD || !SESSION_SECRET) { console.error('Defina DATABASE_URL, ADMIN_PASSWORD e SESSION_SECRET'); process.exit(1); }
const db = new pg.Pool({ connectionString: DATABASE_URL, max: 1, idleTimeoutMillis: 10000 });

// ---- Cardápio (preços em centavos; o servidor é quem calcula o total) ----
const M = (cat, list, price, emoji) => list.map(([id, name, desc]) => ({ id, cat, name, desc, price, emoji }));
const MENU = [
  ...M('Bolos de Pote', [['bp-maracuja', 'Maracujá', 'Bolo de maracujá cremoso com calda de maracujá fresco.'], ['bp-brigadeiro', 'Brigadeiro', 'Bolo de chocolate com cobertura cremosa de brigadeiro.']], 600, '🍰'),
  ...M('Geladinhos Gourmet', [['gg-ninho-nutella', 'Ninho com Nutella', 'Cremoso e delicioso.'], ['gg-brig-nutella', 'Brigadeiro com Nutella', 'Irresistível.'], ['gg-mar-nutella', 'Maracujá com Nutella', 'Tropical e gourmet.'], ['gg-ninho-oreo', 'Ninho com Oreo', 'Crocante e cremoso.'], ['gg-pacoca', 'Paçoca', 'Sabor tradicional e gelado.'], ['gg-mor-nutella', 'Morango com Nutella', 'Frutado e gourmet.'], ['gg-pudim', 'Pudim', 'Doce e macio.']], 300, '🍦'),
  ...M('Geladinhos', [['g-mar-nutella', 'Maracujá com Nutella', 'Refrescante e saboroso.'], ['g-ninho-nutella', 'Ninho com Nutella', 'Cremoso e delicioso.'], ['g-mor-nutella', 'Morango com Nutella', 'Frutado e gelado.'], ['g-acai', 'Açaí', 'Antioxidante e refrescante.'], ['g-maracuja', 'Maracujá', 'Refrescante e saboroso.'], ['g-morango', 'Morango', 'Refrescante e saboroso.'], ['g-cupuacu', 'Cupuaçu', 'Refrescante e saboroso.']], 200, '🧊'),
];
const BYID = Object.fromEntries(MENU.map(p => [p.id, p]));
const STATUS = ['aguardando', 'pago', 'preparo', 'pronto', 'entregue', 'cancelado'];

const init = () => db.query(`CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT PRIMARY KEY, n INT NOT NULL DEFAULT 0, until TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY, public_token TEXT NOT NULL, name TEXT NOT NULL, room TEXT NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('pix','card')), items JSONB NOT NULL, total_cents INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aguardando', mp_payment_id TEXT, pix_code TEXT, pix_qr TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ);
  CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS orders_mp_idx ON orders (mp_payment_id) WHERE mp_payment_id IS NOT NULL;`);

const app = express();
let ready; // cria as tabelas uma vez por instância (IF NOT EXISTS; erros de corrida são ignorados)
app.use((req, res, next) => { ready ??= init().catch(e => console.error('init', e.message)); ready.then(() => next()); });
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Erro interno' }); });
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = s => crypto.createHmac('sha256', SESSION_SECRET).update(s).digest('hex');

// ---- Auth admin (token assinado, 12h) + limite de tentativas ----
app.post('/api/admin/login', wrap(async (req, res) => {
  const ip = req.ip || 'x';
  const { rows: [t] } = await db.query(`SELECT n, until FROM login_attempts WHERE ip=$1`, [ip]);
  if (t?.until && new Date(t.until) > new Date()) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  if (!eq(req.body?.password || '', ADMIN_PASSWORD)) {
    await db.query(`INSERT INTO login_attempts (ip, n) VALUES ($1, 1) ON CONFLICT (ip) DO UPDATE SET
      n = CASE WHEN login_attempts.n + 1 >= 5 THEN 0 ELSE login_attempts.n + 1 END,
      until = CASE WHEN login_attempts.n + 1 >= 5 THEN now() + interval '5 minutes' ELSE NULL END`, [ip]);
    return res.status(401).json({ error: 'Senha incorreta' });
  }
  await db.query(`DELETE FROM login_attempts WHERE ip=$1`, [ip]);
  const exp = Date.now() + 12 * 3600e3;
  res.json({ token: `${exp}.${hmac(String(exp))}` });
}));
const auth = (req, res, next) => {
  const [exp, sig] = (req.get('authorization') || '').replace('Bearer ', '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() || !eq(sig, hmac(exp))) return res.status(401).json({ error: 'Não autorizado' });
  next();
};

// ---- Mercado Pago ----
const mp = (path, opts = {}) => fetch('https://api.mercadopago.com' + path, { ...opts, headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json', ...opts.headers } });

app.get('/api/menu', (_, res) => res.json(MENU));

const pub = o => ({ id: o.id, name: o.name, room: o.room, payment: o.payment, items: o.items, total_cents: o.total_cents, status: o.status, pix_code: o.status === 'aguardando' ? o.pix_code : null, pix_qr: o.status === 'aguardando' ? o.pix_qr : null, created_at: o.created_at });

app.post('/api/orders', wrap(async (req, res) => {
  const { name, room, payment, items } = req.body || {};
  const nm = String(name || '').trim().slice(0, 60), rm = String(room || '').trim().slice(0, 30);
  if (nm.length < 2 || !rm) return res.status(400).json({ error: 'Informe nome e sala.' });
  if (!['pix', 'card'].includes(payment)) return res.status(400).json({ error: 'Escolha a forma de pagamento.' });
  if (!Array.isArray(items) || !items.length || items.length > 30) return res.status(400).json({ error: 'Sacola vazia.' });
  let total = 0; const lines = [];
  for (const it of items) {
    const p = BYID[it?.id], q = Number(it?.qty);
    if (!p || !Number.isInteger(q) || q < 1 || q > 20) return res.status(400).json({ error: 'Item inválido.' });
    total += p.price * q; lines.push({ id: p.id, name: `${p.name} (${p.cat})`, qty: q, price: p.price });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const { rows: [o] } = await db.query(`INSERT INTO orders (public_token,name,room,payment,items,total_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [token, nm, rm, payment, JSON.stringify(lines), total]);
  if (payment === 'pix') {
    try {
      const r = await mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': `order-${o.id}-${token}` }, body: JSON.stringify({
        transaction_amount: total / 100, description: `Mari Gourmet - pedido #${o.id}`, payment_method_id: 'pix',
        payer: { email: PAYER_EMAIL, first_name: nm.split(' ')[0] }, external_reference: String(o.id),
        notification_url: `${BASE_URL}/api/webhooks/mercadopago`,
        date_of_expiration: new Date(Date.now() + 30 * 60e3).toISOString().replace('Z', '-00:00') }) });
      const d = await r.json(); const td = d?.point_of_interaction?.transaction_data;
      if (!r.ok || !td) throw new Error(JSON.stringify(d));
      const { rows: [u] } = await db.query(`UPDATE orders SET mp_payment_id=$1, pix_code=$2, pix_qr=$3 WHERE id=$4 RETURNING *`, [String(d.id), td.qr_code, td.qr_code_base64, o.id]);
      return res.json({ ...pub(u), token });
    } catch (e) {
      console.error('PIX falhou', e.message);
      await db.query(`UPDATE orders SET status='cancelado' WHERE id=$1`, [o.id]);
      return res.status(502).json({ error: 'Não foi possível gerar o PIX agora. Tente novamente ou pague com cartão.' });
    }
  }
  res.json({ ...pub(o), token });
}));

app.get('/api/orders/:id', wrap(async (req, res) => {
  const { rows: [o] } = await db.query(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
  if (!o || !eq(o.public_token, req.query.t || '')) return res.status(404).json({ error: 'Pedido não encontrado' });
  res.json(pub(o));
}));

// ---- Webhook PIX: valida assinatura E consulta o pagamento direto na API ----
app.post('/api/webhooks/mercadopago', wrap(async (req, res) => {
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '').toLowerCase();
  if (MP_WEBHOOK_SECRET) {
    const sig = Object.fromEntries((req.get('x-signature') || '').split(',').map(s => s.trim().split('=')));
    const manifest = `id:${dataId};request-id:${req.get('x-request-id') || ''};ts:${sig.ts};`;
    const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
    if (!sig.v1 || !eq(sig.v1, expected)) return res.sendStatus(401);
  }
  if (!/^\d+$/.test(dataId)) return res.sendStatus(200);
  const r = await mp(`/v1/payments/${dataId}`);
  if (!r.ok) return res.sendStatus(500); // MP tentará novamente
  const p = await r.json();
  if (p.status === 'approved') {
    await db.query(`UPDATE orders SET status='pago', paid_at=now() WHERE mp_payment_id=$1 AND status='aguardando' AND total_cents = $2`, [String(p.id), Math.round(p.transaction_amount * 100)]);
  } else if (['cancelled', 'expired'].includes(p.status)) {
    await db.query(`UPDATE orders SET status='cancelado' WHERE mp_payment_id=$1 AND status='aguardando'`, [String(p.id)]);
  }
  res.sendStatus(200);
}));

// ---- Painel da loja: pedidos do dia (fuso de Brasília), FIFO ----
app.get('/api/admin/orders', auth, wrap(async (_, res) => {
  const { rows } = await db.query(`SELECT id,name,room,payment,items,total_cents,status,created_at FROM orders
    WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY id ASC`);
  res.json(rows);
}));
app.patch('/api/admin/orders/:id/status', auth, wrap(async (req, res) => {
  const s = req.body?.status;
  if (!STATUS.includes(s)) return res.status(400).json({ error: 'Status inválido' });
  const { rowCount } = await db.query(`UPDATE orders SET status=$1, paid_at = CASE WHEN $1='pago' AND paid_at IS NULL THEN now() ELSE paid_at END WHERE id=$2`, [s, req.params.id]);
  res.json({ ok: !!rowCount });
}));
app.get('/api/health', (_, res) => res.send('ok'));
export default app;
