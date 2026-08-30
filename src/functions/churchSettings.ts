import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';
import { requireAuth, enforceRole, enforceTenant } from '../services/authMiddleware';
import { logSecurityEvent } from '../services/auditLogService';

export const DEFAULT_KANBAN_CONFIG = {
  RECEBIDO: {
    title: 'Novos / Recebidos',
    icon: '🔔',
    color: '#ef4444',
    description: 'Pedidos recém-chegados pelo App ou Balcão'
  },
  PREPARANDO: {
    title: 'Em Separação',
    icon: '⏳',
    color: '#f59e0b',
    description: 'Itens em preparo na cozinha ou separação no estoque'
  },
  PRONTO: {
    title: 'Aguardando Retirada',
    icon: '✅',
    color: '#3b82f6',
    description: 'Prontos para retirada no balcão ou despacho'
  },
  ENTREGUE: {
    title: 'Finalizados',
    icon: '🎉',
    color: '#10b981',
    description: 'Venda concluída e entregue ao membro'
  }
};

export const DEFAULT_BIBLE_CONFIG = {
  enabled_versions: ['nvi', 'acf', 'aa'],
  default_version: 'nvi',
  allow_user_version_switch: true,
  daily_verse_enabled: true,
  reading_history_enabled: true,
  highlights_enabled: true,
  whatsapp_share_enabled: true,
  featured_reading_book: 'jo',
  pastoral_note: 'Recomendamos a leitura diária da Palavra de Deus para edificação de sua fé e família.'
};

const DEFAULT_SETTINGS = {
  id: 'default_church',
  church_name: 'Igreja Faith Hub',
  slogan: '',
  cnpj: '',
  pastor_name: 'Pr. Titular',
  phone: '',
  whatsapp: '',
  email: '',
  address_street: '',
  address_number: '',
  address_neighborhood: '',
  address_city: '',
  address_state: '',
  address_zip: '',
  instagram_url: '',
  youtube_url: '',
  facebook_url: '',
  website_url: '',
  logo_icon_url: '',
  logo_header_url: '',
  banner_url: '',
  primary_color: '#0f766e',
  secondary_color: '#14b8a6',
  pwa_theme_color: '#0f766e',
  pwa_short_name: 'Faith Hub',
  pwa_slug: 'faithhub',
  offline_mode: false,
  organization_id: 'org_default',
  kanban_config: DEFAULT_KANBAN_CONFIG,
  bible_config: DEFAULT_BIBLE_CONFIG
};

function formatSettings(item: any) {
  let kanban = item.kanban_config;
  if (kanban && typeof kanban === 'string') {
    try {
      kanban = JSON.parse(kanban);
    } catch {
      kanban = null;
    }
  }

  let bible = item.bible_config;
  if (bible && typeof bible === 'string') {
    try {
      bible = JSON.parse(bible);
    } catch {
      bible = null;
    }
  }

  return {
    ...DEFAULT_SETTINGS,
    ...item,
    kanban_config: kanban || DEFAULT_KANBAN_CONFIG,
    bible_config: bible || DEFAULT_BIBLE_CONFIG,
    offline_mode: Boolean(item.offline_mode)
  };
}

