import { query } from './index';

async function selectAllMembers() {
  try {
    console.log("🛠️ Conectando ao MySQL (AWS RDS)...");
    
    const dbName = process.env.DB_NAME || 'faith-hub';
    console.log(`🔍 Lendo a tabela 'members' de dentro do '${dbName}'...`);
    
    const result = await query("SELECT id, name, email, status, role FROM members;");
    
    if (result.rows.length === 0) {
      console.log("\n❌ Nenhum membro encontrado no Banco MySQL. (Apenas no Cognito)");
    } else {
      console.log(`\n✅ ${result.rows.length} Membro(s) retornado(s) do servidor MYSQL:`);
      console.table(result.rows);
    }
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Erro de conexão/SQL:", error);
    process.exit(1);
  }
}

selectAllMembers();
