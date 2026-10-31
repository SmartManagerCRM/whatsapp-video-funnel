export interface Env {
  DB: D1Database;
  VIDEOS: R2Bucket;
  QUEUE: Queue<QueueMessage>;
  ASSETS: Fetcher;
  // vars
  PRODUCT_ID: string;
  DEFAULT_GRAPH_VERSION: string;
  MAX_UPLOAD_MB: string;
  COOKIE_SECURE: string;
  // secrets
  ENCRYPTION_KEY: string;
  LICENSE_PUBLIC_KEY: string;
  OWNER_BOOTSTRAP_TOKEN?: string;
}

export type QueueMessage =
  | { type: "step"; jobId: string }
  | { type: "webhook_event"; eventId: string };

export interface TenantRow {
  id: string;
  slug: string;
  business_name: string;
  status: "active" | "suspended";
}

export interface TenantSettings {
  tenant_id: string;
  business_name: string | null;
  timezone: string;
  default_language: string;
  delivery_mode: "automatic" | "manual" | "hybrid";
  default_delay_seconds: number;
  website_url: string | null;
  retention_days: number;
  handover_enabled: number;
  handover_timeout_minutes: number;
  category_change_policy: "restart" | "continue";
  opt_out_keywords: string;
  opt_in_keywords: string;
  reopen_template_name: string | null;
  reopen_template_language: string | null;
  automation_enabled: number;
  notification_email: string | null;
}
