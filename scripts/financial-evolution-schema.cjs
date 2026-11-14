// New migration only: the published foundation schema and its checksum remain immutable.
const tables = [
`CREATE TABLE IF NOT EXISTS church_financial_operations (
 organization_id VARCHAR(100) NOT NULL,id CHAR(36) NOT NULL,kind VARCHAR(20) NOT NULL,
 settlement_id CHAR(36) NULL,transaction_id VARCHAR(100) NULL,amount_cents BIGINT UNSIGNED NOT NULL,
 occurred_on DATE NOT NULL,reason VARCHAR(240) NOT NULL,evidence_reference VARCHAR(255) NULL,
 request_hash CHAR(64) NOT NULL,created_by VARCHAR(100) NOT NULL,created_at DATETIME(6) NOT NULL,
 PRIMARY KEY(organization_id,id),KEY idx_fin_operation_settlement(organization_id,settlement_id),
 KEY idx_fin_operation_transaction(organization_id,transaction_id),KEY idx_fin_operation_date(organization_id,occurred_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
`CREATE TABLE IF NOT EXISTS church_financial_cash_movements (
 organization_id VARCHAR(100) NOT NULL,operation_id CHAR(36) NOT NULL,leg TINYINT NOT NULL,
 account_id CHAR(36) NOT NULL,campus_id VARCHAR(100) NOT NULL,amount_cents BIGINT NOT NULL,occurred_on DATE NOT NULL,
 PRIMARY KEY(organization_id,operation_id,leg),KEY idx_fin_movement_account(organization_id,account_id,occurred_on),
 KEY idx_fin_movement_scope(organization_id,campus_id,occurred_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
];
const base = require('./foundation-schema.cjs').reportingView;
const reportingView = base.replace(
 'SELECT organization_id,transaction_id,SUM(amount_cents) AS paid FROM church_financial_settlements GROUP BY organization_id,transaction_id',
 `SELECT s.organization_id,s.transaction_id,SUM(s.amount_cents)-COALESCE((SELECT SUM(o.amount_cents) FROM church_financial_operations o WHERE o.organization_id=s.organization_id AND o.transaction_id=s.transaction_id AND o.kind='CORRECTION'),0) AS paid FROM church_financial_settlements s GROUP BY s.organization_id,s.transaction_id`
) + `
 UNION ALL
 SELECT o.id,t.organization_id,t.campus_id,t.type,t.category,
 CONCAT(IF(o.kind='REFUND','Devolução: ','Correção: '),t.description),CAST(-CAST(o.amount_cents AS SIGNED)/100 AS DECIMAL(12,2)),
 t.payment_method,'PAID',t.member_id,t.member_name,t.project_id,t.origin_module,t.receipt_url,t.due_date,o.occurred_on,o.created_by,o.created_at,o.created_at,t.ledger_version,o.kind,t.account_id,t.id
 FROM church_financial_operations o INNER JOIN church_financial_transactions t ON t.organization_id=o.organization_id AND t.id=o.transaction_id
 WHERE o.kind IN ('CORRECTION','REFUND')`;
module.exports = {tables,reportingView};
