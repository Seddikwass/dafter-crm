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
const plain = n => { const [d, m] = (Math.round((Number(n) || 0) * 1000) / 1000).toFixed(3).split('.'); return d.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + ',' + m + ' DT'; };
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
  box: '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${I[k]}</svg>`;

// ---------- coque ----------
function shell(active, content) {
  const me = S.me; const sub = me.subscription;
  const plat = me.company.is_platform;
  const links = plat ? [['#/admin', 'shield', 'Abonnés'], ['#/admin/acces', 'users', 'Accès'], ['#/parametres', 'gear', 'Compte']] : [
    ['#/', 'home', 'Accueil'], ['#/clients', 'users', 'Clients'], ['#/factures', 'doc', 'Ventes'],
    ['#/achats', 'box', 'Achats'], ['#/alertes', 'bell', 'Échéances'], ['#/parametres', 'gear', 'Compte'],
  ];
  if (me.user.is_superadmin && !plat) links.push(['#/admin', 'shield', 'Abonnés']);
  let banner = '';
  if (plat) banner = '';
  else if (sub.state === 'trial') banner = `<div class="banner info">Essai Pro offert : ${sub.days_left > 0 ? `il reste ${sub.days_left} jour${sub.days_left > 1 ? 's' : ''}` : "dernier jour aujourd'hui"}. <a href="#/parametres">Voir l'abonnement</a></div>`;
  else if (sub.state === 'free') banner = `<div class="banner ${me.invoices_this_month >= sub.free_limit ? 'warn' : 'info'}">Formule gratuite : ${me.invoices_this_month} / ${sub.free_limit} factures ce mois. <a href="#/parametres">Passer à Pro, 40 DT par mois</a></div>`;
  else if (sub.state === 'suspended') banner = `<div class="banner err">Compte suspendu. Contactez le support pour le réactiver.</div>`;
  else if (sub.days_left <= 5) banner = `<div class="banner warn">Votre abonnement se termine le ${fdate(sub.ends)}. <a href="#/parametres">Renouveler</a></div>`;
  root.innerHTML = `<div class="app">
    <header class="topbar"><span class="brand">Dafter</span><span class="co">${plat ? 'Administration' : esc(me.company.name)}</span></header>
    <nav class="nav" aria-label="Navigation">${links.map(([h, i, l]) => `<a href="${h}" class="${active === h ? 'on' : ''}${h === '#/admin' && !plat ? ' desk' : ''}" ${active === h ? 'aria-current="page"' : ''}>${icon(i)}<span>${l}</span>${h === '#/alertes' && S.alertsCount ? `<span class="dot">${S.alertsCount}</span>` : ''}</a>`).join('')}</nav>
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
      <p>Factures avec TVA et timbre fiscal, devis, bons de livraison, avoirs, échéances et encaissements : toute la gestion commerciale de votre entreprise, sur téléphone et sur PC.</p>
      <div class="sample" aria-hidden="true">
        <div><span>Pharmacie El Manar · F2026-0041</span><span class="late">${amt(1250.5)}</span></div>
        <div><span>Atelier Ben Salah · échéance demain</span><span>${amt(384.2)}</span></div>
        <div><span>Café Le Jasmin · payée</span><span>${amt(96.39)}</span></div>
      </div>
      <div class="plans">
        <div><b>Gratuit</b><span class="p">0 DT</span><br>20 factures par mois, 1 utilisateur</div>
        <div><b>Pro</b><span class="p">40 DT</span> par mois<br>ou 400 DT par an, tout illimité</div>
      </div>
    </section>
    <section class="auth-form">
      <h2>${reg ? 'Créer le compte de votre entreprise' : 'Se connecter'}</h2>
      ${reg ? '<p class="sub" style="margin-top:-10px">14 jours de Pro offerts, puis gratuit jusqu\'à 20 factures par mois.</p>' : ''}
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
    ${d.supplier_due > 0 || d.low_stock > 0 ? `<div class="row-actions" style="margin-top:12px">${d.supplier_due > 0 ? `<a class="btn small" href="#/achats/facture">À payer aux fournisseurs : ${amt(d.supplier_due)}${d.supplier_overdue > 0 ? ' dont ' + plain(d.supplier_overdue) + ' en retard' : ''}</a>` : ''}${d.low_stock > 0 ? `<a class="btn small danger" href="#/stock">${d.low_stock} article${d.low_stock > 1 ? 's' : ''} en stock bas</a>` : ''}</div>` : ''}
    <div class="row-actions" style="margin-top:12px"><a class="btn small" href="#/rapports">Déclaration du mois : TVA, timbre, retenues</a></div>
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


// ---------- lignes de document (factures, devis, bons) ----------
function lineHtml(l = {}) {
  return `<div class="line">
    <label class="des">Désignation<input name="designation" list="prodlist" value="${esc(l.designation)}" required autocomplete="off"><input type="hidden" name="product_id" value="${esc(l.product_id || '')}"></label>
    <label>Quantité<input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${esc(l.qty ?? 1)}"></label>
    <label>Prix unitaire HT<input name="unit_price" type="number" inputmode="decimal" step="0.001" min="0" value="${esc(l.unit_price)}"></label>
    <label>TVA<select name="tva">${S.me.tva_rates.map(r => `<option value="${r}" ${Number(l.tva ?? 19) === r ? 'selected' : ''}>${r} %</option>`).join('')}</select></label>
    <button type="button" class="btn small danger rm" aria-label="Retirer la ligne">Retirer</button></div>`;
}
function linesBlock(items, products) {
  return `<h2 style="margin-top:8px">Lignes</h2>
    <datalist id="prodlist">${products.map(p => `<option value="${esc(p.name)}">${esc([p.ref, plain(p.unit_price)].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
    <div class="lines" id="lines">${(items.length ? items : [{}]).map(lineHtml).join('')}</div>
    <div class="row-actions"><button type="button" class="btn small" id="add">Ajouter une ligne</button>${products.length ? '' : '<a class="btn small" href="#/articles">Créer un catalogue d\'articles</a>'}</div>`;
}
function lineEditor(f, products, timbreOn = () => false) {
  const lines = f.querySelector('#lines');
  const readLines = () => [...lines.querySelectorAll('.line')].map(l => {
    const o = { designation: l.querySelector('[name=designation]').value, qty: Number(l.querySelector('[name=qty]').value), unit_price: Number(l.querySelector('[name=unit_price]').value), tva: Number(l.querySelector('[name=tva]').value) };
    const pid = Number(l.querySelector('[name=product_id]').value); if (pid) o.product_id = pid;
    return o;
  });
  const recalc = () => {
    let ht = 0, tva = 0; const byRate = {};
    readLines().forEach(l => { const h = Math.round((l.qty || 0) * (l.unit_price || 0) * 1000) / 1000; ht += h; const v = Math.round(h * l.tva / 100 * 1000) / 1000; tva += v; if (l.tva) byRate[l.tva] = (byRate[l.tva] || 0) + v; });
    const tb = timbreOn() ? 1 : 0;
    f.querySelector('#tot').innerHTML = `<div><span>Total HT</span>${amt(ht)}</div>${Object.entries(byRate).map(([r, v]) => `<div><span>TVA ${r} %</span>${amt(v)}</div>`).join('')}${tb ? `<div><span>Timbre fiscal</span>${amt(1)}</div>` : ''}<div class="grand"><span>Total TTC</span>${amt(ht + tva + tb)}</div>`;
  };
  lines.addEventListener('input', e => {
    if (e.target.name === 'designation') {
      const line = e.target.closest('.line');
      const p = products.find(x => x.name === e.target.value);
      line.querySelector('[name=product_id]').value = p ? p.id : '';
      if (p) { line.querySelector('[name=unit_price]').value = p.unit_price; line.querySelector('[name=tva]').value = p.tva; }
    }
    recalc();
  });
  lines.addEventListener('change', recalc);
  if (f.elements.timbre) f.elements.timbre.addEventListener('change', recalc);
  lines.addEventListener('click', e => { if (e.target.closest('.rm')) { if (lines.children.length > 1) { e.target.closest('.line').remove(); recalc(); } else toast('Gardez au moins une ligne', true); } });
  f.querySelector('#add').onclick = () => { lines.insertAdjacentHTML('beforeend', lineHtml()); lines.lastElementChild.querySelector('input').focus(); };
  recalc();
  return { readLines, recalc };
}
function salesTabs(active) {
  const t = [['#/factures', 'Factures'], ['#/docs/devis', 'Devis'], ['#/docs/commande', 'Commandes'], ['#/docs/livraison', 'Livraisons'], ['#/docs/avoir', 'Avoirs'], ['#/paiements', 'Encaissements'], ['#/articles', 'Articles'], ['#/rapports', 'Rapports']];
  return `<nav class="tabs seg" aria-label="Ventes">${t.map(([h, l]) => `<a href="${h}" class="${h === active ? 'on' : ''}" ${h === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
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
      <label>Matricule fiscal<input name="matricule_fiscal" value="${esc(c.matricule_fiscal)}" placeholder="1234567A/A/M/000"></label>
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
  shell('#/factures', `${salesTabs('#/factures')}<div class="head"><h1>Factures</h1><a class="btn primary" href="#/factures/nouvelle">Nouvelle facture</a></div>
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
  const products = await api('GET', '/products');
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
      ${linesBlock(inv.items, products)}
      <label class="check" style="margin-top:14px"><input type="checkbox" name="timbre" ${inv.timbre ? 'checked' : ''}> Timbre fiscal (1,000 DT)</label>
      <div class="totals" id="tot"></div>
      <label style="margin-top:12px">Notes (imprimées sur la facture)<textarea name="notes">${esc(inv.notes)}</textarea></label>
      <div class="row-actions"><button class="btn primary" type="submit">${id ? 'Enregistrer les modifications' : 'Créer la facture'}</button><a class="btn" href="${id ? '#/factures/' + id : '#/factures'}">Annuler</a></div>
    </form>`);
  const f = document.getElementById('if');
  const issue = f.elements.issue_date, due = f.elements.due_date;
  if (!id) issue.onchange = () => { due.value = addDays(issue.value, S.me.company.default_due_days); };
  const { readLines } = lineEditor(f, products, () => f.elements.timbre.checked);
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
  if (c.phone) out.push(`<a class="btn small wa" data-rec="whatsapp" target="_blank" rel="noopener" href="https://wa.me/${phoneIntl(c.phone)}?text=${encodeURIComponent(txt)}">Relancer par WhatsApp</a>`, `<a class="btn small" data-rec="sms" href="sms:${esc(c.phone)}?body=${encodeURIComponent(txt)}">SMS</a>`, `<a class="btn small" data-rec="telephone" href="tel:${esc(c.phone)}">Appeler</a>`);
  if (c.email) out.push(`<a class="btn small" data-rec="email" href="mailto:${esc(c.email)}?subject=${encodeURIComponent('Facture ' + inv.number)}&body=${encodeURIComponent(txt)}">Relancer par e-mail</a>`);
  if (!out.length) return `<p class="sub">Ajoutez un téléphone ou un e-mail au client pour pouvoir le relancer.</p>`;
  return `<div class="row-actions">${out.join('')}</div><p class="sub">Chaque relance est notée dans l'historique ci-dessous.</p>`;
}
const CHANNEL = { email: 'E-mail', whatsapp: 'WhatsApp', sms: 'SMS', telephone: 'Appel', courrier: 'Courrier' };
function currentStep(daysOverdue) {
  const steps = S.me.company.reminder_settings?.steps || [-3, 7, 15, 30];
  const reached = steps.filter(st => daysOverdue >= st);
  return reached.length ? reached[reached.length - 1] : daysOverdue;
}
// Note la relance quand on touche un bouton WhatsApp, SMS, Appel ou e-mail (le lien s'ouvre normalement).
function bindReminderRecord(rootEl, getInfo, after) {
  rootEl.querySelectorAll('[data-rec]').forEach(a => a.addEventListener('click', () => {
    const info = getInfo(a);
    api('POST', '/reminders', { invoice_id: info.invoice_id, step: info.step, channel: a.dataset.rec, message: info.message }).then(() => { toast('Relance notée dans l\'historique'); if (after) setTimeout(after, 800); }).catch(e => toast(e.message, true));
  }));
}
function reminderHistory(list) {
  if (!list || !list.length) return '<div class="list"><div class="empty">Aucune relance pour cette facture.</div></div>';
  return `<div class="list">${list.map(r => `<div class="item ${r.status === 'echec' ? 's-retard' : ''}"><div class="main"><div class="t">${CHANNEL[r.channel] || r.channel}${r.auto ? ' automatique' : ''} · ${esc(({ rappel: 'rappel', amicale: 'amicale', ferme: 'ferme', dernier: 'dernier rappel' })[r.level] || '')}</div><div class="m">${new Date(r.sent_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}${r.user_name ? ' · ' + esc(r.user_name) : ''}${r.status === 'echec' ? ' · échec : ' + esc(r.error || '') : ''}</div></div><div class="r"><button class="btn small danger" data-delrem="${r.id}" aria-label="Supprimer de l'historique">Retirer</button></div></div>`).join('')}</div>`;
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
      ${inv.status !== 'payee' ? `<a class="btn" href="#/docs/avoir/nouveau?invoice=${inv.id}">Créer un avoir</a>` : ''}
    </div>
    ${inv.status !== 'payee' ? `<h2>Relancer le client</h2>${reminderButtons(inv)}` : ''}
    <h2>Historique des relances</h2>${reminderHistory(inv.reminders)}
    <h2>Lignes</h2>
    <div class="list">${inv.items.map(l => `<div class="item"><div class="main"><div class="t">${esc(l.designation)}</div><div class="m">${l.qty} × ${plain(l.unit_price)} · TVA ${l.tva} %</div></div><div class="r">${amt(l.total_ht)}</div></div>`).join('')}
      <div class="item"><div class="main"><div class="m">HT ${plain(inv.total_ht)} · TVA ${plain(inv.total_tva)}${inv.timbre ? ' · timbre ' + plain(inv.timbre) : ''}</div></div><div class="r"><b>${amt(inv.total_ttc)}</b></div></div></div>
    <h2>Paiements reçus</h2>
    <div class="list">${inv.payments.length ? inv.payments.map(p => `<div class="item s-payee"><div class="main"><div class="t">${fdate(p.paid_on)} · ${esc(p.method)}</div><div class="m">${p.reference ? 'réf. ' + esc(p.reference) : 'sans référence'}</div></div><div class="r">${amt(p.amount)}<div><button class="btn small danger" data-delpay="${p.id}">Annuler</button></div></div></div>`).join('') : '<div class="empty">Aucun paiement reçu pour cette facture.</div>'}</div>
    ${inv.notes ? `<h2>Notes</h2><div class="panel" style="white-space:pre-wrap">${esc(inv.notes)}</div>` : ''}
    <div class="row-actions" style="margin-top:20px"><button class="btn danger" id="del">Supprimer la facture</button></div>`);
  const payBtn = document.getElementById('pay'); if (payBtn) payBtn.onclick = () => paymentModal(inv, () => pageInvoice(id));
  bindReminderRecord(root, () => ({ invoice_id: inv.id, step: currentStep(inv.days_overdue), message: 'Relance facture ' + inv.number }), () => pageInvoice(id));
  document.querySelectorAll('[data-delrem]').forEach(b => b.onclick = () => guard(b, async () => { await api('DELETE', '/reminders/' + b.dataset.delrem); pageInvoice(id); }));
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
  const r3 = n => Math.round(n * 1000) / 1000;
  modal(`<h2>Paiement · ${esc(inv.number)}</h2><p class="sub">${esc(inv.client_name)} · TTC ${plain(inv.total_ttc)} · reste ${plain(inv.balance)}</p>
    <form id="pf" novalidate>
      <label class="check"><input type="checkbox" name="rs_on"> Le client a appliqué une retenue à la source</label>
      <div class="rsbox" hidden><div class="grid2">
        <label>Taux de retenue<select name="rs_rate">${S.me.rs_rates.map(r => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${String(r).replace('.', ',')} %</option>`).join('')}</select></label>
        <label>Montant retenu (DT)<input name="rs_amount" type="number" inputmode="decimal" step="0.001" min="0"></label></div>
        <label>N° du certificat de retenue<input name="rs_ref" placeholder="à réclamer au client"></label>
        <p class="sub" style="margin-top:-6px">Calculée sur le montant TTC. En général 1 % pour les paiements de 1 000 DT TTC ou plus, 1,5 % pour les paiements de l'État.</p></div>
      <label>Montant reçu (DT)<input name="amount" type="number" inputmode="decimal" step="0.001" min="0" value="${inv.balance.toFixed(3)}" required></label>
      <div class="grid2">
        <label>Date<input name="paid_on" type="date" value="${S.me.today}" required></label>
        <label>Mode<select name="method">${S.me.methods.filter(x => x !== 'retenue à la source').map(x => `<option>${x}</option>`).join('')}</select></label>
      </div>
      <label>Référence (n° de chèque, virement…)<input name="reference"></label>
      <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le paiement</button><button type="button" class="btn" data-close>Annuler</button></div>
    </form>`, (m, close) => {
    const f = m.querySelector('form'), box = m.querySelector('.rsbox');
    const calc = () => {
      if (!f.elements.rs_on.checked) { f.elements.amount.value = inv.balance.toFixed(3); return; }
      const rs = Math.min(inv.balance, r3(inv.total_ttc * Number(f.elements.rs_rate.value) / 100));
      f.elements.rs_amount.value = rs.toFixed(3);
      f.elements.amount.value = r3(inv.balance - rs).toFixed(3);
    };
    f.elements.rs_on.onchange = () => { box.hidden = !f.elements.rs_on.checked; calc(); };
    f.elements.rs_rate.onchange = calc;
    f.elements.rs_amount.oninput = () => { f.elements.amount.value = r3(inv.balance - Number(f.elements.rs_amount.value || 0)).toFixed(3); };
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
      const d = formData(f);
      const rs = d.rs_on ? Number(d.rs_amount || 0) : 0, amount = Number(d.amount || 0);
      if (rs <= 0 && amount <= 0) throw new Error('Indiquez un montant');
      if (r3(rs + amount) > r3(inv.balance) + 0.0005) throw new Error(`Le total dépasse le reste à payer (${plain(inv.balance)})`);
      if (rs > 0) await api('POST', '/payments', { invoice_id: inv.id, amount: rs, paid_on: d.paid_on, method: 'retenue à la source', reference: d.rs_ref || `RS ${String(d.rs_rate).replace('.', ',')} %` });
      if (amount > 0) await api('POST', '/payments', { invoice_id: inv.id, amount, paid_on: d.paid_on, method: d.method, reference: d.reference });
      close(); toast(rs > 0 ? 'Paiement et retenue à la source enregistrés' : 'Paiement enregistré'); done();
    }); };
  });
}

function printInvoice(inv, kind, opts = {}) {
  const co = S.me.company, c = opts.party || inv.client;
  const K = opts.label ? { label: opts.label } : kind ? S.me.doc_types[kind] : { label: 'Facture' };
  const qtyOnly = opts.qtyOnly ?? kind === 'livraison';
  const byRate = {}; inv.items.forEach(l => { if (l.tva) byRate[l.tva] = (byRate[l.tva] || 0) + Math.round(l.total_ht * l.tva / 100 * 1000) / 1000; });
  document.getElementById('print').innerHTML = `
    <div class="inv-head">
      <div><h1>${esc(co.name)}</h1>${co.matricule_fiscal ? `MF : ${esc(co.matricule_fiscal)}<br>` : ''}${esc([co.address, co.city].filter(Boolean).join(', '))}<br>${esc([co.phone, co.email].filter(Boolean).join(' · '))}</div>
      <div style="text-align:right"><h1>${K.label}</h1>N° <b>${esc(inv.number)}</b><br>Date : ${fdate(inv.issue_date)}${inv.due_date ? `<br>Échéance : ${fdate(inv.due_date)}` : ''}${inv.valid_until ? `<br>${kind === 'devis' ? 'Valable jusqu\'au' : 'Livraison prévue le'} : ${fdate(inv.valid_until)}` : ''}${kind === 'avoir' && inv.invoice_number ? `<br>Sur facture : ${esc(inv.invoice_number)}` : ''}</div>
    </div>
    <div class="inv-box" style="margin-left:auto;width:50%"><b>${esc(c.name)}</b><br>${c.matricule_fiscal ? `MF : ${esc(c.matricule_fiscal)}<br>` : ''}${[c.address, c.city].some(Boolean) ? esc([c.address, c.city].filter(Boolean).join(', ')) + '<br>' : ''}${esc(c.phone || '')}</div>
    ${qtyOnly ? `<table class="inv-table"><thead><tr><th>Désignation</th><th class="rt">Quantité</th></tr></thead>
    <tbody>${inv.items.map(l => `<tr><td>${esc(l.designation)}</td><td class="rt">${l.qty}</td></tr>`).join('')}</tbody></table>
    <div style="display:flex;justify-content:space-between;margin-top:50px"><span>${opts.sign1 || 'Signature du livreur'}</span><span>${opts.sign2 || 'Signature et cachet du client'}</span></div>` : `<table class="inv-table"><thead><tr><th>Désignation</th><th class="rt">Qté</th><th class="rt">P.U. HT</th><th class="rt">TVA</th><th class="rt">Total HT</th></tr></thead>
    <tbody>${inv.items.map(l => `<tr><td>${esc(l.designation)}</td><td class="rt">${l.qty}</td><td class="rt">${plain(l.unit_price)}</td><td class="rt">${l.tva} %</td><td class="rt">${plain(l.total_ht)}</td></tr>`).join('')}</tbody></table>
    <div class="inv-tot"><div><span>Total HT</span><span>${plain(inv.total_ht)}</span></div>
      ${Object.entries(byRate).map(([r, v]) => `<div><span>TVA ${r} %</span><span>${plain(v)}</span></div>`).join('')}
      ${inv.timbre ? `<div><span>Timbre fiscal</span><span>${plain(inv.timbre)}</span></div>` : ''}
      <div class="g"><span>Total TTC</span><span>${plain(inv.total_ttc)}</span></div>
      ${inv.paid > 0 ? `<div><span>Déjà réglé</span><span>${plain(inv.paid)}</span></div><div><b>Reste à payer</b><b>${plain(inv.balance)}</b></div>` : ''}</div>
    <p class="inv-words">Arrêté${kind === 'facture' || !kind ? 'e la présente facture' : kind === 'devis' ? ' le présent devis' : kind === 'avoir' ? ' le présent avoir' : ' le présent bon'} à la somme de : ${amountWords(inv.total_ttc)}.</p>`}
    ${inv.notes ? `<p style="white-space:pre-wrap">${esc(inv.notes)}</p>` : ''}
    <div class="inv-foot">${esc(co.invoice_footer || '')}</div>`;
  const title = document.title; document.title = `${K.label} ${inv.number}`;
  window.print(); setTimeout(() => { document.title = title; }, 500);
}


// ---------- devis, bons, avoirs ----------
const DOC_STATUS = { emis: ['Émis', 'attente'], accepte: ['Accepté', 'payee'], refuse: ['Refusé', 'retard'], converti: ['Facturé', 'payee'], impute: ['Déduit de la facture', 'payee'] };
const DOC_NEW = { devis: 'Nouveau devis', commande: 'Nouveau bon de commande', livraison: 'Nouveau bon de livraison', avoir: 'Nouvel avoir' };
const DOC_PLURAL = { devis: 'Devis', commande: 'Bons de commande', livraison: 'Bons de livraison', avoir: 'Avoirs' };
function docTag(d) { const [l, c] = DOC_STATUS[d.status] || [d.status, 'attente']; return `<span class="tag ${c}">${l}</span>`; }

async function pageDocs(type) {
  loading('#/factures');
  const rows = (await api('GET', '/documents')).filter(d => d.type === type);
  const help = { devis: 'Proposez un prix, puis transformez le devis accepté en facture en un geste.', commande: 'Enregistrez les commandes de vos clients avant de livrer et facturer.', livraison: 'Imprimez le bon à faire signer à la livraison, puis facturez-le.', avoir: 'Un avoir annule tout ou partie d\'une facture : ouvrez la facture concernée et touchez « Créer un avoir ».' }[type];
  shell('#/factures', `${salesTabs('#/docs/' + type)}<div class="head"><h1>${DOC_PLURAL[type]}</h1><a class="btn primary" href="#/docs/${type}/nouveau">${DOC_NEW[type]}</a></div>
    ${rows.length ? '<input class="search" type="search" id="q" placeholder="Rechercher un numéro ou un client" aria-label="Rechercher">' : ''}
    <div id="lst"></div>`);
  const draw = () => {
    const q = (document.getElementById('q')?.value || '').toLowerCase();
    const f = rows.filter(d => !q || (d.number + ' ' + d.client_name).toLowerCase().includes(q));
    document.getElementById('lst').innerHTML = !rows.length ? `<div class="list"><div class="empty">${help}<br><a class="btn primary" href="#/docs/${type}/nouveau">${DOC_NEW[type]}</a></div></div>`
      : `<div class="list">${f.map(d => `<a class="item ${d.status === 'refuse' ? 's-retard' : d.status === 'converti' || d.status === 'impute' || d.status === 'accepte' ? 's-payee' : ''}" href="#/doc/${d.id}"><div class="main"><div class="t">${esc(d.client_name)}</div><div class="m">${esc(d.number)} · ${fdate(d.issue_date)}${d.invoice_number ? ' · ' + esc(d.invoice_number) : ''}</div></div><div class="r">${amt(d.total_ttc)}<div>${docTag(d)}</div></div></a>`).join('') || '<div class="empty">Aucun résultat.</div>'}</div>`;
  };
  draw(); const q = document.getElementById('q'); if (q) q.oninput = draw;
}

async function pageDocEdit(type, id) {
  loading('#/factures');
  const [clients, products] = await Promise.all([api('GET', '/clients'), api('GET', '/products')]);
  if (!clients.length) { shell('#/factures', `<h1>${DOC_NEW[type]}</h1><div class="list"><div class="empty">Ajoutez d'abord un client.<br><a class="btn primary" href="#/clients/nouveau">Ajouter un client</a></div></div>`); return; }
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  let d = id ? await api('GET', '/documents/' + id) : { client_id: Number(params.get('client')) || '', issue_date: S.me.today, valid_until: type === 'devis' ? addDays(S.me.today, 30) : '', items: [], notes: '' };
  if (id) type = d.type;
  let inv = null;
  if (!id && type === 'avoir' && params.get('invoice')) {
    inv = await api('GET', '/invoices/' + params.get('invoice'));
    d = { ...d, client_id: inv.client_id, invoice_id: inv.id, items: inv.items.map(l => ({ ...l })), notes: `Avoir sur facture ${inv.number}` };
  }
  const back = id ? '#/doc/' + id : inv ? '#/factures/' + inv.id : '#/docs/' + type;
  shell('#/factures', `<a class="back" href="${back}">‹ Retour</a>
    <h1>${id ? 'Modifier ' + esc(d.number) : DOC_NEW[type]}</h1>
    ${inv ? `<div class="banner info">Sur la facture ${esc(inv.number)} · reste à payer ${plain(inv.balance)}. Ajustez les lignes pour ne garder que le montant à annuler : il sera déduit de la facture.</div>` : ''}
    <form id="df" class="panel" novalidate>
      <div class="grid2">
        <label>Client<select name="client_id" required ${inv ? 'disabled' : ''}><option value="">Choisir…</option>${clients.map(c => `<option value="${c.id}" ${c.id === d.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Date<input name="issue_date" type="date" value="${esc(d.issue_date)}" required></label>
        ${type === 'devis' || type === 'commande' ? `<label>${type === 'devis' ? 'Valable jusqu\'au' : 'Livraison prévue le'}<input name="valid_until" type="date" value="${esc(d.valid_until || '')}"></label>` : ''}
      </div>
      ${linesBlock(d.items, products)}
      <div class="totals" id="tot"></div>
      <label style="margin-top:12px">Notes (imprimées)<textarea name="notes">${esc(d.notes)}</textarea></label>
      <div class="row-actions"><button class="btn primary" type="submit">${id ? 'Enregistrer les modifications' : 'Créer'}</button><a class="btn" href="${back}">Annuler</a></div>
    </form>`);
  const f = document.getElementById('df');
  const { readLines } = lineEditor(f, products);
  f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
    const x = formData(f);
    const body = { type, client_id: inv ? inv.client_id : Number(x.client_id), issue_date: x.issue_date, valid_until: x.valid_until || null, notes: x.notes, items: readLines(), invoice_id: inv ? inv.id : undefined };
    const r = id ? await api('PUT', '/documents/' + id, body) : await api('POST', '/documents', body);
    toast(id ? 'Document enregistré' : `${S.me.doc_types[type].label} ${r.number} créé`);
    location.hash = inv ? '#/factures/' + inv.id : '#/doc/' + (id || r.id);
  }); };
}

async function pageDoc(id) {
  loading('#/factures');
  const d = await api('GET', '/documents/' + id);
  const K = S.me.doc_types[d.type];
  const locked = d.status === 'converti' || d.status === 'impute';
  shell('#/factures', `<a class="back" href="#/docs/${d.type}">‹ ${DOC_PLURAL[d.type]}</a>
    <div class="head"><h1>${esc(K.label)} ${esc(d.number)}</h1>${docTag(d)}</div>
    <p class="sub" style="margin-top:-8px"><a href="#/clients/${d.client_id}">${esc(d.client_name)}</a> · ${fdate(d.issue_date)}${d.valid_until ? ` · ${d.type === 'devis' ? 'valable jusqu\'au' : 'livraison prévue le'} ${fdate(d.valid_until)}` : ''}</p>
    ${d.invoice_id ? `<div class="banner info">${d.type === 'avoir' ? 'Déduit de la facture' : 'Facturé :'} <a href="#/factures/${d.invoice_id}">${esc(d.invoice_number)}</a></div>` : ''}
    <div class="ledger"><div><div class="k">Total HT</div><div class="v">${amt(d.total_ht, false)}</div></div><div><div class="k">Total TTC</div><div class="v">${amt(d.total_ttc, false)}</div></div></div>
    <div class="row-actions" style="margin-top:14px">
      ${d.type !== 'avoir' && !locked ? '<button class="btn primary" id="conv">Transformer en facture</button>' : ''}
      <button class="btn" id="print-btn">Imprimer / PDF</button>
      ${!locked ? `<a class="btn" href="#/doc/${d.id}/modifier">Modifier</a>` : ''}
      ${d.type === 'devis' && !locked ? `<button class="btn small" data-st="accepte">Marquer accepté</button><button class="btn small" data-st="refuse">Marquer refusé</button>` : ''}
    </div>
    ${d.client?.phone && d.type === 'devis' ? `<div class="row-actions"><a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/${phoneIntl(d.client.phone)}?text=${encodeURIComponent(`Bonjour, voici notre devis ${d.number} d'un montant de ${plain(d.total_ttc)}. N'hésitez pas à nous contacter pour toute question. Cordialement, ${S.me.company.name}`)}">Envoyer par WhatsApp</a></div>` : ''}
    <h2>Lignes</h2>
    <div class="list">${d.items.map(l => `<div class="item"><div class="main"><div class="t">${esc(l.designation)}</div><div class="m">${l.qty} × ${plain(l.unit_price)} · TVA ${l.tva} %</div></div><div class="r">${amt(l.total_ht)}</div></div>`).join('')}</div>
    ${d.notes ? `<h2>Notes</h2><div class="panel" style="white-space:pre-wrap">${esc(d.notes)}</div>` : ''}
    <div class="row-actions" style="margin-top:20px"><button class="btn danger" id="del">Supprimer</button></div>`);
  document.getElementById('print-btn').onclick = () => printInvoice(d, d.type);
  const conv = document.getElementById('conv');
  if (conv) conv.onclick = () => guard(conv, async () => { const r = await api('POST', `/documents/${id}/convert`); toast(`Facture ${r.number} créée`); location.hash = '#/factures/' + r.id; });
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => guard(b, async () => { await api('POST', `/documents/${id}/status`, { status: b.dataset.st }); toast('Statut mis à jour'); pageDoc(id); }));
  document.getElementById('del').onclick = async e => {
    if (!await confirmBox(`Supprimer ${K.label.toLowerCase()} ${d.number} ?${d.type === 'avoir' && d.invoice_id ? ' La facture retrouvera son solde.' : ''}`)) return;
    guard(e.target, async () => { await api('DELETE', '/documents/' + id); toast('Document supprimé'); location.hash = '#/docs/' + d.type; });
  };
}

// ---------- articles ----------
async function pageProducts() {
  loading('#/factures');
  const rows = await api('GET', '/products');
  shell('#/factures', `${salesTabs('#/articles')}<div class="head"><h1>Articles</h1><button class="btn primary" id="new">Ajouter un article</button></div>
    <p class="sub" style="margin-top:-6px">Vos produits et services : dans une facture ou un devis, tapez le début du nom pour remplir le prix et la TVA.</p>
    ${rows.length ? '<input class="search" type="search" id="q" placeholder="Rechercher un article" aria-label="Rechercher">' : ''}
    <div id="lst"></div>`);
  const form = (p = {}) => `<h2>${p.id ? 'Modifier l\'article' : 'Nouvel article'}</h2><form novalidate>
    <label>Désignation<input name="name" value="${esc(p.name)}" required></label>
    <div class="grid2"><label>Référence<input name="ref" value="${esc(p.ref)}"></label><label>Unité<input name="unit" value="${esc(p.unit)}" placeholder="pièce, heure, kg…"></label>
    <label>Prix unitaire HT (DT)<input name="unit_price" type="number" inputmode="decimal" step="0.001" min="0" value="${esc(p.unit_price ?? '')}"></label>
    <label>TVA<select name="tva">${S.me.tva_rates.map(r => `<option value="${r}" ${Number(p.tva ?? 19) === r ? 'selected' : ''}>${r} %</option>`).join('')}</select></label>
    <label>Prix d'achat HT (DT)<input name="purchase_price" type="number" inputmode="decimal" step="0.001" min="0" value="${esc(p.purchase_price ?? '')}"></label>
    <label>Alerte si stock inférieur ou égal à<input name="stock_alert" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.stock_alert ?? '')}"></label></div>
    <label class="check"><input type="checkbox" name="track_stock" ${p.track_stock ? 'checked' : ''}> Suivre le stock de cet article</label>
    <div class="row-actions"><button class="btn primary" type="submit">Enregistrer l'article</button><button type="button" class="btn" data-close>Annuler</button>${p.id ? '<button type="button" class="btn danger" id="pdel">Supprimer</button>' : ''}</div></form>`;
  const open = p => modal(form(p), (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { p.id ? await api('PUT', '/products/' + p.id, formData(f)) : await api('POST', '/products', formData(f)); close(); toast('Article enregistré'); pageProducts(); }); };
    const del = m.querySelector('#pdel'); if (del) del.onclick = () => guard(del, async () => { await api('DELETE', '/products/' + p.id); close(); toast('Article supprimé'); pageProducts(); });
  });
  const draw = () => {
    const q = (document.getElementById('q')?.value || '').toLowerCase();
    const f = rows.filter(p => !q || (p.name + ' ' + (p.ref || '')).toLowerCase().includes(q));
    document.getElementById('lst').innerHTML = !rows.length ? '<div class="list"><div class="empty">Aucun article. Ajoutez vos produits ou services les plus vendus pour facturer plus vite.</div></div>'
      : `<div class="list">${f.map(p => `<button type="button" class="item" data-p="${p.id}" style="width:100%;border:0;border-bottom:1px solid var(--line);background:none;text-align:left;cursor:pointer"><div class="main"><div class="t">${esc(p.name)}</div><div class="m">${esc([p.ref, p.unit, 'TVA ' + p.tva + ' %', p.track_stock ? 'stock ' + Number(p.stock) : ''].filter(Boolean).join(' · '))}</div></div><div class="r">${amt(p.unit_price)}<div class="sub">HT</div></div></button>`).join('') || '<div class="empty">Aucun résultat.</div>'}</div>`;
    document.querySelectorAll('[data-p]').forEach(b => b.onclick = () => open(rows.find(p => p.id === Number(b.dataset.p))));
  };
  draw(); const q = document.getElementById('q'); if (q) q.oninput = draw;
  document.getElementById('new').onclick = () => open({});
}


