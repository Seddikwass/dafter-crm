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
  mensuel: { label: 'Mensuel', price: 175, period: 'mois', months: 1, maxUsers: 10, maxClients: 100000 },
  annuel: { label: 'Annuel', price: 2000, period: 'an', months: 12, maxUsers: 10, maxClients: 100000 },
};
const METHODS = ['espèces', 'chèque', 'virement', 'traite', 'carte', 'D17'];
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
  let state = 'expired';
  if (c.status === 'suspended') state = 'suspended';
  else if (paidOk) state = 'active';
  else if (trialOk) state = 'trial';
  const end = paidOk ? c.paid_until : c.trial_ends;
  const daysLeft = Math.round((Date.parse(end) - Date.parse(t)) / 864e5);
  return { state, plan: c.plan, plan_label: PLANS[c.plan]?.label || c.plan, price: PLANS[c.plan]?.price, period: PLANS[c.plan]?.period, ends: end, days_left: daysLeft, can_write: state === 'active' || state === 'trial' };
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
    `SELECT u.id, u.name, u.email, u.role, u.is_superadmin, u.company_id, c.name AS company_name, c.plan, c.status, c.trial_ends, c.paid_until
     FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`, [p.uid]);
  return rows[0] || null;
}

// ---------- authentification ----------
route('POST', '/api/auth/register', { public: true }, async (req, res, b) => {
  throttle('reg:' + req.ip);
  const companyName = str(b.companyName, 120), name = str(b.name, 120), email = str(b.email, 160)?.toLowerCase();
  if (!companyName) throw bad('Nom de l\'entreprise obligatoire');
  if (!name) throw bad('Votre nom est obligatoire');
  if (!isEmail(email)) throw bad('E-mail invalide');
  if (!b.password || String(b.password).length < 8) throw bad('Le mot de passe doit contenir au moins 8 caractères');
  const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rows.length) throw bad('Un compte existe déjà avec cet e-mail');
  const user = await db.tx(async t => {
    const c = await t.query(`INSERT INTO companies (name, phone, email, matricule_fiscal, trial_ends) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyName, str(b.phone, 40), email, str(b.matricule_fiscal, 40), addDays(today(), TRIAL_DAYS)]);
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
  const { rows } = await db.query('SELECT * FROM companies WHERE id = $1', [u.company_id]);
  const c = rows[0];
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, is_superadmin: u.is_superadmin },
    company: { id: c.id, name: c.name, matricule_fiscal: c.matricule_fiscal, address: c.address, city: c.city, phone: c.phone, email: c.email, invoice_prefix: c.invoice_prefix, default_due_days: c.default_due_days, invoice_footer: c.invoice_footer },
    subscription: subscription(c), plans: PLANS, methods: METHODS, tva_rates: TVA_RATES, today: today(),
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
    [name, str(b.matricule_fiscal, 40), str(b.address, 300), str(b.city, 80), str(b.phone, 40), str(b.email, 160), prefix, due, str(b.invoice_footer, 500), req.user.company_id]);
  return { ok: true };
});

route('DELETE', '/api/company', { owner: true, readOnlyOk: true }, async (req, res, b) => {
  const cid = req.user.company_id;
  const { rows } = await db.query('SELECT name FROM companies WHERE id = $1', [cid]);
  if (String(b.confirm_name || '').trim() !== rows[0].name.trim()) throw bad('Le nom saisi ne correspond pas');
  await db.tx(async t => {
    for (const tbl of ['payments', 'invoices', 'clients', 'users']) await t.query(`DELETE FROM ${tbl} WHERE company_id = $1`, [cid]);
    await t.query('DELETE FROM companies WHERE id = $1', [cid]);
  });
  setSession(req, res, '', 0);
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
  const max = PLANS[req.user.plan]?.maxUsers || 10;
  if (n.rows[0].n >= max) throw bad(`Votre formule permet ${max} utilisateurs maximum`);
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
  return [name, str(b.matricule_fiscal, 40), str(b.contact_name, 120), str(b.phone, 40), email, str(b.address, 300), str(b.city, 80), str(b.notes, 2000)];
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
  const inv = await db.query('SELECT count(*)::int n FROM invoices WHERE client_id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  if (inv.rows[0].n) throw bad('Ce client a des factures : supprimez-les d\'abord.');
  await db.query('DELETE FROM clients WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
});

// ---------- factures ----------
function computeInvoice(b) {
  if (!Array.isArray(b.items) || !b.items.length) throw bad('Ajoutez au moins une ligne à la facture');
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
    return { designation, qty, unit_price: r3(price), tva: rate, total_ht: lineHt };
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
  return { ...inv.rows[0], items: items.rows[0].items, client: client.rows[0], payments: pays.rows };
});
route('POST', '/api/invoices', async (req, res, b) => {
  const cid = req.user.company_id;
  const cl = await db.query('SELECT id FROM clients WHERE id = $1 AND company_id = $2', [b.client_id, cid]);
  if (!cl.rows[0]) throw bad('Choisissez un client');
  if (!isDate(b.issue_date) || !isDate(b.due_date)) throw bad('Dates invalides');
  if (b.due_date < b.issue_date) throw bad('L\'échéance doit être après la date de facture');
  const v = computeInvoice(b);
  return db.tx(async t => {
    const year = Number(b.issue_date.slice(0, 4));
    const seq = await t.query(`UPDATE companies SET invoice_seq = CASE WHEN invoice_seq_year = $2 THEN invoice_seq + 1 ELSE 1 END, invoice_seq_year = $2 WHERE id = $1 RETURNING invoice_seq, invoice_prefix`, [cid, year]);
    let number = str(b.number, 40);
    if (!number) number = `${seq.rows[0].invoice_prefix}${year}-${String(seq.rows[0].invoice_seq).padStart(4, '0')}`;
    const dup = await t.query('SELECT 1 FROM invoices WHERE company_id = $1 AND number = $2', [cid, number]);
    if (dup.rows.length) throw bad(`Le numéro ${number} existe déjà`);
    const { rows } = await t.query(`INSERT INTO invoices (company_id, client_id, number, issue_date, due_date, items, total_ht, total_tva, timbre, total_ttc, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, number`,
      [cid, b.client_id, number, b.issue_date, b.due_date, v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000)]);
    return rows[0];
  });
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
  const r = await db.query(`UPDATE invoices SET client_id=$1, number=$2, issue_date=$3, due_date=$4, items=$5, total_ht=$6, total_tva=$7, timbre=$8, total_ttc=$9, notes=$10 WHERE id=$11 AND company_id=$12`,
    [b.client_id, number, b.issue_date, b.due_date, v.items, v.ht, v.tva, v.timbre, v.ttc, str(b.notes, 2000), p.id, cid]);
  if (!r.rowCount) throw new HttpError(404, 'Facture introuvable');
  return { ok: true };
});
route('DELETE', '/api/invoices/:id', async (req, res, b, p) => {
  await db.query('DELETE FROM invoices WHERE id = $1 AND company_id = $2', [p.id, req.user.company_id]);
  return { ok: true };
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
  return {
    overdue: rows.filter(r => r.status === 'retard'),
    upcoming: rows.filter(r => r.status !== 'retard'),
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
  return { ...k.rows[0], ...pm.rows[0], ...counts.rows[0], months: months.rows, aging: aging.rows[0], top_debtors: top.rows };
});

// ---------- super-admin (gestion des abonnements) ----------
route('GET', '/api/admin/companies', { superadmin: true, readOnlyOk: true }, async () => {
  const { rows } = await db.query(`SELECT c.id, c.name, c.email, c.phone, c.plan, c.status, c.trial_ends, c.paid_until, c.created_at,
      (SELECT count(*) FROM users u WHERE u.company_id=c.id)::int users, (SELECT count(*) FROM clients cl WHERE cl.company_id=c.id)::int clients,
      (SELECT count(*) FROM invoices i WHERE i.company_id=c.id)::int invoices, (SELECT max(last_login) FROM users u WHERE u.company_id=c.id) last_login
    FROM companies c ORDER BY c.created_at DESC`);
  return rows.map(c => ({ ...c, sub: subscription(c) }));
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
  const { rows } = await db.query('SELECT name FROM companies WHERE id = $1', [p.id]);
  if (!rows[0]) throw new HttpError(404, 'Entreprise introuvable');
  if (String(b.confirm_name || '').trim() !== rows[0].name.trim()) throw bad('Le nom saisi ne correspond pas');
  await db.tx(async t => {
    await t.query('DELETE FROM payments WHERE company_id = $1', [p.id]);
    await t.query('DELETE FROM invoices WHERE company_id = $1', [p.id]);
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
  await db.query(`UPDATE companies SET plan = 'mensuel' WHERE plan NOT IN ('mensuel', 'annuel')`);
  server.listen(PORT, () => console.log(`CRM prêt sur le port ${PORT}`));
})().catch(e => { console.error(e); process.exit(1); });
