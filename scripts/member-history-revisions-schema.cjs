// Additive H1 migration: original observations and all corrections remain intact.
const tables = [
`CREATE TABLE IF NOT EXISTS member_history_revision_state (
 organization_id VARCHAR(100) PRIMARY KEY, revision INT UNSIGNED NOT NULL DEFAULT 0,
 revised_at DATETIME(6) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS member_history_corrections (
 organization_id VARCHAR(100) NOT NULL, id CHAR(36) NOT NULL, history_id CHAR(36) NOT NULL,
 generation CHAR(36) NOT NULL, member_id VARCHAR(100) NOT NULL, revision INT UNSIGNED NOT NULL,
 event_version INT UNSIGNED NOT NULL, effective_at DATETIME(6) NOT NULL,
 after_status VARCHAR(100) NULL, after_campus_id VARCHAR(100) NULL, after_cell_id VARCHAR(100) NULL,
 reason VARCHAR(500) NOT NULL, actor_id VARCHAR(100) NOT NULL, request_hash CHAR(64) NOT NULL,
 recorded_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id), UNIQUE KEY uq_history_correction_version(organization_id,history_id,event_version),
 UNIQUE KEY uq_history_correction_revision(organization_id,revision),
 KEY idx_history_correction_event(organization_id,history_id,revision),
 KEY idx_history_correction_member(organization_id,generation,member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];
// Derive the preceding state again: correcting one state also corrects the before-side
// of its successor, without rewriting either original observation.
const effectiveView = `CREATE OR REPLACE VIEW member_state_history_effective AS
 WITH ranked AS (
  SELECT c.*,ROW_NUMBER() OVER(PARTITION BY organization_id,history_id ORDER BY event_version DESC) AS rn
  FROM member_history_corrections c
 ), effective AS (
  SELECT h.sequence_id,h.id,h.organization_id,h.generation,h.member_id,h.kind,h.after_role,
   CASE WHEN c.id IS NULL THEN h.after_status ELSE c.after_status END AS after_status,
   CASE WHEN c.id IS NULL THEN h.after_campus_id ELSE c.after_campus_id END AS after_campus_id,
   CASE WHEN c.id IS NULL THEN h.after_cell_id ELSE c.after_cell_id END AS after_cell_id,
   h.before_status,h.before_role,h.before_campus_id,h.before_cell_id,h.actor_id,h.source,
   COALESCE(c.effective_at,h.occurred_at) AS occurred_at,h.occurred_at AS observed_at,
   COALESCE(c.event_version,0) AS correction_version,c.recorded_at AS revised_at
  FROM member_state_history h LEFT JOIN ranked c
   ON c.organization_id=h.organization_id AND c.history_id=h.id AND c.rn=1
 ), chained AS (
  SELECT e.*,ROW_NUMBER() OVER w AS position,
   LAG(after_status) OVER w AS prior_status,LAG(after_role) OVER w AS prior_role,
   LAG(after_campus_id) OVER w AS prior_campus,LAG(after_cell_id) OVER w AS prior_cell
  FROM effective e WINDOW w AS (PARTITION BY organization_id,generation,member_id ORDER BY occurred_at,sequence_id)
 )
 SELECT sequence_id,id,organization_id,generation,member_id,kind,
  CASE WHEN position=1 THEN before_status ELSE prior_status END AS before_status,
  CASE WHEN position=1 THEN before_role ELSE prior_role END AS before_role,
  CASE WHEN position=1 THEN before_campus_id ELSE prior_campus END AS before_campus_id,
  CASE WHEN position=1 THEN before_cell_id ELSE prior_cell END AS before_cell_id,
  after_status,after_role,after_campus_id,after_cell_id,actor_id,source,occurred_at,observed_at,correction_version,revised_at
 FROM chained`;
async function applySchema(db) { for (const sql of tables) await db.query(sql); await db.query(effectiveView); }
module.exports = { tables, effectiveView, applySchema };
