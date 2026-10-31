'use strict';
/* Dafter — CRM pour petites entreprises tunisiennes */

const S = { me: null, alertsCount: 0, invTab: 'all' };
const root = document.getElementById('root');

// ---------- utilitaires ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function amt(n, cur = true) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  const neg = v < 0; const a = Math.abs(v);
  const d = Math.floor(a + 1e-9); const m = Math.round((a - d) * 1000);
  const ds = d.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `<span class="amt">${neg ? '−' : ''}${ds}<span class="mil">,${String(m).padStart(3, '0')}</span>${cur ? '<span class="cur">DT</span>' : ''}</span>`;
}
const plain = n => (Math.round((Number(n) || 0) * 1000) / 1000).toFixed(3).replace('.', ',') + ' DT';
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fdate(d) { if (!d) return '—'; const [y, m, j] = String(d).slice(0, 10).split('-'); return `${Number(j)} ${MONTHS[m - 1]} ${y}`; }
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function relDays(n) {
  if (n === 0) return "aujourd'hui";
  if (n > 0) return n === 1 ? 'depuis 1 jour' : `depuis ${n} jours`;
  return n === -1 ? 'demain' : `dans ${-n} jours`;
}
const STATUS = { payee: 'Payée', retard: 'En retard', partielle: 'Partielle', attente: 'En attente' };
function stClass(inv) {
  if (inv.status === 'payee') return 's-payee';
  if (inv.status === 'retard') return 's-retard';
  if (inv.days_overdue >= -7) return 's-soon';
  return '';
}
function tag(inv) { return `<span class="tag ${inv.status}">${STATUS[inv.status]}</span>`; }
function phoneIntl(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.length === 8) return '216' + d;
  return d;
}

async function api(method, url, body) {
  const r = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {}; try { data = await r.json(); } catch (_) {}
  if (r.status === 401 && !url.startsWith('/auth') && url !== '/me') { S.me = null; location.hash = '#/connexion'; throw new Error(data.error || 'Veuillez vous connecter'); }
  if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
  return data;
}
function toast(msg, err) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; t.setAttribute('role', 'status');
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 2600);
}
function formData(form) {
  const o = {};
  for (const el of form.elements) { if (!el.name) continue; o[el.name] = el.type === 'checkbox' ? el.checked : el.value; }
  return o;
}
async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}
function modal(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(bg);
  const first = bg.querySelector('input, select, textarea'); if (first) first.focus();
  if (onMount) onMount(bg.querySelector('.modal'), close);
  return close;
}
function confirmBox(text, label = 'Supprimer') {
  return new Promise(res => {
    modal(`<h2>${esc(text)}</h2><p class="sub">Cette action est définitive.</p><div class="row-actions"><button class="btn danger" data-ok>${esc(label)}</button><button class="btn" data-close>Annuler</button></div>`,
      (m, close) => { m.querySelector('[data-ok]').onclick = () => { close(); res(true); }; m.parentElement.addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === m.parentElement) res(false); }); });
  });
}

