const tables=[`CREATE TABLE IF NOT EXISTS intelligence_reports (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,campus_id VARCHAR(100) NULL,
 requested_by VARCHAR(100) NOT NULL,requester_organization_id VARCHAR(100) NOT NULL,
 model VARCHAR(20) NOT NULL,period_json JSON NOT NULL,scope_json JSON NOT NULL,access_json JSON NOT NULL,
 status VARCHAR(24) NOT NULL DEFAULT 'QUEUED',delivery_state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 request_hash CHAR(64) NOT NULL,definition_version VARCHAR(40) NOT NULL,contains_digital TINYINT NOT NULL DEFAULT 0,
 attempts INT NOT NULL DEFAULT 0,lease_token CHAR(36) NULL,lease_until DATETIME NULL,
 result_json JSON NULL,error_code VARCHAR(60) NULL,created_at DATETIME(6) NOT NULL,updated_at DATETIME(6) NOT NULL,expires_at DATETIME NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_report_owner(organization_id,requested_by,created_at),
 KEY idx_report_dispatch(organization_id,status,delivery_state),KEY idx_report_expiry(organization_id,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`];
const triggers=[`CREATE TRIGGER fh_reports_consent_update AFTER UPDATE ON intelligence_consent FOR EACH ROW BEGIN
 IF OLD.allowed<>NEW.allowed OR OLD.policy_version<>NEW.policy_version OR OLD.revision<>NEW.revision THEN
 UPDATE intelligence_reports SET status='ACCESS_REVOKED',error_code='PRIVACY_REVIEW',updated_at=UTC_TIMESTAMP(6)
 WHERE organization_id=OLD.organization_id AND contains_digital=1 AND status IN ('QUEUED','GENERATING','READY','READY_WITH_NOTES'); END IF; END`,
 `CREATE TRIGGER fh_reports_consent_delete AFTER DELETE ON intelligence_consent FOR EACH ROW BEGIN
 UPDATE intelligence_reports SET status='ACCESS_REVOKED',error_code='PRIVACY_REVIEW',updated_at=UTC_TIMESTAMP(6)
 WHERE organization_id=OLD.organization_id AND contains_digital=1 AND status IN ('QUEUED','GENERATING','READY','READY_WITH_NOTES'); END`];
module.exports={tables,triggers};