// GET /church-settings (Público para leitura de identidade visual do PWA/App)
export const getSettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rawSlug = event.queryStringParameters?.slug;
    const orgId = event.queryStringParameters?.organization_id;

    if (orgId) {
      const { rows } = await query(
        `SELECT cs.*, o.status as org_status 
         FROM church_settings cs
         LEFT JOIN organizations o ON cs.organization_id = o.id
         WHERE cs.organization_id = ? OR cs.id = ? 
         ORDER BY cs.updated_at DESC LIMIT 1`,
        [orgId, orgId]
      );
      if (rows.length > 0) {
        const item = rows[0];
        const finalStatus = item.org_status === 'INACTIVE' || item.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
        return apiResponse(200, { ...formatSettings(item), status: finalStatus });
      }

      const orgRes = await query(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [orgId]);
      if (orgRes.rows.length > 0) {
        const org = orgRes.rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          id: `settings_${org.slug ? org.slug.replace(/-/g, '_') : org.id}`,
          church_name: org.name,
          pwa_slug: org.slug,
          primary_color: org.primary_color || DEFAULT_SETTINGS.primary_color,
          secondary_color: org.secondary_color || DEFAULT_SETTINGS.secondary_color,
          logo_icon_url: org.logo_url || DEFAULT_SETTINGS.logo_icon_url,
          organization_id: org.id,
          status: org.status || 'ACTIVE'
        });
      }
    }

    if (rawSlug) {
      const cleanSlug = rawSlug.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

      const { rows } = await query(
        `SELECT cs.*, o.status as org_status 
         FROM church_settings cs
         LEFT JOIN organizations o ON (cs.organization_id = o.id OR cs.pwa_slug = o.slug)
         WHERE cs.pwa_slug = ? OR cs.pwa_slug = ? OR cs.id = ? OR cs.organization_id IN (SELECT id FROM organizations WHERE slug = ? OR slug = ?) 
         ORDER BY cs.updated_at DESC LIMIT 1`,
        [rawSlug, cleanSlug, rawSlug, rawSlug, cleanSlug]
      );
      if (rows.length > 0) {
        const item = rows[0];
        const finalStatus = item.org_status === 'INACTIVE' || item.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
        return apiResponse(200, { ...formatSettings(item), status: finalStatus });
      }

      const orgRes = await query(
        `SELECT * FROM organizations WHERE slug = ? OR slug = ? OR id = ? LIMIT 1`,
        [rawSlug, cleanSlug, rawSlug]
      );
      if (orgRes.rows.length > 0) {
        const org = orgRes.rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          id: `settings_${org.slug ? org.slug.replace(/-/g, '_') : org.id}`,
          church_name: org.name,
          pwa_slug: org.slug,
          primary_color: org.primary_color || DEFAULT_SETTINGS.primary_color,
          secondary_color: org.secondary_color || DEFAULT_SETTINGS.secondary_color,
          logo_icon_url: org.logo_url || DEFAULT_SETTINGS.logo_icon_url,
          organization_id: org.id,
          status: org.status || 'ACTIVE'
        });
      }
    }

    const { rows: defaultRows } = await query(
      `SELECT * FROM church_settings WHERE organization_id = 'org_default' OR id = 'default_church' ORDER BY updated_at DESC LIMIT 1`
    );
    if (defaultRows.length > 0) {
      return apiResponse(200, formatSettings(defaultRows[0]));
    }

    return apiResponse(200, DEFAULT_SETTINGS);
  } catch (error: any) {
    console.error('Erro ao buscar church-settings:', error);
    return apiResponse(200, DEFAULT_SETTINGS);
  }
};