// ---------- achats ----------
const P_STATUS = { payee: ['Payée', 'payee'], retard: ['En retard', 'retard'], partielle: ['Partielle', 'partielle'], attente: ['À payer', 'attente'], emis: ['En cours', 'attente'], converti: ['Transformé', 'payee'] };
const P_NEW = { commande: 'Nouvelle commande fournisseur', reception: 'Nouveau bon de réception', facture: 'Nouvelle facture d\'achat' };
const P_PLURAL = { commande: 'Commandes fournisseurs', reception: 'Bons de réception', facture: 'Factures d\'achat' };
function pTag(p) { const [l, c] = P_STATUS[p.pay_status] || [p.pay_status, 'attente']; return `<span class="tag ${c}">${l}</span>`; }
function purchaseTabs(active) {
  const t = [['#/achats', 'Fournisseurs'], ['#/achats/commande', 'Commandes'], ['#/achats/reception', 'Réceptions'], ['#/achats/facture', 'Factures d\'achat'], ['#/stock', 'Stock'], ['#/rapports', 'Rapports']];
  return `<nav class="tabs seg" aria-label="Achats">${t.map(([h, l]) => `<a href="${h}" class="${h === active ? 'on' : ''}" ${h === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>`;
}
function purchaseList(rows, empty = 'Aucun document.') {
  if (!rows.length) return `<div class="list"><div class="empty">${empty}</div></div>`;
  return `<div class="list">${rows.map(p => `<a class="item ${p.pay_status === 'retard' ? 's-retard' : p.pay_status === 'payee' || p.pay_status === 'converti' ? 's-payee' : p.type === 'facture' && p.days_overdue >= -7 ? 's-soon' : ''}" href="#/achat/${p.id}">
    <div class="main"><div class="t">${esc(p.supplier_name)}</div><div class="m">${esc(p.number)}${p.supplier_ref ? ' · réf. ' + esc(p.supplier_ref) : ''} · ${p.type === 'facture' ? 'échéance ' + fdate(p.due_date) : fdate(p.issue_date)}</div></div>
    <div class="r">${amt(p.type === 'facture' && p.pay_status !== 'payee' ? p.balance : p.total_ttc)}<div>${pTag(p)}</div></div></a>`).join('')}</div>`;
}
function supplierModal(sp = {}, done) {
  modal(`<h2>${sp.id ? 'Modifier le fournisseur' : 'Nouveau fournisseur'}</h2><form novalidate>
    <label>Nom ou raison sociale<input name="name" required value="${esc(sp.name)}"></label>
    <div class="grid2"><label>Matricule fiscal<input name="matricule_fiscal" value="${esc(sp.matricule_fiscal)}"></label><label>Contact<input name="contact_name" value="${esc(sp.contact_name)}"></label>
    <label>Téléphone<input name="phone" type="tel" value="${esc(sp.phone)}"></label><label>E-mail<input name="email" type="email" value="${esc(sp.email)}"></label>
    <label>Adresse<input name="address" value="${esc(sp.address)}"></label><label>Ville<input name="city" value="${esc(sp.city)}"></label></div>
    <label>Notes<textarea name="notes">${esc(sp.notes)}</textarea></label>
    <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le fournisseur</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { const r = sp.id ? await api('PUT', '/suppliers/' + sp.id, formData(f)) : await api('POST', '/suppliers', formData(f)); close(); toast('Fournisseur enregistré'); done(sp.id || r.id); }); };
  });
}
async function pageSuppliers() {
  loading('#/achats');
  const rows = await api('GET', '/suppliers');
  const due = rows.reduce((s, r) => s + r.balance, 0);
  shell('#/achats', `${purchaseTabs('#/achats')}<div class="head"><h1>Fournisseurs</h1><button class="btn primary" id="new">Ajouter un fournisseur</button></div>
    ${due > 0 ? `<p class="sub" style="margin-top:-6px">Vous devez au total ${amt(due)} à vos fournisseurs.</p>` : ''}
    <div class="list">${rows.length ? rows.map(r => `<a class="item ${r.overdue > 0 ? 's-retard' : ''}" href="#/fournisseurs/${r.id}"><div class="main"><div class="t">${esc(r.name)}</div><div class="m">${esc([r.city, r.phone].filter(Boolean).join(' · ') || r.purchase_count + ' facture(s) d\'achat')}</div></div><div class="r">${r.balance > 0 ? amt(r.balance) : '<span class="sub">soldé</span>'}</div></a>`).join('') : '<div class="empty">Aucun fournisseur. Ajoutez ceux chez qui vous achetez pour suivre vos commandes, réceptions et ce que vous leur devez.</div>'}</div>`);
  document.getElementById('new').onclick = () => supplierModal({}, id => { location.hash = '#/fournisseurs/' + id; });
}
async function pageSupplier(id) {
  loading('#/achats');
  const { supplier: sp, purchases } = await api('GET', '/suppliers/' + id);
  const factures = purchases.filter(p => p.type === 'facture');
  const bal = factures.reduce((s, p) => s + p.balance, 0);
  shell('#/achats', `<a class="back" href="#/achats">‹ Fournisseurs</a>
    <div class="head"><h1>${esc(sp.name)}</h1><button class="btn" id="edit">Modifier</button></div>
    <div class="row-actions" style="margin:-4px 0 16px">${sp.phone ? `<a class="btn small" href="tel:${esc(sp.phone)}">Appeler</a><a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/${phoneIntl(sp.phone)}">WhatsApp</a>` : ''}${sp.email ? `<a class="btn small" href="mailto:${esc(sp.email)}">E-mail</a>` : ''}
      <a class="btn small primary" href="#/achats/commande/nouveau?supplier=${sp.id}">Commander</a><a class="btn small" href="#/achats/facture/nouveau?supplier=${sp.id}">Saisir une facture</a></div>
    <div class="ledger"><div><div class="k">Vous lui devez</div><div class="v ${factures.some(p => p.pay_status === 'retard') ? 'pome' : ''}">${amt(bal, false)}</div></div><div><div class="k">Total acheté</div><div class="v">${amt(factures.reduce((s, p) => s + p.total_ttc, 0), false)}</div></div></div>
    <h2>Documents</h2>${purchaseList(purchases, 'Aucun achat chez ce fournisseur.')}
    <div class="row-actions" style="margin-top:20px"><button class="btn danger" id="del">Supprimer le fournisseur</button></div>`);
  document.getElementById('edit').onclick = () => supplierModal(sp, () => pageSupplier(id));
  document.getElementById('del').onclick = async e => { if (!await confirmBox(`Supprimer ${sp.name} ?`)) return; guard(e.target, async () => { await api('DELETE', '/suppliers/' + id); toast('Fournisseur supprimé'); location.hash = '#/achats'; }); };
}
async function pagePurchases(type) {
  loading('#/achats');
  const rows = (await api('GET', '/purchases')).filter(p => p.type === type);
  const help = { commande: 'Préparez vos commandes fournisseurs, puis transformez-les en réception quand la marchandise arrive.', reception: 'Le bon de réception fait entrer la marchandise en stock.', facture: 'Saisissez les factures de vos fournisseurs pour suivre ce que vous devez et quand payer.' }[type];
  const due = type === 'facture' ? rows.reduce((s, p) => s + p.balance, 0) : 0;
  shell('#/achats', `${purchaseTabs('#/achats/' + type)}<div class="head"><h1>${P_PLURAL[type]}</h1><a class="btn primary" href="#/achats/${type}/nouveau">${P_NEW[type]}</a></div>
    ${due > 0 ? `<p class="sub" style="margin-top:-6px">Reste à payer : ${amt(due)}</p>` : ''}
    ${purchaseList(rows, help)}`);
}
async function pagePurchaseEdit(type, id) {
  loading('#/achats');
  const [suppliers, products] = await Promise.all([api('GET', '/suppliers'), api('GET', '/products')]);
  if (!suppliers.length) { shell('#/achats', `${purchaseTabs('#/achats/' + type)}<h1>${P_NEW[type]}</h1><div class="list"><div class="empty">Ajoutez d'abord un fournisseur.<br><a class="btn primary" href="#/achats">Ajouter un fournisseur</a></div></div>`); return; }
  const pre = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('supplier')) || '';
  const d = id ? await api('GET', '/purchases/' + id) : { supplier_id: pre, issue_date: S.me.today, due_date: type === 'facture' ? addDays(S.me.today, 30) : '', items: [], timbre: type === 'facture' ? 1 : 0, notes: '' };
  if (id) type = d.type;
  // pour les achats, proposer le prix d'achat de l'article
  const prods = products.map(p => ({ ...p, unit_price: p.purchase_price ?? p.unit_price }));
  const back = id ? '#/achat/' + id : '#/achats/' + type;
  shell('#/achats', `<a class="back" href="${back}">‹ Retour</a><h1>${id ? 'Modifier ' + esc(d.number) : P_NEW[type]}</h1>
    <form id="pf" class="panel" novalidate><div class="grid2">
      <label>Fournisseur<select name="supplier_id" required><option value="">Choisir…</option>${suppliers.map(x => `<option value="${x.id}" ${x.id === d.supplier_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>${type === 'facture' ? 'N° de facture du fournisseur' : 'Référence du fournisseur'}<input name="supplier_ref" value="${esc(d.supplier_ref || '')}"></label>
      <label>Date<input name="issue_date" type="date" value="${esc(d.issue_date)}" required></label>
      ${type !== 'reception' ? `<label>${type === 'facture' ? 'Échéance de paiement' : 'Livraison prévue le'}<input name="due_date" type="date" value="${esc(d.due_date || '')}"></label>` : ''}
    </div>
    ${linesBlock(d.items, prods)}
    ${type === 'facture' ? `<label class="check" style="margin-top:14px"><input type="checkbox" name="timbre" ${d.timbre ? 'checked' : ''}> Timbre fiscal (1,000 DT)</label>` : ''}
    <div class="totals" id="tot"></div>
    ${type !== 'commande' ? '<p class="sub">Les lignes liées à un article suivi en stock font entrer la marchandise dans votre dépôt principal.</p>' : ''}
    <label style="margin-top:12px">Notes<textarea name="notes">${esc(d.notes)}</textarea></label>
    <div class="row-actions"><button class="btn primary" type="submit">${id ? 'Enregistrer les modifications' : 'Créer'}</button><a class="btn" href="${back}">Annuler</a></div></form>`);
  const f = document.getElementById('pf');
  const { readLines } = lineEditor(f, prods, () => !!(f.elements.timbre && f.elements.timbre.checked));
  f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
    const x = formData(f);
    const body = { type, supplier_id: Number(x.supplier_id), supplier_ref: x.supplier_ref, issue_date: x.issue_date, due_date: x.due_date || null, timbre: !!(f.elements.timbre && f.elements.timbre.checked), notes: x.notes, items: readLines() };
    const r = id ? await api('PUT', '/purchases/' + id, body) : await api('POST', '/purchases', body);
    toast(id ? 'Document enregistré' : `${S.me.purchase_types[type].label} ${r.number} créé`); location.hash = '#/achat/' + (id || r.id);
  }); };
}
async function pagePurchase(id) {
  loading('#/achats');
  const d = await api('GET', '/purchases/' + id);
  const K = S.me.purchase_types[d.type];
  const locked = d.status === 'converti';
  shell('#/achats', `<a class="back" href="#/achats/${d.type}">‹ ${P_PLURAL[d.type]}</a>
    <div class="head"><h1>${esc(d.number)}</h1>${pTag(d)}</div>
    <p class="sub" style="margin-top:-8px">${esc(K.label)} · <a href="#/fournisseurs/${d.supplier_id}">${esc(d.supplier_name)}</a> · ${fdate(d.issue_date)}${d.supplier_ref ? ' · réf. ' + esc(d.supplier_ref) : ''}${d.type === 'facture' ? ' · échéance ' + fdate(d.due_date) : ''}</p>
    ${d.linked_id ? `<div class="banner info">Transformé en <a href="#/achat/${d.linked_id}">${esc(d.linked_number)}</a></div>` : ''}
    <div class="ledger"><div><div class="k">Total TTC</div><div class="v">${amt(d.total_ttc, false)}</div></div>${d.type === 'facture' ? `<div><div class="k">Reste à payer</div><div class="v ${d.pay_status === 'retard' ? 'pome' : ''}">${amt(d.balance, false)}</div></div>` : `<div><div class="k">Total HT</div><div class="v">${amt(d.total_ht, false)}</div></div>`}</div>
    <div class="row-actions" style="margin-top:14px">
      ${d.type === 'facture' && d.pay_status !== 'payee' ? '<button class="btn primary" id="pay">Enregistrer un paiement</button>' : ''}
      ${d.type === 'commande' && !locked ? '<button class="btn primary" data-conv="reception">Marchandise reçue</button><button class="btn" data-conv="facture">Transformer en facture d\'achat</button>' : ''}
      ${d.type === 'reception' && !locked ? '<button class="btn primary" data-conv="facture">Saisir la facture</button>' : ''}
      <button class="btn" id="print-btn">Imprimer / PDF</button>
      ${!locked ? `<a class="btn" href="#/achat/${d.id}/modifier">Modifier</a>` : ''}
    </div>
    <h2>Lignes</h2>
    <div class="list">${d.items.map(l => `<div class="item"><div class="main"><div class="t">${esc(l.designation)}</div><div class="m">${l.qty} × ${plain(l.unit_price)} · TVA ${l.tva} %</div></div><div class="r">${amt(l.total_ht)}</div></div>`).join('')}</div>
    ${d.type === 'facture' ? `<h2>Paiements faits</h2><div class="list">${d.payments.length ? d.payments.map(p => `<div class="item s-payee"><div class="main"><div class="t">${fdate(p.paid_on)} · ${esc(p.method)}</div><div class="m">${p.reference ? 'réf. ' + esc(p.reference) : 'sans référence'}</div></div><div class="r">${amt(p.amount)}<div><button class="btn small danger" data-delpay="${p.id}">Annuler</button></div></div></div>`).join('') : '<div class="empty">Aucun paiement fait pour cette facture.</div>'}</div>` : ''}
    ${d.notes ? `<h2>Notes</h2><div class="panel" style="white-space:pre-wrap">${esc(d.notes)}</div>` : ''}
    <div class="row-actions" style="margin-top:20px"><button class="btn danger" id="del">Supprimer</button></div>`);
  document.getElementById('print-btn').onclick = () => printInvoice(d, d.type, { label: K.label, party: d.supplier, qtyOnly: d.type === 'reception', sign1: 'Réceptionné par', sign2: 'Signature du livreur' });
  document.querySelectorAll('[data-conv]').forEach(b => b.onclick = () => {
    if (b.dataset.conv === 'facture') return modal(`<h2>Facture du fournisseur</h2><form novalidate><label>N° de la facture du fournisseur<input name="supplier_ref"></label><div class="row-actions"><button class="btn primary" type="submit">Créer la facture d'achat</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
      const f = m.querySelector('form'); f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { const r = await api('POST', `/purchases/${id}/convert`, { to: 'facture', supplier_ref: f.elements.supplier_ref.value }); close(); toast(`Facture d'achat ${r.number} créée`); location.hash = '#/achat/' + r.id; }); };
    });
    guard(b, async () => { const r = await api('POST', `/purchases/${id}/convert`, { to: 'reception' }); toast(`Bon de réception ${r.number} créé, stock mis à jour`); location.hash = '#/achat/' + r.id; });
  });
  const pay = document.getElementById('pay');
  if (pay) pay.onclick = () => modal(`<h2>Paiement · ${esc(d.number)}</h2><p class="sub">${esc(d.supplier_name)} · reste ${plain(d.balance)}</p><form novalidate>
    <label>Montant payé (DT)<input name="amount" type="number" inputmode="decimal" step="0.001" min="0" value="${d.balance.toFixed(3)}"></label>
    <div class="grid2"><label>Date<input name="paid_on" type="date" value="${S.me.today}"></label><label>Mode<select name="method">${S.me.methods.map(x => `<option>${x}</option>`).join('')}</select></label></div>
    <label>Référence (n° de chèque, virement…)<input name="reference"></label>
    <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le paiement</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form'); f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { const x = formData(f); await api('POST', `/purchases/${id}/payments`, { ...x, amount: Number(x.amount) }); close(); toast('Paiement enregistré'); pagePurchase(id); }); };
  });
  document.querySelectorAll('[data-delpay]').forEach(b => b.onclick = async () => { if (!await confirmBox('Annuler ce paiement ?', 'Annuler le paiement')) return; guard(b, async () => { await api('DELETE', '/purchase-payments/' + b.dataset.delpay); toast('Paiement annulé'); pagePurchase(id); }); });
  document.getElementById('del').onclick = async e => { if (!await confirmBox(`Supprimer ${d.number} ?${d.type !== 'commande' ? ' Les entrées de stock liées seront annulées.' : ''}`)) return; guard(e.target, async () => { await api('DELETE', '/purchases/' + id); toast('Document supprimé'); location.hash = '#/achats/' + d.type; }); };
}

// ---------- stock ----------
const MOVE_LABEL = { entree: 'Entrée', sortie: 'Sortie', inventaire: 'Inventaire', transfert: 'Transfert' };
const SOURCE_LABEL = { invoice: 'facture', document: 'bon de livraison', achat: 'achat', manuel: 'saisie manuelle' };
async function pageStock() {
  loading('#/achats');
  const [{ products, warehouses }, moves, allProducts] = await Promise.all([api('GET', '/stock'), api('GET', '/stock/moves'), api('GET', '/products')]);
  const whName = id => warehouses.find(w => w.id === id)?.name || '';
  const value = products.reduce((s, p) => s + Math.max(0, p.stock) * (p.purchase_price || 0), 0);
  shell('#/achats', `${purchaseTabs('#/stock')}<div class="head"><h1>Stock</h1><button class="btn primary" id="mv">Mouvement de stock</button></div>
    <div class="ledger"><div><div class="k">Articles suivis</div><div class="v">${products.length}</div></div><div><div class="k">Valeur au prix d'achat</div><div class="v">${amt(value, false)}</div></div></div>
    <h2>Quantités</h2>
    <div class="list">${products.length ? products.map(p => { const low = p.stock <= (p.stock_alert || 0); return `<div class="item ${p.stock < 0 ? 's-retard' : low ? 's-soon' : ''}"><div class="main"><div class="t">${esc(p.name)}</div><div class="m">${esc([p.ref, warehouses.length > 1 ? p.by_warehouse.filter(w => w.qty != 0).map(w => whName(w.warehouse_id) + ' ' + Number(w.qty)).join(', ') : ''].filter(Boolean).join(' · '))}${p.stock_alert != null ? ' · alerte à ' + Number(p.stock_alert) : ''}</div></div><div class="r"><b style="font-size:18px">${Number(p.stock)}</b> ${esc(p.unit || '')}${low ? `<div><span class="tag ${p.stock < 0 ? 'retard' : 'soon'}">${p.stock < 0 ? 'négatif' : 'stock bas'}</span></div>` : ''}</div></div>`; }).join('')
      : '<div class="empty">Aucun article suivi. Dans Ventes, Articles, cochez « Suivre le stock » sur vos produits, ou saisissez directement un mouvement.</div>'}</div>
    <h2>Dépôts</h2>
    <div class="list">${warehouses.map(w => `<div class="item"><div class="main"><div class="t">${esc(w.name)}</div></div><div class="r"><button class="btn small" data-wren="${w.id}" data-n="${esc(w.name)}">Renommer</button>${warehouses.length > 1 ? ` <button class="btn small danger" data-wdel="${w.id}">Supprimer</button>` : ''}</div></div>`).join('')}</div>
    <div class="row-actions"><button class="btn small" id="addwh">Ajouter un dépôt</button></div>
    <h2>Derniers mouvements</h2>
    <div class="list">${moves.length ? moves.slice(0, 80).map(m => `<div class="item ${m.qty > 0 ? 's-payee' : ''}"><div class="main"><div class="t">${esc(m.product_name)}</div><div class="m">${fdate(m.moved_on)} · ${MOVE_LABEL[m.kind] || m.kind} · ${esc(m.warehouse_name)} · ${SOURCE_LABEL[m.source] || m.source}${m.ref ? ' ' + esc(m.ref) : ''}</div></div><div class="r"><b>${m.qty > 0 ? '+' : ''}${Number(m.qty)}</b>${m.source === 'manuel' ? `<div><button class="btn small danger" data-mdel="${m.id}">Annuler</button></div>` : ''}</div></div>`).join('') : '<div class="empty">Aucun mouvement pour le moment.</div>'}</div>`);
  document.getElementById('mv').onclick = () => {
    if (!allProducts.length) { toast('Créez d\'abord un article dans Ventes, Articles', true); return; }
    modal(`<h2>Mouvement de stock</h2><form novalidate>
      <label>Type<select name="kind"><option value="entree">Entrée (achat, retour client)</option><option value="sortie">Sortie (casse, usage interne)</option><option value="inventaire">Inventaire (quantité comptée)</option>${warehouses.length > 1 ? '<option value="transfert">Transfert entre dépôts</option>' : ''}</select></label>
      <label>Article<select name="product_id">${allProducts.map(p => `<option value="${p.id}">${esc(p.name)}${p.ref ? ' · ' + esc(p.ref) : ''}</option>`).join('')}</select></label>
      <div class="grid2"><label>Dépôt<select name="warehouse_id">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
      <label class="to" hidden>Vers le dépôt<select name="to_warehouse_id">${warehouses.map(w => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>
      <label><span class="ql">Quantité</span><input name="qty" type="number" inputmode="decimal" step="any" min="0"></label>
      <label>Date<input name="moved_on" type="date" value="${S.me.today}"></label></div>
      <label>Motif<input name="ref" placeholder="ex. casse, retour, inventaire de fin d'année"></label>
      <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le mouvement</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
      const f = m.querySelector('form');
      f.elements.kind.onchange = () => { m.querySelector('.to').hidden = f.elements.kind.value !== 'transfert'; m.querySelector('.ql').textContent = f.elements.kind.value === 'inventaire' ? 'Quantité comptée' : 'Quantité'; };
      f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { await api('POST', '/stock/moves', formData(f)); close(); toast('Mouvement enregistré'); pageStock(); }); };
    });
  };
  const whModal = (w = {}) => modal(`<h2>${w.id ? 'Renommer le dépôt' : 'Nouveau dépôt'}</h2><form novalidate><label>Nom<input name="name" value="${esc(w.name || '')}"></label><div class="row-actions"><button class="btn primary" type="submit">Enregistrer le dépôt</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form'); f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { w.id ? await api('PUT', '/warehouses/' + w.id, formData(f)) : await api('POST', '/warehouses', formData(f)); close(); toast('Dépôt enregistré'); pageStock(); }); };
  });
  document.getElementById('addwh').onclick = () => whModal();
  document.querySelectorAll('[data-wren]').forEach(b => b.onclick = () => whModal({ id: b.dataset.wren, name: b.dataset.n }));
  document.querySelectorAll('[data-wdel]').forEach(b => b.onclick = async () => { if (!await confirmBox('Supprimer ce dépôt ?')) return; guard(b, async () => { await api('DELETE', '/warehouses/' + b.dataset.wdel); toast('Dépôt supprimé'); pageStock(); }); });
  document.querySelectorAll('[data-mdel]').forEach(b => b.onclick = async () => { if (!await confirmBox('Annuler ce mouvement ?', 'Annuler le mouvement')) return; guard(b, async () => { await api('DELETE', '/stock/moves/' + b.dataset.mdel); toast('Mouvement annulé'); pageStock(); }); });
}


// ---------- rapports ----------
function csvDownload(name, rows) {
  const cell = v => { if (v == null) return ''; if (typeof v === 'number') return String(Math.round(v * 1000) / 1000).replace('.', ','); const t = String(v); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function rateCols(items) { const o = {}; (items || []).forEach(l => { o[l.tva] = (o[l.tva] || 0) + Math.round(l.total_ht * l.tva / 100 * 1000) / 1000; }); return o; }
async function pageReports() {
  loading('#/factures');
  const month = S.repMonth || S.me.today.slice(0, 7);
  const r = await api('GET', '/reports/monthly?month=' + month);
  const [y, mo] = month.split('-');
  const label = `${['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'][Number(mo) - 1]} ${y}`;
  const rateTable = rows => rows.length ? `<div class="list">${rows.map(x => `<div class="item"><div class="main"><div class="t">TVA ${x.rate} %</div><div class="m">base HT ${plain(x.ht)}</div></div><div class="r">${amt(x.tva)}</div></div>`).join('')}</div>` : '<div class="list"><div class="empty">Rien ce mois-ci.</div></div>';
  shell('#/factures', `${salesTabs('#/rapports')}<div class="head"><h1>Rapports</h1><input type="month" id="mon" value="${month}" aria-label="Mois" style="max-width:180px"></div>
    <p class="sub" style="margin-top:-6px">Déclaration mensuelle de ${label}, d'après les factures, avoirs et factures d'achat saisis dans Dafter. À vérifier avec votre comptable avant dépôt.</p>
    <div class="hero-due"><div class="k">${r.tva_a_payer >= 0 ? 'TVA à payer' : 'Crédit de TVA'}</div><div class="v">${amt(Math.abs(r.tva_a_payer))}</div><div class="sub">collectée ${plain(r.tva_collectee)} − déductible ${plain(r.tva_deductible)}</div></div>
    <div class="ledger">
      <div><div class="k">Chiffre d'affaires HT</div><div class="v">${amt(r.ca_ht, false)}</div><div class="n">${r.nb_factures} facture${r.nb_factures > 1 ? 's' : ''}, avoirs déduits</div></div>
      <div><div class="k">Droit de timbre collecté</div><div class="v">${amt(r.timbre_ventes, false)}</div><div class="n">1 DT par facture</div></div>
      <div><div class="k">Retenues à la source subies</div><div class="v">${amt(r.rs_subies, false)}</div><div class="n">à imputer sur vos impôts</div></div>
      <div><div class="k">Achats HT</div><div class="v">${amt(r.achats_ht, false)}</div><div class="n">factures d'achat</div></div>
    </div>
    <h2>TVA collectée (ventes moins avoirs)</h2>${rateTable(r.collectee)}
    <h2>TVA déductible (achats)</h2>${rateTable(r.deductible)}
    <h2>Trésorerie du mois</h2>
    <div class="list"><div class="item"><div class="main"><div class="t">Encaissé</div><div class="m">${r.methods.filter(x => x.method !== 'retenue à la source' && x.method !== 'avoir').map(x => esc(x.method) + ' ' + plain(x.amount)).join(' · ') || '—'}</div></div><div class="r">${amt(r.encaisse)}</div></div>
      <div class="item"><div class="main"><div class="t">Payé aux fournisseurs</div></div><div class="r">${amt(r.decaisse)}</div></div></div>
    <h2>Pour votre comptable</h2>
    <div class="row-actions"><button class="btn" id="xv">Journal des ventes (Excel)</button><button class="btn" id="xa">Journal des achats (Excel)</button><button class="btn" id="xd">Récapitulatif TVA (Excel)</button></div>`);
  document.getElementById('mon').onchange = e => { S.repMonth = e.target.value; pageReports(); };
  const rates = [0, 7, 13, 19];
  document.getElementById('xv').onclick = () => {
    const head = ['Type', 'Numéro', 'Date', 'Échéance', 'Client', 'Matricule fiscal', 'Total HT', ...rates.map(x => 'TVA ' + x + ' %'), 'Total TVA', 'Timbre', 'Total TTC'];
    const rows = r.journal_ventes.map(v => { const c = rateCols(v.items); return ['Facture', v.number, v.issue_date, v.due_date, v.client, v.mf, v.total_ht, ...rates.map(x => c[x] || 0), v.total_tva, v.timbre, v.total_ttc]; })
      .concat(r.journal_avoirs.map(v => { const c = rateCols(v.items); return ['Avoir', v.number, v.issue_date, '', v.client, v.mf, -v.total_ht, ...rates.map(x => -(c[x] || 0)), -v.total_tva, 0, -v.total_ttc]; }));
    csvDownload(`journal-ventes-${month}.csv`, [head, ...rows]);
  };
  document.getElementById('xa').onclick = () => {
    const head = ['Numéro', 'N° fournisseur', 'Date', 'Échéance', 'Fournisseur', 'Matricule fiscal', 'Total HT', ...rates.map(x => 'TVA ' + x + ' %'), 'Total TVA', 'Timbre', 'Total TTC'];
    csvDownload(`journal-achats-${month}.csv`, [head, ...r.journal_achats.map(v => { const c = rateCols(v.items); return [v.number, v.supplier_ref, v.issue_date, v.due_date, v.fournisseur, v.mf, v.total_ht, ...rates.map(x => c[x] || 0), v.total_tva, v.timbre, v.total_ttc]; })]);
  };
  document.getElementById('xd').onclick = () => csvDownload(`recap-tva-${month}.csv`, [['Rubrique', 'Taux', 'Base HT', 'TVA'],
    ...r.collectee.map(x => ['TVA collectée', x.rate + ' %', x.ht, x.tva]), ...r.deductible.map(x => ['TVA déductible', x.rate + ' %', x.ht, x.tva]),
    ['TVA à payer (ou crédit si négatif)', '', '', r.tva_a_payer], ['Droit de timbre collecté', '', '', r.timbre_ventes], ['Retenues à la source subies', '', '', r.rs_subies]]);
}

// ---------- paiements ----------
async function pagePayments() {
  loading('#/factures');
  const [rows, invs] = await Promise.all([api('GET', '/payments'), api('GET', '/invoices')]);
  const open = invs.filter(i => i.status !== 'payee');
  const month = S.me.today.slice(0, 7);
  const tm = rows.filter(p => p.paid_on.startsWith(month)).reduce((s, p) => s + p.amount, 0);
  shell('#/factures', `${salesTabs('#/paiements')}<div class="head"><h1>Encaissements</h1>${open.length ? '<button class="btn primary" id="new">Enregistrer un paiement</button>' : ''}</div>
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
  const [al, due] = await Promise.all([api('GET', '/alerts'), api('GET', '/reminders/due')]);
  S.alertsCount = al.overdue.length;
  const total = arr => arr.reduce((s, i) => s + i.balance, 0);
  const autoOn = due.email_ready && due.settings.auto_email && ['active', 'trial'].includes(S.me.subscription.state);
  shell('#/alertes', `<h1>Échéances</h1>
    <h2 style="margin-top:0">À relancer aujourd'hui${due.list.length ? ' · ' + due.list.length : ''}</h2>
    ${autoOn ? `<div class="banner info"><span>Les clients avec un e-mail sont relancés automatiquement.</span><button class="btn small" id="runrem">Envoyer maintenant</button></div>` : `<p class="sub" style="margin-top:-4px">${due.email_ready ? (S.me.subscription.state === 'free' ? 'Les relances automatiques par e-mail sont incluses dans Pro.' : 'Relances automatiques désactivées dans Compte.') : 'Touchez un bouton : le message est déjà rédigé et la relance est notée.'}</p>`}
    <div class="list" id="due">${due.list.length ? due.list.map(r => `<div class="item ${r.days_overdue > 0 ? 's-retard' : 's-soon'}" data-inv="${r.invoice_id}" data-step="${r.step}" data-n="${esc(r.number)}"><div class="main"><a class="t" href="#/factures/${r.invoice_id}" style="color:inherit;display:block">${esc(r.client_name)}</a><div class="m">${esc(r.number)} · ${esc(r.level_label)} · ${r.days_overdue > 0 ? 'en retard ' + relDays(r.days_overdue) : 'échéance ' + relDays(r.days_overdue)}</div>
      <div class="row-actions">${r.client_phone ? `<a class="btn small wa" data-rec="whatsapp" target="_blank" rel="noopener" href="https://wa.me/${phoneIntl(r.client_phone)}?text=${encodeURIComponent(r.body)}">WhatsApp</a><a class="btn small" data-rec="telephone" href="tel:${esc(r.client_phone)}">Appeler</a>` : ''}${r.client_email ? `<a class="btn small" data-rec="email" href="mailto:${esc(r.client_email)}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r.body)}">E-mail</a>` : ''}${!r.client_phone && !r.client_email ? `<a class="btn small" href="#/clients/${r.client_id}/modifier">Ajouter un contact</a>` : ''}</div></div>
      <div class="r">${amt(r.balance)}</div></div>`).join('') : '<div class="empty">Personne à relancer aujourd\'hui.</div>'}</div>
    <h2>En retard${al.overdue.length ? ` · ${amt(total(al.overdue))}` : ''}</h2>
    ${invoiceList(al.overdue, 'Aucune facture en retard.')}
    <h2>À échoir dans les 7 jours${al.upcoming.length ? ` · ${amt(total(al.upcoming))}` : ''}</h2>
    ${invoiceList(al.upcoming, 'Aucune échéance cette semaine.')}
    ${al.supplier_due.length ? `<h2>Fournisseurs à payer · ${amt(al.supplier_due.reduce((s, p) => s + p.balance, 0))}</h2>${purchaseList(al.supplier_due)}` : ''}
    ${al.low_stock.length ? `<h2>Stock bas</h2><div class="list">${al.low_stock.map(p => `<a class="item s-retard" href="#/stock"><div class="main"><div class="t">${esc(p.name)}</div><div class="m">alerte à ${Number(p.stock_alert || 0)}</div></div><div class="r"><b>${Number(p.stock)}</b> ${esc(p.unit || '')}</div></a>`).join('')}</div>` : ''}
    <p class="sub" style="margin-top:16px">Les paliers de relance se règlent dans Compte, Relances.</p>`);
  bindReminderRecord(document.getElementById('due'), a => { const it = a.closest('[data-inv]'); return { invoice_id: Number(it.dataset.inv), step: Number(it.dataset.step), message: 'Relance facture ' + it.dataset.n }; }, pageAlerts);
  const rr = document.getElementById('runrem');
  if (rr) rr.onclick = () => guard(rr, async () => { const r = await api('POST', '/reminders/run'); toast(r.sent ? `${r.sent} e-mail${r.sent > 1 ? 's' : ''} de relance envoyé${r.sent > 1 ? 's' : ''}` : 'Aucun e-mail à envoyer pour le moment'); pageAlerts(); });
}

