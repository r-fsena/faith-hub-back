import { query } from './index';

async function updateTable() {
  try {
    console.log("🛠️ Conectando ao MySQL (AWS RDS) para atualizar tabela...");
    
    // Adicionando coluna phone
    await query("ALTER TABLE members ADD COLUMN phone VARCHAR(20);").catch(e => console.log("Col phone já existe ou aviso:", e.message));
    
    // Adicionando coluna activation_date
    await query("ALTER TABLE members ADD COLUMN activation_date TIMESTAMP NULL;").catch(e => console.log("Col activation_date já existe ou aviso:", e.message));
    
    // Adicionando coluna invited_by
    await query("ALTER TABLE members ADD COLUMN invited_by VARCHAR(36);").catch(e => console.log("Col invited_by já existe ou aviso:", e.message));
    
    // Criando a chave estrangeira (Opcional, mas muito recomendado de quem convidou pra tabela de membros)
    await query("ALTER TABLE members ADD CONSTRAINT fk_invited_by FOREIGN KEY (invited_by) REFERENCES members(id) ON DELETE SET NULL;").catch(e => console.log("FK já existe cruzada:", e.message));
    
    console.log("\n✅ Colunas 'phone', 'activation_date' e 'invited_by' criadas com sucesso na tabela members!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Erro:", error);
    process.exit(1);
  }
}

updateTable();
