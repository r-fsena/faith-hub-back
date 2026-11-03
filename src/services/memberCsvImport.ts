import { randomBytes } from 'crypto';
import { AdminCreateUserCommand, AdminGetUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { query } from '../db';
import { normalizeRole, type AuthUser } from './authMiddleware';
import { evaluateTenantFlags } from './featureFlagService';
import { logSecurityEvent } from './auditLogService';

export const IMPORT_INVITATIONS_FLAG = 'system.saas_member_import_invitations';
const text = (value: unknown) => String(value ?? '').trim();
const normalized = (value: unknown) => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ranks = ['MEMBER', 'VOLUNTEER', 'LEADER', 'TREASURER', 'ADMIN', 'PASTOR', 'SUPERADMIN'];

// Resolve only against records already fetched within the authenticated organization.
export function resolveImportRecord(records: any[], value: unknown, kind: string) {
  const key = normalized(value);
  const byId = records.find(record => text(record.id) === text(value));
  if (byId) return byId;
  const matches = records.filter(record => normalized(record.name) === key);
  if (matches.length !== 1) throw Error(matches.length ? `${kind} com nome repetido. Informe o código.` : `${kind} não encontrada nesta igreja.`);
  return matches[0];
}

export async function importMemberRows(body: any, user: AuthUser, orgId: string, cognito: { send: (command: any) => Promise<any> }, poolId: string, event: any) {
  const rows = body.members;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw Error('Envie entre 1 e 100 membros por lote.');
  if (body.send_invitations !== undefined && typeof body.send_invitations !== 'boolean') throw Error('Opção de convites inválida.');
  if (body.resend_pending_invitations !== undefined && typeof body.resend_pending_invitations !== 'boolean') throw Error('Opção de reenvio inválida.');
  const send = body.send_invitations === true;
  const resend = send && body.resend_pending_invitations === true;
  {
    const evaluated = await evaluateTenantFlags(orgId, null, 'production');
    if (send && !evaluated.flags[IMPORT_INVITATIONS_FLAG]) throw Error('Envio de convites na importação indisponível para esta igreja.');
    if (evaluated.contract_version && !evaluated.flags['members.module_enabled']) throw Error('Gestão de membros indisponível neste plano.');
  }
  const { rows: organizations } = await query('SELECT id, name, slug FROM organizations WHERE id = ?', [orgId]);
  if (!organizations.length) throw Error('Igreja não encontrada.');
  const org = organizations[0];
  const { rows: campuses } = await query('SELECT id, name FROM campuses WHERE organization_id = ?', [orgId]);
  const { rows: cells } = await query('SELECT id, name, campus_id FROM cell_groups WHERE organization_id = ?', [orgId]);
  const results = { total: rows.length, created: 0, updated: 0, invitations_requested: 0, invitations_skipped: 0,
    invitation_errors: [] as any[], errors: [] as any[] };
  const seen = new Set<string>();
  const deadline = Date.now() + 21000;
  for (const item of rows) {
    const email = text(item.email).toLowerCase();
    const name = text(item.name);
    let createdCognito = false;
    let saved = false;
    try {
      if (Date.now() > deadline) throw Error('Linha não processada pelo limite de tempo. Importe esta linha novamente.');
      if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Nome e e-mail válidos são obrigatórios.');
      if (seen.has(email)) throw Error('E-mail repetido no lote.');
      seen.add(email);
      if (item.organization_name && ![org.id, org.name, org.slug].some(value => normalized(value) === normalized(item.organization_name))) throw Error('A igreja da linha difere do ambiente selecionado.');
      const { rows: existing } = await query('SELECT id, role, campus_id, campus_ids, cell_group_id FROM members WHERE LOWER(email) = ? AND organization_id = ? LIMIT 1', [email, orgId]);
      const previous = existing[0];
      const canUseCampus = (id: string) => user.isSuperAdmin || user.campusIds.includes('all') || user.campusIds.includes(id);
      if (previous) {
        let linked = [previous.campus_id];
        try { linked = [...linked, ...JSON.parse(typeof previous.campus_ids === 'string' ? previous.campus_ids : JSON.stringify(previous.campus_ids || []))]; } catch {}
        if (linked.filter(Boolean).some(id => !canUseCampus(id))) throw Error('Sem permissão para atualizar este membro em outra unidade.');
        if (!user.isSuperAdmin && ranks.indexOf(normalizeRole(previous.role)) > ranks.indexOf(user.role)) throw Error('Sem permissão para alterar este perfil.');
      }
      const campus = resolveImportRecord(campuses, item.campus_id || item.campus_name || previous?.campus_id || body.campus_id, 'Unidade');
      if (!canUseCampus(campus.id)) throw Error('Sem permissão para importar nesta unidade.');
      const role = normalizeRole(item.role || previous?.role || 'MEMBER');
      if (!ranks.includes(role) || (!user.isSuperAdmin && ranks.indexOf(role) > ranks.indexOf(user.role))) throw Error('Sem permissão para conceder este papel.');
      const cellValue = item.cell_id || item.cell_name;
      const cellId = cellValue ? resolveImportRecord(cells.filter(cell => !cell.campus_id || cell.campus_id === campus.id), cellValue, 'Célula').id : previous?.cell_group_id || null;
      if (!cellValue && previous?.cell_group_id && (item.campus_name || item.campus_id) && campus.id !== previous.campus_id) throw Error('Informe a célula da nova unidade ou ajuste o cadastro antes de transferir.');
      let cognitoId = previous?.id;
      if (!previous) {
        try {
          const response = await cognito.send(new AdminCreateUserCommand({UserPoolId: poolId, Username: email,
            TemporaryPassword: !send && text(body.defaultPassword) ? body.defaultPassword : `Fh1!${randomBytes(24).toString('hex')}`,
            UserAttributes: [{Name:'email',Value:email},{Name:'name',Value:name},{Name:'email_verified',Value:'true'}], MessageAction:'SUPPRESS'}));
          cognitoId = response.User?.Username;
          createdCognito = true;
          if (!cognitoId) throw Error('Não foi possível confirmar a criação do acesso.');
        } catch (error: any) {
          if (error.name === 'UsernameExistsException') throw Error('Este e-mail já possui acesso. Confira o vínculo existente antes de importar em outra igreja.');
          throw Error('Não foi possível criar o acesso. Revise o e-mail e tente novamente.');
        }
      }
      const birth = text(item.birth_date);
      const birthDate = /^\d{2}\/\d{2}\/\d{4}$/.test(birth) ? birth.split('/').reverse().join('-') : birth || null;
      const address = ['address_street','address_number','address_complement','address_neighborhood','address_city','address_state','address_zip'].map(key => text(item[key]) || null);
      if (previous) {
        // Empty optional cells preserve the existing registration. Campus changes require an explicit column.
        const move = Boolean(item.campus_id || item.campus_name);
        let linkedCampuses: string[] = [];
        try { linkedCampuses = typeof previous.campus_ids === 'string' ? JSON.parse(previous.campus_ids) : previous.campus_ids || []; } catch {}
        if (!Array.isArray(linkedCampuses)) linkedCampuses = [];
        const resultingCampuses = [...new Set([campus.id, previous.campus_id, ...linkedCampuses].filter(Boolean))];
        await query(`UPDATE members SET name = ?, phone = COALESCE(?, phone), birth_date = COALESCE(?, birth_date), role = ?, cell_group_id = ?,
          address_street = COALESCE(?, address_street), address_number = COALESCE(?, address_number), address_complement = COALESCE(?, address_complement),
          address_neighborhood = COALESCE(?, address_neighborhood), address_city = COALESCE(?, address_city), address_state = COALESCE(?, address_state), address_zip = COALESCE(?, address_zip),
          campus_id = ?, campus_ids = ?, updated_at = NOW() WHERE id = ? AND organization_id = ?`,
          [name, text(item.phone)||null, birthDate, role, cellId, ...address, campus.id,
            move ? JSON.stringify(resultingCampuses) : typeof previous.campus_ids === 'string' ? previous.campus_ids : JSON.stringify(previous.campus_ids || [campus.id]), previous.id, orgId]);
        results.updated++;
      } else {
        await query(`INSERT INTO members (id, name, email, phone, birth_date, role, status, cell_group_id,
          address_street, address_number, address_complement, address_neighborhood, address_city, address_state, address_zip,
          organization_id, campus_id, campus_ids, invited_by) VALUES (?, ?, ?, ?, ?, ?, 'Ativo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cognitoId,name,email,text(item.phone)||null,birthDate,role,cellId,...address,orgId,campus.id,JSON.stringify([campus.id]),user.email]);
        results.created++;
      }
      saved = true;
      await logSecurityEvent({organizationId:orgId,user,action:'IMPORT_MEMBER',resource:'members',resourceId:cognitoId,
        details:{role,campus_id:campus.id,updated:Boolean(previous)},event});
      if (send && (createdCognito || resend)) {
        try {
          const account = await cognito.send(new AdminGetUserCommand({UserPoolId:poolId,Username:email}));
          if (account.Enabled === false || account.UserStatus !== 'FORCE_CHANGE_PASSWORD') results.invitations_skipped++;
          else {
            await cognito.send(new AdminCreateUserCommand({UserPoolId:poolId,Username:email,MessageAction:'RESEND',DesiredDeliveryMediums:['EMAIL']}));
            results.invitations_requested++;
          }
        } catch {
          results.invitation_errors.push({email,name,error:'Cadastro salvo; não foi possível solicitar o convite. Você pode reenviar o convite pendente.'});
        }
      } else results.invitations_skipped++;
    } catch (error: any) {
      if (createdCognito && !saved) {
        try { await cognito.send(new AdminDeleteUserCommand({UserPoolId:poolId,Username:email})); }
        catch { results.errors.push({email,name,error:'Falha na limpeza do acesso não concluído. Solicite conferência à administração.'}); }
      }
      results.errors.push({email,name,error:saved ? 'Cadastro salvo; falha ao registrar auditoria. Confira antes de repetir.' : error.code || error.$metadata ? 'Não foi possível salvar esta linha. Revise os dados e tente novamente.' : error.message || 'Não foi possível importar esta linha.'});
    }
  }
  await logSecurityEvent({organizationId:orgId,user,action:'BATCH_IMPORT_MEMBERS',resource:'members',
    details:{total:results.total,created:results.created,updated:results.updated,invitations_requested:results.invitations_requested,
      invitations_failed:results.invitation_errors.length,errorsCount:results.errors.length},event});
  return results;
}
