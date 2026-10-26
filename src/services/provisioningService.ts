import crypto from 'crypto';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import { getConnection } from '../db';
import { seedDefaultMinistries } from './ministrySeedService';

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-2' });

function slugify(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export class ProvisioningService {
  static async provisionFromProposal(proposalId: string) {
    const connection = await getConnection();
    try {
      await connection.beginTransaction();
      const [proposalRows] = await connection.query(
        'SELECT * FROM saas_proposals WHERE id = ? LIMIT 1 FOR UPDATE',
        [proposalId]
      ) as any;
      if (!proposalRows.length) throw new Error('PROPOSAL_NOT_FOUND');
      const proposal = proposalRows[0];

      if (proposal.created_organization_id) {
        await connection.commit();
        return {
          already_provisioned: true,
          organization_id: proposal.created_organization_id,
          church_name: proposal.church_name,
          pwa_url: `https://app.faithhubs.com/${proposal.suggested_slug || ''}`
        };
      }

      if (!proposal.asaas_subscription_id) throw new Error('VERIFIED_ASAAS_SUBSCRIPTION_REQUIRED');
      const [verifiedRows] = await connection.query(
        `SELECT id FROM saas_subscriptions
         WHERE id = ? AND proposal_id = ? AND is_verified = 1 LIMIT 1`,
        [proposal.asaas_subscription_id, proposal.id]
      ) as any;
      if (!verifiedRows.length) throw new Error('VERIFIED_ASAAS_SUBSCRIPTION_REQUIRED');

      const digest = crypto.createHash('sha256').update(proposal.id).digest('hex').slice(0, 16);
      const orgId = `org_${digest}`;
      const campusId = `campus_${digest}`;
      const churchSettingsId = `settings_${digest}`;
      const baseSlug = slugify(proposal.suggested_slug || proposal.church_name) || `igreja-${digest.slice(0, 6)}`;
      let finalSlug = baseSlug;
      const [slugRows] = await connection.query(
        'SELECT id FROM organizations WHERE slug = ? AND id <> ? LIMIT 1', [baseSlug, orgId]
      ) as any;
      if (slugRows.length) finalSlug = `${baseSlug.slice(0, 72)}-${digest.slice(0, 6)}`;

      const [memberRows] = await connection.query(
        'SELECT id, organization_id FROM members WHERE email = ? LIMIT 1 FOR UPDATE',
        [proposal.contact_email]
      ) as any;
      if (memberRows.length && memberRows[0].organization_id !== orgId) {
        throw new Error('ADMIN_EMAIL_ALREADY_ASSIGNED_TO_ANOTHER_TENANT');
      }

      let cognitoUserId = memberRows[0]?.id || uuidv4();
      if (!memberRows.length && USER_POOL_ID) {
        const userAttributes: Array<{ Name: string; Value: string }> = [
          { Name: 'email', Value: proposal.contact_email },
          { Name: 'name', Value: proposal.contact_name },
          { Name: 'email_verified', Value: 'true' }
        ];
        if (proposal.contact_phone) {
          const cleanPhone = String(proposal.contact_phone).replace(/\D/g, '');
          if (cleanPhone.length >= 10) {
            const e164 = cleanPhone.startsWith('55') ? `+${cleanPhone}` : `+55${cleanPhone}`;
            userAttributes.push({ Name: 'phone_number', Value: e164 });
          }
        }
        try {
          const response = await cognitoClient.send(new AdminCreateUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: proposal.contact_email,
            UserAttributes: userAttributes,
            DesiredDeliveryMediums: ['EMAIL']
          }));
          cognitoUserId = response.User?.Username || cognitoUserId;
        } catch (error: any) {
          if (error?.name !== 'UsernameExistsException') throw error;
          const existing = await cognitoClient.send(new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: proposal.contact_email
          }));
          cognitoUserId = existing.UserAttributes?.find(attribute => attribute.Name === 'sub')?.Value || '';
          if (!cognitoUserId || cognitoUserId.length > 36) throw new Error('COGNITO_SUB_NOT_FOUND');
        }
      }

      await connection.query(`INSERT INTO organizations
        (id, name, slug, cnpj, plan, status, primary_color, secondary_color)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', '#0f766e', '#14b8a6')`, [
        orgId, proposal.church_name, finalSlug, proposal.cnpj_cpf || null, proposal.plan_tier || 'PRO'
      ]);
      await connection.query(`INSERT INTO campuses
        (id, organization_id, name, slug, pastor_name, phone, whatsapp, email, address, city, state, is_headquarters, status)
        VALUES (?, ?, ?, 'sede', ?, ?, ?, ?, '', '', '', 1, 'ACTIVE')`, [
        campusId, orgId, `${proposal.church_name} - Sede`, proposal.contact_name,
        proposal.contact_phone || '', proposal.contact_phone || '', proposal.contact_email
      ]);
      await connection.query(`INSERT INTO church_settings
        (id, church_name, slogan, cnpj, pastor_name, phone, whatsapp, email,
         primary_color, secondary_color, pwa_theme_color, pwa_short_name, pwa_slug,
         organization_id, campus_id, offline_mode)
        VALUES (?, ?, '', ?, ?, ?, ?, ?, '#0f766e', '#14b8a6', '#0f766e', ?, ?, ?, ?, 0)`, [
        churchSettingsId, proposal.church_name, proposal.cnpj_cpf || '', proposal.contact_name,
        proposal.contact_phone || '', proposal.contact_phone || '', proposal.contact_email,
        proposal.church_name.slice(0, 12), finalSlug, orgId, campusId
      ]);
      await connection.query(`INSERT INTO members
        (id, name, email, role, status, phone, organization_id, campus_id, campus_ids)
        VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', ?, ?, ?, ?)`, [
        cognitoUserId, proposal.contact_name, proposal.contact_email, proposal.contact_phone || null,
        orgId, campusId, JSON.stringify([campusId])
      ]);
      await connection.query(`UPDATE saas_subscriptions SET organization_id = ?, status = 'ACTIVE',
        updated_at = NOW() WHERE id = ? AND proposal_id = ?`, [
        orgId, proposal.asaas_subscription_id, proposal.id
      ]);
      await connection.query(`UPDATE saas_invoices SET organization_id = ?
        WHERE subscription_id = ? AND organization_id IS NULL`, [orgId, proposal.asaas_subscription_id]);
      await connection.query(`UPDATE saas_proposals SET status = 'PAID', billing_status = 'PAID',
        created_organization_id = ?, updated_at = NOW() WHERE id = ?`, [orgId, proposal.id]);

      const executor = async (sql: string, params?: any[]) => connection.query(sql, params);
      await seedDefaultMinistries(orgId, campusId, executor, true);
      await connection.query(`INSERT INTO security_audit_logs
        (id, organization_id, user_id, user_email, user_role, action, resource, resource_id, details, status)
        VALUES (?, ?, NULL, 'system@faithhubs.com', 'SYSTEM', 'PROVISION_SAAS_TENANT',
          'organizations', ?, ?, 'SUCCESS')`, [
        uuidv4(), orgId, orgId, JSON.stringify({ proposalId, subscriptionId: proposal.asaas_subscription_id })
      ]);
      await connection.commit();

      return {
        success: true,
        organization_id: orgId,
        slug: finalSlug,
        pwa_url: `https://app.faithhubs.com/${finalSlug}`,
        studio_url: 'https://studio.faithhubs.com',
        admin_email: proposal.contact_email,
        church_name: proposal.church_name
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