// ---------- compte & paramètres ----------
async function pageSettings() {
  loading('#/parametres');
  S.me = await api('GET', '/me');
  const me = S.me, c = me.company, sub = me.subscription, owner = me.user.role === 'owner';
  if (c.is_platform) {
    shell('#/parametres', `<h1>Compte</h1>
      <div class="panel"><dl class="kv"><dt>Nom</dt><dd>${esc(me.user.name)}</dd><dt>E-mail</dt><dd>${esc(me.user.email)}</dd><dt>Rôle</dt><dd><b>Administrateur de la plateforme</b></dd></dl></div>
      <h2>Sécurité</h2>
      <form id="pwf" class="panel" novalidate><div class="grid2"><label>Mot de passe actuel<input name="current" type="password" autocomplete="current-password"></label><label>Nouveau mot de passe<input name="next" type="password" minlength="8" autocomplete="new-password"></label></div><button class="btn" type="submit">Changer le mot de passe</button></form>
      <h2>E-mails de relance</h2>
      <div class="panel"><p style="margin-top:0">${me.email_ready ? 'L\'envoi d\'e-mails est configuré.' : 'L\'envoi d\'e-mails n\'est pas encore configuré.'}</p><button class="btn" id="testmail" ${me.email_ready ? '' : 'disabled'}>Envoyer un e-mail de test à ${esc(me.user.email)}</button></div>
      <div class="row-actions" style="margin-top:20px"><button class="btn" id="logout">Se déconnecter</button></div>
      <p class="sign">Dafter · créé par Wassim Khalfalli</p>`);
    const tm = document.getElementById('testmail');
    tm.onclick = () => guard(tm, async () => { const r = await api('POST', '/admin/test-email'); toast('E-mail de test envoyé à ' + r.to + ' : vérifiez aussi les spams'); });
    const pwf = document.getElementById('pwf');
    pwf.onsubmit = e => { e.preventDefault(); guard(pwf.querySelector('button'), async () => { await api('PUT', '/me/password', formData(pwf)); pwf.reset(); toast('Mot de passe changé'); }); };
    document.getElementById('logout').onclick = async () => { await api('POST', '/auth/logout'); S.me = null; location.hash = '#/connexion'; };
    return;
  }
  const users = await api('GET', '/users');
  const stateText = { trial: `Essai Pro jusqu'au ${fdate(sub.ends)}`, active: `Actif jusqu'au ${fdate(sub.ends)}`, free: `${me.invoices_this_month} / ${sub.free_limit} factures utilisées ce mois`, suspended: 'Suspendu' }[sub.state];
  shell('#/parametres', `<h1>Compte</h1>
    ${me.user.is_superadmin ? '<div class="banner info"><span>Vous êtes <b>administrateur de la plateforme</b> : vous gérez les abonnements de toutes les entreprises inscrites.</span><a class="btn small primary" href="#/admin">Gérer les abonnés</a></div>' : ''}
    <h2 style="margin-top:0">Abonnement</h2>
    <div class="panel">
      <dl class="kv"><dt>Formule</dt><dd>${esc(sub.plan_label)}${sub.price ? ` · ${sub.price.toLocaleString('fr-FR')} DT par ${sub.period}` : ''}</dd><dt>État</dt><dd>${stateText}</dd></dl>
      <div class="plans" style="max-width:none;margin-top:14px">${Object.entries(me.plans).map(([k, p]) => `<div style="border-color:var(--line)${k === sub.plan ? ';outline:2px solid var(--door)' : ''}"><b>${p.label}${k === sub.plan ? ' · votre formule' : ''}</b><span class="p" style="font-size:20px">${p.price.toLocaleString('fr-FR')} DT</span> par ${p.period}<br><span class="sub">${k === 'annuel' ? `2 mois offerts, soit ${(p.price / 12).toFixed(2).replace('.', ',')} DT par mois` : 'sans engagement, factures illimitées'}</span></div>`).join('')}</div>
      ${me.payment.rib ? `<h2 style="margin-top:18px">Payer par virement ou versement</h2>
      <dl class="kv">${me.payment.holder ? `<dt>Titulaire</dt><dd>${esc(me.payment.holder)}</dd>` : ''}${me.payment.bank ? `<dt>Banque</dt><dd>${esc(me.payment.bank)}</dd>` : ''}<dt>RIB</dt><dd class="num" style="font-weight:500;word-break:break-all">${esc(me.payment.rib)}</dd>
        <dt>Motif</dt><dd>Dafter ${esc(c.name)}</dd><dt>Montant</dt><dd>40 DT (1 mois) ou 400 DT (1 an)</dd></dl>
      <div class="row-actions"><button class="btn small" id="copyrib">Copier le RIB</button></div>
      <p style="margin-bottom:0" class="sub">À la réception du paiement, l'abonnement sera activé.${me.payment.contact ? ` Pour accélérer, envoyez le reçu à <b>${esc(me.payment.contact)}</b>.` : ''}</p>` : `<p style="margin-bottom:0">${me.payment_info ? esc(me.payment_info) : 'Paiement par virement ou versement. À la réception du paiement, l\'abonnement sera activé.'}</p>`}
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
    <h2>Relances</h2>
    <form id="remf" class="panel" novalidate>
      <label>Paliers de relance (jours par rapport à l'échéance)<input name="steps" value="${esc((c.reminder_settings?.steps || [-3, 7, 15, 30]).join(', '))}" ${owner ? '' : 'disabled'}><span class="sub">Un nombre négatif relance avant l'échéance. Par défaut : -3 (rappel), 7 (amicale), 15 (ferme), 30 (dernier rappel avant mise en demeure).</span></label>
      <label class="check"><input type="checkbox" name="auto_email" ${c.reminder_settings?.auto_email !== false ? 'checked' : ''} ${owner ? '' : 'disabled'}> Envoyer automatiquement les relances par e-mail (Pro)</label>
      <p class="sub">${me.email_ready ? 'Envoi d\'e-mails actif. Les réponses de vos clients arrivent à l\'e-mail de votre entreprise' + (c.email ? ' (' + esc(c.email) + ')' : ' : renseignez-le ci-dessus') + '.' : 'L\'envoi automatique d\'e-mails sera bientôt activé sur Dafter. En attendant, relancez en un geste depuis Échéances.'}</p>
      ${owner ? '<button class="btn primary" type="submit">Enregistrer les relances</button>' : ''}
    </form>
    <h2>Équipe</h2>
    <div class="list">${users.map(u => `<div class="item"><div class="main"><div class="t">${esc(u.name)}${u.id === me.user.id ? ' (vous)' : ''}</div><div class="m">${esc(u.email)} · ${u.role === 'owner' ? 'responsable' : 'membre'}${u.id === me.user.id && me.user.is_superadmin ? ' · <b>administrateur de la plateforme</b>' : ''}</div></div>${owner && u.role !== 'owner' ? `<div class="r"><button class="btn small danger" data-deluser="${u.id}">Retirer</button></div>` : ''}</div>`).join('')}</div>
    ${owner ? '<div class="row-actions"><button class="btn" id="adduser">Ajouter un utilisateur</button></div>' : ''}
    <h2>Sécurité</h2>
    <form id="pwf" class="panel" novalidate><div class="grid2"><label>Mot de passe actuel<input name="current" type="password" autocomplete="current-password"></label><label>Nouveau mot de passe<input name="next" type="password" minlength="8" autocomplete="new-password"></label></div><button class="btn" type="submit">Changer le mot de passe</button></form>
    <div class="row-actions" style="margin-top:20px">${me.user.is_superadmin ? '<a class="btn" href="#/admin">Gérer les abonnés</a>' : ''}<button class="btn" id="logout">Se déconnecter</button></div>
    ${owner ? `<h2>Fermer le compte</h2><div class="panel"><p style="margin-top:0">Supprime définitivement votre entreprise, ses utilisateurs, clients, factures et paiements.</p><button class="btn danger" id="delco">Supprimer mon compte</button></div>` : ''}
    <p class="sign">Dafter · créé par Wassim Khalfalli</p>`);
  const cof = document.getElementById('cof');
  cof.onsubmit = e => { e.preventDefault(); guard(cof.querySelector('button'), async () => { await api('PUT', '/company', formData(cof)); S.me = await api('GET', '/me'); toast('Informations enregistrées'); document.querySelector('.topbar .co').textContent = S.me.company.name; }); };
  const cr = document.getElementById('copyrib');
  if (cr) cr.onclick = async () => { try { await navigator.clipboard.writeText(me.payment.rib); toast('RIB copié'); } catch (_) { toast(me.payment.rib); } };
  const remf = document.getElementById('remf');
  remf.onsubmit = e => { e.preventDefault(); guard(remf.querySelector('[type=submit]'), async () => { await api('PUT', '/company/reminders', formData(remf)); S.me = await api('GET', '/me'); toast('Relances enregistrées'); }); };
  const pwf = document.getElementById('pwf');
  pwf.onsubmit = e => { e.preventDefault(); guard(pwf.querySelector('button'), async () => { await api('PUT', '/me/password', formData(pwf)); pwf.reset(); toast('Mot de passe changé'); }); };
  document.getElementById('logout').onclick = async () => { await api('POST', '/auth/logout'); S.me = null; location.hash = '#/connexion'; };
  const dc = document.getElementById('delco');
  if (dc) dc.onclick = () => modal(`<h2>Supprimer votre compte ?</h2><p>Votre entreprise ${esc(c.name)}, ses utilisateurs, clients, factures et paiements seront effacés définitivement.</p>
    <form novalidate><label>Pour confirmer, tapez le nom de l'entreprise : <b>${esc(c.name)}</b><input name="confirm_name" autocomplete="off"></label>
    <div class="row-actions"><button class="btn danger" type="submit">Supprimer définitivement</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
      await api('DELETE', '/company', { confirm_name: f.elements.confirm_name.value });
      close(); S.me = null; toast('Compte supprimé'); location.hash = '#/inscription';
    }); };
  });
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
  const mrr = rows.filter(r => r.sub.state === 'active').reduce((s, r) => s + ((S.me.plans[r.plan]?.price || 0) / (S.me.plans[r.plan]?.months || 1)), 0);
  const label = { trial: 'essai', active: 'Pro', free: 'gratuit', suspended: 'suspendu' };
  const cls = { trial: 'attente', active: 'payee', free: 'partielle', suspended: 'retard' };
  shell('#/admin', `<div class="head"><h1>Abonnés</h1><button class="btn primary" id="newco">Inscrire une entreprise</button></div>
    <div class="ledger"><div><div class="k">Entreprises</div><div class="v">${rows.length}</div></div><div><div class="k">Abonnés actifs</div><div class="v">${rows.filter(r => r.sub.state === 'active').length}</div></div>
      <div><div class="k">En essai / gratuits</div><div class="v">${rows.filter(r => r.sub.state === 'trial').length} / ${rows.filter(r => r.sub.state === 'free').length}</div></div><div><div class="k">Revenu mensuel moyen</div><div class="v">${amt(mrr, false)}</div></div></div>
    <h2>Entreprises inscrites</h2>
    <div class="list">${rows.map(r => `<div class="item"><div class="main"><div class="t">${esc(r.name)} <span class="tag ${cls[r.sub.state]}">${label[r.sub.state]}</span></div>
      <div class="m">${esc(r.email || '')}${r.phone ? ' · ' + esc(r.phone) : ''} · ${r.sub.plan_label}${r.sub.state === 'free' ? '' : ` · jusqu'au ${fdate(r.sub.ends)}`}</div>
      <div class="m">${r.users} util. · ${r.clients} clients · ${r.invoices} factures · inscrit le ${fdate(r.created_at)}</div>
      <div class="row-actions">
        <button class="btn small primary" data-a="add_months" data-v="1" data-id="${r.id}">40 DT reçus : +1 mois</button>
        <button class="btn small primary" data-a="add_months" data-v="12" data-id="${r.id}" data-plan="annuel">400 DT reçus : +12 mois</button>
        <button class="btn small" data-a="extend_trial" data-v="14" data-id="${r.id}">Essai +14 j</button>
        <button class="btn small" data-a="plan" data-v="${r.plan === 'annuel' ? 'mensuel' : 'annuel'}" data-id="${r.id}">Passer en ${r.plan === 'annuel' ? 'Mensuel' : 'Annuel'}</button>
        <button class="btn small" data-users="${r.id}" data-name="${esc(r.name)}">Utilisateurs</button>
        ${r.id !== S.me.company.id ? `<button class="btn small danger" data-delco="${r.id}" data-name="${esc(r.name)}">Supprimer</button>` : ''}
        <button class="btn small danger" data-a="status" data-v="${r.status === 'suspended' ? 'active' : 'suspended'}" data-id="${r.id}">${r.status === 'suspended' ? 'Réactiver' : 'Suspendre'}</button>
      </div></div></div>`).join('') || '<div class="empty">Aucune entreprise inscrite pour le moment.</div>'}</div>`);
  document.getElementById('newco').onclick = () => modal(`<h2>Inscrire une entreprise</h2><p class="sub">Vous créez le compte puis transmettez l'e-mail et le mot de passe au responsable : il pourra le changer.</p>
    <form novalidate><label>Nom de l'entreprise<input name="companyName" required></label>
    <div class="grid2"><label>Nom du responsable<input name="name" required></label><label>Téléphone<input name="phone" type="tel"></label>
    <label>E-mail de connexion<input name="email" type="email" required></label><label>Mot de passe provisoire<input name="password" type="text" minlength="8" required></label></div>
    <label>Abonnement<select name="offer"><option value="trial">Essai Pro de 14 jours</option><option value="m1">Pro mensuel déjà payé (40 DT, 1 mois)</option><option value="a12">Pro annuel déjà payé (400 DT, 12 mois)</option></select></label>
    <div class="row-actions"><button class="btn primary" type="submit">Créer le compte</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
      const d = formData(f);
      await api('POST', '/admin/companies', { ...d, plan: d.offer === 'a12' ? 'annuel' : 'mensuel', months: d.offer === 'a12' ? 12 : d.offer === 'm1' ? 1 : 0 });
      close(); toast('Entreprise inscrite'); pageAdmin();
    }); };
  });
  document.querySelectorAll('[data-users]').forEach(b => b.onclick = () => guard(b, async () => {
    const users = await api('GET', `/admin/companies/${b.dataset.users}/users`);
    modal(`<h2>Utilisateurs · ${esc(b.dataset.name)}</h2><div class="list">${users.map(u => `<div class="item"><div class="main"><div class="t">${esc(u.name)}</div><div class="m">${esc(u.email)} · ${u.role === 'owner' ? 'responsable' : 'membre'} · ${u.last_login ? 'connecté le ' + fdate(u.last_login) : 'jamais connecté'}</div></div><div class="r"><button class="btn small" data-pw="${u.id}" data-n="${esc(u.name)}">Nouveau mot de passe</button></div></div>`).join('')}</div>
      <div class="row-actions" style="margin-top:12px"><button class="btn" data-close>Fermer</button></div>`, (m, close) => {
      m.querySelectorAll('[data-pw]').forEach(x => x.onclick = () => { close(); passwordModal(x.dataset.pw, x.dataset.n); });
    });
  }));
  document.querySelectorAll('[data-delco]').forEach(b => b.onclick = () => {
    const name = b.dataset.name;
    modal(`<h2>Supprimer ${esc(name)} ?</h2><p>L'entreprise, ses utilisateurs, clients, factures et paiements seront effacés définitivement. Ses utilisateurs ne pourront plus se connecter.</p>
      <form novalidate><label>Pour confirmer, tapez le nom de l'entreprise : <b>${esc(name)}</b><input name="confirm_name" autocomplete="off"></label>
      <div class="row-actions"><button class="btn danger" type="submit">Supprimer définitivement</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
      const f = m.querySelector('form');
      f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => {
        await api('DELETE', '/admin/companies/' + b.dataset.delco, { confirm_name: f.elements.confirm_name.value });
        close(); toast('Entreprise supprimée'); pageAdmin();
      }); };
    });
  });
  document.querySelectorAll('[data-a]').forEach(b => b.onclick = () => guard(b, async () => {
    await api('POST', '/admin/companies/' + b.dataset.id, { [b.dataset.a]: b.dataset.v, ...(b.dataset.plan ? { plan: b.dataset.plan } : b.dataset.a === 'add_months' ? { plan: 'mensuel' } : {}) }); toast('Abonnement mis à jour'); pageAdmin();
  }));
}


