// Additive schema shared by migration and isolated integration verification.
const tables=[
`CREATE TABLE IF NOT EXISTS church_financial_ledger_rollout (organization_id VARCHAR(100) PRIMARY KEY,activated_at DATETIME NOT NULL,activated_by VARCHAR(100) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS member_history_coverage (
 organization_id VARCHAR(100) PRIMARY KEY,generation CHAR(36) NOT NULL,flag_id VARCHAR(100) NOT NULL,flag_updated_at DATETIME(6) NOT NULL,
 invalidated_at DATETIME(6) NULL,started_at DATETIME(6) NOT NULL,started_by VARCHAR(100) NULL,created_at DATETIME(6) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS member_state_history (
 sequence_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,id CHAR(36) NOT NULL,organization_id VARCHAR(100) NOT NULL,generation CHAR(36) NOT NULL,
 member_id VARCHAR(100) NOT NULL,kind VARCHAR(16) NOT NULL,
 before_status VARCHAR(100) NULL,after_status VARCHAR(100) NULL,before_role VARCHAR(100) NULL,after_role VARCHAR(100) NULL,
 before_campus_id VARCHAR(100) NULL,after_campus_id VARCHAR(100) NULL,before_cell_id VARCHAR(100) NULL,after_cell_id VARCHAR(100) NULL,
 actor_id VARCHAR(100) NULL,source VARCHAR(40) NOT NULL,request_id VARCHAR(100) NULL,occurred_at DATETIME(6) NOT NULL,
 UNIQUE KEY uq_member_history_event(organization_id,id),KEY idx_member_history_date(organization_id,occurred_at),
 KEY idx_member_history_state(organization_id,generation,member_id,sequence_id),KEY idx_member_history_scope(organization_id,after_campus_id,after_cell_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
`CREATE TABLE IF NOT EXISTS church_financial_accounts (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,name VARCHAR(80) NOT NULL,currency CHAR(3) NOT NULL DEFAULT 'BRL',
 opening_on DATE NOT NULL,opening_balance_cents BIGINT NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',version INT NOT NULL DEFAULT 0,
 request_hash CHAR(64) NOT NULL,created_by VARCHAR(100) NOT NULL,created_at DATETIME NOT NULL,updated_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_fin_accounts_scope(organization_id,campus_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE IF NOT EXISTS church_financial_settlements (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,transaction_id VARCHAR(100) NOT NULL,account_id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,
 amount_cents BIGINT UNSIGNED NOT NULL,settled_on DATE NOT NULL,request_hash CHAR(64) NOT NULL,created_by VARCHAR(100) NOT NULL,created_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_fin_settlement_transaction(organization_id,transaction_id),KEY idx_fin_settlement_date(organization_id,campus_id,settled_on),
 KEY idx_fin_settlement_account(organization_id,account_id,settled_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
const columns={ledger_version:'TINYINT NOT NULL DEFAULT 0',financial_kind:"VARCHAR(32) NOT NULL DEFAULT 'LEGACY_UNCLASSIFIED'",account_id:'CHAR(36) NULL',ledger_lock_version:'INT NOT NULL DEFAULT 0',ledger_request_hash:'CHAR(64) NULL'};
const reportingView=`CREATE OR REPLACE VIEW church_financial_reporting_transactions AS
 SELECT t.id,t.organization_id,t.campus_id,t.type,t.category,t.description,t.amount,t.payment_method,t.status,t.member_id,t.member_name,t.project_id,t.origin_module,t.receipt_url,t.due_date,t.payment_date,t.created_by,t.created_at,t.updated_at,t.ledger_version,t.financial_kind,t.account_id,t.id AS original_transaction_id
 FROM church_financial_transactions t WHERE t.ledger_version=0
 UNION ALL
 SELECT s.id,t.organization_id,t.campus_id,t.type,t.category,t.description,CAST(s.amount_cents/100 AS DECIMAL(12,2)),t.payment_method,'PAID',t.member_id,t.member_name,t.project_id,t.origin_module,t.receipt_url,t.due_date,s.settled_on,t.created_by,s.created_at,t.updated_at,t.ledger_version,t.financial_kind,t.account_id,t.id
 FROM church_financial_transactions t INNER JOIN church_financial_settlements s ON s.organization_id=t.organization_id AND s.transaction_id=t.id WHERE t.ledger_version=1
 UNION ALL
 SELECT t.id,t.organization_id,t.campus_id,t.type,t.category,t.description,
 CAST(GREATEST(0,ROUND(t.amount*100)-COALESCE(s.paid,0))/100 AS DECIMAL(12,2)),t.payment_method,IF(t.status='CANCELLED','CANCELLED','PENDING'),t.member_id,t.member_name,t.project_id,t.origin_module,t.receipt_url,t.due_date,t.payment_date,t.created_by,t.created_at,t.updated_at,t.ledger_version,t.financial_kind,t.account_id,t.id
 FROM church_financial_transactions t LEFT JOIN (SELECT organization_id,transaction_id,SUM(amount_cents) AS paid FROM church_financial_settlements GROUP BY organization_id,transaction_id) s ON s.organization_id=t.organization_id AND s.transaction_id=t.id
 WHERE t.ledger_version=1 AND (t.status='CANCELLED' OR ROUND(t.amount*100)>COALESCE(s.paid,0))`;
function trigger(kind){const row=kind==='DELETE'?'OLD':'NEW',before=kind==='INSERT'?null:'OLD',after=kind==='DELETE'?null:'NEW';
 const value=(alias,column)=>alias?`${alias}.${column}`:'NULL';
 const changed=kind==='UPDATE'?` AND NOT (OLD.status <=> NEW.status AND OLD.role <=> NEW.role AND OLD.campus_id <=> NEW.campus_id AND OLD.cell_group_id <=> NEW.cell_group_id)`:'';
 const prefix=kind==='UPDATE'?`IF NOT(OLD.organization_id <=> NEW.organization_id) AND EXISTS(SELECT 1 FROM member_history_coverage WHERE organization_id=OLD.organization_id) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TRACKED_MEMBER_TENANT_CHANGE_FORBIDDEN'; END IF;`:'';
 return `CREATE TRIGGER fh_member_history_${kind.toLowerCase()} AFTER ${kind} ON members FOR EACH ROW
 BEGIN ${prefix}
 INSERT INTO member_state_history(id,organization_id,generation,member_id,kind,before_status,after_status,before_role,after_role,before_campus_id,after_campus_id,before_cell_id,after_cell_id,actor_id,source,request_id,occurred_at)
 SELECT UUID(),${row}.organization_id,c.generation,${row}.id,'${kind==='INSERT'?'CREATED':kind==='DELETE'?'REMOVED':'CHANGED'}',
 ${value(before,'status')},${value(after,'status')},${value(before,'role')},${value(after,'role')},${value(before,'campus_id')},${value(after,'campus_id')},${value(before,'cell_group_id')},${value(after,'cell_group_id')},
 IF(@fh_history_org=${row}.organization_id,@fh_history_actor,NULL),IF(@fh_history_org=${row}.organization_id,COALESCE(@fh_history_source,'DATABASE'),'DATABASE'),
 IF(@fh_history_org=${row}.organization_id,@fh_history_request,NULL),UTC_TIMESTAMP(6)
 FROM member_history_coverage c INNER JOIN tenant_feature_flags f ON f.id=c.flag_id AND f.organization_id=c.organization_id
 WHERE c.organization_id=${row}.organization_id AND f.feature_key='intelligence.history' AND f.is_enabled=1 AND f.campus_id IS NULL
 AND f.environment='production' AND f.updated_at=c.flag_updated_at AND c.invalidated_at IS NULL${changed};
 END`;
}
const triggers=['INSERT','UPDATE','DELETE'].map(trigger);
triggers.push(`CREATE TRIGGER fh_member_history_flag_update AFTER UPDATE ON tenant_feature_flags FOR EACH ROW BEGIN
 IF OLD.feature_key='intelligence.history' AND (NOT(OLD.is_enabled <=> NEW.is_enabled) OR NOT(OLD.organization_id <=> NEW.organization_id) OR NOT(OLD.campus_id <=> NEW.campus_id) OR NOT(OLD.environment <=> NEW.environment) OR NOT(OLD.feature_key <=> NEW.feature_key)) THEN
 UPDATE member_history_coverage SET invalidated_at=UTC_TIMESTAMP(6) WHERE organization_id=OLD.organization_id AND flag_id=OLD.id; END IF; END`);
triggers.push(`CREATE TRIGGER fh_member_history_flag_delete AFTER DELETE ON tenant_feature_flags FOR EACH ROW BEGIN
 IF OLD.feature_key='intelligence.history' THEN UPDATE member_history_coverage SET invalidated_at=UTC_TIMESTAMP(6) WHERE organization_id=OLD.organization_id AND flag_id=OLD.id; END IF; END`);
async function initializeHistoryBaseline(db,org,actor){
 const [flags]=await db.query("SELECT id,updated_at FROM tenant_feature_flags WHERE organization_id = ? AND feature_key='intelligence.history' AND campus_id IS NULL AND environment='production' AND is_enabled=1 LIMIT 1 FOR UPDATE",[org]);
 if(!flags.length)throw Error('HISTORY_PRODUCTION_OVERRIDE_REQUIRED');
 // Lock the tenant range before observing the baseline, so concurrent edits/inserts follow it.
 await db.query('SELECT id FROM members WHERE organization_id = ? FOR UPDATE',[org]);
 const generation=require('node:crypto').randomUUID();
 await db.query(`INSERT INTO member_history_coverage(organization_id,generation,flag_id,flag_updated_at,started_at,started_by,created_at,invalidated_at)
 VALUES(?,?,?,?,UTC_TIMESTAMP(6),?,UTC_TIMESTAMP(6),NULL) ON DUPLICATE KEY UPDATE generation=VALUES(generation),flag_id=VALUES(flag_id),flag_updated_at=VALUES(flag_updated_at),started_at=VALUES(started_at),started_by=VALUES(started_by),invalidated_at=NULL`,[org,generation,flags[0].id,flags[0].updated_at,actor||null]);
 await db.query(`INSERT INTO member_state_history(id,organization_id,generation,member_id,kind,after_status,after_role,after_campus_id,after_cell_id,actor_id,source,occurred_at)
 SELECT UUID(),organization_id,?,id,'BASELINE',status,role,campus_id,cell_group_id,?,'BASELINE',UTC_TIMESTAMP(6) FROM members WHERE organization_id = ?`,[generation,actor||null,org]);
 return generation;
}
module.exports={tables,columns,reportingView,triggers,initializeHistoryBaseline};
