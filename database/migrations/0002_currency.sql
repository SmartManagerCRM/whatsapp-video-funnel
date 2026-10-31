-- Display currency for cost estimates and reports (ISO 4217 code). Informational only.
ALTER TABLE tenant_settings ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