// ---------- montant en lettres ----------
const U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
const T = ['', 'dix', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
function below100(n) {
  if (n <= 16) return U[n];
  if (n < 20) return 'dix-' + U[n - 10];
  if (n < 70) { const t = Math.floor(n / 10), u = n % 10; return T[t] + (u === 0 ? '' : u === 1 ? ' et un' : '-' + U[u]); }
  if (n < 80) return n === 71 ? 'soixante et onze' : 'soixante-' + below100(n - 60);
  if (n === 80) return 'quatre-vingts';
  return 'quatre-vingt-' + below100(n - 80);
}
function below1000(n) {
  const c = Math.floor(n / 100), r = n % 100;
  let s = c === 0 ? '' : c === 1 ? 'cent' : U[c] + ' cent' + (r === 0 ? 's' : '');
  if (r) s += (s ? ' ' : '') + below100(r);
  return s || 'zéro';
}
function words(n) {
  if (n === 0) return 'zéro';
  const parts = []; const scales = [[1e9, 'milliard'], [1e6, 'million'], [1e3, 'mille']];
  for (const [v, w] of scales) {
    const q = Math.floor(n / v); if (!q) continue; n %= v;
    if (w === 'mille') parts.push(q === 1 ? 'mille' : below1000(q).replace(/cents$/, 'cent') + ' mille');
    else parts.push(below1000(q) + ' ' + w + (q > 1 ? 's' : ''));
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
function amountWords(x) {
  const v = Math.round(x * 1000); const d = Math.floor(v / 1000), m = v % 1000;
  let s = words(d) + (d > 1 ? ' dinars' : ' dinar');
  if (m) s += ' et ' + words(m) + (m > 1 ? ' millimes' : ' millime');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- icônes ----------
const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20c-.5-2.6-2-4.4-4-5.1"/>',
  doc: '<path d="M6 2.5h8l4 4V21a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 21z"/><path d="M14 2.5V7h4M9 12h6M9 16h6"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  shield: '<path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;

// ---------- coque ----------
function shell(active, content) {
  const me = S.me; const sub = me.subscription;
  const links = [
    ['#/', 'home', 'Accueil'], ['#/clients', 'users', 'Clients'], ['#/factures', 'doc', 'Factures'],
    ['#/paiements', 'cash', 'Paiements'], ['#/alertes', 'bell', 'Échéances'], ['#/parametres', 'gear', 'Compte'],
  ];
  if (me.user.is_superadmin) links.push(['#/admin', 'shield', 'Abonnés']);
  let banner = '';
  if (sub.state === 'trial') banner = `<div class="banner info">Essai gratuit : ${sub.days_left > 0 ? `il reste ${sub.days_left} jour${sub.days_left > 1 ? 's' : ''}` : "dernier jour aujourd'hui"}. <a href="#/parametres">Voir l'abonnement</a></div>`;
  else if (sub.state === 'expired') banner = `<div class="banner err">Abonnement expiré : vos données restent consultables, mais la saisie est bloquée. <a href="#/parametres">Renouveler</a></div>`;
  else if (sub.state === 'suspended') banner = `<div class="banner err">Compte suspendu. Contactez le support pour le réactiver.</div>`;
  else if (sub.days_left <= 5) banner = `<div class="banner warn">Votre abonnement se termine le ${fdate(sub.ends)}. <a href="#/parametres">Renouveler</a></div>`;
  root.innerHTML = `<div class="app">
    <header class="topbar"><span class="brand">Dafter</span><span class="co">${esc(me.company.name)}</span></header>
    <nav class="nav" aria-label="Navigation">${links.map(([h, i, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}${h === '#/admin' ? ' desk' : ''}" ${active === h ? 'aria-current="page"' : ''}>${icon(i)}<span>${l}</span>${h === '#/alertes' && S.alertsCount ? `<span class="dot">${S.alertsCount}</span>` : ''}</a>`).join('')}</nav>
    <main>${banner}${content}</main></div>`;
  window.scrollTo(0, 0);
}
function loading(active) { shell(active, '<p class="sub">Chargement…</p>'); }

// ---------- connexion / inscription ----------
function authPage(mode) {
  const reg = mode === 'register';
  root.innerHTML = `<div class="auth">
    <section class="auth-side">
      <div class="brand">Dafter</div>
      <h1>Qui vous doit quoi, et pour quand.</h1>
      <p>Clients, factures avec TVA et timbre fiscal, échéances et encaissements : tout le carnet de votre entreprise, sur téléphone et sur PC.</p>
      <div class="sample" aria-hidden="true">
        <div><span>Pharmacie El Manar · F2026-0041</span><span class="late">${amt(1250.5)}</span></div>
        <div><span>Atelier Ben Salah · échéance demain</span><span>${amt(384.2)}</span></div>
        <div><span>Café Le Jasmin · payée</span><span>${amt(96.39)}</span></div>
      </div>
      <div class="plans">
        <div><b>Essentiel</b><span class="p">29 DT</span> / mois<br>2 utilisateurs, 200 clients</div>
        <div><b>Pro</b><span class="p">59 DT</span> / mois<br>10 utilisateurs, clients illimités</div>
      </div>
    </section>
    <section class="auth-form">
      <h2>${reg ? 'Créer le compte de votre entreprise' : 'Se connecter'}</h2>
      ${reg ? '<p class="sub" style="margin-top:-10px">14 jours gratuits, sans carte bancaire.</p>' : ''}
      <form id="f" novalidate>
        <div class="err-msg" id="e"></div>
        ${reg ? `<label>Nom de l'entreprise<input name="companyName" required autocomplete="organization"></label>
        <label>Votre nom<input name="name" required autocomplete="name"></label>
        <label>Téléphone<input name="phone" type="tel" autocomplete="tel" placeholder="98 123 456"></label>` : ''}
        <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
        <label>Mot de passe<input name="password" type="password" required minlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}">${reg ? '<span class="sub">8 caractères minimum</span>' : ''}</label>
        <button class="btn primary" type="submit">${reg ? 'Créer mon compte' : 'Se connecter'}</button>
      </form>
      <p class="switch">${reg ? 'Déjà inscrit ? <a href="#/connexion">Se connecter</a>' : 'Pas encore de compte ? <a href="#/inscription">Essayer gratuitement</a>'}</p>
    </section></div>`;
  const f = document.getElementById('f');
  f.onsubmit = async e => {
    e.preventDefault(); const btn = f.querySelector('button');
    btn.disabled = true; document.getElementById('e').textContent = '';
    try {
      await api('POST', reg ? '/auth/register' : '/auth/login', formData(f));
      S.me = await api('GET', '/me'); location.hash = '#/'; router();
    } catch (err) { document.getElementById('e').textContent = err.message; }
    finally { btn.disabled = false; }
  };
}

// ---------- tableau de bord ----------
function barChart(months) {
  const W = 640, H = 200, pl = 8, pb = 22, max = Math.max(1, ...months.flatMap(m => [m.invoiced, m.collected]));
  const step = (W - pl * 2) / months.length, bw = Math.min(14, step / 2 - 3);
  let g = '';
  [0.5, 1].forEach(f => { const y = (H - pb) * (1 - f); g += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#dde3ee" stroke-dasharray="3 4"/>`; });
  months.forEach((m, i) => {
    const x = pl + i * step + step / 2;
    const h1 = (H - pb - 6) * m.invoiced / max, h2 = (H - pb - 6) * m.collected / max;
    g += `<rect x="${x - bw - 1}" y="${H - pb - h1}" width="${bw}" height="${h1}" rx="2" fill="#13294b"><title>Facturé ${plain(m.invoiced)}</title></rect>`;
    g += `<rect x="${x + 1}" y="${H - pb - h2}" width="${bw}" height="${h2}" rx="2" fill="#6fa0d8"><title>Encaissé ${plain(m.collected)}</title></rect>`;
    g += `<text x="${x}" y="${H - 6}" text-anchor="middle">${MONTHS[Number(m.month.slice(5)) - 1]}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Facturé et encaissé sur 12 mois">${g}</svg>
    <div class="legend"><span><i style="background:#13294b"></i>Facturé</span><span><i style="background:#6fa0d8"></i>Encaissé</span><span>max ${plain(max)}</span></div>`;
}

async function pageDashboard() {
  loading('#/');
  const [d, al] = await Promise.all([api('GET', '/dashboard'), api('GET', '/alerts')]);
  S.alertsCount = al.overdue.length;
  const a = d.aging; const agingMax = Math.max(1, a.not_due, a.d30, a.d60, a.d90, a.d90plus);
  const bars = [['Pas encore dû', a.not_due, '#6fa0d8'], ['1 à 30 jours', a.d30, '#d9a23a'], ['31 à 60 jours', a.d60, '#d77a3a'], ['61 à 90 jours', a.d90, '#c4473a'], ['Plus de 90 jours', a.d90plus, '#8f1d16']];
  const firstName = S.me.user.name.split(' ')[0];
  const isEmpty = !d.clients;
  shell('#/', `
    <p class="sub" style="margin:0">Bonjour ${esc(firstName)}</p>
    <div class="hero-due"><div class="k">Reste à encaisser</div><div class="v">${amt(d.outstanding)}</div>
      ${d.overdue > 0 ? `<div class="sub" style="color:var(--pome)">dont ${amt(d.overdue)} en retard sur ${d.overdue_count} facture${d.overdue_count > 1 ? 's' : ''}</div>` : '<div class="sub">Aucune facture en retard</div>'}</div>
    ${isEmpty ? `<div class="panel"><h2 style="margin-top:0">Pour commencer</h2><p>Ajoutez votre premier client, puis créez sa facture : les échéances et le tableau de bord se rempliront tout seuls.</p><div class="row-actions"><a class="btn primary" href="#/clients/nouveau">Ajouter un client</a><a class="btn" href="#/parametres">Compléter les infos de l'entreprise</a></div></div>` : ''}
    <div class="ledger">
      <div><div class="k">Facturé ce mois</div><div class="v">${amt(d.invoiced_month, false)}</div><div class="n">${amt(d.invoiced_year)} cette année</div></div>
      <div><div class="k">Encaissé ce mois</div><div class="v">${amt(d.collected_month, false)}</div><div class="n">${amt(d.collected_year)} cette année</div></div>
      <div><div class="k">À échoir sous 7 jours</div><div class="v">${amt(d.due_soon, false)}</div><div class="n">${d.due_soon_count} facture${d.due_soon_count > 1 ? 's' : ''}</div></div>
      <div><div class="k">En retard</div><div class="v ${d.overdue > 0 ? 'pome' : ''}">${amt(d.overdue, false)}</div><div class="n">${d.overdue_count} facture${d.overdue_count > 1 ? 's' : ''}</div></div>
    </div>
    <div class="dash-cols">
      <div>
        <h2>Échéances à traiter</h2>
        ${invoiceList([...al.overdue, ...al.upcoming].slice(0, 6), 'Rien à relancer pour le moment.')}
        ${al.overdue.length + al.upcoming.length > 6 ? '<p><a href="#/alertes">Voir toutes les échéances</a></p>' : ''}
        <h2>Facturé et encaissé, 12 derniers mois</h2>
        <div class="panel">${barChart(d.months)}</div>
      </div>
      <div>
        <h2>Ancienneté des impayés</h2>
        <div class="panel aging">${bars.map(([l, v, c]) => `<div class="bar"><span>${l}</span><div class="track"><div class="fill" style="width:${(v / agingMax * 100).toFixed(1)}%;background:${c}"></div></div>${amt(v, false)}</div>`).join('')}</div>
        <h2>Plus gros soldes clients</h2>
        <div class="list">${d.top_debtors.length ? d.top_debtors.map(t => `<a class="item ${t.overdue > 0 ? 's-retard' : ''}" href="#/clients/${t.client_id}"><div class="main"><div class="t">${esc(t.client_name)}</div>${t.overdue > 0 ? `<div class="m">${plain(t.overdue)} en retard</div>` : ''}</div><div class="r">${amt(t.balance)}</div></a>`).join('') : '<div class="empty">Aucun solde ouvert.</div>'}</div>
      </div>
    </div>
    <p class="sign">Dafter · créé par Wassim Khalfalli</p>`);
}

function invoiceList(rows, emptyText, emptyAction = '') {
  if (!rows.length) return `<div class="list"><div class="empty">${emptyText}${emptyAction}</div></div>`;
  return `<div class="list">${rows.map(i => `<a class="item ${stClass(i)}" href="#/factures/${i.id}">
    <div class="main"><div class="t">${esc(i.client_name)}</div><div class="m">${esc(i.number)} · échéance ${fdate(i.due_date)}${i.status === 'retard' ? ` · ${relDays(i.days_overdue)}` : i.status !== 'payee' && i.days_overdue >= -7 ? ` · ${relDays(i.days_overdue)}` : ''}</div></div>
    <div class="r">${amt(i.status === 'payee' ? i.total_ttc : i.balance)}<div>${tag(i)}</div></div></a>`).join('')}</div>`;
}

// ---------- clients ----------
async function pageClients() {
  loading('#/clients');
  const rows = await api('GET', '/clients');
  shell('#/clients', `<div class="head"><h1>Clients</h1><a class="btn primary" href="#/clients/nouveau">Ajouter un client</a></div>
    ${rows.length ? '<input class="search" type="search" placeholder="Rechercher un client, un téléphone, une ville" id="q" aria-label="Rechercher">' : ''}
    <div id="lst"></div>`);
  const draw = q => {
    q = (q || '').toLowerCase();
    const f = rows.filter(c => !q || [c.name, c.phone, c.city, c.email, c.contact_name].some(v => (v || '').toLowerCase().includes(q)));
    document.getElementById('lst').innerHTML = !rows.length
      ? '<div class="list"><div class="empty">Aucun client pour l\'instant.<br><a class="btn primary" href="#/clients/nouveau">Ajouter un client</a></div></div>'
      : `<div class="list">${f.map(c => `<a class="item ${c.overdue > 0 ? 's-retard' : ''}" href="#/clients/${c.id}"><div class="main"><div class="t">${esc(c.name)}</div><div class="m">${esc([c.city, c.phone].filter(Boolean).join(' · ') || `${c.invoice_count} facture${c.invoice_count > 1 ? 's' : ''}`)}</div></div>
        <div class="r">${c.balance > 0 ? amt(c.balance) : '<span class="sub">soldé</span>'}${c.overdue > 0 ? '<div><span class="tag retard">retard</span></div>' : ''}</div></a>`).join('') || '<div class="empty">Aucun résultat.</div>'}</div>`;
  };
  draw();
  const q = document.getElementById('q'); if (q) q.oninput = () => draw(q.value);
}

function clientForm(c = {}) {
  return `<form id="cf" novalidate>
    <label>Nom ou raison sociale<input name="name" required value="${esc(c.name)}"></label>
    <div class="grid2">
      <label>Matricule fiscal<input name="matricule_fiscal" value="${esc(c.matricule_fiscal)}" placeholder="1234567/A/M/000"></label>
      <label>Personne à contacter<input name="contact_name" value="${esc(c.contact_name)}"></label>
      <label>Téléphone<input name="phone" type="tel" value="${esc(c.phone)}" placeholder="98 123 456"></label>
      <label>E-mail<input name="email" type="email" value="${esc(c.email)}"></label>
      <label>Adresse<input name="address" value="${esc(c.address)}"></label>
      <label>Ville<input name="city" value="${esc(c.city)}"></label>
    </div>
    <label>Notes<textarea name="notes">${esc(c.notes)}</textarea></label>
    <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le client</button><a class="btn" href="${c.id ? '#/clients/' + c.id : '#/clients'}">Annuler</a></div>
  </form>`;
}
async function pageClientEdit(id) {
  loading('#/clients');
  const c = id ? (await api('GET', '/clients/' + id)).client : {};
  shell('#/clients', `<a class="back" href="${id ? '#/clients/' + id : '#/clients'}">‹ Retour</a><h1>${id ? 'Modifier le client' : 'Nouveau client'}</h1><div class="panel">${clientForm(c)}</div>`);
  const f = document.getElementById('cf');
  f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('button'), async () => {
    const r = id ? await api('PUT', '/clients/' + id, formData(f)) : await api('POST', '/clients', formData(f));
    toast('Client enregistré'); location.hash = '#/clients/' + (id || r.id);
  }); };
}
async function pageClient(id) {
  loading('#/clients');
  const { client: c, invoices, payments } = await api('GET', '/clients/' + id);
  const bal = invoices.reduce((s, i) => s + i.balance, 0), inv = invoices.reduce((s, i) => s + i.total_ttc, 0), paid = invoices.reduce((s, i) => s + i.paid, 0);
  const open = invoices.filter(i => i.status !== 'payee');
  const tel = phoneIntl(c.phone);
  shell('#/clients', `<a class="back" href="#/clients">‹ Clients</a>
    <div class="head"><h1>${esc(c.name)}</h1><a class="btn" href="#/clients/${c.id}/modifier">Modifier</a></div>
    <div class="row-actions" style="margin:-4px 0 16px">
      ${c.phone ? `<a class="btn small" href="tel:${esc(c.phone)}">Appeler</a><a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/${tel}">WhatsApp</a>` : ''}
      ${c.email ? `<a class="btn small" href="mailto:${esc(c.email)}">E-mail</a>` : ''}
      <a class="btn small primary" href="#/factures/nouvelle?client=${c.id}">Nouvelle facture</a>
    </div>
    <div class="ledger">
      <div><div class="k">Solde dû</div><div class="v ${open.some(i => i.status === 'retard') ? 'pome' : ''}">${amt(bal, false)}</div><div class="n">${open.length} facture${open.length > 1 ? 's' : ''} ouverte${open.length > 1 ? 's' : ''}</div></div>
      <div><div class="k">Total facturé</div><div class="v">${amt(inv, false)}</div><div class="n">${invoices.length} facture${invoices.length > 1 ? 's' : ''}</div></div>
      <div><div class="k">Total payé</div><div class="v">${amt(paid, false)}</div><div class="n">${payments.length} paiement${payments.length > 1 ? 's' : ''}</div></div>
      <div><div class="k">Dernier paiement</div><div class="v" style="font-size:18px">${payments[0] ? fdate(payments[0].paid_on) : '—'}</div><div class="n">${payments[0] ? plain(payments[0].amount) : ''}</div></div>
    </div>
    <h2>Factures</h2>${invoiceList(invoices, 'Aucune facture pour ce client.', `<br><a class="btn primary" href="#/factures/nouvelle?client=${c.id}">Créer une facture</a>`)}
    <h2>Historique des paiements</h2>
    <div class="list">${payments.length ? payments.map(p => `<a class="item" href="#/factures/${p.invoice_id}"><div class="main"><div class="t">${fdate(p.paid_on)} · ${esc(p.method)}</div><div class="m">${esc(p.number)}${p.reference ? ' · réf. ' + esc(p.reference) : ''}</div></div><div class="r">${amt(p.amount)}</div></a>`).join('') : '<div class="empty">Aucun paiement reçu.</div>'}</div>
    <h2>Coordonnées</h2>
    <div class="panel"><dl class="kv">
      <dt>Matricule fiscal</dt><dd>${esc(c.matricule_fiscal) || '—'}</dd><dt>Contact</dt><dd>${esc(c.contact_name) || '—'}</dd>
      <dt>Téléphone</dt><dd>${esc(c.phone) || '—'}</dd><dt>E-mail</dt><dd>${esc(c.email) || '—'}</dd>
      <dt>Adresse</dt><dd>${esc([c.address, c.city].filter(Boolean).join(', ')) || '—'}</dd><dt>Notes</dt><dd style="white-space:pre-wrap">${esc(c.notes) || '—'}</dd>
    </dl></div>
    <div class="row-actions" style="margin-top:16px"><button class="btn danger" id="del">Supprimer le client</button></div>`);
  document.getElementById('del').onclick = async e => {
    if (!await confirmBox(`Supprimer ${c.name} ?`)) return;
    guard(e.target, async () => { await api('DELETE', '/clients/' + c.id); toast('Client supprimé'); location.hash = '#/clients'; });
  };
}

// ---------- factures ----------
async function pageInvoices() {
  loading('#/factures');
  const rows = await api('GET', '/invoices');
  const tabs = [['all', 'Toutes'], ['open', 'À encaisser'], ['retard', 'En retard'], ['partielle', 'Partielles'], ['payee', 'Payées']];
  shell('#/factures', `<div class="head"><h1>Factures</h1><a class="btn primary" href="#/factures/nouvelle">Nouvelle facture</a></div>
    ${rows.length ? `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-t="${k}" class="${S.invTab === k ? 'on' : ''}" aria-selected="${S.invTab === k}">${l}</button>`).join('')}</div>
    <input class="search" type="search" id="q" placeholder="Rechercher un numéro ou un client" aria-label="Rechercher">` : ''}
    <div id="lst"></div>`);
  const draw = () => {
    const q = (document.getElementById('q')?.value || '').toLowerCase();
    const f = rows.filter(i => (S.invTab === 'all' || (S.invTab === 'open' ? i.status !== 'payee' : i.status === S.invTab)) && (!q || (i.number + ' ' + i.client_name).toLowerCase().includes(q)));
    const total = f.reduce((s, i) => s + (i.status === 'payee' ? 0 : i.balance), 0);
    document.getElementById('lst').innerHTML = (f.length && S.invTab !== 'payee' && total > 0 ? `<p class="sub">${f.length} facture${f.length > 1 ? 's' : ''} · reste dû ${amt(total)}</p>` : '') +
      invoiceList(f, rows.length ? 'Aucune facture dans cette liste.' : 'Aucune facture pour l\'instant.', rows.length ? '' : '<br><a class="btn primary" href="#/factures/nouvelle">Créer une facture</a>');
  };
  draw();
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.invTab = b.dataset.t; document.querySelectorAll('[data-t]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); }); draw(); });
  const q = document.getElementById('q'); if (q) q.oninput = draw;
}

async function pageInvoiceEdit(id) {
  loading('#/factures');
  const clients = await api('GET', '/clients');
  if (!clients.length) {
    shell('#/factures', `<h1>Nouvelle facture</h1><div class="list"><div class="empty">Ajoutez d'abord un client pour pouvoir le facturer.<br><a class="btn primary" href="#/clients/nouveau">Ajouter un client</a></div></div>`); return;
  }
  const t = S.me.today;
  const preClient = new URLSearchParams(location.hash.split('?')[1] || '').get('client');
  const inv = id ? await api('GET', '/invoices/' + id) : {
    client_id: Number(preClient) || '', issue_date: t, due_date: addDays(t, S.me.company.default_due_days), timbre: 1,
    items: [{ designation: '', qty: 1, unit_price: '', tva: 19 }], notes: '',
  };
  const lineHtml = (l = {}) => `<div class="line">
    <label class="des">Désignation<input name="designation" value="${esc(l.designation)}" required></label>
    <label>Quantité<input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${esc(l.qty ?? 1)}"></label>
    <label>Prix unitaire HT<input name="unit_price" type="number" inputmode="decimal" step="0.001" min="0" value="${esc(l.unit_price)}"></label>
    <label>TVA<select name="tva">${S.me.tva_rates.map(r => `<option value="${r}" ${Number(l.tva ?? 19) === r ? 'selected' : ''}>${r} %</option>`).join('')}</select></label>
    <button type="button" class="btn small danger rm" aria-label="Retirer la ligne">Retirer</button></div>`;
  shell('#/factures', `<a class="back" href="${id ? '#/factures/' + id : '#/factures'}">‹ Retour</a>
    <h1>${id ? 'Modifier la facture ' + esc(inv.number) : 'Nouvelle facture'}</h1>
    <form id="if" class="panel" novalidate>
      <div class="grid2">
        <label>Client<select name="client_id" required><option value="">Choisir…</option>${clients.map(c => `<option value="${c.id}" ${c.id === inv.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Numéro<input name="number" value="${esc(inv.number || '')}" placeholder="${id ? '' : 'Automatique'}"></label>
        <label>Date de facture<input name="issue_date" type="date" value="${esc(inv.issue_date)}" required></label>
        <label>Échéance<input name="due_date" type="date" value="${esc(inv.due_date)}" required></label>
      </div>
      <h2 style="margin-top:8px">Lignes</h2>
      <div class="lines" id="lines">${inv.items.map(lineHtml).join('')}</div>
      <div class="row-actions"><button type="button" class="btn small" id="add">Ajouter une ligne</button></div>
      <label class="check" style="margin-top:14px"><input type="checkbox" name="timbre" ${inv.timbre ? 'checked' : ''}> Timbre fiscal (1,000 DT)</label>
      <div class="totals" id="tot"></div>
      <label style="margin-top:12px">Notes (imprimées sur la facture)<textarea name="notes">${esc(inv.notes)}</textarea></label>
      <div class="row-actions"><button class="btn primary" type="submit">${id ? 'Enregistrer les modifications' : 'Créer la facture'}</button><a class="btn" href="${id ? '#/factures/' + id : '#/factures'}">Annuler</a></div>
    </form>`);
  const f = document.getElementById('if'), lines = document.getElementById('lines');
  const issue = f.elements.issue_date, due = f.elements.due_date;
  if (!id) issue.onchange = () => { due.value = addDays(issue.value, S.me.company.default_due_days); };
  const readLines = () => [...lines.querySelectorAll('.line')].map(l => ({ designation: l.querySelector('[name=designation]').value, qty: Number(l.querySelector('[name=qty]').value), unit_price: Number(l.querySelector('[name=unit_price]').value), tva: Number(l.querySelector('[name=tva]').value) }));
  const recalc = () => {
    let ht = 0, tva = 0; const byRate = {};
    readLines().forEach(l => { const h = Math.round((l.qty || 0) * (l.unit_price || 0) * 1000) / 1000; ht += h; const v = Math.round(h * l.tva / 100 * 1000) / 1000; tva += v; if (l.tva) byRate[l.tva] = (byRate[l.tva] || 0) + v; });
    const tb = f.elements.timbre.checked ? 1 : 0;
    document.getElementById('tot').innerHTML = `<div><span>Total HT</span>${amt(ht)}</div>${Object.entries(byRate).map(([r, v]) => `<div><span>TVA ${r} %</span>${amt(v)}</div>`).join('')}${tb ? `<div><span>Timbre fiscal</span>${amt(1)}</div>` : ''}<div class="grand"><span>Total TTC</span>${amt(ht + tva + tb)}</div>`;
  };
  lines.addEventListener('input', recalc); lines.addEventListener('change', recalc); f.elements.timbre.onchange = recalc;
  lines.addEventListener('click', e => { if (e.target.closest('.rm')) { if (lines.children.length > 1) { e.target.closest('.line').remove(); recalc(); } else toast('Une facture doit garder au moins une ligne', true); } });
  document.getElementById('add').onclick = () => { lines.insertAdjacentHTML('beforeend', lineHtml()); lines.lastElementChild.querySelector('input').focus(); };
  recalc();
  f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
    const d = formData(f);
    const body = { client_id: Number(d.client_id), number: d.number, issue_date: d.issue_date, due_date: d.due_date, timbre: f.elements.timbre.checked, notes: d.notes, items: readLines() };
    const r = id ? await api('PUT', '/invoices/' + id, body) : await api('POST', '/invoices', body);
    toast(id ? 'Facture enregistrée' : `Facture ${r.number} créée`); location.hash = '#/factures/' + (id || r.id);
  }); };
}

function reminderText(inv) {
  const co = S.me.company.name;
  if (inv.status === 'retard') return `Bonjour, sauf erreur de notre part, la facture ${inv.number} du ${fdate(inv.issue_date)} d'un montant restant de ${plain(inv.balance)} est échue depuis le ${fdate(inv.due_date)}. Merci de nous indiquer la date de règlement prévue. Cordialement, ${co}`;
  return `Bonjour, petit rappel : la facture ${inv.number} d'un montant de ${plain(inv.balance)} arrive à échéance le ${fdate(inv.due_date)}. Merci d'avance pour votre règlement. Cordialement, ${co}`;
}
function reminderButtons(inv) {
  if (inv.status === 'payee') return '';
  const c = inv.client || {}; const txt = reminderText(inv);
  const out = [];
  if (c.phone) out.push(`<a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/${phoneIntl(c.phone)}?text=${encodeURIComponent(txt)}">Relancer par WhatsApp</a>`, `<a class="btn small" href="sms:${esc(c.phone)}?body=${encodeURIComponent(txt)}">SMS</a>`, `<a class="btn small" href="tel:${esc(c.phone)}">Appeler</a>`);
  if (c.email) out.push(`<a class="btn small" href="mailto:${esc(c.email)}?subject=${encodeURIComponent('Facture ' + inv.number)}&body=${encodeURIComponent(txt)}">Relancer par e-mail</a>`);
  if (!out.length) return `<p class="sub">Ajoutez un téléphone ou un e-mail au client pour pouvoir le relancer.</p>`;
  return `<div class="row-actions">${out.join('')}</div>`;
}

async function pageInvoice(id) {
  loading('#/factures');
  const inv = await api('GET', '/invoices/' + id);
  shell('#/factures', `<a class="back" href="#/factures">‹ Factures</a>
    <div class="head"><h1>${esc(inv.number)}</h1>${tag(inv)}</div>
    <p class="sub" style="margin-top:-8px"><a href="#/clients/${inv.client_id}">${esc(inv.client_name)}</a> · émise le ${fdate(inv.issue_date)} · échéance ${fdate(inv.due_date)}${inv.status === 'retard' ? ` (en retard ${relDays(inv.days_overdue)})` : ''}</p>
    <div class="ledger">
      <div><div class="k">Total TTC</div><div class="v">${amt(inv.total_ttc, false)}</div></div>
      <div><div class="k">Reste à payer</div><div class="v ${inv.status === 'retard' ? 'pome' : ''}">${amt(inv.balance, false)}</div></div>
      <div><div class="k">Déjà payé</div><div class="v">${amt(inv.paid, false)}</div></div>
      <div><div class="k">Paiements</div><div class="v">${inv.payments.length}</div></div>
    </div>
    <div class="row-actions" style="margin-top:14px">
      ${inv.status !== 'payee' ? '<button class="btn primary" id="pay">Enregistrer un paiement</button>' : ''}
      <button class="btn" id="print-btn">Imprimer / PDF</button>
      <a class="btn" href="#/factures/${inv.id}/modifier">Modifier</a>
    </div>
    ${inv.status !== 'payee' ? `<h2>Relancer le client</h2>${reminderButtons(inv)}` : ''}
    <h2>Lignes</h2>
    <div class="list">${inv.items.map(l => `<div class="item"><div class="main"><div class="t">${esc(l.designation)}</div><div class="m">${l.qty} × ${plain(l.unit_price)} · TVA ${l.tva} %</div></div><div class="r">${amt(l.total_ht)}</div></div>`).join('')}
      <div class="item"><div class="main"><div class="m">HT ${plain(inv.total_ht)} · TVA ${plain(inv.total_tva)}${inv.timbre ? ' · timbre ' + plain(inv.timbre) : ''}</div></div><div class="r"><b>${amt(inv.total_ttc)}</b></div></div></div>
    <h2>Paiements reçus</h2>
    <div class="list">${inv.payments.length ? inv.payments.map(p => `<div class="item s-payee"><div class="main"><div class="t">${fdate(p.paid_on)} · ${esc(p.method)}</div><div class="m">${p.reference ? 'réf. ' + esc(p.reference) : 'sans référence'}</div></div><div class="r">${amt(p.amount)}<div><button class="btn small danger" data-delpay="${p.id}">Annuler</button></div></div></div>`).join('') : '<div class="empty">Aucun paiement reçu pour cette facture.</div>'}</div>
    ${inv.notes ? `<h2>Notes</h2><div class="panel" style="white-space:pre-wrap">${esc(inv.notes)}</div>` : ''}
    <div class="row-actions" style="margin-top:20px"><button class="btn danger" id="del">Supprimer la facture</button></div>`);
  const payBtn = document.getElementById('pay'); if (payBtn) payBtn.onclick = () => paymentModal(inv, () => pageInvoice(id));
  document.getElementById('print-btn').onclick = () => printInvoice(inv);
  document.getElementById('del').onclick = async e => {
    if (!await confirmBox(`Supprimer la facture ${inv.number} et ses paiements ?`)) return;
    guard(e.target, async () => { await api('DELETE', '/invoices/' + id); toast('Facture supprimée'); location.hash = '#/factures'; });
  };
  document.querySelectorAll('[data-delpay]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('Annuler ce paiement ?', 'Annuler le paiement')) return;
    guard(b, async () => { await api('DELETE', '/payments/' + b.dataset.delpay); toast('Paiement annulé'); pageInvoice(id); });
  });
}

function paymentModal(inv, done) {
  modal(`<h2>Paiement · ${esc(inv.number)}</h2><p class="sub">${esc(inv.client_name)} · reste ${plain(inv.balance)}</p>
    <form id="pf" novalidate>
      <label>Montant reçu (DT)<input name="amount" type="number" inputmode="decimal" step="0.001" min="0" value="${inv.balance.toFixed(3)}" required></label>
      <div class="grid2">
        <label>Date<input name="paid_on" type="date" value="${S.me.today}" required></label>
        <label>Mode<select name="method">${S.me.methods.map(m => `<option>${m}</option>`).join('')}</select></label>
      </div>
      <label>Référence (n° de chèque, virement…)<input name="reference"></label>
      <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le paiement</button><button type="button" class="btn" data-close>Annuler</button></div>
    </form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
      const d = formData(f); await api('POST', '/payments', { invoice_id: inv.id, amount: Number(d.amount), paid_on: d.paid_on, method: d.method, reference: d.reference });
      close(); toast('Paiement enregistré'); done();
    }); };
  });
}

function printInvoice(inv) {
  const co = S.me.company, c = inv.client;
  const byRate = {}; inv.items.forEach(l => { if (l.tva) byRate[l.tva] = (byRate[l.tva] || 0) + Math.round(l.total_ht * l.tva / 100 * 1000) / 1000; });
  document.getElementById('print').innerHTML = `
    <div class="inv-head">
      <div><h1>${esc(co.name)}</h1>${co.matricule_fiscal ? `MF : ${esc(co.matricule_fiscal)}<br>` : ''}${esc([co.address, co.city].filter(Boolean).join(', '))}<br>${esc([co.phone, co.email].filter(Boolean).join(' · '))}</div>
      <div style="text-align:right"><h1>Facture</h1>N° <b>${esc(inv.number)}</b><br>Date : ${fdate(inv.issue_date)}<br>Échéance : ${fdate(inv.due_date)}</div>
    </div>
    <div class="inv-box" style="margin-left:auto;width:50%"><b>${esc(c.name)}</b><br>${c.matricule_fiscal ? `MF : ${esc(c.matricule_fiscal)}<br>` : ''}${[c.address, c.city].some(Boolean) ? esc([c.address, c.city].filter(Boolean).join(', ')) + '<br>' : ''}${esc(c.phone || '')}</div>
    <table class="inv-table"><thead><tr><th>Désignation</th><th class="rt">Qté</th><th class="rt">P.U. HT</th><th class="rt">TVA</th><th class="rt">Total HT</th></tr></thead>
    <tbody>${inv.items.map(l => `<tr><td>${esc(l.designation)}</td><td class="rt">${l.qty}</td><td class="rt">${plain(l.unit_price)}</td><td class="rt">${l.tva} %</td><td class="rt">${plain(l.total_ht)}</td></tr>`).join('')}</tbody></table>
    <div class="inv-tot"><div><span>Total HT</span><span>${plain(inv.total_ht)}</span></div>
      ${Object.entries(byRate).map(([r, v]) => `<div><span>TVA ${r} %</span><span>${plain(v)}</span></div>`).join('')}
      ${inv.timbre ? `<div><span>Timbre fiscal</span><span>${plain(inv.timbre)}</span></div>` : ''}
      <div class="g"><span>Total TTC</span><span>${plain(inv.total_ttc)}</span></div>
      ${inv.paid > 0 ? `<div><span>Déjà réglé</span><span>${plain(inv.paid)}</span></div><div><b>Reste à payer</b><b>${plain(inv.balance)}</b></div>` : ''}</div>
    <p class="inv-words">Arrêtée la présente facture à la somme de : ${amountWords(inv.total_ttc)}.</p>
    ${inv.notes ? `<p style="white-space:pre-wrap">${esc(inv.notes)}</p>` : ''}
    <div class="inv-foot">${esc(co.invoice_footer || '')}</div>`;
  const title = document.title; document.title = `Facture ${inv.number}`;
  window.print(); setTimeout(() => { document.title = title; }, 500);
}

// ---------- paiements ----------
async function pagePayments() {
  loading('#/paiements');
  const [rows, invs] = await Promise.all([api('GET', '/payments'), api('GET', '/invoices')]);
  const open = invs.filter(i => i.status !== 'payee');
  const month = S.me.today.slice(0, 7);
  const tm = rows.filter(p => p.paid_on.startsWith(month)).reduce((s, p) => s + p.amount, 0);
  shell('#/paiements', `<div class="head"><h1>Paiements</h1>${open.length ? '<button class="btn primary" id="new">Enregistrer un paiement</button>' : ''}</div>
    <p class="sub">Encaissé ce mois : ${amt(tm)}</p>
    <div class="list">${rows.length ? rows.map(p => `<a class="item s-payee" href="#/factures/${p.invoice_id}"><div class="main"><div class="t">${esc(p.client_name)}</div><div class="m">${fdate(p.paid_on)} · ${esc(p.method)} · ${esc(p.number)}${p.reference ? ' · ' + esc(p.reference) : ''}</div></div><div class="r">${amt(p.amount)}</div></a>`).join('') : '<div class="empty">Aucun paiement enregistré. Ouvrez une facture pour saisir un règlement.</div>'}</div>`);
  const nb = document.getElementById('new');
  if (nb) nb.onclick = () => modal(`<h2>Quelle facture est réglée ?</h2><input class="search" type="search" placeholder="Client ou numéro" id="pq"><div class="list" id="pl"></div><div class="row-actions" style="margin-top:12px"><button class="btn" data-close>Annuler</button></div>`, (m, close) => {
    const draw = q => { q = (q || '').toLowerCase(); m.querySelector('#pl').innerHTML = open.filter(i => !q || (i.client_name + ' ' + i.number).toLowerCase().includes(q)).slice(0, 30).map(i => `<button type="button" class="item ${stClass(i)}" data-i="${i.id}" style="width:100%;border:0;border-bottom:1px solid var(--line);background:none;text-align:left;cursor:pointer"><div class="main"><div class="t">${esc(i.client_name)}</div><div class="m">${esc(i.number)} · échéance ${fdate(i.due_date)}</div></div><div class="r">${amt(i.balance)}</div></button>`).join('') || '<div class="empty">Aucune facture trouvée.</div>'; };
    draw(); m.querySelector('#pq').oninput = e => draw(e.target.value);
    m.querySelector('#pl').onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; close(); paymentModal(open.find(i => i.id === Number(b.dataset.i)), pagePayments); };
  });
}

// ---------- échéances ----------
async function pageAlerts() {
  loading('#/alertes');
  const al = await api('GET', '/alerts');
  S.alertsCount = al.overdue.length;
  const total = arr => arr.reduce((s, i) => s + i.balance, 0);
  shell('#/alertes', `<h1>Échéances</h1>
    <h2 style="margin-top:0">En retard${al.overdue.length ? ` · ${amt(total(al.overdue))}` : ''}</h2>
    ${invoiceList(al.overdue, 'Aucune facture en retard.')}
    <h2>À échoir dans les 7 jours${al.upcoming.length ? ` · ${amt(total(al.upcoming))}` : ''}</h2>
    ${invoiceList(al.upcoming, 'Aucune échéance cette semaine.')}
    <p class="sub" style="margin-top:16px">Ouvrez une facture pour relancer le client par WhatsApp, SMS ou e-mail avec un message déjà rédigé.</p>`);
}

// ---------- compte & paramètres ----------
async function pageSettings() {
  loading('#/parametres');
  S.me = await api('GET', '/me');
  const me = S.me, c = me.company, sub = me.subscription, owner = me.user.role === 'owner';
  const users = await api('GET', '/users');
  const stateText = { trial: `Essai gratuit jusqu'au ${fdate(sub.ends)}`, active: `Actif jusqu'au ${fdate(sub.ends)}`, expired: `Expiré depuis le ${fdate(sub.ends)}`, suspended: 'Suspendu' }[sub.state];
  shell('#/parametres', `<h1>Compte</h1>
    <h2 style="margin-top:0">Abonnement</h2>
    <div class="panel">
      <dl class="kv"><dt>Formule</dt><dd>${esc(sub.plan_label)} · ${sub.price} DT / mois</dd><dt>État</dt><dd>${stateText}</dd></dl>
      <div class="plans" style="max-width:none;margin-top:14px">${Object.entries(me.plans).map(([k, p]) => `<div style="border-color:var(--line)${k === sub.plan ? ';outline:2px solid var(--door)' : ''}"><b>${p.label}</b><span class="p" style="font-size:20px">${p.price} DT</span> / mois<br><span class="sub">${p.maxUsers} utilisateurs · ${p.maxClients >= 5000 ? 'clients illimités' : p.maxClients + ' clients'}</span></div>`).join('')}</div>
      <p style="margin-bottom:0">${me.payment_info ? esc(me.payment_info) : 'Pour activer ou renouveler, réglez par virement ou D17 puis envoyez le reçu : votre accès est prolongé dès réception.'}</p>
    </div>
    <h2>Entreprise</h2>
    <form id="cof" class="panel" novalidate>
      <div class="grid2">
        <label>Nom de l'entreprise<input name="name" value="${esc(c.name)}" ${owner ? '' : 'disabled'}></label>
        <label>Matricule fiscal<input name="matricule_fiscal" value="${esc(c.matricule_fiscal)}" ${owner ? '' : 'disabled'}></label>
        <label>Adresse<input name="address" value="${esc(c.address)}" ${owner ? '' : 'disabled'}></label>
        <label>Ville<input name="city" value="${esc(c.city)}" ${owner ? '' : 'disabled'}></label>
        <label>Téléphone<input name="phone" value="${esc(c.phone)}" ${owner ? '' : 'disabled'}></label>
        <label>E-mail<input name="email" value="${esc(c.email)}" ${owner ? '' : 'disabled'}></label>
        <label>Préfixe des numéros de facture<input name="invoice_prefix" value="${esc(c.invoice_prefix)}" ${owner ? '' : 'disabled'}></label>
        <label>Délai de paiement par défaut (jours)<input name="default_due_days" type="number" min="0" max="365" value="${c.default_due_days}" ${owner ? '' : 'disabled'}></label>
      </div>
      <label>Pied de facture (RIB, conditions…)<textarea name="invoice_footer" ${owner ? '' : 'disabled'}>${esc(c.invoice_footer)}</textarea></label>
      ${owner ? '<button class="btn primary" type="submit">Enregistrer</button>' : '<p class="sub">Seul le responsable du compte peut modifier ces informations.</p>'}
    </form>
    <h2>Équipe</h2>
    <div class="list">${users.map(u => `<div class="item"><div class="main"><div class="t">${esc(u.name)}${u.id === me.user.id ? ' (vous)' : ''}</div><div class="m">${esc(u.email)} · ${u.role === 'owner' ? 'responsable' : 'membre'}</div></div>${owner && u.role !== 'owner' ? `<div class="r"><button class="btn small danger" data-deluser="${u.id}">Retirer</button></div>` : ''}</div>`).join('')}</div>
    ${owner ? '<div class="row-actions"><button class="btn" id="adduser">Ajouter un utilisateur</button></div>' : ''}
    <h2>Sécurité</h2>
    <form id="pwf" class="panel" novalidate><div class="grid2"><label>Mot de passe actuel<input name="current" type="password" autocomplete="current-password"></label><label>Nouveau mot de passe<input name="next" type="password" minlength="8" autocomplete="new-password"></label></div><button class="btn" type="submit">Changer le mot de passe</button></form>
    <div class="row-actions" style="margin-top:20px">${me.user.is_superadmin ? '<a class="btn" href="#/admin">Gérer les abonnés</a>' : ''}<button class="btn" id="logout">Se déconnecter</button></div>
    <p class="sign">Dafter · créé par Wassim Khalfalli</p>`);
  const cof = document.getElementById('cof');
  cof.onsubmit = e => { e.preventDefault(); guard(cof.querySelector('button'), async () => { await api('PUT', '/company', formData(cof)); S.me = await api('GET', '/me'); toast('Informations enregistrées'); document.querySelector('.topbar .co').textContent = S.me.company.name; }); };
  const pwf = document.getElementById('pwf');
  pwf.onsubmit = e => { e.preventDefault(); guard(pwf.querySelector('button'), async () => { await api('PUT', '/me/password', formData(pwf)); pwf.reset(); toast('Mot de passe changé'); }); };
  document.getElementById('logout').onclick = async () => { await api('POST', '/auth/logout'); S.me = null; location.hash = '#/connexion'; };
  const au = document.getElementById('adduser');
  if (au) au.onclick = () => modal(`<h2>Ajouter un utilisateur</h2><form novalidate><label>Nom<input name="name" required></label><label>E-mail<input name="email" type="email" required></label><label>Mot de passe provisoire<input name="password" type="text" minlength="8" required><span class="sub">À transmettre à la personne ; elle pourra le changer.</span></label><div class="row-actions"><button class="btn primary" type="submit">Ajouter l'utilisateur</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form'); f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { await api('POST', '/users', formData(f)); close(); toast('Utilisateur ajouté'); pageSettings(); }); };
  });
  document.querySelectorAll('[data-deluser]').forEach(b => b.onclick = async () => { if (!await confirmBox('Retirer cet utilisateur ?', 'Retirer')) return; guard(b, async () => { await api('DELETE', '/users/' + b.dataset.deluser); toast('Utilisateur retiré'); pageSettings(); }); });
}

