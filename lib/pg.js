// Client PostgreSQL minimal sans dépendance (protocole v3, SCRAM-SHA-256, MD5, TLS optionnel).
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const TYPE_PARSERS = {
  16: v => v === 't',
  20: v => Number(v), 21: v => Number(v), 23: v => Number(v),
  700: v => Number(v), 701: v => Number(v), 1700: v => Number(v),
  114: v => JSON.parse(v), 3802: v => JSON.parse(v),
};

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Erreur PostgreSQL');
    this.code = fields.C; this.detail = fields.D; this.constraint = fields.n;
  }
}

function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
    ssl: ['require', 'verify-full', 'verify-ca', 'prefer'].includes(u.searchParams.get('sslmode')) ||
      /\.render\.com$/.test(u.hostname),
  };
}

class Connection {
  constructor(cfg) { this.cfg = cfg; this.buf = Buffer.alloc(0); this.waiters = []; this.msgs = []; }

  async connect() {
    const c = this.cfg;
    let sock = net.connect(c.port, c.host);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (c.ssl) {
      const req = Buffer.alloc(8); req.writeInt32BE(8, 0); req.writeInt32BE(80877103, 4);
      sock.write(req);
      const answer = await new Promise((res, rej) => { sock.once('data', d => res(d)); sock.once('error', rej); });
      if (answer[0] !== 0x53) throw new Error('Le serveur refuse SSL');
      sock = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: false });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    }
    this.sock = sock;
    sock.on('data', d => this._onData(d));
    sock.on('error', e => this._fail(e));
    sock.on('close', () => this._fail(new Error('Connexion PostgreSQL fermée')));

    const params = Buffer.from(`user\0${c.user}\0database\0${c.database}\0client_encoding\0UTF8\0timezone\0Africa/Tunis\0datestyle\0ISO\0\0`);
    const start = Buffer.alloc(8); start.writeInt32BE(8 + params.length, 0); start.writeInt32BE(196608, 4);
    sock.write(Buffer.concat([start, params]));
    await this._auth();
  }

  _fail(e) { this.dead = true; this.error = e; const w = this.waiters; this.waiters = []; w.forEach(f => f()); }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      this.msgs.push({ type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) });
      this.buf = this.buf.subarray(len + 1);
    }
    const w = this.waiters; this.waiters = []; w.forEach(f => f());
  }

  async _next() {
    while (!this.msgs.length) {
      if (this.dead) throw this.error;
      await new Promise(r => this.waiters.push(r));
    }
    return this.msgs.shift();
  }

  _send(type, body) {
    const h = Buffer.alloc(5); h[0] = type.charCodeAt(0); h.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([h, body]);
  }

  async _auth() {
    let nonce, clientFirstBare, serverSig;
    for (;;) {
      const m = await this._next();
      if (m.type === 'E') throw new PgError(parseFields(m.body));
      if (m.type === 'Z') return;
      if (m.type !== 'R') continue;
      const code = m.body.readInt32BE(0);
      if (code === 0) continue;
      if (code === 3) {
        this.sock.write(this._send('p', Buffer.from(this.cfg.password + '\0')));
      } else if (code === 5) {
        const salt = m.body.subarray(4, 8);
        const inner = md5(this.cfg.password + this.cfg.user);
        const outer = 'md5' + md5(Buffer.concat([Buffer.from(inner), salt]));
        this.sock.write(this._send('p', Buffer.from(outer + '\0')));
      } else if (code === 10) {
        nonce = crypto.randomBytes(18).toString('base64');
        clientFirstBare = `n=*,r=${nonce}`;
        const first = Buffer.from('n,,' + clientFirstBare);
        const mech = Buffer.from('SCRAM-SHA-256\0');
        const len = Buffer.alloc(4); len.writeInt32BE(first.length, 0);
        this.sock.write(this._send('p', Buffer.concat([mech, len, first])));
      } else if (code === 11) {
        const serverFirst = m.body.subarray(4).toString();
        const a = Object.fromEntries(serverFirst.split(',').map(p => [p[0], p.slice(2)]));
        if (!a.r.startsWith(nonce)) throw new Error('Nonce SCRAM invalide');
        const salted = crypto.pbkdf2Sync(this.cfg.password, Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
        const finalNoProof = `c=biws,r=${a.r}`;
        const authMsg = `${clientFirstBare},${serverFirst},${finalNoProof}`;
        const sig = hmac(storedKey, authMsg);
        const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
        serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
        this.sock.write(this._send('p', Buffer.from(`${finalNoProof},p=${proof.toString('base64')}`)));
      } else if (code === 12) {
        const v = m.body.subarray(4).toString().match(/v=([^,]+)/);
        if (!v || v[1] !== serverSig) throw new Error('Signature serveur SCRAM invalide');
      } else {
        throw new Error('Méthode d\'authentification PostgreSQL non gérée : ' + code);
      }
    }
  }

  async query(text, values = []) {
    const parts = [];
    parts.push(this._send('P', Buffer.concat([Buffer.from('\0' + text + '\0'), Buffer.from([0, 0])])));
    const bind = [Buffer.from('\0\0'), int16(0), int16(values.length)];
    for (let v of values) {
      if (v === null || v === undefined) { bind.push(int32(-1)); continue; }
      if (v instanceof Date) v = v.toISOString();
      else if (typeof v === 'object') v = JSON.stringify(v);
      else if (typeof v === 'boolean') v = v ? 't' : 'f';
      const b = Buffer.from(String(v)); bind.push(int32(b.length), b);
    }
    bind.push(int16(0));
    parts.push(this._send('B', Buffer.concat(bind)));
    parts.push(this._send('D', Buffer.from('P\0')));
    parts.push(this._send('E', Buffer.concat([Buffer.from('\0'), int32(0)])));
    parts.push(this._send('S', Buffer.alloc(0)));
    this.sock.write(Buffer.concat(parts));

    let fields = [], rows = [], rowCount = 0, err = null;
    for (;;) {
      const m = await this._next();
      if (m.type === 'T') fields = parseRowDesc(m.body);
      else if (m.type === 'D') rows.push(parseRow(m.body, fields));
      else if (m.type === 'C') { const t = m.body.toString().replace(/\0$/, '').split(' '); rowCount = Number(t[t.length - 1]) || 0; }
      else if (m.type === 'E') err = new PgError(parseFields(m.body));
      else if (m.type === 'Z') break;
    }
    if (err) throw err;
    return { rows, rowCount };
  }

  close() { try { this.sock.write(this._send('X', Buffer.alloc(0))); this.sock.end(); } catch (_) {} }
}

