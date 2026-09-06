const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

async function seedData() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub'
  });

  try {
    console.log('🚀 Iniciando inserção das Células em Palhoça e 30 Produtos da Loja...');

    const orgId = 'org_default';
    const campusId = 'campus_sede';
    const leaderId = '31fb4560-a0f1-7021-fdc9-82357c2522e1'; // Rafael Farias de Sena (rfsena@icloud.com)

    // 1. INSERIR CÉLULAS EM PALHOÇA
    const cellGroups = [
      {
        name: 'Juventude',
        address: 'Av. Atílio Pedro Pagani, 250, Ed. Prime Tower',
        neighborhood: 'Pagani, Palhoça - SC',
        meeting_day: 'Sábado',
        meeting_time: '19:30',
        focus: 'JOVENS',
        whatsapp_contact: '48991234567',
        description: 'Comunhão, louvor dinâmico, palavra transformadora e conexões profundas para toda a juventude.'
      },
      {
        name: 'Crianças',
        address: 'Rua Prefeito Reinoldo Alves, 120',
        neighborhood: 'Passa Vinte, Palhoça - SC',
        meeting_day: 'Quarta-feira',
        meeting_time: '19:30',
        focus: 'KIDS',
        whatsapp_contact: '48991234567',
        description: 'Ensino bíblico lúdico, brincadeiras, memorização de versículos e discipulado infantil com amor.'
      },
      {
        name: 'Mulheres',
        address: 'Rua Tenente Francisco Lehmkhul, 85',
        neighborhood: 'Centro, Palhoça - SC',
        meeting_day: 'Terça-feira',
        meeting_time: '20:00',
        focus: 'MULHERES',
        whatsapp_contact: '48991234567',
        description: 'Espaço de acolhimento, oração, mentoria e fortalecimento espiritual para mulheres de todas as idades.'
      },
      {
        name: 'Casais',
        address: 'Rua José Cosme da Silva, 410',
        neighborhood: 'Pedra Branca, Palhoça - SC',
        meeting_day: 'Sexta-feira',
        meeting_time: '20:00',
        focus: 'CASAIS',
        whatsapp_contact: '48991234567',
        description: 'Edificação do casamento, princípios bíblicos para o lar, diálogo, cumplicidade e comunhão entre casais.'
      }
    ];

    for (const cell of cellGroups) {
      const [existing] = await connection.query(
        'SELECT id FROM cell_groups WHERE organization_id = ? AND name = ? LIMIT 1',
        [orgId, cell.name]
      );

      if (existing.length > 0) {
        await connection.query(
          `UPDATE cell_groups SET leader_id=?, address=?, neighborhood=?, meeting_day=?, meeting_time=?, focus=?, whatsapp_contact=?, description=?, status='ACTIVE', campus_id=?, updated_at=NOW() WHERE id=?`,
          [leaderId, cell.address, cell.neighborhood, cell.meeting_day, cell.meeting_time, cell.focus, cell.whatsapp_contact, cell.description, campusId, existing[0].id]
        );
        console.log(`✔ Célula atualizada: ${cell.name}`);
      } else {
        const id = uuidv4();
        await connection.query(
          `INSERT INTO cell_groups (id, name, leader_id, description, address, neighborhood, meeting_day, meeting_time, whatsapp_contact, status, focus, organization_id, campus_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, NOW(), NOW())`,
          [id, cell.name, leaderId, cell.description, cell.address, cell.neighborhood, cell.meeting_day, cell.meeting_time, cell.whatsapp_contact, cell.focus, orgId, campusId]
        );
        console.log(`✔ Célula inserida: ${cell.name}`);
      }
    }

    // 2. INSERIR 30 PRODUTOS NA LOJA (R$ 1,00 cada)
    const products = [
      // LIVROS (10 itens)
      {
        name: 'Bíblia Sagrada NVI - Couro Nobre Black',
        category: 'Livros',
        description: 'Texto na Nova Versão Internacional com letra gigante, mapas coloridos e fitas marcadoras.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?q=80&w=800'])
      },
      {
        name: 'Devocional Diário: Graça e Propósito',
        category: 'Livros',
        description: '365 reflexões diárias com versículos para meditação matinal e oração guiada.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1512820790803-83ca734da794?q=80&w=800'])
      },
      {
        name: 'O Poder da Oração Eficaz',
        category: 'Livros',
        description: 'Um guia prático sobre como desenvolver intimidade diária com o Pai e perseverar na intercessão.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1497633762265-9d179a990aa6?q=80&w=800'])
      },
      {
        name: 'Liderança com Propósito no Reino',
        category: 'Livros',
        description: 'Princípios de discipulado, cuidado pastoral e gestão de células e pequenos grupos.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1532012164546-f432f2e37b73?q=80&w=800'])
      },
      {
        name: 'Bíblia de Estudo - Mulheres de Fé',
        category: 'Livros',
        description: 'Notas de estudo, biografias de mulheres bíblicas e artigos sobre sabedoria no lar.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1495446815901-a7297e633e8d?q=80&w=800'])
      },
      {
        name: 'Bíblia Infantil Histórias Inesquecíveis',
        category: 'Livros',
        description: 'Capa dura acolchoada, ilustrações vibrantes e linguagem acessível para os pequeninos.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1516979187457-637abb4f9353?q=80&w=800'])
      },
      {
        name: 'Caminho do Discipulado: Fundamentos',
        category: 'Livros',
        description: 'Manual completo de passos iniciais na fé cristã, batismo e vida no Espírito Santo.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?q=80&w=800'])
      },
      {
        name: 'Coração de Adorador: Louvor e Vida',
        category: 'Livros',
        description: 'Descubra o verdadeiro sentido da adoração além do domingo, como estilo de vida constante.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1476275466078-4007374efbbe?q=80&w=800'])
      },
      {
        name: 'Casamento Blindado por Deus',
        category: 'Livros',
        description: 'Chaves práticas para proteger e fortalecer a aliança conjugal através do perdão e diálogo.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1519741497674-611481863552?q=80&w=800'])
      },
      {
        name: 'Jovens Fortes: Firmeza em Meio à Cultura',
        category: 'Livros',
        description: 'Uma mensagem inspiradora para a juventude viver com integridade, pureza e ousadia.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1524995997946-a1c2e315a42f?q=80&w=800'])
      },

      // CANECAS (10 itens)
      {
        name: 'Caneca Fosca - Tudo Posso Naquele Que Me Fortalece',
        category: 'Canecas',
        description: 'Caneca de cerâmica fosca premium 350ml com tipografia minimalista dourada.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?q=80&w=800'])
      },
      {
        name: 'Caneca Esmaltada Vintage - O Senhor é Meu Pastor',
        category: 'Canecas',
        description: 'Caneca esmaltada estilo rústico/camping, resistente e perfeita para cafés especiais.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1577937927133-66ef06acdf18?q=80&w=800'])
      },
      {
        name: 'Caneca Térmica Inox - Fé Move Montanhas',
        category: 'Canecas',
        description: 'Tampa hermética à prova de vazamentos, conserva quente por 6h e frio por 12h.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1534349762230-e0cadf78f5da?q=80&w=800'])
      },
      {
        name: 'Caneca Pastel Lilás - Graça & Paz Diária',
        category: 'Canecas',
        description: 'Design delicado em tom pastel com detalhes em ouro fosco no acabamento da alça.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1509042239860-f550ce710b93?q=80&w=800'])
      },
      {
        name: 'Caneca Mágica - Revelação da Cruz',
        category: 'Canecas',
        description: 'Muda de cor e revela a arte com versículo bíblico quando em contato com líquido quente.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1572119865084-43c285814d63?q=80&w=800'])
      },
      {
        name: 'Caneca Minimalista White - Soli Deo Gloria',
        category: 'Canecas',
        description: 'Cerâmica branca brilhante com inscrição latina tradicional gravada a laser.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1517256064527-09c73fc73e38?q=80&w=800'])
      },
      {
        name: 'Caneca Cerâmica Bold Black - Leão de Judá',
        category: 'Canecas',
        description: 'Arte imponente em relevo do Leão de Judá, 400ml para amantes de café forte.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1542838132-92c53300491e?q=80&w=800'])
      },
      {
        name: 'Caneca com Pires Madeira - Café com Deus Pai',
        category: 'Canecas',
        description: 'Kit caneca em cerâmica artesanal acompanhada de pires em madeira nobre de reflorestamento.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1530629013299-6cb10d168419?q=80&w=800'])
      },
      {
        name: 'Caneca Duo Casais - O Amor Jamais Acaba',
        category: 'Canecas',
        description: 'Par de canecas que se encaixam formando o coração e a citação de 1 Coríntios 13.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?q=80&w=800'])
      },
      {
        name: 'Caneca Kids Colorida - Jesus Me Ama Muito',
        category: 'Canecas',
        description: 'Material atóxico super resistente a quedas com ilustrações alegres para as crianças.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?q=80&w=800'])
      },

      // VESTIMENTAS (10 itens)
      {
        name: 'Camiseta Oversized - Chosen & Blessed',
        category: 'Vestimentas',
        description: 'Modelagem streetwear moderna, 100% algodão penteado 30.1 com estampa serigráfica nas costas.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1521572267360-ee0c2909d518?q=80&w=800'])
      },
      {
        name: 'Camiseta Minimalista Off-White - Faith Over Fear',
        category: 'Vestimentas',
        description: 'Bordado sutil no peito esquerdo, gola canelada reforçada e caimento premium.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?q=80&w=800'])
      },
      {
        name: 'Moletom Canguru Heavyweight - Maranata',
        category: 'Vestimentas',
        description: 'Interior flanelado macio, capuz forrado, cordões em algodão e estampa em relevo.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1556905055-8f358a7a47b2?q=80&w=800'])
      },
      {
        name: 'Camiseta Raglan 3/4 - Jesus Culture',
        category: 'Vestimentas',
        description: 'Estilo atlético vintage, mangas contrastantes e tecido respirável para cultos e eventos.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?q=80&w=800'])
      },
      {
        name: 'Boné Dad Hat Strapback - Grace',
        category: 'Vestimentas',
        description: 'Brim lavado 100% algodão, fivela metálica ajustável e bordado em alta definição.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1588850561407-ed78c282e89b?q=80&w=800'])
      },
      {
        name: 'Camiseta Baby Look - Filha do Rei',
        category: 'Vestimentas',
        description: 'Toque macio com elastano, modelagem que valoriza o caimento com conforto e elegância.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1503341455253-b2e723bb3dbb?q=80&w=800'])
      },
      {
        name: 'Camiseta Juventude - Holy Spirit Fire',
        category: 'Vestimentas',
        description: 'Design tipográfico arrojado com acabamento tie-dye suave em tons neutros.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1618354691373-d851c5c3a990?q=80&w=800'])
      },
      {
        name: 'Moletom Careca - Emmanuel: Deus Conosco',
        category: 'Vestimentas',
        description: 'Sem capuz, corte clean europeu, ideal para sobreposições nos dias amenos.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1578587018452-892bacefd3f2?q=80&w=800'])
      },
      {
        name: 'Camiseta Infantil - Pequeno Discípulo',
        category: 'Vestimentas',
        description: 'Algodão hipoalergênico ultra suave para a pele das crianças, cores vivas que não desbotam.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1622290291468-a28f7a7dc6a8?q=80&w=800'])
      },
      {
        name: 'Ecobag Algodão Cru - Boas Novas',
        category: 'Vestimentas',
        description: 'Sacola ecológica reforçada 40x40cm com alças duplas, perfeita para Bíblias e cadernos.',
        price: 1.00,
        image_urls: JSON.stringify(['https://images.unsplash.com/photo-1597484662317-9bd7bdda2907?q=80&w=800'])
      }
    ];

    // Limpa produtos mock anteriores da org_default para deixar a loja limpa e organizada
    await connection.query("DELETE FROM pdv_products WHERE organization_id = ? AND name = 'Coxinha Artesanal'", [orgId]);

    for (const prod of products) {
      const [existing] = await connection.query(
        'SELECT id FROM pdv_products WHERE organization_id = ? AND name = ? LIMIT 1',
        [orgId, prod.name]
      );

      if (existing.length > 0) {
        await connection.query(
          `UPDATE pdv_products SET category=?, description=?, price=?, image_urls=?, status='ACTIVE', campus_id=?, updated_at=NOW() WHERE id=?`,
          [prod.category, prod.description, prod.price, prod.image_urls, campusId, existing[0].id]
        );
        console.log(`✔ Produto atualizado: [${prod.category}] ${prod.name}`);
      } else {
        const id = uuidv4();
        await connection.query(
          `INSERT INTO pdv_products (id, name, description, price, category, image_urls, status, organization_id, campus_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NOW(), NOW())`,
          [id, prod.name, prod.description, prod.price, prod.category, prod.image_urls, orgId, campusId]
        );
        console.log(`✔ Produto inserido: [${prod.category}] ${prod.name}`);
      }
    }

    // 3. ATUALIZAR GRUPOS NO CHURCH_SETTINGS
    const [settingsRows] = await connection.query("SELECT * FROM church_settings WHERE organization_id = ? LIMIT 1", [orgId]);
    if (settingsRows.length > 0) {
      let storeConfig = {};
      try {
        storeConfig = typeof settingsRows[0].store_config === 'string' ? JSON.parse(settingsRows[0].store_config || '{}') : (settingsRows[0].store_config || {});
      } catch {}

      storeConfig.product_groups = [
        { id: 'grp_livros', name: 'Livros', active: true },
        { id: 'grp_canecas', name: 'Canecas', active: true },
        { id: 'grp_vestimentas', name: 'Vestimentas', active: true }
      ];

      await connection.query(
        "UPDATE church_settings SET store_config = ?, updated_at = NOW() WHERE organization_id = ?",
        [JSON.stringify(storeConfig), orgId]
      );
      console.log('✔ store_config atualizado com os 3 grupos: Livros, Canecas, Vestimentas!');
    }

    console.log('\n🎉 Todas as Células e os 30 Produtos foram inseridos com sucesso no banco de dados!');
  } catch (err) {
    console.error('❌ Erro durante a inserção:', err);
  } finally {
    await connection.end();
  }
}

seedData();
