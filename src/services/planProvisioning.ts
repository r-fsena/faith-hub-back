import { createHash, randomUUID } from 'crypto';
import { logSecurityEvent } from './auditLogService';
import { PlanContract } from './planCatalog';

/** Must use the same transaction as the organization creation. Existing tenants are never mass migrated. */
export async function initializePlanEntitlements(
  organizationId: string,
  contract: PlanContract,
  execute: (sql: string, params: any[]) => Promise<any>
): Promise<void> {
  await execute('UPDATE organizations SET plan_contract = ? WHERE id = ?', [JSON.stringify(contract), organizationId]);
  for (const [key, enabled] of Object.entries(contract.entitlements)) {
    // General availability follows the saved contract; source modules remain independently gated.
    const initiallyEnabled=enabled;
    const id = createHash('sha256').update(`${organizationId}:plan:${key}`).digest('hex').slice(0, 36);
    await execute(`INSERT INTO tenant_feature_flags
      (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
      VALUES (?, ?, NULL, '${key==='intelligence.history'?'production':'all'}', ?, ?, 'Plano contratado', ?, 'Plan provisioning')
      ON DUPLICATE KEY UPDATE updated_at=IF(is_enabled<>VALUES(is_enabled),NOW(),updated_at), is_enabled = VALUES(is_enabled), updated_by = VALUES(updated_by)`,
    [id, organizationId, key, initiallyEnabled ? 1 : 0, `${contract.name} — ${key}`]);
  }
  if(contract.entitlements['intelligence.history']){
    const generation=randomUUID();
    await execute(`INSERT INTO member_history_coverage(organization_id,generation,flag_id,flag_updated_at,started_at,started_by,created_at)
      SELECT f.organization_id,?,f.id,f.updated_at,UTC_TIMESTAMP(6),NULL,UTC_TIMESTAMP(6) FROM tenant_feature_flags f LEFT JOIN member_history_coverage c ON c.organization_id=f.organization_id WHERE f.organization_id = ? AND f.feature_key='intelligence.history' AND f.campus_id IS NULL AND f.environment='production' AND f.is_enabled=1 AND (c.organization_id IS NULL OR c.invalidated_at IS NOT NULL OR c.flag_id<>f.id OR c.flag_updated_at<>f.updated_at) ON DUPLICATE KEY UPDATE generation=VALUES(generation),flag_id=VALUES(flag_id),flag_updated_at=VALUES(flag_updated_at),started_at=VALUES(started_at),invalidated_at=NULL`,[generation,organizationId]);
    await execute(`INSERT INTO member_state_history(id,organization_id,generation,member_id,kind,after_status,after_role,after_campus_id,after_cell_id,source,occurred_at)
      SELECT UUID(),m.organization_id,c.generation,m.id,'BASELINE',m.status,m.role,m.campus_id,m.cell_group_id,'BASELINE',UTC_TIMESTAMP(6) FROM members m INNER JOIN member_history_coverage c ON c.organization_id=m.organization_id AND c.generation=? WHERE m.organization_id = ?`,[generation,organizationId]);
  }
  if(contract.entitlements['financial.accounts_ledger'])await execute('INSERT IGNORE INTO church_financial_ledger_rollout(organization_id,activated_at,activated_by) VALUES(?,UTC_TIMESTAMP(),?)',[organizationId,'Plan provisioning']);
  await logSecurityEvent({organizationId,action:'PROVISION_CONTRACT_ENTITLEMENTS',resource:'organizations',resourceId:organizationId,details:{plan:contract.plan_id,generalAvailability:true},strict:true,executor:execute});
}
