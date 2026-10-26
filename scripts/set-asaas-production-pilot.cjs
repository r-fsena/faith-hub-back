require('dotenv').config();
const { createAdminConnection } = require('./db-admin.cjs');

async function main() {
  const argument = process.argv[2];
  const disable = argument === '--disable';
  if (!disable && !/^[0-9a-f-]{36}$/i.test(argument || '')) {
    throw new Error('USAGE: npm run billing:pilot:asaas -- <proposal-id> | --disable');
  }

  const connection = await createAdminConnection();
  try {
    await connection.beginTransaction();
    let proposalId = null;
    if (!disable) {
      proposalId = argument;
      const [rows] = await connection.query(`SELECT p.id, p.status, p.cnpj_cpf, p.setup_fee,
        p.discount_type, p.monthly_amount, p.first_cycle_amount, p.created_organization_id,
        p.asaas_checkout_id, EXISTS(SELECT 1 FROM members m WHERE m.email = p.contact_email) AS email_in_use
        FROM saas_proposals p WHERE p.id = ? LIMIT 1 FOR UPDATE`, [proposalId]);
      if (!rows.length) throw new Error('PILOT_PROPOSAL_NOT_FOUND');
      const proposal = rows[0];
      if (proposal.status === 'PAID' || proposal.created_organization_id) throw new Error('PILOT_PROPOSAL_ALREADY_PROVISIONED');
      if (!proposal.cnpj_cpf) throw new Error('PILOT_PROPOSAL_DOCUMENT_REQUIRED');
      if (proposal.email_in_use) throw new Error('PILOT_ADMIN_EMAIL_ALREADY_ASSIGNED');
      if (Number(proposal.setup_fee || 0) > 0) throw new Error('PILOT_PROPOSAL_SETUP_FEE_NOT_SUPPORTED');
      if (['FIRST_MONTH_DISCOUNT', 'RECURRING_MONTHS_DISCOUNT'].includes(proposal.discount_type)) {
        throw new Error('PILOT_PROPOSAL_DISCOUNT_NOT_SUPPORTED');
      }
      if (proposal.asaas_checkout_id) throw new Error('PILOT_PROPOSAL_ALREADY_HAS_CHECKOUT');
      const recurringValue = proposal.discount_type === 'PERMANENT_DISCOUNT'
        ? Number(proposal.first_cycle_amount)
        : Number(proposal.monthly_amount);
      if (!Number.isFinite(recurringValue) || recurringValue < 5) throw new Error('PILOT_RECURRING_VALUE_BELOW_ASAAS_MINIMUM');
    }

    const config = disable
      ? { mode: 'disabled', allowedProposalIds: [] }
      : { mode: 'allowlist', allowedProposalIds: [proposalId], pilot: true, activatedAt: new Date().toISOString() };
    const [updated] = await connection.query(`UPDATE tenant_feature_flags
      SET is_enabled = ?, config_payload = ?, updated_by = 'asaas-production-pilot', updated_at = NOW()
      WHERE id = 'ff_global_saas_checkout'`, [disable ? 0 : 1, JSON.stringify(config)]);
    if (!updated.affectedRows) throw new Error('SAAS_CHECKOUT_FEATURE_FLAG_NOT_FOUND');

    await connection.query(`INSERT INTO security_audit_logs
      (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
      VALUES (UUID(), 'org_default', NULL, 'system@faithhubs.com', 'SYSTEM', ?,
        'tenant_feature_flags', 'system.saas_billing_checkout', ?, 'SUCCESS')`, [
      disable ? 'DISABLE_ASAAS_PRODUCTION_PILOT' : 'ENABLE_ASAAS_PRODUCTION_PILOT',
      JSON.stringify({ proposalId, config })
    ]);
    await connection.commit();
    console.log(JSON.stringify({ enabled: !disable, proposalId, mode: config.mode }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
