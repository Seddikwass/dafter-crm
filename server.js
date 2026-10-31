'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('./lib/pg');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.SESSION_SECRET || 'dev-secret-a-changer';
const SUPERADMIN_EMAIL = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL manquant'); process.exit(1); }
const db = new Pool(process.env.DATABASE_URL, Number(process.env.DB_POOL || 5));

const PLANS = {
  mensuel: { label: 'Pro mensuel', price: 40, period: 'mois', months: 1, maxUsers: 10, maxClients: 100000 },
  annuel: { label: 'Pro annuel', price: 400, period: 'an', months: 12, maxUsers: 10, maxClients: 100000 },
};
const FREE = { label: 'Gratuit', maxInvoicesPerMonth: 20, maxUsers: 1 };
const DOC_TYPES = {
  devis: { label: 'Devis', prefix: 'DV' },
  commande: { label: 'Bon de commande', prefix: 'BC' },
  livraison: { label: 'Bon de livraison', prefix: 'BL' },
  avoir: { label: 'Avoir', prefix: 'AV' },
};
const METHODS = ['espèces', 'chèque', 'virement', 'traite', 'carte', 'D17', 'retenue à la source'];
const RS_RATES = [0.5, 1, 1.5, 3, 5, 10, 15, 25];
// Matricule fiscal tunisien : 7 chiffres + lettre de contrôle, puis code TVA / catégorie / n° d'établissement (ex. 1234567/A/M/000).
function normMF(v) {
  const raw = str(v, 40); if (!raw) return null;
  const x = raw.toUpperCase().replace(/[\s.\-]/g, '');
  let m = x.match(/^(\d{7})\/?([A-Z])\/?([A-Z])\/?([A-Z])\/?(\d{3})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}/${m[4]}/${m[5]}`.replace(/^(\d{7})\/([A-Z])/, '$1$2');
  m = x.match(/^(\d{7})\/?([A-Z])\/?([A-Z])\/?(\d{3})$/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  m = x.match(/^(\d{7})\/?([A-Z])$/);
  if (m) return m[1] + m[2];
  throw bad('Matricule fiscal invalide. Exemples acceptés : 1234567A/A/M/000, 1234567/A/M/000 ou 1234567A');
}
const PURCHASE_TYPES = {
  commande: { label: 'Commande fournisseur', prefix: 'CF' },
  reception: { label: 'Bon de réception', prefix: 'BR' },
  facture: { label: 'Facture d\'achat', prefix: 'FA' },
};
const PURCHASE_SELECT = `
  SELECT pu.id, pu.supplier_id, s.name AS supplier_name, pu.type, pu.number, pu.supplier_ref, pu.issue_date, pu.due_date, pu.items, pu.total_ht, pu.total_tva, pu.timbre, pu.total_ttc, pu.notes, pu.status, pu.linked_id, pu.created_at,
    l.number AS linked_number, l.type AS linked_type,
    COALESCE(pp.paid, 0)::numeric AS paid,
    CASE WHEN pu.type = 'facture' THEN (pu.total_ttc - COALESCE(pp.paid, 0)) ELSE 0 END::numeric AS balance,
    CASE WHEN pu.type <> 'facture' THEN pu.status
         WHEN COALESCE(pp.paid,0) >= pu.total_ttc - 0.0005 THEN 'payee'
         WHEN pu.due_date < CURRENT_DATE THEN 'retard'
         WHEN COALESCE(pp.paid,0) > 0 THEN 'partielle'
         ELSE 'attente' END AS pay_status,
    (CURRENT_DATE - pu.due_date) AS days_overdue
  FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
  LEFT JOIN purchases l ON l.id = pu.linked_id
  LEFT JOIN (SELECT purchase_id, SUM(amount) paid FROM purchase_payments GROUP BY purchase_id) pp ON pp.purchase_id = pu.id`;
const TVA_RATES = [0, 7, 13, 19];

// ---------- utilitaires ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);
const r3 = n => Math.round((Number(n) || 0) * 1000) / 1000;
const str = (v, max = 500) => (v === undefined || v === null) ? null : String(v).trim().slice(0, max) || null;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const isEmail = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date()); }
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function addMonths(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [, s, k] = String(stored).split('$');
  if (!s || !k) return false;
  const key = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32);
  return crypto.timingSafeEqual(key, Buffer.from(k, 'base64'));
}
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(token) {
  if (!token) return null;
  const [b, s] = token.split('.');
  if (!b || !s) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function setSession(req, res, token, maxAge) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

const loginAttempts = new Map();
function throttle(key) {
  const now = Date.now(); const a = (loginAttempts.get(key) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 10) throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
  a.push(now); loginAttempts.set(key, a);
}

// ---------- abonnement ----------
function subscription(c) {
  const t = today();
  const paidOk = c.paid_until && c.paid_until >= t;
  const trialOk = c.trial_ends >= t;
  let state = 'free';
  if (c.status === 'suspended') state = 'suspended';
  else if (paidOk) state = 'active';
  else if (trialOk) state = 'trial';
  const end = paidOk ? c.paid_until : c.trial_ends;
  const daysLeft = Math.round((Date.parse(end) - Date.parse(t)) / 864e5);
  const plan = state === 'free' ? FREE : PLANS[c.plan];
  return { state, plan: state === 'free' ? 'gratuit' : c.plan, plan_label: plan?.label || c.plan, price: state === 'free' ? 0 : plan?.price, period: plan?.period || 'mois', ends: end, days_left: daysLeft,
    can_write: state !== 'suspended', free_limit: FREE.maxInvoicesPerMonth, paid_plan: c.plan };
}

// ---------- routeur ----------
const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, opts });
}

async function loadUser(req) {
  const p = verify(cookies(req).sid);
  if (!p) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.is_superadmin, u.company_id, c.name AS company_name, c.plan, c.status, c.trial_ends, c.paid_until, c.is_platform
     FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`, [p.uid]);
  return rows[0] || null;
}

