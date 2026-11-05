import { createHash } from 'node:crypto';

export interface StateMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const V1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE shadow_task_contracts (
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  contract_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (task_id, version),
  UNIQUE (task_id, contract_hash)
) STRICT;

CREATE TABLE shadow_iterations (
  iteration_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  payload_json TEXT NOT NULL,
  UNIQUE (task_id, ordinal),
  FOREIGN KEY (task_id, contract_version)
    REFERENCES shadow_task_contracts(task_id, version) ON DELETE RESTRICT
) STRICT;

CREATE TABLE shadow_stage_runs (
  stage_run_id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  stage_type TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  payload_json TEXT NOT NULL,
  UNIQUE (iteration_id, stage_type, attempt),
  FOREIGN KEY (iteration_id)
    REFERENCES shadow_iterations(iteration_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE control_events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE command_receipts (
  idempotency_key TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER control_events_no_update
BEFORE UPDATE ON control_events
BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;

CREATE TRIGGER control_events_no_delete
BEFORE DELETE ON control_events
BEGIN SELECT RAISE(ABORT, 'control_events is append-only'); END;

CREATE TRIGGER shadow_contracts_no_update
BEFORE UPDATE ON shadow_task_contracts
BEGIN SELECT RAISE(ABORT, 'contracts are immutable'); END;

CREATE TRIGGER shadow_contracts_no_delete
BEFORE DELETE ON shadow_task_contracts
BEGIN SELECT RAISE(ABORT, 'contracts are immutable'); END;

CREATE TRIGGER command_receipts_no_update
BEFORE UPDATE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;

CREATE TRIGGER command_receipts_no_delete
BEFORE DELETE ON command_receipts
BEGIN SELECT RAISE(ABORT, 'command receipts are immutable'); END;

CREATE TRIGGER schema_migrations_no_update
BEFORE UPDATE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;

CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
`;

const V2_SQL = `
CREATE TABLE shadow_task_retirements (
  task_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;

CREATE TABLE projection_envelopes (
  delivery_id TEXT PRIMARY KEY,
  authority_revision TEXT NOT NULL,
  authority_input_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  gap_codes_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  command_count INTEGER NOT NULL CHECK (command_count >= 0)
) STRICT;

CREATE TABLE projection_batch_acknowledgements (
  delivery_id TEXT NOT NULL,
  batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  start_index INTEGER NOT NULL CHECK (start_index >= 0),
  end_index INTEGER NOT NULL CHECK (end_index > start_index),
  receipt_digests_json TEXT NOT NULL,
  PRIMARY KEY (delivery_id, batch_ordinal),
  UNIQUE (delivery_id, start_index),
  FOREIGN KEY (delivery_id) REFERENCES projection_envelopes(delivery_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE projection_completion_receipts (
  delivery_id TEXT PRIMARY KEY,
  manifest_digest TEXT NOT NULL,
  command_count INTEGER NOT NULL CHECK (command_count >= 0),
  FOREIGN KEY (delivery_id) REFERENCES projection_envelopes(delivery_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER shadow_retirements_no_update BEFORE UPDATE ON shadow_task_retirements
BEGIN SELECT RAISE(ABORT, 'retirements are immutable'); END;
CREATE TRIGGER shadow_retirements_no_delete BEFORE DELETE ON shadow_task_retirements
BEGIN SELECT RAISE(ABORT, 'retirements are immutable'); END;
CREATE TRIGGER projection_envelopes_no_update BEFORE UPDATE ON projection_envelopes
BEGIN SELECT RAISE(ABORT, 'projection envelopes are immutable'); END;
CREATE TRIGGER projection_envelopes_no_delete BEFORE DELETE ON projection_envelopes
BEGIN SELECT RAISE(ABORT, 'projection envelopes are immutable'); END;
CREATE TRIGGER projection_batches_no_update BEFORE UPDATE ON projection_batch_acknowledgements
BEGIN SELECT RAISE(ABORT, 'projection batch acknowledgements are immutable'); END;
CREATE TRIGGER projection_batches_no_delete BEFORE DELETE ON projection_batch_acknowledgements
BEGIN SELECT RAISE(ABORT, 'projection batch acknowledgements are immutable'); END;
CREATE TRIGGER projection_completions_no_update BEFORE UPDATE ON projection_completion_receipts
BEGIN SELECT RAISE(ABORT, 'projection completion receipts are immutable'); END;
CREATE TRIGGER projection_completions_no_delete BEFORE DELETE ON projection_completion_receipts
BEGIN SELECT RAISE(ABORT, 'projection completion receipts are immutable'); END;
`;

const V3_SQL = `
CREATE UNIQUE INDEX shadow_stage_run_iteration_identity
  ON shadow_stage_runs(stage_run_id, iteration_id);
CREATE UNIQUE INDEX shadow_iteration_contract_identity
  ON shadow_iterations(iteration_id, task_id, contract_version);

CREATE TABLE shadow_contract_criteria (
  task_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  criterion_id TEXT NOT NULL,
  PRIMARY KEY (task_id, contract_version, criterion_id),
  FOREIGN KEY (task_id, contract_version)
    REFERENCES shadow_task_contracts(task_id, version) ON DELETE RESTRICT
) STRICT;

INSERT INTO shadow_contract_criteria (task_id, contract_version, criterion_id)
SELECT c.task_id, c.version, json_extract(j.value, '$.id')
FROM shadow_task_contracts c, json_each(c.payload_json, '$.acceptanceCriteria') j;

CREATE TABLE artifact_archive_lineage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_lineage_id TEXT NOT NULL UNIQUE,
  artifact_root TEXT NOT NULL UNIQUE,
  root_device INTEGER NOT NULL CHECK (root_device >= 0),
  root_inode INTEGER NOT NULL CHECK (root_inode >= 0),
  payload_json TEXT NOT NULL
) STRICT;

CREATE TABLE artifact_capture_authorizations (
  authorization_id TEXT PRIMARY KEY,
  artifact_ref_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
  iteration_id TEXT NOT NULL,
  producer_stage_run_id TEXT NOT NULL,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('git', 'artifact', 'external')),
  candidate_json TEXT NOT NULL,
  media_type TEXT NOT NULL,
  max_byte_length INTEGER NOT NULL CHECK (max_byte_length >= 0 AND max_byte_length <= 67108864),
  environment_ref TEXT NOT NULL,
  surface TEXT NOT NULL,
  max_trust_class TEXT NOT NULL CHECK (max_trust_class IN ('primary', 'derived', 'agent_claim')),
  access_class TEXT NOT NULL CHECK (access_class IN ('operator', 'restricted')),
  issuer TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (producer_stage_run_id, iteration_id)
    REFERENCES shadow_stage_runs(stage_run_id, iteration_id) ON DELETE RESTRICT,
  FOREIGN KEY (iteration_id, task_id, contract_version)
    REFERENCES shadow_iterations(iteration_id, task_id, contract_version) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_content_policies (
  sha256 TEXT PRIMARY KEY,
  access_class TEXT NOT NULL CHECK (access_class IN ('operator', 'restricted'))
) STRICT;

CREATE TABLE artifact_refs (
  artifact_ref_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 67108864),
  storage_key TEXT NOT NULL,
  capture_authorization_id TEXT NOT NULL UNIQUE,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('git', 'artifact', 'external')),
  candidate_json TEXT NOT NULL,
  producer_stage_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  surface TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class IN ('primary', 'derived', 'agent_claim')),
  redaction_state TEXT NOT NULL CHECK (redaction_state IN ('none', 'redacted', 'restricted')),
  access_class TEXT NOT NULL CHECK (access_class IN ('operator', 'restricted')),
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (capture_authorization_id)
    REFERENCES artifact_capture_authorizations(authorization_id) ON DELETE RESTRICT,
  FOREIGN KEY (producer_stage_run_id)
    REFERENCES shadow_stage_runs(stage_run_id) ON DELETE RESTRICT,
  FOREIGN KEY (sha256)
    REFERENCES artifact_content_policies(sha256) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX artifact_ref_digest_identity
  ON artifact_refs(artifact_ref_id, sha256);

CREATE TABLE artifact_candidate_bindings (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('capture_authorization', 'artifact_ref', 'iteration', 'manifest')),
  owner_id TEXT NOT NULL,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('git', 'artifact', 'external')),
  candidate_json TEXT NOT NULL,
  protected_artifact_ref_id TEXT,
  candidate_artifact_ref_id TEXT,
  candidate_artifact_sha256 TEXT,
  protection_expires_at TEXT,
  CHECK ((candidate_kind = 'artifact') =
    (candidate_artifact_ref_id IS NOT NULL AND candidate_artifact_sha256 IS NOT NULL)),
  PRIMARY KEY (owner_kind, owner_id),
  FOREIGN KEY (protected_artifact_ref_id)
    REFERENCES artifact_refs(artifact_ref_id) ON DELETE RESTRICT,
  FOREIGN KEY (candidate_artifact_ref_id, candidate_artifact_sha256)
    REFERENCES artifact_refs(artifact_ref_id, sha256) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evidence_manifests (
  manifest_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
  iteration_id TEXT NOT NULL,
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('git', 'artifact', 'external')),
  candidate_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (iteration_id, task_id, contract_version)
    REFERENCES shadow_iterations(iteration_id, task_id, contract_version) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evidence_manifest_entries (
  manifest_id TEXT NOT NULL,
  artifact_ref_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  candidate_kind TEXT NOT NULL CHECK (candidate_kind IN ('git', 'artifact', 'external')),
  candidate_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  environment_ref TEXT NOT NULL,
  surface TEXT NOT NULL,
  trust_class TEXT NOT NULL CHECK (trust_class IN ('primary', 'derived', 'agent_claim')),
  redaction_state TEXT NOT NULL CHECK (redaction_state IN ('none', 'redacted', 'restricted')),
  access_class TEXT NOT NULL CHECK (access_class IN ('operator', 'restricted')),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (manifest_id, artifact_ref_id),
  UNIQUE (manifest_id, ordinal),
  FOREIGN KEY (manifest_id) REFERENCES evidence_manifests(manifest_id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_ref_id) REFERENCES artifact_refs(artifact_ref_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE evidence_manifest_criteria (
  manifest_id TEXT NOT NULL,
  artifact_ref_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
  criterion_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (manifest_id, artifact_ref_id, criterion_id),
  UNIQUE (manifest_id, artifact_ref_id, ordinal),
  FOREIGN KEY (manifest_id, artifact_ref_id)
    REFERENCES evidence_manifest_entries(manifest_id, artifact_ref_id) ON DELETE RESTRICT,
  FOREIGN KEY (task_id, contract_version, criterion_id)
    REFERENCES shadow_contract_criteria(task_id, contract_version, criterion_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_retirements (
  retirement_id TEXT NOT NULL UNIQUE,
  artifact_ref_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  policy_cutoff TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (artifact_ref_id) REFERENCES artifact_refs(artifact_ref_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_archive_mutations (
  event_id TEXT PRIMARY KEY,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (
    'issue_capture_authorization', 'record_artifact', 'record_manifest', 'retire_artifact'
  )),
  aggregate_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  sealed_through_sequence INTEGER NOT NULL CHECK (sealed_through_sequence >= 1),
  sealed_through_event_hash TEXT NOT NULL,
  v3_inventory_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES control_events(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE artifact_archive_receipts (
  idempotency_key TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES artifact_archive_mutations(event_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER shadow_iterations_no_artifact_candidate_insert
BEFORE INSERT ON shadow_iterations
WHEN json_extract(NEW.payload_json, '$.candidateRef.kind') = 'artifact'
BEGIN SELECT RAISE(ABORT, 'artifact candidates require archive-coordinated iteration advancement'); END;
CREATE TRIGGER shadow_iterations_no_artifact_candidate_update
BEFORE UPDATE ON shadow_iterations
WHEN json_extract(NEW.payload_json, '$.candidateRef.kind') = 'artifact'
BEGIN SELECT RAISE(ABORT, 'artifact candidates require archive-coordinated iteration advancement'); END;

CREATE TRIGGER shadow_contract_criteria_no_update BEFORE UPDATE ON shadow_contract_criteria
BEGIN SELECT RAISE(ABORT, 'contract criteria are immutable'); END;
CREATE TRIGGER shadow_contract_criteria_no_delete BEFORE DELETE ON shadow_contract_criteria
BEGIN SELECT RAISE(ABORT, 'contract criteria are immutable'); END;
CREATE TRIGGER shadow_contract_criteria_checked
BEFORE INSERT ON shadow_contract_criteria
WHEN NOT EXISTS (
  SELECT 1 FROM shadow_task_contracts c, json_each(c.payload_json, '$.acceptanceCriteria') j
  WHERE c.task_id = NEW.task_id AND c.version = NEW.contract_version
    AND json_extract(j.value, '$.id') = NEW.criterion_id
)
BEGIN SELECT RAISE(ABORT, 'contract criterion is not present in the canonical contract'); END;

CREATE TRIGGER artifact_refs_exact_authorization
BEFORE INSERT ON artifact_refs
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_capture_authorizations a
  WHERE a.authorization_id = NEW.capture_authorization_id
    AND a.artifact_ref_id = NEW.artifact_ref_id
    AND a.producer_stage_run_id = NEW.producer_stage_run_id
    AND a.candidate_kind = NEW.candidate_kind
    AND a.candidate_json = NEW.candidate_json
    AND a.media_type = NEW.media_type
    AND NEW.byte_length <= a.max_byte_length
    AND a.environment_ref = NEW.environment_ref
    AND a.surface = NEW.surface
    AND NEW.observed_at >= a.issued_at
    AND NEW.observed_at <= NEW.created_at
    AND NEW.created_at <= a.expires_at
    AND (a.access_class = 'operator' OR NEW.access_class = 'restricted')
    AND (a.max_trust_class = 'primary'
      OR (a.max_trust_class = 'derived' AND NEW.trust_class IN ('derived', 'agent_claim'))
      OR (a.max_trust_class = 'agent_claim' AND NEW.trust_class = 'agent_claim'))
    AND (NEW.redaction_state != 'restricted' OR NEW.access_class = 'restricted')
)
BEGIN SELECT RAISE(ABORT, 'artifact ref does not consume its exact authorization'); END;

CREATE TRIGGER artifact_capture_authorizations_checked
BEFORE INSERT ON artifact_capture_authorizations
WHEN NOT EXISTS (
  SELECT 1 FROM shadow_iterations i JOIN shadow_stage_runs s
    ON s.stage_run_id = NEW.producer_stage_run_id AND s.iteration_id = i.iteration_id
  WHERE i.iteration_id = NEW.iteration_id
    AND i.task_id = NEW.task_id
    AND i.contract_version = NEW.contract_version
    AND json_extract(i.payload_json, '$.candidateRef.kind') = NEW.candidate_kind
    AND json_extract(i.payload_json, '$.candidateRef') = json(NEW.candidate_json)
    AND (NEW.max_trust_class != 'primary' OR s.stage_type = 'verify')
    AND NEW.issued_at < NEW.expires_at
)
BEGIN SELECT RAISE(ABORT, 'capture authorization trusted relationship is invalid'); END;

CREATE TRIGGER artifact_refs_restriction_consistent
BEFORE INSERT ON artifact_refs
WHEN NOT EXISTS (
  SELECT 1 FROM artifact_content_policies p
  WHERE p.sha256 = NEW.sha256
    AND (p.access_class = 'restricted' OR NEW.access_class = 'operator')
)
BEGIN SELECT RAISE(ABORT, 'artifact ref weakens digest restriction'); END;

CREATE TRIGGER artifact_candidate_bindings_checked
BEFORE INSERT ON artifact_candidate_bindings
WHEN
  (NEW.owner_kind = 'capture_authorization' AND NOT EXISTS (
    SELECT 1 FROM artifact_capture_authorizations WHERE authorization_id = NEW.owner_id
  )) OR
  (NEW.owner_kind = 'artifact_ref' AND NOT EXISTS (
    SELECT 1 FROM artifact_refs WHERE artifact_ref_id = NEW.owner_id
  )) OR
  (NEW.owner_kind = 'iteration' AND NOT EXISTS (
    SELECT 1 FROM shadow_iterations WHERE iteration_id = NEW.owner_id
  )) OR
  (NEW.owner_kind = 'manifest' AND NOT EXISTS (
    SELECT 1 FROM evidence_manifests WHERE manifest_id = NEW.owner_id
  )) OR
  (NEW.owner_kind = 'iteration') OR
  (NEW.owner_kind = 'capture_authorization' AND NOT EXISTS (
    SELECT 1 FROM artifact_capture_authorizations a
    WHERE a.authorization_id = NEW.owner_id
      AND a.candidate_kind = NEW.candidate_kind AND a.candidate_json = NEW.candidate_json
      AND NEW.protected_artifact_ref_id IS NULL
      AND NEW.protection_expires_at = a.expires_at
  )) OR
  (NEW.owner_kind = 'artifact_ref' AND NOT EXISTS (
    SELECT 1 FROM artifact_refs a
    WHERE a.artifact_ref_id = NEW.owner_id
      AND a.candidate_kind = NEW.candidate_kind AND a.candidate_json = NEW.candidate_json
      AND NEW.protected_artifact_ref_id = a.artifact_ref_id
      AND NEW.protection_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at, '+7 days')
  )) OR
  (NEW.owner_kind = 'manifest' AND NOT EXISTS (
    SELECT 1 FROM evidence_manifests m
    WHERE m.manifest_id = NEW.owner_id
      AND m.candidate_kind = NEW.candidate_kind AND m.candidate_json = NEW.candidate_json
      AND NEW.protected_artifact_ref_id IS NULL AND NEW.protection_expires_at IS NULL
  )) OR
  (NEW.protected_artifact_ref_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM artifact_retirements WHERE artifact_ref_id = NEW.protected_artifact_ref_id
  )) OR
  (NEW.candidate_artifact_ref_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM artifact_retirements WHERE artifact_ref_id = NEW.candidate_artifact_ref_id
  )) OR
  (NEW.candidate_kind = 'artifact' AND (
    NEW.candidate_artifact_ref_id IS NULL OR NEW.candidate_artifact_sha256 IS NULL OR
    NEW.candidate_artifact_ref_id != json_extract(NEW.candidate_json, '$.artifactId') OR
    NEW.candidate_artifact_sha256 != json_extract(NEW.candidate_json, '$.sha256')
  )) OR
  (NEW.candidate_kind != 'artifact' AND (
    NEW.candidate_artifact_ref_id IS NOT NULL OR NEW.candidate_artifact_sha256 IS NOT NULL
  )) OR
  (NEW.candidate_kind = 'artifact' AND NOT EXISTS (
    SELECT 1 FROM artifact_refs candidate
    WHERE candidate.artifact_ref_id = NEW.candidate_artifact_ref_id
      AND candidate.sha256 = NEW.candidate_artifact_sha256
      AND NOT EXISTS (
        SELECT 1 FROM artifact_retirements retired
        WHERE retired.artifact_ref_id = candidate.artifact_ref_id
      )
  ))
BEGIN SELECT RAISE(ABORT, 'artifact candidate binding owner or live artifact is invalid'); END;

CREATE TRIGGER evidence_manifests_checked
BEFORE INSERT ON evidence_manifests
WHEN NOT EXISTS (
  SELECT 1 FROM shadow_iterations i
  WHERE i.iteration_id = NEW.iteration_id
    AND i.task_id = NEW.task_id
    AND i.contract_version = NEW.contract_version
    AND json_extract(i.payload_json, '$.candidateRef.kind') = NEW.candidate_kind
    AND json_extract(i.payload_json, '$.candidateRef') = json(NEW.candidate_json)
)
BEGIN SELECT RAISE(ABORT, 'evidence manifest iteration binding is invalid'); END;

CREATE TRIGGER evidence_manifest_entries_require_active_ref
BEFORE INSERT ON evidence_manifest_entries
WHEN EXISTS (SELECT 1 FROM artifact_retirements WHERE artifact_ref_id = NEW.artifact_ref_id)
  OR NOT EXISTS (
    SELECT 1 FROM artifact_refs a JOIN artifact_content_policies p ON p.sha256 = a.sha256
    JOIN evidence_manifests m ON m.manifest_id = NEW.manifest_id
    WHERE a.artifact_ref_id = NEW.artifact_ref_id
      AND a.candidate_kind = NEW.candidate_kind AND a.candidate_json = NEW.candidate_json
      AND m.candidate_kind = NEW.candidate_kind AND m.candidate_json = NEW.candidate_json
      AND a.observed_at = NEW.observed_at AND a.environment_ref = NEW.environment_ref
      AND a.surface = NEW.surface AND a.trust_class = NEW.trust_class
      AND a.redaction_state = NEW.redaction_state AND p.access_class = NEW.access_class
  )
BEGIN SELECT RAISE(ABORT, 'retired artifact cannot enter a manifest'); END;

CREATE TRIGGER evidence_manifest_criteria_checked
BEFORE INSERT ON evidence_manifest_criteria
WHEN NOT EXISTS (
  SELECT 1 FROM evidence_manifests m
  JOIN evidence_manifest_entries e
    ON e.manifest_id = NEW.manifest_id AND e.artifact_ref_id = NEW.artifact_ref_id
  WHERE m.manifest_id = NEW.manifest_id
    AND m.task_id = NEW.task_id AND m.contract_version = NEW.contract_version
    AND NEW.ordinal < json_array_length(e.payload_json, '$.criterionIds')
    AND json_extract(e.payload_json, '$.criterionIds[' || NEW.ordinal || ']') = NEW.criterion_id
)
BEGIN SELECT RAISE(ABORT, 'manifest criterion contract binding is invalid'); END;

CREATE TRIGGER artifact_retirements_require_unreferenced
BEFORE INSERT ON artifact_retirements
WHEN NEW.policy_cutoff > NEW.retired_at OR EXISTS (
  SELECT 1 FROM evidence_manifest_entries WHERE artifact_ref_id = NEW.artifact_ref_id
) OR EXISTS (
  SELECT 1 FROM artifact_candidate_bindings
  WHERE (protected_artifact_ref_id = NEW.artifact_ref_id OR candidate_artifact_ref_id = NEW.artifact_ref_id)
    AND (protection_expires_at IS NULL OR protection_expires_at >= NEW.retired_at)
)
BEGIN SELECT RAISE(ABORT, 'referenced or live-bound artifact cannot be retired'); END;

CREATE TRIGGER artifact_content_policies_monotonic
BEFORE UPDATE ON artifact_content_policies
WHEN OLD.sha256 != NEW.sha256 OR OLD.access_class = 'restricted' OR NEW.access_class != 'restricted'
BEGIN SELECT RAISE(ABORT, 'artifact content policy is monotonic'); END;
CREATE TRIGGER artifact_content_policies_no_delete BEFORE DELETE ON artifact_content_policies
BEGIN SELECT RAISE(ABORT, 'artifact content policies cannot be deleted'); END;

CREATE TRIGGER artifact_archive_lineage_no_update BEFORE UPDATE ON artifact_archive_lineage
BEGIN SELECT RAISE(ABORT, 'artifact archive lineage is immutable'); END;
CREATE TRIGGER artifact_archive_lineage_no_delete BEFORE DELETE ON artifact_archive_lineage
BEGIN SELECT RAISE(ABORT, 'artifact archive lineage is immutable'); END;
CREATE TRIGGER artifact_capture_authorizations_no_update BEFORE UPDATE ON artifact_capture_authorizations
BEGIN SELECT RAISE(ABORT, 'artifact capture authorizations are immutable'); END;
CREATE TRIGGER artifact_capture_authorizations_no_delete BEFORE DELETE ON artifact_capture_authorizations
BEGIN SELECT RAISE(ABORT, 'artifact capture authorizations are immutable'); END;
CREATE TRIGGER artifact_refs_no_update BEFORE UPDATE ON artifact_refs
BEGIN SELECT RAISE(ABORT, 'artifact refs are immutable'); END;
CREATE TRIGGER artifact_refs_no_delete BEFORE DELETE ON artifact_refs
BEGIN SELECT RAISE(ABORT, 'artifact refs are immutable'); END;
CREATE TRIGGER artifact_candidate_bindings_no_update BEFORE UPDATE ON artifact_candidate_bindings
BEGIN SELECT RAISE(ABORT, 'artifact candidate bindings are immutable'); END;
CREATE TRIGGER artifact_candidate_bindings_no_delete BEFORE DELETE ON artifact_candidate_bindings
BEGIN SELECT RAISE(ABORT, 'artifact candidate bindings are immutable'); END;
CREATE TRIGGER evidence_manifests_no_update BEFORE UPDATE ON evidence_manifests
BEGIN SELECT RAISE(ABORT, 'evidence manifests are immutable'); END;
CREATE TRIGGER evidence_manifests_no_delete BEFORE DELETE ON evidence_manifests
BEGIN SELECT RAISE(ABORT, 'evidence manifests are immutable'); END;
CREATE TRIGGER evidence_manifest_entries_no_update BEFORE UPDATE ON evidence_manifest_entries
BEGIN SELECT RAISE(ABORT, 'evidence manifest entries are immutable'); END;
CREATE TRIGGER evidence_manifest_entries_no_delete BEFORE DELETE ON evidence_manifest_entries
BEGIN SELECT RAISE(ABORT, 'evidence manifest entries are immutable'); END;
CREATE TRIGGER evidence_manifest_criteria_no_update BEFORE UPDATE ON evidence_manifest_criteria
BEGIN SELECT RAISE(ABORT, 'evidence manifest criteria are immutable'); END;
CREATE TRIGGER evidence_manifest_criteria_no_delete BEFORE DELETE ON evidence_manifest_criteria
BEGIN SELECT RAISE(ABORT, 'evidence manifest criteria are immutable'); END;
CREATE TRIGGER artifact_retirements_no_update BEFORE UPDATE ON artifact_retirements
BEGIN SELECT RAISE(ABORT, 'artifact retirements are immutable'); END;
CREATE TRIGGER artifact_retirements_no_delete BEFORE DELETE ON artifact_retirements
BEGIN SELECT RAISE(ABORT, 'artifact retirements are immutable'); END;
CREATE TRIGGER artifact_archive_mutations_no_update BEFORE UPDATE ON artifact_archive_mutations
BEGIN SELECT RAISE(ABORT, 'artifact archive mutations are immutable'); END;
CREATE TRIGGER artifact_archive_mutations_no_delete BEFORE DELETE ON artifact_archive_mutations
BEGIN SELECT RAISE(ABORT, 'artifact archive mutations are immutable'); END;
CREATE TRIGGER artifact_archive_receipts_no_update BEFORE UPDATE ON artifact_archive_receipts
BEGIN SELECT RAISE(ABORT, 'artifact archive receipts are immutable'); END;
CREATE TRIGGER artifact_archive_receipts_no_delete BEFORE DELETE ON artifact_archive_receipts
BEGIN SELECT RAISE(ABORT, 'artifact archive receipts are immutable'); END;
`;

const V4_SQL = `
CREATE TABLE v2_aggregate_state (
  aggregate_id TEXT PRIMARY KEY,
  state_version INTEGER NOT NULL CHECK (state_version >= 1),
  task_status TEXT NOT NULL CHECK (task_status IN ('todo','in_progress','review','done','cancelled','retrying','failed','deleted')),
  review_package_json TEXT NULL,
  projection_hash TEXT NULL,
  projection_state TEXT NOT NULL CHECK (projection_state IN ('projected','unprojectable')),
  unprojectable_reason TEXT NULL CHECK (unprojectable_reason IS NULL OR unprojectable_reason IN ('empty_iteration_history','missing_contract','invalid_source','invalid_package')),
  updated_at_sequence INTEGER NOT NULL REFERENCES control_events(sequence),
  CHECK ((projection_state = 'projected' AND review_package_json IS NOT NULL AND projection_hash IS NOT NULL AND unprojectable_reason IS NULL)
      OR (projection_state = 'unprojectable' AND review_package_json IS NULL AND projection_hash IS NULL AND unprojectable_reason IS NOT NULL))
);

CREATE TRIGGER v2_aggregate_state_no_delete BEFORE DELETE ON v2_aggregate_state
BEGIN SELECT RAISE(ABORT, 'v2_aggregate_state rows are permanent'); END;

CREATE TRIGGER v2_aggregate_state_monotonic BEFORE UPDATE ON v2_aggregate_state
  WHEN NEW.state_version <= OLD.state_version OR NEW.updated_at_sequence <= OLD.updated_at_sequence OR NEW.aggregate_id <> OLD.aggregate_id
  BEGIN SELECT RAISE(ABORT, 'v2_aggregate_state updates must bump version and sequence'); END;

CREATE TABLE v2_admission_ledger (
  key_hash TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL REFERENCES v2_aggregate_state(aggregate_id),
  request_hash TEXT NOT NULL,
  event_sequence INTEGER NOT NULL UNIQUE REFERENCES control_events(sequence),
  receipt_json TEXT NOT NULL
);

CREATE INDEX v2_admission_ledger_aggregate_id ON v2_admission_ledger(aggregate_id);

CREATE TRIGGER v2_admission_ledger_no_update BEFORE UPDATE ON v2_admission_ledger
BEGIN SELECT RAISE(ABORT, 'v2_admission_ledger rows are immutable'); END;

CREATE TRIGGER v2_admission_ledger_no_delete BEFORE DELETE ON v2_admission_ledger
BEGIN SELECT RAISE(ABORT, 'v2_admission_ledger rows are permanent'); END;

CREATE TABLE v2_pending_effects (
  key_hash TEXT PRIMARY KEY REFERENCES v2_admission_ledger(key_hash),
  aggregate_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve_outcome','reject_outcome','request_changes')),
  event_sequence INTEGER NOT NULL,
  effect_state TEXT NOT NULL CHECK (effect_state IN ('pending','applied')),
  applied_at_sequence INTEGER NULL
);

CREATE TABLE v2_sweeps (
  sweep_key TEXT PRIMARY KEY,
  completed_at_sequence INTEGER NOT NULL,
  materialized_count INTEGER NOT NULL CHECK (materialized_count >= 0)
);
`;

const V5_SQL = `
CREATE TABLE v2_review_evidence (
  aggregate_id TEXT NOT NULL,
  iteration_id TEXT NOT NULL,
  candidate_repository TEXT NOT NULL,
  candidate_revision TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_sequence INTEGER NOT NULL REFERENCES control_events(sequence),
  PRIMARY KEY (aggregate_id, iteration_id)
);

CREATE TRIGGER v2_review_evidence_no_update BEFORE UPDATE ON v2_review_evidence
BEGIN SELECT RAISE(ABORT, 'v2_review_evidence rows are immutable'); END;

CREATE TRIGGER v2_review_evidence_no_delete BEFORE DELETE ON v2_review_evidence
BEGIN SELECT RAISE(ABORT, 'v2_review_evidence rows are permanent'); END;

CREATE TABLE v2_review_evaluation (
  aggregate_id TEXT NOT NULL,
  iteration_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  evaluation_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  event_sequence INTEGER NOT NULL REFERENCES control_events(sequence),
  PRIMARY KEY (aggregate_id, iteration_id)
);

CREATE TRIGGER v2_review_evaluation_no_update BEFORE UPDATE ON v2_review_evaluation
BEGIN SELECT RAISE(ABORT, 'v2_review_evaluation rows are immutable'); END;

CREATE TRIGGER v2_review_evaluation_no_delete BEFORE DELETE ON v2_review_evaluation
BEGIN SELECT RAISE(ABORT, 'v2_review_evaluation rows are permanent'); END;
`;

const V6_SQL = `
CREATE TRIGGER v2_pending_effects_no_delete BEFORE DELETE ON v2_pending_effects
BEGIN SELECT RAISE(ABORT, 'v2_pending_effects rows are permanent'); END;

CREATE TRIGGER v2_pending_effects_forward_only BEFORE UPDATE ON v2_pending_effects
  WHEN NOT (
    OLD.effect_state = 'pending'
    AND NEW.effect_state = 'applied'
    AND NEW.applied_at_sequence IS NOT NULL
    AND NEW.key_hash = OLD.key_hash
    AND NEW.aggregate_id = OLD.aggregate_id
    AND NEW.action = OLD.action
    AND NEW.event_sequence = OLD.event_sequence
  )
BEGIN SELECT RAISE(ABORT, 'v2_pending_effects may only move pending→applied with applied_at_sequence set'); END;
`;

/**
 * C3.58: durable "authority revision observed" cursor. Zero-command deliveries
 * no longer append envelopes, so the envelope log alone cannot tell the sync
 * loop how far Git history has been observed. Single row, updatable.
 */
const V7_SQL = `
CREATE TABLE projection_observed_revision (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_revision TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
`;

function checksum(sql: string): string {
  return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`;
}

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  { version: 1, name: 'initial_shadow_state', sql: V1_SQL, checksum: checksum(V1_SQL) },
  { version: 2, name: 'shadow_projection_delivery', sql: V2_SQL, checksum: checksum(V2_SQL) },
  { version: 3, name: 'artifact_evidence_metadata', sql: V3_SQL, checksum: checksum(V3_SQL) },
  { version: 4, name: 'v2_aggregate_authority', sql: V4_SQL, checksum: checksum(V4_SQL) },
  { version: 5, name: 'v2_review_truth', sql: V5_SQL, checksum: checksum(V5_SQL) },
  { version: 6, name: 'v2_pending_effect_guards', sql: V6_SQL, checksum: checksum(V6_SQL) },
  { version: 7, name: 'projection_observed_revision', sql: V7_SQL, checksum: checksum(V7_SQL) },
];

export const CURRENT_STATE_SCHEMA_VERSION = STATE_MIGRATIONS.length;