function passwordModal(uid, name) {
  modal(`<h2>Nouveau mot de passe pour ${esc(name)}</h2><p class="sub">Transmettez-le à la personne : elle pourra le changer dans Compte.</p>
    <form novalidate><label>Mot de passe (8 caractères minimum)<input name="password" type="text" minlength="8" autocomplete="off"></label>
    <div class="row-actions"><button class="btn primary" type="submit">Enregistrer le mot de passe</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { await api('POST', `/admin/users/${uid}/password`, formData(f)); close(); toast('Mot de passe enregistré'); }); };
  });
}

async function pageAccess() {
  if (!S.me.user.is_superadmin) { location.hash = '#/'; return; }
  loading('#/admin/acces');
  const admins = await api('GET', '/admin/admins');
  shell('#/admin/acces', `<div class="head"><h1>Accès</h1><button class="btn primary" id="newadm">Ajouter un administrateur</button></div>
    <p class="sub" style="margin-top:-6px">Les administrateurs gèrent les abonnements et les accès de toutes les entreprises. Pour les utilisateurs d'une entreprise, ouvrez Abonnés puis « Utilisateurs ».</p>
    <div class="list">${admins.map(a => `<div class="item"><div class="main"><div class="t">${esc(a.name)}${a.id === S.me.user.id ? ' (vous)' : ''}</div><div class="m">${esc(a.email)} · ${a.protected ? 'administrateur principal' : a.is_platform ? 'administrateur' : 'administrateur, aussi dans ' + esc(a.company_name)} · ${a.last_login ? 'connecté le ' + fdate(a.last_login) : 'jamais connecté'}</div></div>
      <div class="r">${a.id !== S.me.user.id ? `<button class="btn small" data-pw="${a.id}" data-n="${esc(a.name)}">Mot de passe</button>` : ''}${a.id !== S.me.user.id && !a.protected ? ` <button class="btn small danger" data-rm="${a.id}" data-n="${esc(a.name)}">Retirer</button>` : ''}</div></div>`).join('')}</div>`);
  document.getElementById('newadm').onclick = () => modal(`<h2>Ajouter un administrateur</h2>
    <form novalidate><label>Nom<input name="name" required></label><label>E-mail<input name="email" type="email" required></label>
    <label>Mot de passe provisoire<input name="password" type="text" minlength="8" autocomplete="off"><span class="sub">Laissez vide si la personne a déjà un compte Dafter : elle recevra simplement les droits.</span></label>
    <div class="row-actions"><button class="btn primary" type="submit">Ajouter l'administrateur</button><button type="button" class="btn" data-close>Annuler</button></div></form>`, (m, close) => {
    const f = m.querySelector('form');
    f.onsubmit = e => { e.preventDefault(); guard(f.querySelector('[type=submit]'), async () => { const d = formData(f); if (!d.password) delete d.password; await api('POST', '/admin/admins', d); close(); toast('Administrateur ajouté'); pageAccess(); }); };
  });
  document.querySelectorAll('[data-pw]').forEach(b => b.onclick = () => passwordModal(b.dataset.pw, b.dataset.n));
  document.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmBox(`Retirer les droits d'administrateur de ${b.dataset.n} ?`, 'Retirer')) return;
    guard(b, async () => { await api('DELETE', '/admin/admins/' + b.dataset.rm); toast('Administrateur retiré'); pageAccess(); });
  });
}