// ---------- super-admin ----------
async function pageAdmin() {
  if (!S.me.user.is_superadmin) { location.hash = '#/'; return; }
  loading('#/admin');
  const rows = await api('GET', '/admin/companies');
  const mrr = rows.filter(r => r.sub.state === 'active').reduce((s, r) => s + (S.me.plans[r.plan]?.price || 0), 0);
  const label = { trial: 'essai', active: 'actif', expired: 'expiré', suspended: 'suspendu' };
  const cls = { trial: 'attente', active: 'payee', expired: 'retard', suspended: 'retard' };
  shell('#/admin', `<h1>Abonnés</h1>
    <div class="ledger"><div><div class="k">Entreprises</div><div class="v">${rows.length}</div></div><div><div class="k">Abonnés actifs</div><div class="v">${rows.filter(r => r.sub.state === 'active').length}</div></div>
      <div><div class="k">En essai</div><div class="v">${rows.filter(r => r.sub.state === 'trial').length}</div></div><div><div class="k">Revenu mensuel</div><div class="v">${amt(mrr, false)}</div></div></div>
    <h2>Entreprises inscrites</h2>
    <div class="list">${rows.map(r => `<div class="item"><div class="main"><div class="t">${esc(r.name)} <span class="tag ${cls[r.sub.state]}">${label[r.sub.state]}</span></div>
      <div class="m">${esc(r.email || '')}${r.phone ? ' · ' + esc(r.phone) : ''} · ${S.me.plans[r.plan]?.label} · jusqu'au ${fdate(r.sub.ends)}</div>
      <div class="m">${r.users} util. · ${r.clients} clients · ${r.invoices} factures · inscrit le ${fdate(r.created_at)}</div>
      <div class="row-actions">
        <button class="btn small" data-a="add_months" data-v="1" data-id="${r.id}">+1 mois payé</button>
        <button class="btn small" data-a="add_months" data-v="12" data-id="${r.id}">+12 mois</button>
        <button class="btn small" data-a="extend_trial" data-v="14" data-id="${r.id}">Essai +14 j</button>
        <button class="btn small" data-a="plan" data-v="${r.plan === 'pro' ? 'essentiel' : 'pro'}" data-id="${r.id}">Passer en ${r.plan === 'pro' ? 'Essentiel' : 'Pro'}</button>
        <button class="btn small danger" data-a="status" data-v="${r.status === 'suspended' ? 'active' : 'suspended'}" data-id="${r.id}">${r.status === 'suspended' ? 'Réactiver' : 'Suspendre'}</button>
      </div></div></div>`).join('')}</div>`);
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => guard(b, async () => {
    await api('POST', '/admin/companies/' + b.dataset.id, { [b.dataset.a]: b.dataset.v }); toast('Abonnement mis à jour'); pageAdmin();
  }));
}

