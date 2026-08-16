import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, apiResponse } from '../db';

const DEFAULT_SETTINGS = {
  id: 'default_church',
  church_name: 'Igreja Faith Hub',
  slogan: 'Um lugar de fé, amor e comunhão',
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
  offline_mode: false
};

// GET /church-settings
export const getSettings = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const slug = event.queryStringParameters?.slug;
    const orgId = event.queryStringParameters?.organization_id;

    let sql = `SELECT * FROM church_settings`;
    let params: any[] = [];

    if (slug) {
      sql += ` WHERE pwa_slug = ? OR id = ? LIMIT 1`;
      params = [slug, slug];
    } else if (orgId) {
      sql += ` WHERE organization_id = ? LIMIT 1`;
      params = [orgId];
    } else {
      sql += ` ORDER BY updated_at DESC LIMIT 1`;
    }

    const { rows } = await query(sql, params);
    if (rows.length > 0) {
      const item = rows[0];
      return apiResponse(200, {
        ...DEFAULT_SETTINGS,
        ...item,
        offline_mode: Boolean(item.offline_mode)
      });
    }

    // Se não encontrou em church_settings mas foi passado slug, tenta buscar em organizations
    if (slug) {
      const orgRes = await query(`SELECT * FROM organizations WHERE slug = ? OR id = ? LIMIT 1`, [slug, slug]);
      if (orgRes.rows.length > 0) {
        const org = orgRes.rows[0];
        return apiResponse(200, {
          ...DEFAULT_SETTINGS,
          id: org.id,
          church_name: org.name,
          pwa_slug: org.slug,
          primary_color: org.primary_color || DEFAULT_SETTINGS.primary_color,
          secondary_color: org.secondary_color || DEFAULT_SETTINGS.secondary_color,
          logo_icon_url: org.logo_url || DEFAULT_SETTINGS.logo_icon_url,
          organization_id: org.id
        });
      }
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
    const settings = { ...DEFAULT_SETTINGS, ...body };

    const sql = `
      INSERT INTO church_settings (
        id, church_name, slogan, cnpj, pastor_name, phone, whatsapp, email,
        address_street, address_number, address_neighborhood, address_city, address_state, address_zip,
        instagram_url, youtube_url, facebook_url, website_url,
        logo_icon_url, logo_header_url, banner_url,
        primary_color, secondary_color, pwa_theme_color, pwa_short_name, pwa_slug, offline_mode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at = NOW()
    `;

    const params = [
      settings.id || 'default_church',
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
      settings.offline_mode ? 1 : 0
    ];

    await query(sql, params);

    return apiResponse(200, {
      message: 'Configurações da Igreja salvas com sucesso!',
      settings
    });
  } catch (error: any) {
    console.error('Erro ao salvar church-settings:', error);
    return apiResponse(500, { message: 'Erro ao salvar configurações', error: error.message });
  }
};