// POST /church-settings (PROTEGIDO: Apenas Liderança/Pastor da própria congregação)
export const updateSettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = await requireAuth(event);
    if ('errorResponse' in auth) return auth.errorResponse;

    const roleCheck = enforceRole(auth.user, ['SUPERADMIN', 'PASTOR', 'ADMIN']);
    if (!roleCheck.allowed) return roleCheck.errorResponse!;

    const body = JSON.parse(event.body || '{}');
    const requestedOrgId = body.organization_id || body.orgId;

    const tenantCheck = enforceTenant(auth.user, requestedOrgId);
    if (!tenantCheck.allowed) return tenantCheck.errorResponse!;
    const orgId = tenantCheck.effectiveOrgId;

    const pwaSlug = (body.pwa_slug || body.slug || 'igreja').toLowerCase().trim();

    let settingsId = body.id;
    if (!settingsId && orgId) {
      const existing = await query(`SELECT id FROM church_settings WHERE organization_id = ? LIMIT 1`, [orgId]);
      if (existing.rows.length > 0) {
        settingsId = existing.rows[0].id;
      }
    }
    if (!settingsId) {
      settingsId = `settings_${pwaSlug.replace(/-/g, '_')}`;
    }

    const sloganValue = body.slogan !== undefined ? body.slogan : (body.tagline !== undefined ? body.tagline : '');
    const kanbanValue = body.kanban_config ? (typeof body.kanban_config === 'string' ? body.kanban_config : JSON.stringify(body.kanban_config)) : JSON.stringify(DEFAULT_KANBAN_CONFIG);
    const bibleValue = body.bible_config ? (typeof body.bible_config === 'string' ? body.bible_config : JSON.stringify(body.bible_config)) : JSON.stringify(DEFAULT_BIBLE_CONFIG);

    const settings = {
      ...DEFAULT_SETTINGS,
      ...body,
      id: settingsId,
      organization_id: orgId,
      pwa_slug: pwaSlug,
      slogan: sloganValue,
      kanban_config: body.kanban_config || DEFAULT_KANBAN_CONFIG,
      bible_config: body.bible_config || DEFAULT_BIBLE_CONFIG
    };

    const sql = `
      INSERT INTO church_settings (
        id, church_name, slogan, cnpj, pastor_name, phone, whatsapp, email,
        address_street, address_number, address_neighborhood, address_city, address_state, address_zip,
        instagram_url, youtube_url, facebook_url, website_url,
        logo_icon_url, logo_header_url, banner_url,
        primary_color, secondary_color, pwa_theme_color, pwa_short_name, pwa_slug, offline_mode,
        organization_id, kanban_config, bible_config
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        church_name = VALUES(church_name),
        slogan = VALUES(slogan),
        cnpj = VALUES(cnpj),
        pastor_name = VALUES(pastor_name),
        phone = VALUES(phone),
        whatsapp = VALUES(whatsapp),
        email = VALUES(email),
        address_street = VALUES(address_street),
        address_number = VALUES(address_number),
        address_neighborhood = VALUES(address_neighborhood),
        address_city = VALUES(address_city),
        address_state = VALUES(address_state),
        address_zip = VALUES(address_zip),
        instagram_url = VALUES(instagram_url),
        youtube_url = VALUES(youtube_url),
        facebook_url = VALUES(facebook_url),
        website_url = VALUES(website_url),
        logo_icon_url = VALUES(logo_icon_url),
        logo_header_url = VALUES(logo_header_url),
        banner_url = VALUES(banner_url),
        primary_color = VALUES(primary_color),
        secondary_color = VALUES(secondary_color),
        pwa_theme_color = VALUES(pwa_theme_color),
        pwa_short_name = VALUES(pwa_short_name),
        pwa_slug = VALUES(pwa_slug),
        offline_mode = VALUES(offline_mode),
        organization_id = VALUES(organization_id),
        kanban_config = VALUES(kanban_config),
        bible_config = VALUES(bible_config),
        updated_at = NOW()
    `;

    const params = [
      settings.id,
      settings.church_name,
      settings.slogan,
      settings.cnpj,
      settings.pastor_name,
      settings.phone,
      settings.whatsapp,
      settings.email,
      settings.address_street,
      settings.address_number,
      settings.address_neighborhood,
      settings.address_city,
      settings.address_state,
      settings.address_zip,
      settings.instagram_url,
      settings.youtube_url,
      settings.facebook_url,
      settings.website_url,
      settings.logo_icon_url,
      settings.logo_header_url,
      settings.banner_url,
      settings.primary_color,
      settings.secondary_color,
      settings.pwa_theme_color,
      settings.pwa_short_name,
      settings.pwa_slug,
      settings.offline_mode ? 1 : 0,
      settings.organization_id,
      kanbanValue,
      bibleValue
    ];

    await query(sql, params);

    if (orgId && orgId !== 'org_default') {
      await query(
        `UPDATE organizations SET name = ?, primary_color = ?, secondary_color = ?, logo_url = ?, updated_at = NOW() WHERE id = ?`,
        [settings.church_name, settings.primary_color, settings.secondary_color, settings.logo_icon_url || null, orgId]
      ).catch(() => {});
    }

    await logSecurityEvent({
      organizationId: orgId,
      user: auth.user,
      action: 'UPDATE_CHURCH_SETTINGS',
      resource: 'church_settings',
      resourceId: settings.id,
      details: { church_name: settings.church_name, pwa_slug: settings.pwa_slug },
      event
    });

    return apiResponse(200, {
      message: 'Configurações da Igreja salvas com sucesso!',
      settings
    });
  } catch (error: any) {
    console.error('Erro ao salvar church-settings:', error);
    return apiResponse(500, { message: 'Erro ao salvar configurações' });
  }
};