// ---------- routeur ----------
async function router() {
  const h = (location.hash || '#/').split('?')[0];
  try {
    if (!S.me) { try { S.me = await api('GET', '/me'); } catch (_) { S.me = null; } }
    if (!S.me) return authPage(h === '#/inscription' ? 'register' : 'login');
    if (h === '#/connexion' || h === '#/inscription') { location.hash = '#/'; return; }
    let m;
    if (h === '#/' || h === '#') return await pageDashboard();
    if (h === '#/clients') return await pageClients();
    if (h === '#/clients/nouveau') return await pageClientEdit();
    if ((m = h.match(/^#\/clients\/(\d+)\/modifier$/))) return await pageClientEdit(m[1]);
    if ((m = h.match(/^#\/clients\/(\d+)$/))) return await pageClient(m[1]);
    if (h === '#/factures') return await pageInvoices();
    if (h === '#/factures/nouvelle') return await pageInvoiceEdit();
    if ((m = h.match(/^#\/factures\/(\d+)\/modifier$/))) return await pageInvoiceEdit(m[1]);
    if ((m = h.match(/^#\/factures\/(\d+)$/))) return await pageInvoice(m[1]);
    if (h === '#/paiements') return await pagePayments();
    if (h === '#/alertes') return await pageAlerts();
    if (h === '#/parametres') return await pageSettings();
    if (h === '#/admin') return await pageAdmin();
    location.hash = '#/';
  } catch (e) {
    if (S.me) shell('', `<div class="banner err">${esc(e.message)}</div><a class="btn" href="#/">Retour à l'accueil</a>`);
  }
}
window.addEventListener('hashchange', router);
router();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
