import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';

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
  organization_id: 'org_default'
};

// GET /church-settings
export const getSettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const rawSlug = event.queryStringParameters?.slug;
    const orgId = event.queryStringParameters?.organization_id;

    if (orgId) {
      // 1. Busca específica por ID da organização
      const { rows } = await query(
        `SELECT * FROM church_settings WHERE organization_id = ? OR id = ? LIMIT 1`,
        [orgId, orgId]
      );
      if (rows.length > 0) {
        const item = rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          ...item,
          offline_mode: Boolean(item.offline_mode)
        });
      }

      // Se não encontrou em church_settings, busca na tabela organizations
      const orgRes = await query(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [orgId]);
      if (orgRes.rows.length > 0) {
        const org = orgRes.rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          id: `settings_${org.id}`,
          church_name: org.name,
          pwa_slug: org.slug,
          primary_color: org.primary_color || DEFAULT_SETTINGS.primary_color,
          secondary_color: org.secondary_color || DEFAULT_SETTINGS.secondary_color,
          logo_icon_url: org.logo_url || DEFAULT_SETTINGS.logo_icon_url,
          organization_id: org.id
        });
      }
    }

    if (rawSlug) {
      const cleanSlug = rawSlug.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

      // 2. Busca específica por slug do PWA
      const { rows } = await query(
        `SELECT * FROM church_settings WHERE pwa_slug = ? OR pwa_slug = ? OR id = ? OR organization_id IN (SELECT id FROM organizations WHERE slug = ? OR slug = ?) LIMIT 1`,
        [rawSlug, cleanSlug, rawSlug, rawSlug, cleanSlug]
      );
      if (rows.length > 0) {
        const item = rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          ...item,
          offline_mode: Boolean(item.offline_mode)
        });
      }

      // Se não encontrou em church_settings, busca na tabela organizations
      const orgRes = await query(
        `SELECT * FROM organizations WHERE slug = ? OR slug = ? OR id = ? LIMIT 1`,
        [rawSlug, cleanSlug, rawSlug]
      );
      if (orgRes.rows.length > 0) {
        const org = orgRes.rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          id: `settings_${org.id}`,
          church_name: org.name,
          pwa_slug: org.slug,
          primary_color: org.primary_color || DEFAULT_SETTINGS.primary_color,
          secondary_color: org.secondary_color || DEFAULT_SETTINGS.secondary_color,
          logo_icon_url: org.logo_url || DEFAULT_SETTINGS.logo_icon_url,
          organization_id: org.id
        });
      }
    }

    // 3. Se nenhum parâmetro foi passado, retorna a congregação padrão
    const { rows: defaultRows } = await query(
      `SELECT * FROM church_settings WHERE id = 'default_church' OR organization_id = 'org_default' LIMIT 1`
    );
    if (defaultRows.length > 0) {
      return apiResponse(200, {
        ...DEFAULT_SETTINGS,
        ...defaultRows[0],
        offline_mode: Boolean(defaultRows[0].offline_mode)
      });
    }

    return apiResponse(200, DEFAULT_SETTINGS);
  } catch (error: any) {
    console.error('Erro ao buscar church-settings:', error);
    return apiResponse(200, DEFAULT_SETTINGS);
  }
};

// POST /church-settings
export const updateSettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || '{}');
    const orgId = body.organization_id || body.orgId;
    const pwaSlug = (body.pwa_slug || body.slug || 'igreja').toLowerCase().trim();
    const settingsId = body.id || (orgId ? `settings_${orgId.replace(/-/g, '_')}` : `settings_${pwaSlug.replace(/-/g, '_')}`);
    const sloganValue = body.slogan !== undefined ? body.slogan : (body.tagline !== undefined ? body.tagline : '');

    const settings = {
      ...DEFAULT_SETTINGS,
      ...body,
      id: settingsId,
      organization_id: orgId || DEFAULT_SETTINGS.organization_id,
      pwa_slug: pwaSlug,
      slogan: sloganValue
    };

    const sql = `
      INSERT INTO church_settings (
        id, church_name, slogan, cnpj, pastor_name, phone, whatsapp, email,
        address_street, address_number, address_neighborhood, address_city, address_state, address_zip,
        instagram_url, youtube_url, facebook_url, website_url,
        logo_icon_url, logo_header_url, banner_url,
        primary_color, secondary_color, pwa_theme_color, pwa_short_name, pwa_slug, offline_mode,
        organization_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      settings.organization_id
    ];

    await query(sql, params);

    // Sincroniza também na tabela organizations se houver organization_id
    if (orgId) {
      await query(
        `UPDATE organizations SET name = ?, primary_color = ?, secondary_color = ?, logo_url = ?, updated_at = NOW() WHERE id = ?`,
        [settings.church_name, settings.primary_color, settings.secondary_color, settings.logo_icon_url || null, orgId]
      ).catch(() => {});
    }

    return apiResponse(200, {
      message: 'Configurações da Igreja salvas com sucesso!',
      settings
    });
  } catch (error: any) {
    console.error('Erro ao salvar church-settings:', error);
    return apiResponse(500, { message: 'Erro ao salvar configurações', error: error.message });
  }
};
