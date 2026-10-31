-- Development seed. Login: admin@dev.local / the password you set with scripts/create-user (see docs/INSTALLATION.md).
-- The tenant is created without credentials on purpose; no default passwords are shipped.
INSERT OR IGNORE INTO tenants (id, slug, business_name, status, created_at, updated_at)
VALUES ('tnt_dev', 'dev-client', 'Dev Client Co.', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT OR IGNORE INTO tenant_settings (tenant_id, business_name, updated_at)
VALUES ('tnt_dev', 'Dev Client Co.', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
