import { query } from '../db';
import { v4 as uuidv4 } from 'uuid';

export interface BaseMinistryTemplate {
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  roles: Array<{ name: string; description?: string; min_volunteers?: number }>;
}

export const BASE_MINISTRIES_TEMPLATE: BaseMinistryTemplate[] = [
  {
    slug: 'diaconia',
    name: 'Diaconia & Tesouraria',
    description: 'Serviço de apoio litúrgico, ordem do culto, ceia e contagem de ofertas.',
    icon: 'Shield',
    color: '#0f766e',
    roles: [
      { name: 'Serviço da Santa Ceia', min_volunteers: 1 },
      { name: 'Apoio ao Altar/Púlpito', min_volunteers: 1 },
      { name: 'Contagem de Ofertas & Dízimos', min_volunteers: 1 }
    ]
  },
  {
    slug: 'intercessao',
    name: 'Intercessão & Oração',
    description: 'Equipe de intercessão antes, durante e após as celebrações e vigílias.',
    icon: 'Sun',
    color: '#10b981',
    roles: [
      { name: 'Intercessão Pré-Culto', min_volunteers: 1 },
      { name: 'Oração no Altar pós-mensagem', min_volunteers: 1 }
    ]
  },
  {
    slug: 'kids',
    name: 'Ministério Infantil (Kids)',
    description: 'Cuidado, ensino bíblico e segurança das crianças durante as ministrações.',
    icon: 'Smile',
    color: '#f59e0b',
    roles: [
      { name: 'Berçário (0 a 2 anos)', min_volunteers: 1 },
      { name: 'Maternal (3 a 5 anos)', min_volunteers: 1 },
      { name: 'Juniores (6 a 10 anos)', min_volunteers: 1 },
      { name: 'Apoio/Recreação', min_volunteers: 1 },
      { name: 'Recepção Kids', min_volunteers: 1 }
    ]
  },
  {
    slug: 'louvor',
    name: 'Louvor & Adoração',
    description: 'Ministração musical, banda e vocalistas para todos os cultos e eventos.',
    icon: 'Music',
    color: '#8b5cf6',
    roles: [
      { name: 'Vocal Líder', min_volunteers: 1 },
      { name: 'Backing Vocal', min_volunteers: 1 },
      { name: 'Teclado', min_volunteers: 1 },
      { name: 'Bateria', min_volunteers: 1 },
      { name: 'Guitarra', min_volunteers: 1 },
      { name: 'Violão', min_volunteers: 1 },
      { name: 'Baixo', min_volunteers: 1 }
    ]
  },
  {
    slug: 'midia',
    name: 'Mídia & Transmissão',
    description: 'Transmissão ao vivo, câmeras, som, projeção de letras e iluminação.',
    icon: 'Video',
    color: '#3b82f6',
    roles: [
      { name: 'Operador de Áudio/Som', min_volunteers: 1 },
      { name: 'Câmera 1 (Principal)', min_volunteers: 1 },
      { name: 'Câmera 2 (Móvel)', min_volunteers: 1 },
      { name: 'Corte/OBS', min_volunteers: 1 },
      { name: 'Projeção (Holyrics)', min_volunteers: 1 },
      { name: 'Iluminação', min_volunteers: 1 }
    ]
  },
  {
    slug: 'recepcao',
    name: 'Recepção & Boas-Vindas',
    description: 'Acolhimento de membros e visitantes na entrada da igreja e nave.',
    icon: 'Heart',
    color: '#ec4899',
    roles: [
      { name: 'Porta Principal', min_volunteers: 1 },
      { name: 'Acolhimento da Nave', min_volunteers: 1 },
      { name: 'Entrega de Bíblias/Folhetos', min_volunteers: 1 },
      { name: 'Balcão de Novos Visitantes', min_volunteers: 1 }
    ]
  }
];

/**
 * Cria os 6 ministérios padrão e suas funções para uma nova organização/tenant.
 * Garante que cada tenant tenha seus próprios registros isolados (Multi-Tenant First).
 */
type QueryExecutor = (sql: string, params?: any[]) => Promise<any>;

export async function seedDefaultMinistries(
  orgId: string,
  campusId?: string,
  executor: QueryExecutor = query,
  throwOnError = false
): Promise<void> {
  if (!orgId) return;

  try {
    for (const item of BASE_MINISTRIES_TEMPLATE) {
      const ministryId = orgId === 'org_default' ? `min_${item.slug}` : `min_${orgId.replace(/[^a-zA-Z0-9]/g, '_')}_${item.slug}`;
      const finalCampusId = campusId || (orgId === 'org_default' ? 'campus_sede' : null);

      await executor(`
        INSERT INTO ministries (
          id, organization_id, campus_id, name, slug, description, icon, color, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          description = VALUES(description),
          icon = VALUES(icon),
          color = VALUES(color),
          status = 'ACTIVE'
      `, [
        ministryId,
        orgId,
        finalCampusId,
        item.name,
        item.slug,
        item.description,
        item.icon,
        item.color
      ]);

      // Seed de funções de cada ministério
      for (let i = 0; i < item.roles.length; i++) {
        const role = item.roles[i];
        const roleId = orgId === 'org_default'
          ? `role_${item.slug}_${i + 1}`
          : `role_${orgId.replace(/[^a-zA-Z0-9]/g, '_')}_${item.slug}_${i + 1}`;

        await executor(`
          INSERT INTO ministry_roles (
            id, organization_id, ministry_id, name, description, min_volunteers
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            min_volunteers = VALUES(min_volunteers)
        `, [
          roleId,
          orgId,
          ministryId,
          role.name,
          role.description || null,
          role.min_volunteers || 1
        ]);
      }
    }
    console.log(`✅ [seedDefaultMinistries] Ministérios e funções criados com sucesso para tenant: ${orgId}`);
  } catch (err) {
    console.error(`❌ [seedDefaultMinistries] Erro ao criar ministérios para tenant ${orgId}:`, err);
    if (throwOnError) throw err;
  }
}
