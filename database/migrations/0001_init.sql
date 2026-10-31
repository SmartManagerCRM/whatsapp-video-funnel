-- SmartManager WhatsApp Video Funnel - initial schema (all timestamps UTC, ISO-8601 TEXT)
PRAGMA foreign_keys = ON;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT
);

CREATE TABLE platform_owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, email)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tenant','owner')),
  user_id TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  business_name TEXT,
  logo_key TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  default_language TEXT NOT NULL DEFAULT 'en',
  delivery_mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (delivery_mode IN ('automatic','manual','hybrid')),
  default_delay_seconds INTEGER NOT NULL DEFAULT 60,
  website_url TEXT,
  retention_days INTEGER NOT NULL DEFAULT 0,        -- 0 = keep forever
  handover_enabled INTEGER NOT NULL DEFAULT 1,
  handover_timeout_minutes INTEGER NOT NULL DEFAULT 0, -- 0 = until resumed manually
  category_change_policy TEXT NOT NULL DEFAULT 'restart' CHECK (category_change_policy IN ('restart','continue')),
  opt_out_keywords TEXT NOT NULL DEFAULT '["STOP","UNSUBSCRIBE","CANCEL","STOP MESSAGES","ARRET","ARRETER","SE DESABONNER","إيقاف","توقف","الغاء","إلغاء"]',
  opt_in_keywords TEXT NOT NULL DEFAULT '["START","SUBSCRIBE","DEMARRER","ابدأ"]',
  reopen_template_name TEXT,                         -- approved template used when 24h window is closed
  reopen_template_language TEXT,
  automation_enabled INTEGER NOT NULL DEFAULT 0,     -- must be switched on explicitly after verification
  notification_email TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE licenses (
  id TEXT PRIMARY KEY,                       -- license_id from token
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  license_type TEXT NOT NULL,
  features TEXT NOT NULL DEFAULT '[]',
  max_whatsapp_numbers INTEGER NOT NULL DEFAULT 1,
  issued_at TEXT NOT NULL,
  expires_at TEXT,                            -- NULL for LIFETIME
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked','transferred')),
  token TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  registered_phone TEXT,
  last_verified_at TEXT
);
CREATE INDEX idx_licenses_tenant ON licenses(tenant_id);

CREATE TABLE license_events (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  tenant_id TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_license_events_license ON license_events(license_id);

CREATE TABLE whatsapp_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  app_id TEXT,
  waba_id TEXT,
  phone_number_id TEXT UNIQUE,
  display_phone TEXT,
  access_token_enc TEXT,
  app_secret_enc TEXT,
  verify_token TEXT NOT NULL,
  graph_version TEXT NOT NULL DEFAULT 'v23.0',
  status TEXT NOT NULL DEFAULT 'not_connected' CHECK (status IN
    ('not_connected','onboarding_pending','connected','coexistence_verified','disconnected','token_invalid','webhook_incomplete')),
  is_on_biz_app INTEGER,
  platform_type TEXT,
  last_api_ok_at TEXT,
  last_webhook_at TEXT,
  last_check_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE whatsapp_webhook_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,                   -- idempotency key (wa message id + kind)
  field TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','failed','ignored')),
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE (tenant_id, event_key)
);

CREATE TABLE business_categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_categories_tenant ON business_categories(tenant_id, sort_order);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  caption TEXT,
  r2_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_seconds INTEGER,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_videos_tenant ON videos(tenant_id);

CREATE TABLE video_sequences (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES business_categories(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE (category_id)
);

CREATE TABLE sequence_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sequence_id TEXT NOT NULL REFERENCES video_sequences(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  delay_seconds INTEGER,                      -- NULL = tenant default
  caption TEXT                                -- NULL = video caption
);
CREATE INDEX idx_items_sequence ON sequence_items(sequence_id, position);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, key, language)
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_phone TEXT NOT NULL,
  name TEXT,
  category_id TEXT REFERENCES business_categories(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','waiting','completed','human_handling','paused','opted_out','failed')),
  opted_out INTEGER NOT NULL DEFAULT 0,
  first_interaction_at TEXT NOT NULL,
  last_interaction_at TEXT NOT NULL,
  UNIQUE (tenant_id, wa_phone)
);
CREATE INDEX idx_customers_tenant_status ON customers(tenant_id, status);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('NEW','WELCOME_SENT','WAITING_FOR_CATEGORY','CATEGORY_SELECTED','VIDEO_SEQUENCE_ACTIVE','WAITING_FOR_NEXT_VIDEO','WEBSITE_LINK_SENT','GOODBYE_SENT','COMPLETED','HUMAN_HANDLING','PAUSED','OPTED_OUT','FAILED')),
  category_id TEXT REFERENCES business_categories(id) ON DELETE SET NULL,
  pending_category_id TEXT,                   -- awaiting change confirmation
  sequence_id TEXT,
  sequence_version INTEGER,
  next_step INTEGER NOT NULL DEFAULT 0,       -- 0..n-1 = video index, n = website+goodbye
  videos_sent INTEGER NOT NULL DEFAULT 0,
  run_version INTEGER NOT NULL DEFAULT 1,     -- bumped to invalidate in-flight jobs
  lock_until TEXT,                            -- short lease held while a step is being sent (duplicate prevention)
  resume_state TEXT,                          -- state to restore after human handling / pause
  paused_reason TEXT,
  human_handling_until TEXT,
  last_inbound_at TEXT,
  website_sent INTEGER NOT NULL DEFAULT 0,
  goodbye_sent INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conv_tenant_state ON conversations(tenant_id, state);
CREATE INDEX idx_conv_customer ON conversations(customer_id, started_at);

CREATE TABLE conversation_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_conv_events ON conversation_events(conversation_id, created_at);

CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'step',
  step INTEGER NOT NULL,
  run_version INTEGER NOT NULL,
  sequence_version INTEGER,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatched INTEGER NOT NULL DEFAULT 0,       -- 1 once a Queue message exists (delays > 24h are dispatched by cron)
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON scheduled_jobs(status, run_at);
CREATE INDEX idx_jobs_conv ON scheduled_jobs(conversation_id, status);

CREATE TABLE message_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound_auto','outbound_human')),
  wa_message_id TEXT,
  kind TEXT NOT NULL,                         -- text | video | interactive | template | button_reply | list_reply
  body TEXT,
  video_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitted','sent','delivered','read','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_msg_conv ON message_logs(conversation_id, created_at);
CREATE UNIQUE INDEX idx_msg_wa ON message_logs(tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL;

CREATE TABLE media_uploads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  media_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploaded','failed','invalid')),
  error TEXT,
  uploaded_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (video_id, phone_number_id, sha256)
);

CREATE TABLE automation_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_autolog_tenant ON automation_logs(tenant_id, created_at);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant ON audit_logs(tenant_id, created_at);

CREATE TABLE usage_counters (
  day TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tenant_id, metric)
);
