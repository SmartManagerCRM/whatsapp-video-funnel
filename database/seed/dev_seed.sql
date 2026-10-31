-- Development seed: a tenant with settings but NO user and no credentials (no default passwords are shipped).
-- Easiest dev path: create the owner + tenant through the Owner portal (docs/INSTALLATION.md); this seed is for DB-level experiments only.
INSERT OR IGNORE INTO tenants (id, slug, business_name, status, created_at, updated_at)
VALUES ('tnt_dev', 'dev-client', 'Dev Client Co.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO tenant_settings (tenant_id, business_name, updated_at)
VALUES ('tnt_dev', 'Dev Client Co.', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
