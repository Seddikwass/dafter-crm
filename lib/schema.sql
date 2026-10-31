CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  matricule_fiscal TEXT,
  address TEXT,
  city TEXT,
  phone TEXT,
  email TEXT,
  invoice_prefix TEXT NOT NULL DEFAULT 'F',
  invoice_seq INT NOT NULL DEFAULT 0,
  invoice_seq_year INT NOT NULL DEFAULT 0,
  default_due_days INT NOT NULL DEFAULT 30,
  invoice_footer TEXT,
  plan TEXT NOT NULL DEFAULT 'essentiel',
  status TEXT NOT NULL DEFAULT 'trial',
  trial_ends DATE NOT NULL,
  paid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_superadmin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  matricule_fiscal TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clients_company ON clients(company_id);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  total_ht NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(14,3) NOT NULL DEFAULT 0,
  timbre NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(14,3) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);
CREATE INDEX IF NOT EXISTS invoices_company ON invoices(company_id, due_date);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  method TEXT NOT NULL DEFAULT 'virement',
  reference TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS payments_company ON payments(company_id, paid_on);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS doc_seq JSONB NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_platform BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  unit_price NUMERIC(14,3) NOT NULL DEFAULT 0,
  tva INT NOT NULL DEFAULT 19,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_company ON products(company_id);

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id INT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  issue_date DATE NOT NULL,
  valid_until DATE,
  items JSONB NOT NULL DEFAULT '[]',
  total_ht NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(14,3) NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'emis',
  invoice_id INT REFERENCES invoices(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, type, number)
);
CREATE INDEX IF NOT EXISTS documents_company ON documents(company_id, type, issue_date);

ALTER TABLE products ADD COLUMN IF NOT EXISTS track_stock BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_alert NUMERIC(14,3);
ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,3);

CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_moves (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  qty NUMERIC(14,3) NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manuel',
  source_id INT,
  ref TEXT,
  moved_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_product ON stock_moves(product_id, warehouse_id);
CREATE INDEX IF NOT EXISTS stock_moves_source ON stock_moves(company_id, source, source_id);

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  matricule_fiscal TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suppliers_company ON suppliers(company_id);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id INT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  supplier_ref TEXT,
  issue_date DATE NOT NULL,
  due_date DATE,
  items JSONB NOT NULL DEFAULT '[]',
  total_ht NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_tva NUMERIC(14,3) NOT NULL DEFAULT 0,
  timbre NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_ttc NUMERIC(14,3) NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'emis',
  linked_id INT REFERENCES purchases(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, type, number)
);
CREATE INDEX IF NOT EXISTS purchases_company ON purchases(company_id, type, issue_date);

CREATE TABLE IF NOT EXISTS purchase_payments (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  amount NUMERIC(14,3) NOT NULL CHECK (amount > 0),
  paid_on DATE NOT NULL,
  method TEXT NOT NULL DEFAULT 'virement',
  reference TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_payments_purchase ON purchase_payments(purchase_id);