// ---------- routeur ----------
async function router() {
  const h = (location.hash || '#/').split('?')[0];
  try {
    if (!S.me) { try { S.me = await api('GET', '/me'); } catch (_) { S.me = null; } }
    if (!S.me) return authPage(h === '#/inscription' ? 'register' : 'login');
    if (h === '#/connexion' || h === '#/inscription') { location.hash = '#/'; return; }
    let m;
    if (S.me.company.is_platform && !['#/admin', '#/admin/acces', '#/parametres'].includes(h)) { location.hash = '#/admin'; return; }
    if (h === '#/admin/acces') return await pageAccess();
    if (h === '#/' || h === '#') return await pageDashboard();
    if (h === '#/clients') return await pageClients();
    if (h === '#/clients/nouveau') return await pageClientEdit();
    if ((m = h.match(/^#\/clients\/(\d+)\/modifier$/))) return await pageClientEdit(m[1]);
    if ((m = h.match(/^#\/clients\/(\d+)$/))) return await pageClient(m[1]);
    if (h === '#/factures') return await pageInvoices();
    if (h === '#/factures/nouvelle') return await pageInvoiceEdit();
    if ((m = h.match(/^#\/factures\/(\d+)\/modifier$/))) return await pageInvoiceEdit(m[1]);
    if ((m = h.match(/^#\/factures\/(\d+)$/))) return await pageInvoice(m[1]);
    if ((m = h.match(/^#\/docs\/(devis|commande|livraison|avoir)$/))) return await pageDocs(m[1]);
    if ((m = h.match(/^#\/docs\/(devis|commande|livraison|avoir)\/nouveau$/))) return await pageDocEdit(m[1]);
    if ((m = h.match(/^#\/doc\/(\d+)\/modifier$/))) return await pageDocEdit(null, m[1]);
    if ((m = h.match(/^#\/doc\/(\d+)$/))) return await pageDoc(m[1]);
    if (h === '#/articles') return await pageProducts();
    if (h === '#/rapports') return await pageReports();
    if (h === '#/achats') return await pageSuppliers();
    if ((m = h.match(/^#\/fournisseurs\/(\d+)$/))) return await pageSupplier(m[1]);
    if ((m = h.match(/^#\/achats\/(commande|reception|facture)$/))) return await pagePurchases(m[1]);
    if ((m = h.match(/^#\/achats\/(commande|reception|facture)\/nouveau$/))) return await pagePurchaseEdit(m[1]);
    if ((m = h.match(/^#\/achat\/(\d+)\/modifier$/))) return await pagePurchaseEdit(null, m[1]);
    if ((m = h.match(/^#\/achat\/(\d+)$/))) return await pagePurchase(m[1]);
    if (h === '#/stock') return await pageStock();
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
