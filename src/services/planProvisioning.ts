import { createHash } from 'crypto';
import { PlanContract } from './planCatalog';

/** Must use the same transaction as the organization creation. Existing tenants are never mass migrated. */
export async function initializePlanEntitlements(
  organizationId: string,
  contract: PlanContract,
  execute: (sql: string, params: any[]) => Promise<any>
): Promise<void> {
  await execute('UPDATE organizations SET plan_contract = ? WHERE id = ?', [JSON.stringify(contract), organizationId]);
  for (const [key, enabled] of Object.entries(contract.entitlements)) {
    const id = createHash('sha256').update(`${organizationId}:plan:${key}`).digest('hex').slice(0, 36);
    await execute(`INSERT INTO tenant_feature_flags
      (id, organization_id, campus_id, environment, feature_key, is_enabled, category, description, updated_by)
      VALUES (?, ?, NULL, 'all', ?, ?, 'Plano contratado', ?, 'Plan provisioning')
      ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [id, organizationId, key, enabled ? 1 : 0, `${contract.name} — ${key}`]);
  }
}
