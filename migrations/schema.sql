-- Schéma de la base de données PostgreSQL pour l'application de gestion de stock

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Ancienne version de l'app : chaque compte est maintenant indépendant, il n'y a
-- plus de notion d'administrateur ou d'employé.
ALTER TABLE users DROP COLUMN IF EXISTS role;

-- Statut Premium (activé manuellement en base pour l'instant, pas de paiement réel) :
--   UPDATE users SET is_premium = true WHERE email = 'compte@exemple.com';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN NOT NULL DEFAULT false;

-- Profil entreprise, utilisé pour personnaliser l'en-tête des factures/devis/bons de livraison
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_name VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_phone VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_address TEXT;

CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Ancienne version de l'app : ajoute le propriétaire et rend le nom unique par
-- compte (et non plus globalement, chaque compte étant indépendant).
ALTER TABLE categories ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_user_name_unique') THEN
    ALTER TABLE categories ADD CONSTRAINT categories_user_name_unique UNIQUE (user_id, name);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    contact_name VARCHAR(150),
    email VARCHAR(150),
    phone VARCHAR(50),
    address TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    sku VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'unité',
    price NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 0,
    min_threshold INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS stock_movements (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL CHECK (type IN ('IN', 'OUT')),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    reason VARCHAR(255),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    invoice_number VARCHAR(50) UNIQUE NOT NULL,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(200) NOT NULL,
    customer_contact VARCHAR(150),
    status VARCHAR(20) NOT NULL DEFAULT 'unpaid', -- 'unpaid', 'paid', 'cancelled'
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    product_name VARCHAR(200) NOT NULL, -- copie du nom au moment de la facture
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL,
    cost_price NUMERIC(12,2) NOT NULL DEFAULT 0, -- copie du prix d'achat au moment de la vente (pour calculer la marge réelle)
    subtotal NUMERIC(14,2) NOT NULL
);

ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Permet de retrouver quelle facture a déclenché quel mouvement de stock
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL;

-- La fonctionnalité "devis" a été retirée : les tables associées sont supprimées
-- si elles existaient (installations mises à jour depuis une version antérieure).
DROP TABLE IF EXISTS quote_items;
DROP TABLE IF EXISTS quotes;

-- Dépenses de l'entreprise (feature Premium) : permet de calculer un bénéfice
-- réel net (marge - dépenses), pas seulement une marge brute.
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    label VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    amount NUMERIC(14,2) NOT NULL,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Dettes clients : une facture peut être payée en plusieurs fois. amount_paid +
-- invoice_payments permettent de calculer le solde dû, affiché sur la fiche client.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Facturation consolidée : quand un client a déjà une dette au moment d'une nouvelle
-- facture, cette dette est ajoutée au montant des nouveaux achats pour former le
-- total_amount de la nouvelle facture. previous_debt garde une trace du montant
-- ainsi reporté, pour pouvoir l'afficher séparément (achats vs dette) sur le PDF.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS previous_debt NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS invoice_payments (
    id SERIAL PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    amount NUMERIC(14,2) NOT NULL,
    payment_date TIMESTAMP NOT NULL DEFAULT NOW(),
    note VARCHAR(255),
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Paiements d'abonnement Premium via CinetPay (Orange Money / MTN Mobile Money).
-- Le statut n'est jamais activé depuis les données du webhook seules : il est
-- toujours reconfirmé via l'API de vérification CinetPay (voir routes/payments.js).
CREATE TABLE IF NOT EXISTS subscription_payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    transaction_id VARCHAR(100) UNIQUE NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'XAF',
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'accepted', 'refused'
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_user ON suppliers(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice ON invoice_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user ON subscription_payments(user_id);

-- Un compte de démonstration peut être créé via backend/db/seed.js (npm run seed)