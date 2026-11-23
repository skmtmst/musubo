-- Store bindings are authoritative; legacy origin columns are checked for conflicts.
-- Version foreign keys use RESTRICT: tenant purge deletes jobs and bindings first.
CREATE TABLE hq_template_store_bindings (
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('booking_menu','mileage_reward')),
  target_id TEXT NOT NULL,
  applied_version_id TEXT NOT NULL,
  pending_version_id TEXT,
  dismissed_version_id TEXT,
  applied_snapshot_hash TEXT NOT NULL,
  hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version > 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,template_id,target_account_id),
  UNIQUE (tenant_id,target_account_id,kind,target_id),
  FOREIGN KEY (template_id,tenant_id) REFERENCES hq_templates(id,tenant_id),
  FOREIGN KEY (applied_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (pending_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (dismissed_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id) ON DELETE RESTRICT
);
CREATE INDEX hq_store_bindings_pending ON hq_template_store_bindings(tenant_id,target_account_id,pending_version_id);
CREATE TABLE hq_template_distribution_jobs (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','partial','failed')),
  created_by TEXT NOT NULL,
  notification_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (id,tenant_id),
  UNIQUE (tenant_id,request_key),
  FOREIGN KEY (template_version_id,template_id,tenant_id) REFERENCES hq_template_versions(id,template_id,tenant_id) ON DELETE RESTRICT
);
CREATE INDEX hq_distribution_jobs_status ON hq_template_distribution_jobs(status,updated_at);
CREATE INDEX hq_distribution_jobs_version ON hq_template_distribution_jobs(tenant_id,template_id,template_version_id);
CREATE TABLE hq_template_distribution_job_items (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  preflight_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','conflict')),
  lease_token TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (tenant_id,job_id,target_account_id),
  FOREIGN KEY (job_id,tenant_id) REFERENCES hq_template_distribution_jobs(id,tenant_id),
  FOREIGN KEY (preflight_id,tenant_id) REFERENCES hq_template_preflights(id,tenant_id)
);
CREATE INDEX hq_distribution_job_items_queue ON hq_template_distribution_job_items(status,lease_expires_at,tenant_id,job_id);
CREATE INDEX hq_distribution_job_items_preflight ON hq_template_distribution_job_items(tenant_id,preflight_id);