// ---------- authentification ----------
route('POST', '/api/auth/register', { public: true }, async (req, res, b) => {
  throttle('reg:' + req.ip);
  const companyName = str(b.companyName, 120), name = str(b.name, 120), email = str(b.email, 160)?.toLowerCase();
  if (!companyName && !(SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL)) throw bad('Nom de l\'entreprise obligatoire');
  if (!name) throw bad('Votre nom est obligatoire');
  if (!isEmail(email)) throw bad('E-mail invalide');
  if (!b.password || String(b.password).length < 8) throw bad('Le mot de passe doit contenir au moins 8 caractères');
  const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rows.length) throw bad('Un compte existe déjà avec cet e-mail');
  const user = await db.tx(async t => {
    if (SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL) {
      const pid = await platformCompany(t);
      const u = await t.query(`INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin) VALUES ($1,$2,$3,$4,'owner',true) RETURNING id`, [pid, name, email, hashPassword(String(b.password))]);
      return u.rows[0];
    }
    const c = await t.query(`INSERT INTO companies (name, phone, email, matricule_fiscal, trial_ends, plan) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [companyName, str(b.phone, 40), email, normMF(b.matricule_fiscal), addDays(today(), TRIAL_DAYS), PLANS[b.plan] ? b.plan : 'mensuel']);
    const u = await t.query(`INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin) VALUES ($1,$2,$3,$4,'owner',$5) RETURNING id`,
      [c.rows[0].id, name, email, hashPassword(String(b.password)), !!SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL]);
    return u.rows[0];
  });
  setSession(req, res, sign({ uid: user.id, exp: Date.now() + 30 * 864e5 }), 30 * 86400);
  return { ok: true };
});

route('POST', '/api/auth/login', { public: true }, async (req, res, b) => {
  const email = str(b.email, 160)?.toLowerCase();
  throttle('login:' + email + ':' + req.ip);
  const { rows } = await db.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  if (!rows[0] || !checkPassword(String(b.password || ''), rows[0].password_hash)) throw new HttpError(401, 'E-mail ou mot de passe incorrect');
  await db.query('UPDATE users SET last_login = now() WHERE id = $1', [rows[0].id]);
  if (SUPERADMIN_EMAIL && email === SUPERADMIN_EMAIL) await db.query('UPDATE users SET is_superadmin = true WHERE id = $1', [rows[0].id]);
  setSession(req, res, sign({ uid: rows[0].id, exp: Date.now() + 30 * 864e5 }), 30 * 86400);
  return { ok: true };
});

route('POST', '/api/auth/logout', { public: true }, async (req, res) => { setSession(req, res, '', 0); return { ok: true }; });

route('GET', '/api/me', async (req) => {
  const u = req.user;
  runRemindersSoon(u.company_id);
  const { rows } = await db.query('SELECT * FROM companies WHERE id = $1', [u.company_id]);
  const c = rows[0];
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, is_superadmin: u.is_superadmin },
    company: { id: c.id, is_platform: c.is_platform, name: c.name, matricule_fiscal: c.matricule_fiscal, address: c.address, city: c.city, phone: c.phone, email: c.email, invoice_prefix: c.invoice_prefix, default_due_days: c.default_due_days, invoice_footer: c.invoice_footer, reminder_settings: reminderSettings(c) },
    email_ready: !!process.env.BREVO_API_KEY,
    rs_rates: RS_RATES, subscription: subscription(c), plans: PLANS, free: FREE, doc_types: DOC_TYPES, purchase_types: PURCHASE_TYPES, invoices_this_month: await invoicesThisMonth(c.id), methods: METHODS, tva_rates: TVA_RATES, today: today(),
    payment_info: process.env.PAYMENT_INFO || '',
    payment: { rib: process.env.PAYMENT_RIB || '', holder: process.env.PAYMENT_HOLDER || '', bank: process.env.PAYMENT_BANK || '', contact: process.env.PAYMENT_CONTACT || '' },
  };
});

route('PUT', '/api/me/password', { readOnlyOk: true }, async (req, res, b) => {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!checkPassword(String(b.current || ''), rows[0].password_hash)) throw bad('Mot de passe actuel incorrect');
  if (!b.next || String(b.next).length < 8) throw bad('Le nouveau mot de passe doit contenir au moins 8 caractères');
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(b.next)), req.user.id]);
  return { ok: true };
});

route('PUT', '/api/company', { owner: true, readOnlyOk: true }, async (req, res, b) => {
  const name = str(b.name, 120); if (!name) throw bad('Nom obligatoire');
  const due = Math.max(0, Math.min(365, parseInt(b.default_due_days, 10) || 30));
  const prefix = (str(b.invoice_prefix, 10) || 'F').replace(/[^A-Za-z0-9-]/g, '') || 'F';
  await db.query(`UPDATE companies SET name=$1, matricule_fiscal=$2, address=$3, city=$4, phone=$5, email=$6, invoice_prefix=$7, default_due_days=$8, invoice_footer=$9 WHERE id=$10`,
    [name, normMF(b.matricule_fiscal), str(b.address, 300), str(b.city, 80), str(b.phone, 40), str(b.email, 160), prefix, due, str(b.invoice_footer, 500), req.user.company_id]);
  return { ok: true };
});

route('DELETE', '/api/company', { owner: true, readOnlyOk: true }, async (req, res, b) => {
  const cid = req.user.company_id;
  if (req.user.is_platform) throw bad('L\'espace d\'administration ne peut pas être supprimé');
  const { rows } = await db.query('SELECT name FROM companies WHERE id = $1', [cid]);
  if (String(b.confirm_name || '').trim() !== rows[0].name.trim()) throw bad('Le nom saisi ne correspond pas');
  await db.tx(async t => {
    for (const tbl of ['reminders', 'payments', 'purchase_payments', 'stock_moves', 'documents', 'purchases', 'invoices', 'warehouses', 'products', 'clients', 'suppliers', 'users']) await t.query(`DELETE FROM ${tbl} WHERE company_id = $1`, [cid]);
    await t.query('DELETE FROM companies WHERE id = $1', [cid]);
  });
  setSession(req, res, '', 0);
  return { ok: true };
});

route('PUT', '/api/company/plan', { owner: true, readOnlyOk: true }, async (req, res, b) => {
  if (!PLANS[b.plan]) throw bad('Formule inconnue');
  await db.query('UPDATE companies SET plan = $1 WHERE id = $2', [b.plan, req.user.company_id]);
  return { ok: true };
});

// ---------- équipe ----------
route('GET', '/api/users', async (req) => {
  const { rows } = await db.query('SELECT id, name, email, role, last_login FROM users WHERE company_id = $1 ORDER BY id', [req.user.company_id]);
  return rows;
});
route('POST', '/api/users', { owner: true }, async (req, res, b) => {
  const name = str(b.name, 120), email = str(b.email, 160)?.toLowerCase();
  if (!name || !isEmail(email)) throw bad('Nom et e-mail valides obligatoires');
  if (!b.password || String(b.password).length < 8) throw bad('Mot de passe de 8 caractères minimum');
  const n = await db.query('SELECT count(*)::int n FROM users WHERE company_id = $1', [req.user.company_id]);
  const max = subscription(req.user).state === 'free' ? FREE.maxUsers : (PLANS[req.user.plan]?.maxUsers || 10);
  if (n.rows[0].n >= max) throw bad(max === 1 ? 'La formule gratuite est limitée à 1 utilisateur. Passez à Pro pour ajouter votre équipe.' : `Votre formule permet ${max} utilisateurs maximum`);
  const ex = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (ex.rows.length) throw bad('Cet e-mail est déjà utilisé');
  await db.query(`INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'member')`, [req.user.company_id, name, email, hashPassword(String(b.password))]);
  return { ok: true };
});
route('DELETE', '/api/users/:id', { owner: true }, async (req, res, b, p) => {
  if (Number(p.id) === req.user.id) throw bad('Vous ne pouvez pas supprimer votre propre compte');
  await db.query(`DELETE FROM users WHERE id = $1 AND company_id = $2 AND role <> 'owner'`, [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- clients ----------
const INVOICE_SELECT = `
  SELECT i.id, i.client_id, cl.name AS client_name, i.number, i.issue_date, i.due_date, i.total_ht, i.total_tva, i.timbre, i.total_ttc, i.notes, i.created_at,
    COALESCE(p.paid, 0)::numeric AS paid,
    (i.total_ttc - COALESCE(p.paid, 0))::numeric AS balance,
    CASE WHEN COALESCE(p.paid,0) >= i.total_ttc - 0.0005 THEN 'payee'
         WHEN i.due_date < CURRENT_DATE THEN 'retard'
         WHEN COALESCE(p.paid,0) > 0 THEN 'partielle'
         ELSE 'attente' END AS status,
    (CURRENT_DATE - i.due_date) AS days_overdue
  FROM invoices i
  JOIN clients cl ON cl.id = i.client_id
  LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id`;

function clientFields(b) {
  const name = str(b.name, 160); if (!name) throw bad('Nom du client obligatoire');
  const email = str(b.email, 160); if (email && !isEmail(email)) throw bad('E-mail du client invalide');
  return [name, normMF(b.matricule_fiscal), str(b.contact_name, 120), str(b.phone, 40), email, str(b.address, 300), str(b.city, 80), str(b.notes, 2000)];
}

route('GET', '/api/clients', async (req) => {
  const { rows } = await db.query(`
    SELECT c.*, COALESCE(s.invoiced,0)::numeric invoiced, COALESCE(s.paid,0)::numeric paid, COALESCE(s.balance,0)::numeric balance,
      COALESCE(s.overdue,0)::numeric overdue, COALESCE(s.count,0)::int invoice_count
    FROM clients c LEFT JOIN (
      SELECT client_id, SUM(total_ttc) invoiced, SUM(paid) paid, SUM(balance) balance,
        SUM(CASE WHEN status='retard' THEN balance ELSE 0 END) overdue, count(*) count
      FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x GROUP BY client_id
    ) s ON s.client_id = c.id
    WHERE c.company_id = $1 ORDER BY c.name`, [req.user.company_id]);
  return rows;
});
route('GET', '/api/clients/:id', async (req, res, b, p) => {
  const c = await db.query('SELECT * FROM clients WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  if (!c.rows[0]) throw new HttpError(404, 'Client introuvable');
  const inv = await db.query(`${INVOICE_SELECT} WHERE i.company_id = $1 AND i.client_id = $2 ORDER BY i.issue_date DESC, i.id DESC`, [req.user.company_id, p.id]);
  const pay = await db.query(`SELECT p.*, i.number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.company_id = $1 AND i.client_id = $2 ORDER BY p.paid_on DESC, p.id DESC`, [req.user.company_id, p.id]);
  return { client: c.rows[0], invoices: inv.rows, payments: pay.rows };
});
route('POST', '/api/clients', async (req, res, b) => {
  const n = await db.query('SELECT count(*)::int n FROM clients WHERE company_id = $1', [req.user.company_id]);
  const max = PLANS[req.user.plan]?.maxClients || 100000;
  if (n.rows[0].n >= max) throw bad(`Limite de ${max} clients atteinte.`);
  const { rows } = await db.query(`INSERT INTO clients (company_id, name, matricule_fiscal, contact_name, phone, email, address, city, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [req.user.company_id, ...clientFields(b)]);
  return rows[0];
});
route('PUT', '/api/clients/:id', async (req, res, b, p) => {
  const r = await db.query(`UPDATE clients SET name=$1, matricule_fiscal=$2, contact_name=$3, phone=$4, email=$5, address=$6, city=$7, notes=$8 WHERE id=$9 AND company_id=$10`,
    [...clientFields(b), p.id, req.user.company_id]);
  if (!r.rowCount) throw new HttpError(404, 'Client introuvable');
  return { ok: true };
});
route('DELETE', '/api/clients/:id', async (req, res, b, p) => {
  const inv = await db.query('SELECT (SELECT count(*) FROM invoices WHERE client_id = $1 AND company_id = $2)::int n, (SELECT count(*) FROM documents WHERE client_id = $1 AND company_id = $2)::int d', [p.id, req.user.company_id]);
  if (inv.rows[0].n) throw bad('Ce client a des factures : supprimez-les d\'abord.');
  if (inv.rows[0].d) throw bad('Ce client a des devis ou des bons : supprimez-les d\'abord.');
  await db.query('DELETE FROM clients WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- factures ----------
async function defaultWarehouse(t, cid) {
  const r = await t.query('SELECT id FROM warehouses WHERE company_id = $1 ORDER BY id LIMIT 1', [cid]);
  if (r.rows[0]) return r.rows[0].id;
  return (await t.query(`INSERT INTO warehouses (company_id, name) VALUES ($1, 'Dépôt principal') RETURNING id`, [cid])).rows[0].id;
}
// Remplace les mouvements de stock liés à une pièce (facture, bon, réception…) par ceux de ses lignes.
async function syncStock(t, cid, source, sourceId, items, sign, date, ref, userId, warehouseId) {
  await t.query('DELETE FROM stock_moves WHERE company_id = $1 AND source = $2 AND source_id = $3', [cid, source, sourceId]);
  if (!items || !items.length) return;
  const ids = [...new Set(items.filter(i => i.product_id).map(i => Number(i.product_id)))];
  if (!ids.length) return;
  const tracked = (await t.query(`SELECT id FROM products WHERE company_id = $1 AND track_stock AND id IN (SELECT jsonb_array_elements_text($2::jsonb)::int)`, [cid, JSON.stringify(ids)])).rows.map(r => r.id);
  if (!tracked.length) return;
  const wh = warehouseId || await defaultWarehouse(t, cid);
  for (const it of items) {
    if (!tracked.includes(Number(it.product_id))) continue;
    await t.query(`INSERT INTO stock_moves (company_id, product_id, warehouse_id, qty, kind, source, source_id, ref, moved_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [cid, it.product_id, wh, r3(it.qty * sign), sign > 0 ? 'entree' : 'sortie', source, sourceId, ref, date, userId]);
  }
}
async function invoicesThisMonth(cid) {
  const { rows } = await db.query(`SELECT count(*)::int n FROM invoices WHERE company_id = $1 AND date_trunc('month', created_at) = date_trunc('month', now())`, [cid]);
  return rows[0].n;
}
async function insertInvoice(t, req, b, v, opts = {}) {
  const cid = req.user.company_id;
  if (!req.user.is_superadmin && subscription(req.user).state === 'free' && await invoicesThisMonth(cid) >= FREE.maxInvoicesPerMonth)
    throw new HttpError(402, `La formule gratuite est limitée à ${FREE.maxInvoicesPerMonth} factures par mois. Passez à Pro (40 DT par mois) pour facturer sans limite.`);
  const year = Number(b.issue_date.slice(0, 4));
  const seq = await t.query(`UPDATE companies SET invoice_seq = CASE WHEN invoice_seq_year = $2 THEN invoice_seq + 1 ELSE 1 END, invoice_seq_year = $2 WHERE id = $1 RETURNING invoice_seq, invoice_prefix`, [cid, year]);
  let number = str(b.number, 40);
  if (!number) number = `${seq.rows[0].invoice_prefix}${year}-${String(seq.rows[0].invoice_seq).padStart(4, '0')}`;
  const dup = await t.query('SELECT 1 FROM invoices WHERE company_id = $1 AND number = $2', [cid, number]);
  if (dup.rows.length) throw bad(`Le numéro ${number} existe déjà`);
  const { rows } = await t.query(`INSERT INTO invoices (company_id, client_id, number, issue_date, due_date, items, total_ht, total_tva, timbre, total_ttc, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
    [cid, b.client_id, number, b.issue_date, b.due_date, v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000)]);
  if (!opts.skipStock) await syncStock(t, cid, 'invoice', rows[0].id, v.items, -1, b.issue_date, rows[0].number, req.user.id);
  return rows[0];
}
function computeInvoice(b) {
  if (!Array.isArray(b.items) || !b.items.length) throw bad('Ajoutez au moins une ligne');
  if (b.items.length > 200) throw bad('Trop de lignes');
  let ht = 0, tva = 0;
  const items = b.items.map(it => {
    const designation = str(it.designation, 300); if (!designation) throw bad('Chaque ligne doit avoir une désignation');
    const qty = Number(it.qty), price = Number(it.unit_price), rate = Number(it.tva);
    if (!(qty > 0)) throw bad('Quantité invalide');
    if (!(price >= 0)) throw bad('Prix invalide');
    if (!TVA_RATES.includes(rate)) throw bad('Taux de TVA invalide');
    const lineHt = r3(qty * price);
    ht += lineHt; tva += r3(lineHt * rate / 100);
    const line = { designation, qty, unit_price: r3(price), tva: rate, total_ht: lineHt };
    if (it.product_id) line.product_id = Number(it.product_id) || undefined;
    if (it.ref) line.ref = str(it.ref, 40);
    if (it.unit) line.unit = str(it.unit, 20);
    return line;
  });
  ht = r3(ht); tva = r3(tva);
  const timbre = b.timbre ? 1 : 0;
  return { items, ht, tva, timbre, ttc: r3(ht + tva + timbre) };
}

route('GET', '/api/invoices', async (req) => {
  const { rows } = await db.query(`${INVOICE_SELECT} WHERE i.company_id = $1 ORDER BY i.issue_date DESC, i.id DESC`, [req.user.company_id]);
  return rows;
});
route('GET', '/api/invoices/:id', async (req, res, b, p) => {
  const inv = await db.query(`${INVOICE_SELECT} WHERE i.company_id = $1 AND i.id = $2`, [req.user.company_id, p.id]);
  if (!inv.rows[0]) throw new HttpError(404, 'Facture introuvable');
  const items = await db.query('SELECT items FROM invoices WHERE id = $1', [p.id]);
  const client = await db.query('SELECT * FROM clients WHERE id = $1', [inv.rows[0].client_id]);
  const pays = await db.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_on, id', [p.id]);
  const rem = await db.query('SELECT r.*, u.name AS user_name FROM reminders r LEFT JOIN users u ON u.id = r.sent_by WHERE r.invoice_id = $1 ORDER BY r.sent_at DESC', [p.id]);
  return { ...inv.rows[0], items: items.rows[0].items, client: client.rows[0], payments: pays.rows, reminders: rem.rows };
});
route('POST', '/api/invoices', async (req, res, b) => {
  const cid = req.user.company_id;
  const cl = await db.query('SELECT id FROM clients WHERE id = $1 AND company_id = $2', [b.client_id, cid]);
  if (!cl.rows[0]) throw bad('Choisissez un client');
  if (!isDate(b.issue_date) || !isDate(b.due_date)) throw bad('Dates invalides');
  if (b.due_date < b.issue_date) throw bad('L\'échéance doit être après la date de facture');
  const v = computeInvoice(b);
  return db.tx(t => insertInvoice(t, req, b, v));
});
route('PUT', '/api/invoices/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const cl = await db.query('SELECT id FROM clients WHERE id = $1 AND company_id = $2', [b.client_id, cid]);
  if (!cl.rows[0]) throw bad('Choisissez un client');
  if (!isDate(b.issue_date) || !isDate(b.due_date)) throw bad('Dates invalides');
  if (b.due_date < b.issue_date) throw bad('L\'échéance doit être après la date de facture');
  const v = computeInvoice(b);
  const paid = await db.query('SELECT COALESCE(SUM(amount),0)::numeric s FROM payments WHERE invoice_id = $1 AND company_id = $2', [p.id, cid]);
  if (paid.rows[0].s > v.ttc + 0.0005) throw bad('Le total ne peut pas être inférieur aux paiements déjà reçus');
  const number = str(b.number, 40);
  if (!number) throw bad('Numéro de facture obligatoire');
  const dup = await db.query('SELECT 1 FROM invoices WHERE company_id = $1 AND number = $2 AND id <> $3', [cid, number, p.id]);
  if (dup.rows.length) throw bad(`Le numéro ${number} existe déjà`);
  return db.tx(async t => {
    const r = await t.query(`UPDATE invoices SET client_id=$1, number=$2, issue_date=$3, due_date=$4, items=$5, total_ht=$6, total_tva=$7, timbre=$8, total_ttc=$9, notes=$10 WHERE id=$11 AND company_id=$12`,
      [b.client_id, number, b.issue_date, b.due_date, v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000), p.id, cid]);
    if (!r.rowCount) throw new HttpError(404, 'Facture introuvable');
    const fromBL = await t.query(`SELECT 1 FROM documents WHERE company_id = $1 AND invoice_id = $2 AND type = 'livraison'`, [cid, p.id]);
    if (!fromBL.rows.length) await syncStock(t, cid, 'invoice', Number(p.id), v.items, -1, b.issue_date, number, req.user.id);
    return { ok: true };
  });
});
route('DELETE', '/api/invoices/:id', async (req, res, b, p) => {
  await db.tx(async t => {
    await syncStock(t, req.user.company_id, 'invoice', Number(p.id), null);
    await t.query('DELETE FROM invoices WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  });
  return { ok: true };
});

// ---------- articles ----------
function productFields(b) {
  const name = str(b.name, 200); if (!name) throw bad('Désignation obligatoire');
  const price = Number(b.unit_price); if (!(price >= 0)) throw bad('Prix invalide');
  const rate = Number(b.tva); if (!TVA_RATES.includes(rate)) throw bad('Taux de TVA invalide');
  const alert = b.stock_alert === '' || b.stock_alert == null ? null : Number(b.stock_alert);
  const buy = b.purchase_price === '' || b.purchase_price == null ? null : r3(b.purchase_price);
  return [str(b.ref, 40), name, str(b.unit, 20), r3(price), rate, str(b.description, 1000), !!b.track_stock, Number.isFinite(alert) ? alert : null, buy];
}
route('GET', '/api/products', async (req) => {
  const { rows } = await db.query(`SELECT p.*, COALESCE((SELECT SUM(qty) FROM stock_moves m WHERE m.product_id = p.id), 0)::numeric AS stock FROM products p WHERE p.company_id = $1 ORDER BY p.name`, [req.user.company_id]);
  return rows;
});
route('POST', '/api/products', async (req, res, b) => {
  const { rows } = await db.query('INSERT INTO products (company_id, ref, name, unit, unit_price, tva, description, track_stock, stock_alert, purchase_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [req.user.company_id, ...productFields(b)]);
  return rows[0];
});
route('PUT', '/api/products/:id', async (req, res, b, p) => {
  const r = await db.query('UPDATE products SET ref=$1, name=$2, unit=$3, unit_price=$4, tva=$5, description=$6, track_stock=$7, stock_alert=$8, purchase_price=$9 WHERE id=$10 AND company_id=$11', [...productFields(b), p.id, req.user.company_id]);
  if (!r.rowCount) throw new HttpError(404, 'Article introuvable');
  return { ok: true };
});
route('DELETE', '/api/products/:id', async (req, res, b, p) => {
  await db.query('DELETE FROM stock_moves WHERE product_id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  await db.query('DELETE FROM products WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- devis, bons, avoirs ----------
const DOC_SELECT = `SELECT d.*, cl.name AS client_name, i.number AS invoice_number FROM documents d JOIN clients cl ON cl.id = d.client_id LEFT JOIN invoices i ON i.id = d.invoice_id`;
function docType(t) { if (!DOC_TYPES[t]) throw bad('Type de document inconnu'); return t; }
async function docData(req, b) {
  const cl = await db.query('SELECT id FROM clients WHERE id = $1 AND company_id = $2', [b.client_id, req.user.company_id]);
  if (!cl.rows[0]) throw bad('Choisissez un client');
  if (!isDate(b.issue_date)) throw bad('Date invalide');
  if (b.valid_until && !isDate(b.valid_until)) throw bad('Date de validité invalide');
  return computeInvoice({ ...b, timbre: false });
}
route('GET', '/api/documents', async (req) => {
  const { rows } = await db.query(`${DOC_SELECT} WHERE d.company_id = $1 ORDER BY d.issue_date DESC, d.id DESC`, [req.user.company_id]);
  return rows;
});
route('GET', '/api/documents/:id', async (req, res, b, p) => {
  const { rows } = await db.query(`${DOC_SELECT} WHERE d.company_id = $1 AND d.id = $2`, [req.user.company_id, p.id]);
  if (!rows[0]) throw new HttpError(404, 'Document introuvable');
  const client = await db.query('SELECT * FROM clients WHERE id = $1', [rows[0].client_id]);
  return { ...rows[0], client: client.rows[0] };
});
route('POST', '/api/documents', async (req, res, b) => {
  const cid = req.user.company_id, type = docType(b.type);
  const v = await docData(req, b);
  let inv = null;
  if (type === 'avoir' && b.invoice_id) {
    const r = await db.query(`${INVOICE_SELECT} WHERE i.company_id = $1 AND i.id = $2`, [cid, b.invoice_id]);
    inv = r.rows[0]; if (!inv) throw bad('Facture introuvable');
    if (inv.client_id !== Number(b.client_id)) throw bad('L\'avoir doit concerner le client de la facture');
    if (v.ttc > r3(inv.balance) + 0.0005) throw bad(`L'avoir dépasse le reste à payer de la facture (${r3(inv.balance).toFixed(3)} DT)`);
  }
  return db.tx(async t => {
    const year = Number(b.issue_date.slice(0, 4)), key = `${type}-${year}`;
    const seq = await t.query(`UPDATE companies SET doc_seq = jsonb_set(doc_seq, ARRAY[$2::text], to_jsonb(COALESCE((doc_seq->>$2)::int, 0) + 1)) WHERE id = $1 RETURNING (doc_seq->>$2)::int n`, [cid, key]);
    const number = `${DOC_TYPES[type].prefix}${year}-${String(seq.rows[0].n).padStart(4, '0')}`;
    const { rows } = await t.query(`INSERT INTO documents (company_id, client_id, type, number, issue_date, valid_until, items, total_ht, total_tva, total_ttc, notes, status, invoice_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, number`,
      [cid, b.client_id, type, number, b.issue_date, b.valid_until || null, v.items, v.ht, v.tva, v.ttc, str(b.notes, 2000), type === 'avoir' && inv ? 'impute' : 'emis', inv ? inv.id : null]);
    if (inv) await t.query(`INSERT INTO payments (company_id, invoice_id, amount, paid_on, method, reference, created_by) VALUES ($1,$2,$3,$4,'avoir',$5,$6)`, [cid, inv.id, v.ttc, b.issue_date, number, req.user.id]);
    if (type === 'livraison') await syncStock(t, cid, 'document', rows[0].id, v.items, -1, b.issue_date, number, req.user.id);
    return rows[0];
  });
});
route('PUT', '/api/documents/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const cur = await db.query('SELECT type, status FROM documents WHERE id = $1 AND company_id = $2', [p.id, cid]);
  if (!cur.rows[0]) throw new HttpError(404, 'Document introuvable');
  if (cur.rows[0].status === 'converti' || cur.rows[0].status === 'impute') throw bad('Ce document a déjà été transformé : il ne peut plus être modifié');
  const v = await docData(req, b);
  await db.tx(async t => {
    await t.query(`UPDATE documents SET client_id=$1, issue_date=$2, valid_until=$3, items=$4, total_ht=$5, total_tva=$6, total_ttc=$7, notes=$8 WHERE id=$9 AND company_id=$10`,
      [b.client_id, b.issue_date, b.valid_until || null, v.items, v.ht, v.tva, v.ttc, str(b.notes, 2000), p.id, cid]);
    if (cur.rows[0].type === 'livraison') {
      const n = (await t.query('SELECT number FROM documents WHERE id = $1', [p.id])).rows[0].number;
      await syncStock(t, cid, 'document', Number(p.id), v.items, -1, b.issue_date, n, req.user.id);
    }
  });
  return { ok: true };
});
route('POST', '/api/documents/:id/status', async (req, res, b, p) => {
  if (!['emis', 'accepte', 'refuse'].includes(b.status)) throw bad('Statut invalide');
  const r = await db.query(`UPDATE documents SET status = $1 WHERE id = $2 AND company_id = $3 AND status NOT IN ('converti','impute')`, [b.status, p.id, req.user.company_id]);
  if (!r.rowCount) throw bad('Statut non modifiable');
  return { ok: true };
});
route('POST', '/api/documents/:id/convert', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const { rows } = await db.query('SELECT * FROM documents WHERE id = $1 AND company_id = $2', [p.id, cid]);
  const d = rows[0]; if (!d) throw new HttpError(404, 'Document introuvable');
  if (d.type === 'avoir') throw bad('Un avoir ne se transforme pas en facture');
  if (d.status === 'converti') throw bad('Ce document a déjà été facturé');
  const co = await db.query('SELECT default_due_days FROM companies WHERE id = $1', [cid]);
  const issue = today();
  const data = { client_id: d.client_id, issue_date: issue, due_date: addDays(issue, co.rows[0].default_due_days), items: d.items, timbre: true,
    notes: [`Selon ${DOC_TYPES[d.type].label.toLowerCase()} ${d.number}`, d.notes].filter(Boolean).join('\n') };
  const v = computeInvoice(data);
  return db.tx(async t => {
    const inv = await insertInvoice(t, req, data, v, { skipStock: d.type === 'livraison' });
    await t.query(`UPDATE documents SET status = 'converti', invoice_id = $1 WHERE id = $2`, [inv.id, d.id]);
    return inv;
  });
});
route('DELETE', '/api/documents/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  await db.tx(async t => {
    const { rows } = await t.query('SELECT type, number, invoice_id FROM documents WHERE id = $1 AND company_id = $2', [p.id, cid]);
    if (rows[0]?.type === 'avoir' && rows[0].invoice_id) await t.query(`DELETE FROM payments WHERE company_id = $1 AND invoice_id = $2 AND method = 'avoir' AND reference = $3`, [cid, rows[0].invoice_id, rows[0].number]);
    await syncStock(t, cid, 'document', Number(p.id), null);
    await t.query('DELETE FROM documents WHERE id = $1 AND company_id = $2', [p.id, cid]);
  });
  return { ok: true };
});

// ---------- stock ----------
route('GET', '/api/warehouses', async (req) => {
  await db.tx(t => defaultWarehouse(t, req.user.company_id));
  const { rows } = await db.query('SELECT * FROM warehouses WHERE company_id = $1 ORDER BY id', [req.user.company_id]);
  return rows;
});
route('POST', '/api/warehouses', async (req, res, b) => {
  const name = str(b.name, 80); if (!name) throw bad('Nom du dépôt obligatoire');
  return (await db.query('INSERT INTO warehouses (company_id, name) VALUES ($1,$2) RETURNING id', [req.user.company_id, name])).rows[0];
});
route('PUT', '/api/warehouses/:id', async (req, res, b, p) => {
  const name = str(b.name, 80); if (!name) throw bad('Nom du dépôt obligatoire');
  await db.query('UPDATE warehouses SET name = $1 WHERE id = $2 AND company_id = $3', [name, p.id, req.user.company_id]);
  return { ok: true };
});
route('DELETE', '/api/warehouses/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const n = await db.query('SELECT (SELECT count(*) FROM warehouses WHERE company_id = $1)::int w, (SELECT COALESCE(SUM(abs(qty)),0) FROM stock_moves WHERE warehouse_id = $2)::numeric m', [cid, p.id]);
  if (n.rows[0].w <= 1) throw bad('Gardez au moins un dépôt');
  if (n.rows[0].m > 0) throw bad('Ce dépôt a des mouvements de stock : il ne peut pas être supprimé');
  await db.query('DELETE FROM warehouses WHERE id = $1 AND company_id = $2', [p.id, cid]);
  return { ok: true };
});
route('GET', '/api/stock', async (req) => {
  const cid = req.user.company_id;
  await db.tx(t => defaultWarehouse(t, cid));
  const products = (await db.query(`SELECT p.id, p.ref, p.name, p.unit, p.stock_alert, p.purchase_price, p.unit_price, COALESCE(SUM(m.qty), 0)::numeric AS stock
    FROM products p LEFT JOIN stock_moves m ON m.product_id = p.id WHERE p.company_id = $1 AND p.track_stock GROUP BY p.id ORDER BY p.name`, [cid])).rows;
  const byWh = (await db.query(`SELECT product_id, warehouse_id, SUM(qty)::numeric qty FROM stock_moves WHERE company_id = $1 GROUP BY product_id, warehouse_id`, [cid])).rows;
  const warehouses = (await db.query('SELECT * FROM warehouses WHERE company_id = $1 ORDER BY id', [cid])).rows;
  return { products: products.map(p => ({ ...p, by_warehouse: byWh.filter(x => x.product_id === p.id) })), warehouses };
});
route('GET', '/api/stock/moves', async (req) => {
  const { rows } = await db.query(`SELECT m.*, p.name AS product_name, p.unit, w.name AS warehouse_name, u.name AS user_name FROM stock_moves m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.created_by
    WHERE m.company_id = $1 ORDER BY m.moved_on DESC, m.id DESC LIMIT 300`, [req.user.company_id]);
  return rows;
});
route('POST', '/api/stock/moves', async (req, res, b) => {
  const cid = req.user.company_id;
  const kind = b.kind;
  if (!['entree', 'sortie', 'inventaire', 'transfert'].includes(kind)) throw bad('Type de mouvement invalide');
  const prod = (await db.query('SELECT id, track_stock FROM products WHERE id = $1 AND company_id = $2', [b.product_id, cid])).rows[0];
  if (!prod) throw bad('Choisissez un article');
  const wh = (await db.query('SELECT id FROM warehouses WHERE id = $1 AND company_id = $2', [b.warehouse_id, cid])).rows[0];
  if (!wh) throw bad('Choisissez un dépôt');
  const qty = Number(b.qty), date = isDate(b.moved_on) ? b.moved_on : today(), ref = str(b.ref, 120);
  if (!Number.isFinite(qty) || (kind !== 'inventaire' && !(qty > 0)) || (kind === 'inventaire' && qty < 0)) throw bad('Quantité invalide');
  await db.tx(async t => {
    if (!prod.track_stock) await t.query('UPDATE products SET track_stock = true WHERE id = $1', [prod.id]);
    const ins = (w, q, k, r) => t.query(`INSERT INTO stock_moves (company_id, product_id, warehouse_id, qty, kind, source, ref, moved_on, created_by) VALUES ($1,$2,$3,$4,$5,'manuel',$6,$7,$8)`, [cid, prod.id, w, r3(q), k, r, date, req.user.id]);
    if (kind === 'entree') await ins(wh.id, qty, 'entree', ref);
    else if (kind === 'sortie') await ins(wh.id, -qty, 'sortie', ref);
    else if (kind === 'inventaire') {
      const cur = Number((await t.query('SELECT COALESCE(SUM(qty),0)::numeric s FROM stock_moves WHERE product_id = $1 AND warehouse_id = $2', [prod.id, wh.id])).rows[0].s);
      if (r3(qty - cur) !== 0) await ins(wh.id, qty - cur, 'inventaire', ref || `Inventaire : ${qty} comptés`);
    } else {
      const to = (await t.query('SELECT id FROM warehouses WHERE id = $1 AND company_id = $2', [b.to_warehouse_id, cid])).rows[0];
      if (!to || to.id === wh.id) throw bad('Choisissez un dépôt de destination différent');
      await ins(wh.id, -qty, 'transfert', ref || 'Transfert sortant');
      await ins(to.id, qty, 'transfert', ref || 'Transfert entrant');
    }
  });
  return { ok: true };
});
route('DELETE', '/api/stock/moves/:id', async (req, res, b, p) => {
  const r = await db.query(`DELETE FROM stock_moves WHERE id = $1 AND company_id = $2 AND source = 'manuel'`, [p.id, req.user.company_id]);
  if (!r.rowCount) throw bad('Seuls les mouvements saisis à la main peuvent être annulés ici');
  return { ok: true };
});

// ---------- fournisseurs & achats ----------
route('GET', '/api/suppliers', async (req) => {
  const { rows } = await db.query(`SELECT s.*, COALESCE(x.balance,0)::numeric balance, COALESCE(x.overdue,0)::numeric overdue, COALESCE(x.n,0)::int purchase_count
    FROM suppliers s LEFT JOIN (SELECT supplier_id, SUM(balance) balance, SUM(CASE WHEN pay_status='retard' THEN balance ELSE 0 END) overdue, count(*) n FROM (${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.type = 'facture') q GROUP BY supplier_id) x ON x.supplier_id = s.id
    WHERE s.company_id = $1 ORDER BY s.name`, [req.user.company_id]);
  return rows;
});
route('GET', '/api/suppliers/:id', async (req, res, b, p) => {
  const s = (await db.query('SELECT * FROM suppliers WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id])).rows[0];
  if (!s) throw new HttpError(404, 'Fournisseur introuvable');
  const purchases = (await db.query(`${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.supplier_id = $2 ORDER BY pu.issue_date DESC, pu.id DESC`, [req.user.company_id, p.id])).rows;
  return { supplier: s, purchases };
});
route('POST', '/api/suppliers', async (req, res, b) => {
  const { rows } = await db.query(`INSERT INTO suppliers (company_id, name, matricule_fiscal, contact_name, phone, email, address, city, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [req.user.company_id, ...clientFields(b)]);
  return rows[0];
});
route('PUT', '/api/suppliers/:id', async (req, res, b, p) => {
  const r = await db.query(`UPDATE suppliers SET name=$1, matricule_fiscal=$2, contact_name=$3, phone=$4, email=$5, address=$6, city=$7, notes=$8 WHERE id=$9 AND company_id=$10`, [...clientFields(b), p.id, req.user.company_id]);
  if (!r.rowCount) throw new HttpError(404, 'Fournisseur introuvable');
  return { ok: true };
});
route('DELETE', '/api/suppliers/:id', async (req, res, b, p) => {
  const n = await db.query('SELECT count(*)::int n FROM purchases WHERE supplier_id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  if (n.rows[0].n) throw bad('Ce fournisseur a des achats : supprimez-les d\'abord.');
  await db.query('DELETE FROM suppliers WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

async function purchaseData(req, b) {
  const s = await db.query('SELECT id FROM suppliers WHERE id = $1 AND company_id = $2', [b.supplier_id, req.user.company_id]);
  if (!s.rows[0]) throw bad('Choisissez un fournisseur');
  if (!isDate(b.issue_date)) throw bad('Date invalide');
  if (b.due_date && !isDate(b.due_date)) throw bad('Échéance invalide');
  return computeInvoice({ ...b, timbre: b.type === 'facture' && b.timbre });
}
route('GET', '/api/purchases', async (req) => {
  const { rows } = await db.query(`${PURCHASE_SELECT} WHERE pu.company_id = $1 ORDER BY pu.issue_date DESC, pu.id DESC`, [req.user.company_id]);
  return rows;
});
route('GET', '/api/purchases/:id', async (req, res, b, p) => {
  const r = (await db.query(`${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.id = $2`, [req.user.company_id, p.id])).rows[0];
  if (!r) throw new HttpError(404, 'Achat introuvable');
  const supplier = (await db.query('SELECT * FROM suppliers WHERE id = $1', [r.supplier_id])).rows[0];
  const pays = (await db.query('SELECT * FROM purchase_payments WHERE purchase_id = $1 ORDER BY paid_on, id', [p.id])).rows;
  return { ...r, supplier, payments: pays };
});
async function insertPurchase(t, req, b, v, opts = {}) {
  const cid = req.user.company_id, type = b.type;
  const year = Number(b.issue_date.slice(0, 4)), key = `achat-${type}-${year}`;
  const seq = await t.query(`UPDATE companies SET doc_seq = jsonb_set(doc_seq, ARRAY[$2::text], to_jsonb(COALESCE((doc_seq->>$2)::int, 0) + 1)) WHERE id = $1 RETURNING (doc_seq->>$2)::int n`, [cid, key]);
  const number = `${PURCHASE_TYPES[type].prefix}${year}-${String(seq.rows[0].n).padStart(4, '0')}`;
  const { rows } = await t.query(`INSERT INTO purchases (company_id, supplier_id, type, number, supplier_ref, issue_date, due_date, items, total_ht, total_tva, timbre, total_ttc, notes, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'emis') RETURNING id, number`,
    [cid, b.supplier_id, type, number, str(b.supplier_ref, 60), b.issue_date, type === 'facture' ? (b.due_date || b.issue_date) : (b.due_date || null), v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000)]);
  if ((type === 'reception' || type === 'facture') && !opts.skipStock) await syncStock(t, cid, 'achat', rows[0].id, v.items, 1, b.issue_date, number, req.user.id);
  return rows[0];
}
route('POST', '/api/purchases', async (req, res, b) => {
  if (!PURCHASE_TYPES[b.type]) throw bad('Type d\'achat inconnu');
  const v = await purchaseData(req, b);
  return db.tx(t => insertPurchase(t, req, b, v));
});
route('PUT', '/api/purchases/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const cur = (await db.query('SELECT * FROM purchases WHERE id = $1 AND company_id = $2', [p.id, cid])).rows[0];
  if (!cur) throw new HttpError(404, 'Achat introuvable');
  if (cur.status === 'converti') throw bad('Ce document a déjà été transformé : il ne peut plus être modifié');
  const v = await purchaseData(req, { ...b, type: cur.type });
  const paid = (await db.query('SELECT COALESCE(SUM(amount),0)::numeric s FROM purchase_payments WHERE purchase_id = $1', [p.id])).rows[0].s;
  if (paid > v.ttc + 0.0005) throw bad('Le total ne peut pas être inférieur aux paiements déjà faits');
  await db.tx(async t => {
    await t.query(`UPDATE purchases SET supplier_id=$1, supplier_ref=$2, issue_date=$3, due_date=$4, items=$5, total_ht=$6, total_tva=$7, timbre=$8, total_ttc=$9, notes=$10 WHERE id=$11`,
      [b.supplier_id, str(b.supplier_ref, 60), b.issue_date, cur.type === 'facture' ? (b.due_date || b.issue_date) : (b.due_date || null), v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000), p.id]);
    const fromReception = (await t.query(`SELECT 1 FROM purchases WHERE company_id = $1 AND linked_id = $2 AND type = 'reception'`, [cid, p.id])).rows.length;
    if ((cur.type === 'reception' || cur.type === 'facture') && !fromReception) await syncStock(t, cid, 'achat', Number(p.id), v.items, 1, b.issue_date, cur.number, req.user.id);
  });
  return { ok: true };
});
route('POST', '/api/purchases/:id/convert', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const d = (await db.query('SELECT * FROM purchases WHERE id = $1 AND company_id = $2', [p.id, cid])).rows[0];
  if (!d) throw new HttpError(404, 'Achat introuvable');
  if (d.type === 'facture') throw bad('C\'est déjà une facture d\'achat');
  if (d.status === 'converti') throw bad('Ce document a déjà été transformé');
  const target = b.to === 'reception' && d.type === 'commande' ? 'reception' : 'facture';
  const data = { type: target, supplier_id: d.supplier_id, issue_date: today(), due_date: target === 'facture' ? addDays(today(), 30) : null, items: d.items, timbre: target === 'facture', supplier_ref: b.supplier_ref,
    notes: [`Selon ${PURCHASE_TYPES[d.type].label.toLowerCase()} ${d.number}`, d.notes].filter(Boolean).join('\n') };
  const v = computeInvoice(data);
  return db.tx(async t => {
    const r = await insertPurchase(t, req, data, v, { skipStock: d.type === 'reception' });
    await t.query(`UPDATE purchases SET status = 'converti', linked_id = $1 WHERE id = $2`, [r.id, d.id]);
    return r;
  });
});
route('DELETE', '/api/purchases/:id', async (req, res, b, p) => {
  const cid = req.user.company_id;
  await db.tx(async t => {
    await syncStock(t, cid, 'achat', Number(p.id), null);
    await t.query(`UPDATE purchases SET status = 'emis', linked_id = NULL WHERE company_id = $1 AND linked_id = $2`, [cid, p.id]);
    await t.query('DELETE FROM purchases WHERE id = $1 AND company_id = $2', [p.id, cid]);
  });
  return { ok: true };
});
route('POST', '/api/purchases/:id/payments', async (req, res, b, p) => {
  const cid = req.user.company_id;
  const pu = (await db.query(`${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.id = $2`, [cid, p.id])).rows[0];
  if (!pu || pu.type !== 'facture') throw bad('Facture d\'achat introuvable');
  const amount = r3(b.amount);
  if (!(amount > 0)) throw bad('Montant invalide');
  if (amount > r3(pu.balance) + 0.0005) throw bad(`Le montant dépasse le reste à payer (${r3(pu.balance).toFixed(3)} DT)`);
  if (!isDate(b.paid_on)) throw bad('Date invalide');
  if (!METHODS.includes(b.method)) throw bad('Mode de paiement invalide');
  return (await db.query(`INSERT INTO purchase_payments (company_id, purchase_id, amount, paid_on, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [cid, p.id, amount, b.paid_on, b.method, str(b.reference, 120), req.user.id])).rows[0];
});
route('DELETE', '/api/purchase-payments/:id', async (req, res, b, p) => {
  await db.query('DELETE FROM purchase_payments WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- relances ----------
const DEFAULT_STEPS = [-3, 7, 15, 30];
function reminderSettings(c) {
  const r = c.reminder_settings || {};
  const steps = Array.isArray(r.steps) && r.steps.length ? r.steps : DEFAULT_STEPS;
  return { auto_email: r.auto_email !== false, steps: [...new Set(steps.map(Number).filter(n => Number.isInteger(n) && n >= -30 && n <= 365))].sort((a, b) => a - b) };
}
function reminderLevel(step) {
  if (step < 0) return { key: 'rappel', label: 'Rappel avant échéance' };
  if (step <= 10) return { key: 'amicale', label: 'Relance amicale' };
  if (step < 30) return { key: 'ferme', label: 'Relance ferme' };
  return { key: 'dernier', label: 'Dernier rappel avant mise en demeure' };
}
const fmtDT = n => (Math.round(Number(n) * 1000) / 1000).toFixed(3).replace('.', ',') + ' DT';
const fmtDate = d => { const [y, m, j] = String(d).slice(0, 10).split('-'); return `${j}/${m}/${y}`; };
function reminderMessage(inv, step, co) {
  const lvl = reminderLevel(step).key;
  const base = `la facture ${inv.number} du ${fmtDate(inv.issue_date)}, d'un montant restant de ${fmtDT(inv.balance)}`;
  const sign = `\n\nCordialement,\n${co.name}${co.phone ? '\n' + co.phone : ''}`;
  const subject = { rappel: `Rappel : facture ${inv.number} à échéance le ${fmtDate(inv.due_date)}`, amicale: `Facture ${inv.number} en attente de règlement`, ferme: `Relance : facture ${inv.number} impayée`, dernier: `Dernier rappel avant mise en demeure : facture ${inv.number}` }[lvl];
  const body = {
    rappel: `Bonjour,\n\nPetit rappel : ${base} arrive à échéance le ${fmtDate(inv.due_date)}. Merci d'avance pour votre règlement.`,
    amicale: `Bonjour,\n\nSauf erreur de notre part, ${base} était à régler le ${fmtDate(inv.due_date)}. Pourriez-vous nous indiquer la date de règlement prévue ? Si le paiement a déjà été effectué, merci de ne pas tenir compte de ce message.`,
    ferme: `Bonjour,\n\nMalgré notre précédent rappel, ${base} reste impayée depuis le ${fmtDate(inv.due_date)}. Nous vous remercions de procéder au règlement dans les plus brefs délais.`,
    dernier: `Bonjour,\n\n${base.charAt(0).toUpperCase() + base.slice(1)} reste impayée depuis le ${fmtDate(inv.due_date)}, malgré nos relances. Sans règlement sous 8 jours, nous serons contraints de vous adresser une mise en demeure.`,
  }[lvl] + sign;
  return { subject, body, level: lvl, level_label: reminderLevel(step).label };
}
// Relances dues : pour chaque facture non payée, le dernier palier atteint et pas encore fait.
async function dueReminders(cid) {
  const co = (await db.query('SELECT * FROM companies WHERE id = $1', [cid])).rows[0];
  const set = reminderSettings(co);
  const invs = (await db.query(`SELECT x.*, cl.email AS client_email, cl.phone AS client_phone FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x JOIN clients cl ON cl.id = x.client_id WHERE x.status <> 'payee'`, [cid])).rows;
  const done = (await db.query(`SELECT invoice_id, step FROM reminders WHERE company_id = $1 AND status = 'envoye'`, [cid])).rows;
  const out = [];
  for (const inv of invs) {
    const reached = set.steps.filter(st => (-inv.days_overdue) <= -st); // jours depuis l'échéance >= palier
    if (!reached.length) continue;
    const step = reached[reached.length - 1];
    if (done.some(d => d.invoice_id === inv.id && d.step >= step)) continue;
    out.push({ ...inv, step, ...reminderMessage(inv, step, co) });
  }
  return { co, set, list: out.sort((a, b) => b.days_overdue - a.days_overdue) };
}
async function sendBrevo({ to, toName, subject, text, fromName, replyTo }) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { email: process.env.BREVO_SENDER_EMAIL, name: fromName }, to: [{ email: to, name: toName }], subject, textContent: text, ...(replyTo ? { replyTo: { email: replyTo } } : {}) }),
  });
  if (!r.ok) throw new Error(`Brevo ${r.status} : ${(await r.text()).slice(0, 200)}`);
}
const lastRun = new Map();
function runRemindersSoon(cid) {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return;
  const t = lastRun.get(cid) || 0;
  if (Date.now() - t < 60 * 60e3) return;
  lastRun.set(cid, Date.now());
  autoRemind(cid).catch(e => console.error('Relances', cid, e.message));
}
async function autoRemind(cid) {
  const { co, set, list } = await dueReminders(cid);
  if (!set.auto_email || co.is_platform || !['active', 'trial'].includes(subscription(co).state)) return 0;
  let n = 0;
  const failed = (await db.query(`SELECT invoice_id, step FROM reminders WHERE company_id = $1 AND status = 'echec' AND sent_at > now() - interval '24 hours'`, [cid])).rows;
  for (const r of list) {
    if (!r.client_email || failed.some(f => f.invoice_id === r.id && f.step === r.step)) continue;
    try {
      await sendBrevo({ to: r.client_email, toName: r.client_name, subject: r.subject, text: r.body, fromName: `${co.name} via Dafter`, replyTo: co.email });
      await db.query(`INSERT INTO reminders (company_id, invoice_id, step, level, channel, status, message, auto) VALUES ($1,$2,$3,$4,'email','envoye',$5,true)`, [cid, r.id, r.step, r.level, r.subject]);
      n++;
    } catch (e) {
      await db.query(`INSERT INTO reminders (company_id, invoice_id, step, level, channel, status, message, error, auto) VALUES ($1,$2,$3,$4,'email','echec',$5,$6,true)`, [cid, r.id, r.step, r.level, r.subject, e.message]);
    }
  }
  return n;
}
async function autoRemindAll() {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) return;
  const cs = (await db.query('SELECT id FROM companies WHERE NOT is_platform')).rows;
  for (const c of cs) { lastRun.set(c.id, Date.now()); await autoRemind(c.id).catch(e => console.error('Relances', c.id, e.message)); }
}
route('GET', '/api/reminders/due', async (req) => {
  const { set, list } = await dueReminders(req.user.company_id);
  return { settings: set, email_ready: !!process.env.BREVO_API_KEY, list: list.map(r => ({ invoice_id: r.id, number: r.number, client_id: r.client_id, client_name: r.client_name, client_email: r.client_email, client_phone: r.client_phone, balance: r.balance, due_date: r.due_date, days_overdue: r.days_overdue, step: r.step, level: r.level, level_label: r.level_label, subject: r.subject, body: r.body })) };
});
route('POST', '/api/reminders', async (req, res, b) => {
  const cid = req.user.company_id;
  const inv = (await db.query('SELECT id FROM invoices WHERE id = $1 AND company_id = $2', [b.invoice_id, cid])).rows[0];
  if (!inv) throw bad('Facture introuvable');
  if (!['email', 'whatsapp', 'sms', 'telephone', 'courrier'].includes(b.channel)) throw bad('Canal invalide');
  const step = Number.isInteger(Number(b.step)) ? Number(b.step) : 0;
  await db.query(`INSERT INTO reminders (company_id, invoice_id, step, level, channel, status, message, note, sent_by) VALUES ($1,$2,$3,$4,$5,'envoye',$6,$7,$8)`,
    [cid, inv.id, step, reminderLevel(step).key, b.channel, str(b.message, 300), str(b.note, 1000), req.user.id]);
  return { ok: true };
});
route('DELETE', '/api/reminders/:id', async (req, res, b, p) => {
  await db.query('DELETE FROM reminders WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});
route('PUT', '/api/company/reminders', { owner: true }, async (req, res, b) => {
  const steps = String(b.steps || '').split(/[,; ]+/).filter(Boolean).map(Number);
  if (!steps.length || steps.some(n => !Number.isInteger(n) || n < -30 || n > 365)) throw bad('Paliers invalides : indiquez des nombres de jours, par exemple -3, 7, 15, 30');
  await db.query(`UPDATE companies SET reminder_settings = $1 WHERE id = $2`, [{ auto_email: !!b.auto_email, steps: [...new Set(steps)].sort((x, y) => x - y) }, req.user.company_id]);
  return { ok: true };
});
route('POST', '/api/reminders/run', async (req) => {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) throw bad('L\'envoi d\'e-mails n\'est pas encore activé sur Dafter');
  const n = await autoRemind(req.user.company_id);
  lastRun.set(req.user.company_id, Date.now());
  return { sent: n };
});

// ---------- rapports & déclaration mensuelle ----------
route('GET', '/api/reports/monthly', async (req) => {
  const cid = req.user.company_id;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const from = month + '-01', to = addMonths(from, 1);
  const byRate = (table, extra) => db.query(`SELECT (it->>'tva')::int AS rate, SUM((it->>'total_ht')::numeric) AS ht, SUM(round((it->>'total_ht')::numeric * (it->>'tva')::numeric / 100, 3)) AS tva
    FROM ${table} x, jsonb_array_elements(x.items) it WHERE x.company_id = $1 AND x.issue_date >= $2 AND x.issue_date < $3 ${extra} GROUP BY 1 ORDER BY 1`, [cid, from, to]);
  const [ventes, avoirs, achats] = await Promise.all([byRate('invoices', ''), byRate('documents', "AND x.type = 'avoir'"), byRate('purchases', "AND x.type = 'facture'")]);
  const sums = (await db.query(`SELECT
      (SELECT COALESCE(SUM(timbre),0) FROM invoices WHERE company_id=$1 AND issue_date >= $2 AND issue_date < $3)::numeric timbre_ventes,
      (SELECT count(*) FROM invoices WHERE company_id=$1 AND issue_date >= $2 AND issue_date < $3)::int nb_factures,
      (SELECT COALESCE(SUM(total_ttc),0) FROM invoices WHERE company_id=$1 AND issue_date >= $2 AND issue_date < $3)::numeric ttc_ventes,
      (SELECT COALESCE(SUM(timbre),0) FROM purchases WHERE company_id=$1 AND type='facture' AND issue_date >= $2 AND issue_date < $3)::numeric timbre_achats,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE company_id=$1 AND method='retenue à la source' AND paid_on >= $2 AND paid_on < $3)::numeric rs_subies,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE company_id=$1 AND method NOT IN ('retenue à la source','avoir') AND paid_on >= $2 AND paid_on < $3)::numeric encaisse,
      (SELECT COALESCE(SUM(amount),0) FROM purchase_payments WHERE company_id=$1 AND paid_on >= $2 AND paid_on < $3)::numeric decaisse`, [cid, from, to])).rows[0];
  const methods = (await db.query(`SELECT method, SUM(amount)::numeric amount FROM payments WHERE company_id=$1 AND paid_on >= $2 AND paid_on < $3 GROUP BY 1 ORDER BY 2 DESC`, [cid, from, to])).rows;
  const journalVentes = (await db.query(`SELECT i.number, i.issue_date, i.due_date, cl.name AS client, cl.matricule_fiscal AS mf, i.total_ht, i.total_tva, i.timbre, i.total_ttc, i.items FROM invoices i JOIN clients cl ON cl.id = i.client_id
    WHERE i.company_id=$1 AND i.issue_date >= $2 AND i.issue_date < $3 ORDER BY i.issue_date, i.number`, [cid, from, to])).rows;
  const journalAvoirs = (await db.query(`SELECT d.number, d.issue_date, cl.name AS client, cl.matricule_fiscal AS mf, d.total_ht, d.total_tva, d.total_ttc, d.items FROM documents d JOIN clients cl ON cl.id = d.client_id
    WHERE d.company_id=$1 AND d.type='avoir' AND d.issue_date >= $2 AND d.issue_date < $3 ORDER BY d.issue_date, d.number`, [cid, from, to])).rows;
  const journalAchats = (await db.query(`SELECT p.number, p.supplier_ref, p.issue_date, p.due_date, s.name AS fournisseur, s.matricule_fiscal AS mf, p.total_ht, p.total_tva, p.timbre, p.total_ttc, p.items FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
    WHERE p.company_id=$1 AND p.type='facture' AND p.issue_date >= $2 AND p.issue_date < $3 ORDER BY p.issue_date, p.number`, [cid, from, to])).rows;
  const merge = (a, b, sign) => { const m = {}; for (const r of a) m[r.rate] = { rate: r.rate, ht: r3(r.ht), tva: r3(r.tva) }; for (const r of b) { const x = m[r.rate] || (m[r.rate] = { rate: r.rate, ht: 0, tva: 0 }); x.ht = r3(x.ht + sign * r.ht); x.tva = r3(x.tva + sign * r.tva); } return Object.values(m).sort((x, y) => x.rate - y.rate); };
  const collectee = merge(ventes.rows, avoirs.rows, -1);
  const deductible = achats.rows.map(r => ({ rate: r.rate, ht: r3(r.ht), tva: r3(r.tva) }));
  const tc = r3(collectee.reduce((s, r) => s + r.tva, 0)), td = r3(deductible.reduce((s, r) => s + r.tva, 0));
  return { month, collectee, deductible, tva_collectee: tc, tva_deductible: td, tva_a_payer: r3(tc - td),
    ca_ht: r3(collectee.reduce((s, r) => s + r.ht, 0)), achats_ht: r3(deductible.reduce((s, r) => s + r.ht, 0)), ...sums, methods,
    journal_ventes: journalVentes, journal_avoirs: journalAvoirs, journal_achats: journalAchats };
});

// ---------- paiements ----------
route('GET', '/api/payments', async (req) => {
  const { rows } = await db.query(`SELECT p.*, i.number, cl.name AS client_name, cl.id AS client_id, u.name AS created_by_name
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients cl ON cl.id = i.client_id LEFT JOIN users u ON u.id = p.created_by
    WHERE p.company_id = $1 ORDER BY p.paid_on DESC, p.id DESC`, [req.user.company_id]);
  return rows;
});
route('POST', '/api/payments', async (req, res, b) => {
  const cid = req.user.company_id;
  const inv = await db.query(`${INVOICE_SELECT} WHERE i.company_id = $1 AND i.id = $2`, [cid, b.invoice_id]);
  if (!inv.rows[0]) throw bad('Facture introuvable');
  const amount = r3(b.amount);
  if (!(amount > 0)) throw bad('Montant invalide');
  if (amount > r3(inv.rows[0].balance) + 0.0005) throw bad(`Le montant dépasse le reste à payer (${r3(inv.rows[0].balance).toFixed(3)} DT)`);
  if (!isDate(b.paid_on)) throw bad('Date invalide');
  if (!METHODS.includes(b.method)) throw bad('Mode de paiement invalide');
  const { rows } = await db.query(`INSERT INTO payments (company_id, invoice_id, amount, paid_on, method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [cid, b.invoice_id, amount, b.paid_on, b.method, str(b.reference, 120), req.user.id]);
  return rows[0];
});
route('DELETE', '/api/payments/:id', async (req, res, b, p) => {
  await db.query('DELETE FROM payments WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- alertes & tableau de bord ----------
route('GET', '/api/alerts', async (req) => {
  const { rows } = await db.query(`SELECT * FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x
    WHERE status <> 'payee' AND due_date <= CURRENT_DATE + 7 ORDER BY due_date`, [req.user.company_id]);
  const sup = (await db.query(`SELECT * FROM (${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.type = 'facture') x WHERE pay_status <> 'payee' AND due_date <= CURRENT_DATE + 7 ORDER BY due_date`, [req.user.company_id])).rows;
  const low = (await db.query(`SELECT * FROM (SELECT p.id, p.name, p.unit, p.stock_alert, COALESCE(SUM(m.qty),0)::numeric stock FROM products p LEFT JOIN stock_moves m ON m.product_id = p.id WHERE p.company_id = $1 AND p.track_stock GROUP BY p.id) z WHERE stock <= COALESCE(stock_alert, 0) ORDER BY stock`, [req.user.company_id])).rows;
  return {
    overdue: rows.filter(r => r.status === 'retard'),
    upcoming: rows.filter(r => r.status !== 'retard'),
    supplier_due: sup, low_stock: low,
  };
});

route('GET', '/api/dashboard', async (req) => {
  const cid = req.user.company_id;
  const k = await db.query(`SELECT
      COALESCE(SUM(total_ttc) FILTER (WHERE date_trunc('month', issue_date) = date_trunc('month', CURRENT_DATE)),0)::numeric invoiced_month,
      COALESCE(SUM(total_ttc) FILTER (WHERE date_trunc('year', issue_date) = date_trunc('year', CURRENT_DATE)),0)::numeric invoiced_year,
      COALESCE(SUM(balance),0)::numeric outstanding,
      COALESCE(SUM(balance) FILTER (WHERE status='retard'),0)::numeric overdue,
      count(*) FILTER (WHERE status='retard')::int overdue_count,
      count(*) FILTER (WHERE status<>'payee' AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int due_soon_count,
      COALESCE(SUM(balance) FILTER (WHERE status<>'payee' AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7),0)::numeric due_soon
    FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x`, [cid]);
  const pm = await db.query(`SELECT
      COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', paid_on) = date_trunc('month', CURRENT_DATE)),0)::numeric collected_month,
      COALESCE(SUM(amount) FILTER (WHERE date_trunc('year', paid_on) = date_trunc('year', CURRENT_DATE)),0)::numeric collected_year
    FROM payments WHERE company_id = $1`, [cid]);
  const months = await db.query(`
    SELECT to_char(m, 'YYYY-MM') AS month,
      COALESCE((SELECT SUM(total_ttc) FROM invoices WHERE company_id=$1 AND date_trunc('month', issue_date)=m),0)::numeric invoiced,
      COALESCE((SELECT SUM(amount) FROM payments WHERE company_id=$1 AND date_trunc('month', paid_on)=m),0)::numeric collected
    FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '11 months', date_trunc('month', CURRENT_DATE), interval '1 month') m ORDER BY m`, [cid]);
  const aging = await db.query(`SELECT
      COALESCE(SUM(balance) FILTER (WHERE status<>'payee' AND days_overdue <= 0),0)::numeric not_due,
      COALESCE(SUM(balance) FILTER (WHERE status='retard' AND days_overdue BETWEEN 1 AND 30),0)::numeric d30,
      COALESCE(SUM(balance) FILTER (WHERE status='retard' AND days_overdue BETWEEN 31 AND 60),0)::numeric d60,
      COALESCE(SUM(balance) FILTER (WHERE status='retard' AND days_overdue BETWEEN 61 AND 90),0)::numeric d90,
      COALESCE(SUM(balance) FILTER (WHERE status='retard' AND days_overdue > 90),0)::numeric d90plus
    FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x`, [cid]);
  const top = await db.query(`SELECT client_id, client_name, SUM(balance)::numeric balance, SUM(balance) FILTER (WHERE status='retard')::numeric overdue
    FROM (${INVOICE_SELECT} WHERE i.company_id = $1) x WHERE status <> 'payee' GROUP BY client_id, client_name ORDER BY SUM(balance) DESC LIMIT 5`, [cid]);
  const counts = await db.query(`SELECT (SELECT count(*) FROM clients WHERE company_id=$1)::int clients, (SELECT count(*) FROM invoices WHERE company_id=$1)::int invoices`, [cid]);
  const sp = (await db.query(`SELECT COALESCE(SUM(balance),0)::numeric supplier_due, COALESCE(SUM(balance) FILTER (WHERE pay_status='retard'),0)::numeric supplier_overdue FROM (${PURCHASE_SELECT} WHERE pu.company_id = $1 AND pu.type = 'facture') x`, [cid])).rows[0];
  const ls = (await db.query(`SELECT count(*)::int low_stock FROM (SELECT p.id, p.stock_alert, COALESCE(SUM(m.qty),0) stock FROM products p LEFT JOIN stock_moves m ON m.product_id = p.id WHERE p.company_id = $1 AND p.track_stock GROUP BY p.id) z WHERE stock <= COALESCE(stock_alert, 0)`, [cid])).rows[0];
  return { ...k.rows[0], ...pm.rows[0], ...counts.rows[0], ...sp, ...ls, months: months.rows, aging: aging.rows[0], top_debtors: top.rows };
});

// ---------- super-admin (gestion des abonnements) ----------
route('GET', '/api/admin/companies', { superadmin: true, readOnlyOk: true }, async () => {
  const { rows } = await db.query(`SELECT c.id, c.name, c.email, c.phone, c.plan, c.status, c.trial_ends, c.paid_until, c.created_at,
      (SELECT count(*) FROM users u WHERE u.company_id=c.id)::int users, (SELECT count(*) FROM clients cl WHERE cl.company_id=c.id)::int clients,
      (SELECT count(*) FROM invoices i WHERE i.company_id=c.id)::int invoices, (SELECT max(last_login) FROM users u WHERE u.company_id=c.id) last_login
    FROM companies c WHERE NOT c.is_platform ORDER BY c.created_at DESC`);
  return rows.map(c => ({ ...c, sub: subscription(c) }));
});
async function platformCompany(t) {
  const r = await t.query('SELECT id FROM companies WHERE is_platform LIMIT 1');
  if (r.rows[0]) return r.rows[0].id;
  const c = await t.query(`INSERT INTO companies (name, is_platform, trial_ends, status) VALUES ('Administration Dafter', true, '2099-12-31', 'active') RETURNING id`);
  return c.rows[0].id;
}
function accountFields(b) {
  const name = str(b.name, 120), email = str(b.email, 160)?.toLowerCase();
  if (!name) throw bad('Nom obligatoire');
  if (!isEmail(email)) throw bad('E-mail invalide');
  if (!b.password || String(b.password).length < 8) throw bad('Le mot de passe doit contenir au moins 8 caractères');
  return { name, email, hash: hashPassword(String(b.password)) };
}
route('POST', '/api/admin/companies', { superadmin: true, readOnlyOk: true }, async (req, res, b) => {
  const companyName = str(b.companyName, 120); if (!companyName) throw bad('Nom de l\'entreprise obligatoire');
  const a = accountFields(b);
  const ex = await db.query('SELECT 1 FROM users WHERE email = $1', [a.email]);
  if (ex.rows.length) throw bad('Un compte existe déjà avec cet e-mail');
  const months = Math.max(0, Math.min(24, parseInt(b.months, 10) || 0));
  return db.tx(async t => {
    const c = await t.query(`INSERT INTO companies (name, phone, email, matricule_fiscal, trial_ends, plan, paid_until, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING id`,
      [companyName, str(b.phone, 40), a.email, normMF(b.matricule_fiscal), addDays(today(), TRIAL_DAYS), PLANS[b.plan] ? b.plan : 'mensuel', months ? addMonths(today(), months) : null]);
    await t.query(`INSERT INTO users (company_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'owner')`, [c.rows[0].id, a.name, a.email, a.hash]);
    return { id: c.rows[0].id };
  });
});
route('GET', '/api/admin/companies/:id/users', { superadmin: true, readOnlyOk: true }, async (req, res, b, p) => {
  const { rows } = await db.query('SELECT id, name, email, role, last_login FROM users WHERE company_id = $1 ORDER BY id', [p.id]);
  return rows;
});
route('POST', '/api/admin/users/:id/password', { superadmin: true, readOnlyOk: true }, async (req, res, b, p) => {
  if (!b.password || String(b.password).length < 8) throw bad('Le mot de passe doit contenir au moins 8 caractères');
  const r = await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(b.password)), p.id]);
  if (!r.rowCount) throw new HttpError(404, 'Utilisateur introuvable');
  return { ok: true };
});
route('POST', '/api/admin/test-email', { superadmin: true, readOnlyOk: true }, async (req) => {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) throw bad('Clé Brevo ou adresse d\'envoi manquante sur le serveur');
  try {
    await sendBrevo({ to: req.user.email, toName: req.user.name, subject: 'Test Dafter : l\'envoi des relances fonctionne', text: `Bonjour ${req.user.name},\n\nCet e-mail confirme que Dafter peut envoyer les relances automatiques de vos abonnés.\n\nDafter`, fromName: 'Dafter' });
  } catch (e) { throw bad('Envoi refusé : ' + e.message); }
  return { ok: true, to: req.user.email };
});
route('GET', '/api/admin/admins', { superadmin: true, readOnlyOk: true }, async () => {
  const { rows } = await db.query(`SELECT u.id, u.name, u.email, u.last_login, c.is_platform, c.name AS company_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.is_superadmin ORDER BY u.id`);
  return rows.map(r => ({ ...r, protected: !!SUPERADMIN_EMAIL && r.email === SUPERADMIN_EMAIL }));
});
route('POST', '/api/admin/admins', { superadmin: true, readOnlyOk: true }, async (req, res, b) => {
  const email = str(b.email, 160)?.toLowerCase();
  const ex = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (ex.rows[0]) {
    if (b.password) throw bad('Un compte existe déjà avec cet e-mail : laissez le mot de passe vide pour lui donner les droits d\'administrateur');
    await db.query('UPDATE users SET is_superadmin = true WHERE id = $1', [ex.rows[0].id]);
    return { ok: true, promoted: true };
  }
  const a = accountFields(b);
  await db.tx(async t => {
    const pid = await platformCompany(t);
    await t.query(`INSERT INTO users (company_id, name, email, password_hash, role, is_superadmin) VALUES ($1,$2,$3,$4,'owner',true)`, [pid, a.name, a.email, a.hash]);
  });
  return { ok: true };
});
route('DELETE', '/api/admin/admins/:id', { superadmin: true, readOnlyOk: true }, async (req, res, b, p) => {
  if (Number(p.id) === req.user.id) throw bad('Vous ne pouvez pas retirer vos propres droits');
  const { rows } = await db.query('SELECT u.email, c.is_platform FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1', [p.id]);
  if (!rows[0]) throw new HttpError(404, 'Administrateur introuvable');
  if (SUPERADMIN_EMAIL && rows[0].email === SUPERADMIN_EMAIL) throw bad('Ce compte est l\'administrateur principal : il ne peut pas être retiré');
  if (rows[0].is_platform) await db.query('DELETE FROM users WHERE id = $1', [p.id]);
  else await db.query('UPDATE users SET is_superadmin = false WHERE id = $1', [p.id]);
  return { ok: true };
});

route('POST', '/api/admin/companies/:id', { superadmin: true, readOnlyOk: true }, async (req, res, b, p) => {
  const { rows } = await db.query('SELECT * FROM companies WHERE id = $1', [p.id]);
  const c = rows[0]; if (!c) throw new HttpError(404, 'Entreprise introuvable');
  if (b.plan && PLANS[b.plan]) await db.query('UPDATE companies SET plan = $1 WHERE id = $2', [b.plan, p.id]);
  if (b.add_months) {
    const n = Math.max(1, Math.min(24, parseInt(b.add_months, 10)));
    const base = c.paid_until && c.paid_until > today() ? c.paid_until : today();
    await db.query(`UPDATE companies SET paid_until = $1, status = 'active' WHERE id = $2`, [addMonths(base, n), p.id]);
  }
  if (b.extend_trial) await db.query('UPDATE companies SET trial_ends = $1 WHERE id = $2', [addDays(today(), Math.max(1, Math.min(60, parseInt(b.extend_trial, 10)))), p.id]);
  if (b.status === 'suspended' || b.status === 'active') await db.query('UPDATE companies SET status = $1 WHERE id = $2', [b.status, p.id]);
  return { ok: true };
});

route('DELETE', '/api/admin/companies/:id', { superadmin: true, readOnlyOk: true }, async (req, res, b, p) => {
  if (Number(p.id) === req.user.company_id) throw bad('Vous ne pouvez pas supprimer votre propre entreprise');
  const plat = await db.query('SELECT is_platform FROM companies WHERE id = $1', [p.id]);
  if (plat.rows[0]?.is_platform) throw bad('Espace d\'administration protégé');
  const { rows } = await db.query('SELECT name FROM companies WHERE id = $1', [p.id]);
  if (!rows[0]) throw new HttpError(404, 'Entreprise introuvable');
  if (String(b.confirm_name || '').trim() !== rows[0].name.trim()) throw bad('Le nom saisi ne correspond pas');
  await db.tx(async t => {
    for (const tbl of ['reminders', 'payments', 'purchase_payments', 'stock_moves', 'documents', 'purchases', 'invoices', 'warehouses', 'products', 'suppliers']) await t.query(`DELETE FROM ${tbl} WHERE company_id = $1`, [p.id]);
    await t.query('DELETE FROM clients WHERE company_id = $1', [p.id]);
    await t.query('DELETE FROM users WHERE company_id = $1', [p.id]);
    await t.query('DELETE FROM companies WHERE id = $1', [p.id]);
  });
  return { ok: true };
});

// ---------- serveur HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const PUBLIC = path.join(__dirname, 'public');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Interdit', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': ['.html', '.js', '.css', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=86400' });
  fs.createReadStream(file).pipe(res);
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw new HttpError(413, 'Requête trop volumineuse'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad('JSON invalide'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  req.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  req.query = Object.fromEntries(url.searchParams);
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Route inconnue');
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Origine refusée');
    }
    const m = url.pathname.match(r.re); const params = {}; r.keys.forEach((k, i) => params[k] = m[i + 1]);
    const body = req.method === 'GET' ? {} : await readBody(req);
    if (!r.opts.public) {
      req.user = await loadUser(req);
      if (!req.user) throw new HttpError(401, 'Veuillez vous connecter');
      if (r.opts.superadmin && !req.user.is_superadmin) throw new HttpError(403, 'Accès réservé');
      if (r.opts.owner && req.user.role !== 'owner') throw new HttpError(403, 'Réservé au responsable du compte');
      if (req.method !== 'GET' && !r.opts.readOnlyOk && !req.user.is_superadmin && !subscription(req.user).can_write)
        throw new HttpError(402, 'Votre abonnement est expiré. Vos données restent consultables ; renouvelez pour continuer à saisir.');
    }
    const out = await r.handler(req, res, body, params);
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    if (e.code === '23503') return send(res, 400, { error: 'Élément lié introuvable ou encore utilisé' });
    if (e.code === '23505') return send(res, 400, { error: 'Cet élément existe déjà' });
    console.error(e);
    send(res, 500, { error: 'Erreur serveur, réessayez' });
  }
});

(async () => {
  for (let i = 0; ; i++) {
    try { await db.query('SELECT 1'); break; }
    catch (e) { if (i > 10) throw e; console.log('Attente de la base…', e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
  for (const stmt of fs.readFileSync(path.join(__dirname, 'lib/schema.sql'), 'utf8').split(';').map(s => s.trim()).filter(Boolean)) await db.query(stmt);
  await db.query(`ALTER TABLE companies ALTER COLUMN plan SET DEFAULT 'mensuel'`);
  if (SUPERADMIN_EMAIL) await db.tx(async t => {
    const u = (await t.query('SELECT u.id, u.company_id, c.is_platform FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = $1', [SUPERADMIN_EMAIL])).rows[0];
    if (!u || u.is_platform) return;
    const n = (await t.query(`SELECT (SELECT count(*) FROM clients WHERE company_id = $1) + (SELECT count(*) FROM invoices WHERE company_id = $1) + (SELECT count(*) FROM products WHERE company_id = $1) + (SELECT count(*) FROM users WHERE company_id = $1 AND id <> $2) AS n`, [u.company_id, u.id])).rows[0].n;
    if (Number(n) > 0) { console.log('Administrateur principal laissé dans son entreprise : elle contient des données'); return; }
    const pid = await platformCompany(t);
    await t.query('UPDATE users SET company_id = $1, is_superadmin = true WHERE id = $2', [pid, u.id]);
    await t.query('DELETE FROM documents WHERE company_id = $1', [u.company_id]);
    await t.query('DELETE FROM companies WHERE id = $1', [u.company_id]);
    console.log('Administrateur principal déplacé dans l\'espace d\'administration');
  });
  await db.query(`UPDATE companies SET plan = 'mensuel' WHERE plan NOT IN ('mensuel', 'annuel')`);
  server.listen(PORT, () => console.log(`CRM prêt sur le port ${PORT}`));
  setTimeout(() => autoRemindAll().catch(e => console.error(e)), 60e3);
  setInterval(() => autoRemindAll().catch(e => console.error(e)), 6 * 60 * 60e3);
})().catch(e => { console.error(e); process.exit(1); });
