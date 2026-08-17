// Serviço de Provisionamento 100% Automático de Igrejas e Usuários
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db';

const USER_POOL_ID = process.env.USER_POOL_ID || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-2';

const cognitoClient = new CognitoIdentityProviderClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  }
});

export class ProvisioningService {
  static async provisionFromProposal(proposalId: string) {
    console.log(`🚀 Iniciando provisionamento automático para a proposta: ${proposalId}`);

    // 1. Busca a proposta no banco
    const { rows: proposalRows } = await query(`SELECT * FROM saas_proposals WHERE id = ? LIMIT 1`, [proposalId]);
    if (proposalRows.length === 0) {
      throw new Error(`Proposta ${proposalId} não encontrada.`);
    }

    const proposal = proposalRows[0];

    // Se já foi provisionada, retorna os dados existentes
    if (proposal.created_organization_id) {
      console.log(`⚠️ Proposta já provisionada anteriormente para org: ${proposal.created_organization_id}`);
      return {
        already_provisioned: true,
        organization_id: proposal.created_organization_id,
        church_name: proposal.church_name
      };
    }

    // 2. Define o Slug e IDs da nova Organização
    const baseSlug = (proposal.suggested_slug || proposal.church_name)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || `igreja-${Date.now().toString().slice(-4)}`;

    // Garante que o slug é único
    let finalSlug = baseSlug;
    const { rows: existingOrgs } = await query(`SELECT id FROM organizations WHERE slug = ?`, [finalSlug]);
    if (existingOrgs.length > 0) {
      finalSlug = `${baseSlug}-${Math.floor(100 + Math.random() * 900)}`;
    }

    const orgId = `org_${finalSlug.replace(/-/g, '_')}_${Date.now().toString().slice(-4)}`;
    const churchSettingsId = `settings_${finalSlug.replace(/-/g, '_')}`;
    const campusId = `campus_${finalSlug.replace(/-/g, '_')}_sede`;

    // 3. Cria a Organização no MySQL
    await query(`
      INSERT INTO organizations (
        id, name, slug, cnpj, plan, status, primary_color, secondary_color
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', '#0f766e', '#14b8a6')
    `, [
      orgId,
      proposal.church_name,
      finalSlug,
      proposal.cnpj_cpf || null,
      proposal.plan_tier || 'PRO'
    ]);

    // 4. Cria as Configurações da Igreja (church_settings)
    await query(`
      INSERT INTO church_settings (
        id, church_name, slogan, cnpj, pastor_name, phone, whatsapp, email,
        primary_color, secondary_color, pwa_theme_color, pwa_short_name, pwa_slug,
        organization_id, campus_id, offline_mode
      ) VALUES (?, ?, '', ?, ?, ?, ?, ?, '#0f766e', '#14b8a6', '#0f766e', ?, ?, ?, ?, 0)
    `, [
      churchSettingsId,
      proposal.church_name,
      proposal.cnpj_cpf || '',
      proposal.contact_name,
      proposal.contact_phone || '',
      proposal.contact_phone || '',
      proposal.contact_email,
      proposal.church_name.slice(0, 12),
      finalSlug,
      orgId,
      campusId
    ]);

    // 5. Cria a Congregação Sede Principal (campuses)
    await query(`
      INSERT INTO campuses (
        id, organization_id, name, slug, pastor_name, phone, whatsapp, email, address, city, state, is_headquarters, status
      ) VALUES (?, ?, 'Sede Principal', 'sede', ?, ?, ?, ?, '', '', '', 1, 'ACTIVE')
      ON DUPLICATE KEY UPDATE name = VALUES(name)
    `, [
      campusId,
      orgId,
      proposal.contact_name,
      proposal.contact_phone || '',
      proposal.contact_phone || '',
      proposal.contact_email
    ]);

    // 6. Cria o Usuário Administrador no AWS Cognito com envio de convite por e-mail
    let cognitoUserId = uuidv4();
    try {
      if (USER_POOL_ID) {
        const command = new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: proposal.contact_email,
          UserAttributes: [
            { Name: 'email', Value: proposal.contact_email },
            { Name: 'name', Value: proposal.contact_name },
            { Name: 'email_verified', Value: 'true' }
          ],
          DesiredDeliveryMediums: ['EMAIL']
        });

        const cognitoRes = await cognitoClient.send(command);
        cognitoUserId = cognitoRes.User?.Username || cognitoUserId;
        console.log(`✅ Usuário administrador criado no Cognito: ${cognitoUserId} (${proposal.contact_email})`);
      }
    } catch (cognitoErr: any) {
      console.warn(`Cognito Create User (pode já existir):`, cognitoErr.message);
    }

    // 7. Registra o Administrador na tabela members
    await query(`
      INSERT INTO members (
        id, name, email, role, status, phone, organization_id, campus_id, campus_ids
      ) VALUES (?, ?, ?, 'ADMIN', 'Ativo', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        organization_id = VALUES(organization_id),
        role = 'ADMIN',
        status = 'Ativo'
    `, [
      cognitoUserId,
      proposal.contact_name,
      proposal.contact_email,
      proposal.contact_phone || null,
      orgId,
      campusId,
      JSON.stringify([campusId])
    ]);

    // 8. Cria registro de Assinatura Recorrente ativa (saas_subscriptions)
    const subscriptionId = proposal.asaas_subscription_id || `sub_${uuidv4()}`;
    await query(`
      INSERT INTO saas_subscriptions (
        id, organization_id, customer_id, proposal_id, church_name, status, value, cycle, billing_type, next_due_date
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, 'PIX', DATE_ADD(CURDATE(), INTERVAL 1 MONTH))
      ON DUPLICATE KEY UPDATE status = 'ACTIVE', updated_at = NOW()
    `, [
      subscriptionId,
      orgId,
      proposal.asaas_customer_id || null,
      proposal.id,
      proposal.church_name,
      proposal.monthly_amount || 297.00,
      proposal.billing_cycle || 'MONTHLY'
    ]);

    // 9. Atualiza o status da proposta para PAID / CONVERTIDA
    await query(`
      UPDATE saas_proposals 
      SET status = 'PAID',
          created_organization_id = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [orgId, proposal.id]);

    console.log(`🎉 Provisionamento concluído com sucesso!`);
    console.log(`- Organização: ${orgId} (${proposal.church_name})`);
    console.log(`- Slug PWA: ${finalSlug} -> https://app.faithhubs.com/${finalSlug}`);
    console.log(`- Admin Studio: ${proposal.contact_email} -> https://studio.faithhubs.com`);

    return {
      success: true,
      organization_id: orgId,
      slug: finalSlug,
      pwa_url: `https://app.faithhubs.com/${finalSlug}`,
      studio_url: 'https://studio.faithhubs.com',
      admin_email: proposal.contact_email,
      church_name: proposal.church_name
    };
  }
}
