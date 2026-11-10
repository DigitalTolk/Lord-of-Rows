DROP SCHEMA IF EXISTS shop CASCADE;
CREATE SCHEMA shop;
SET search_path = shop;
CREATE TYPE order_status AS ENUM ('pending','paid','shipped','refunded');
CREATE TABLE customers (id bigserial PRIMARY KEY, name text NOT NULL, email text UNIQUE, country char(2), vip boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE products (id serial PRIMARY KEY, sku text UNIQUE NOT NULL, title text NOT NULL, price numeric(12,2) NOT NULL CHECK (price >= 0), tags text[], attributes jsonb);
CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE, status order_status NOT NULL DEFAULT 'pending', total numeric(12,2) NOT NULL, placed_at timestamptz NOT NULL DEFAULT now(), notes text);
CREATE TABLE order_items (order_id bigint REFERENCES orders(id) ON DELETE CASCADE, product_id int REFERENCES products(id), qty int NOT NULL CHECK (qty > 0), unit_price numeric(12,2) NOT NULL, PRIMARY KEY (order_id, product_id));
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_status_idx ON orders(status) WHERE status <> 'refunded';
INSERT INTO customers (name,email,country,vip,created_at)
SELECT 'Customer ' || g, 'user' || g || '@example.com', (ARRAY['US','GB','DE','PK','SE','JP','BR'])[1 + g % 7], g % 11 = 0, now() - (g || ' hours')::interval FROM generate_series(1,500) g;
INSERT INTO products (sku,title,price,tags,attributes)
SELECT 'SKU-' || lpad(g::text,4,'0'), (ARRAY['Desk','Chair','Lamp','Monitor','Keyboard','Mouse','Cable','Dock'])[1 + g % 8] || ' ' || g, round((5 + random()*500)::numeric,2), ARRAY['office', CASE WHEN g%2=0 THEN 'sale' ELSE 'new' END], jsonb_build_object('color', (ARRAY['black','white','oak'])[1+g%3], 'weight_kg', g%9+1) FROM generate_series(1,120) g;
INSERT INTO orders (customer_id,status,total,placed_at,notes)
SELECT 1 + (g*7) % 500, (ARRAY['pending','paid','shipped','refunded']::order_status[])[1 + g % 4], round((10 + random()*900)::numeric,2), now() - (g || ' minutes')::interval, CASE WHEN g%13=0 THEN 'gift wrap' END FROM generate_series(1,5000) g;
INSERT INTO order_items SELECT o.id, 1 + (o.id*3) % 120, 1 + o.id % 4, 19.99 FROM orders o;
CREATE VIEW revenue_by_country AS SELECT c.country, count(*) AS orders, sum(o.total) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status <> 'refunded' GROUP BY 1 ORDER BY 3 DESC;
CREATE FUNCTION customer_lifetime_value(cid bigint) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(total),0) FROM shop.orders WHERE customer_id = cid AND status <> 'refunded' $$;
ANALYZE;