function md5(x) { return crypto.createHash('md5').update(x).digest('hex'); }
function hmac(k, s) { return crypto.createHmac('sha256', k).update(s).digest(); }
function int16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }
function parseFields(body) {
  const f = {}; let i = 0;
  while (i < body.length && body[i] !== 0) { const t = String.fromCharCode(body[i]); const e = body.indexOf(0, i + 1); f[t] = body.toString('utf8', i + 1, e); i = e + 1; }
  return f;
}
function parseRowDesc(body) {
  const n = body.readInt16BE(0); let i = 2; const out = [];
  for (let k = 0; k < n; k++) { const e = body.indexOf(0, i); const name = body.toString('utf8', i, e); i = e + 1; const oid = body.readInt32BE(i + 6); i += 18; out.push({ name, oid }); }
  return out;
}
function parseRow(body, fields) {
  const n = body.readInt16BE(0); let i = 2; const row = {};
  for (let k = 0; k < n; k++) {
    const len = body.readInt32BE(i); i += 4;
    if (len === -1) { row[fields[k].name] = null; continue; }
    const s = body.toString('utf8', i, i + len); i += len;
    const p = TYPE_PARSERS[fields[k].oid];
    row[fields[k].name] = p ? p(s) : s;
  }
  return row;
}

class Pool {
  constructor(url, size = 5) { this.cfg = parseUrl(url); this.size = size; this.idle = []; this.count = 0; this.queue = []; }
  async _acquire() {
    while (this.idle.length) { const c = this.idle.pop(); if (!c.dead) return c; this.count--; }
    if (this.count < this.size) {
      this.count++;
      const c = new Connection(this.cfg);
      try { await c.connect(); return c; } catch (e) { this.count--; throw e; }
    }
    return new Promise(r => this.queue.push(r));
  }
  _release(c) {
    if (c.dead) { this.count--; if (this.queue.length) this._acquire().then(this.queue.shift()); return; }
    const w = this.queue.shift(); if (w) w(c); else this.idle.push(c);
  }
  async query(text, values) {
    const c = await this._acquire();
    try { return await c.query(text, values); } finally { this._release(c); }
  }
  async tx(fn) {
    const c = await this._acquire();
    try {
      await c.query('BEGIN');
      const r = await fn({ query: (t, v) => c.query(t, v) });
      await c.query('COMMIT'); return r;
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { this._release(c); }
  }
}

module.exports = { Pool, PgError };
