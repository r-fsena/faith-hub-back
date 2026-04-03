import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { query } from "./index";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const USER_POOL_ID = process.env.USER_POOL_ID as string;

async function syncUsers() {
  try {
    console.log("🛠️  Buscando usuários no AWS Cognito...");
    const command = new ListUsersCommand({ UserPoolId: USER_POOL_ID });
    const response = await cognitoClient.send(command);
    
    const users = response.Users || [];
    console.log(`✅  Foram encontrados ${users.length} usuário(s) no Cognito.`);

    if (users.length === 0) {
      console.log("Nenhum usuário para sincronizar.");
      return;
    }

    console.log("💾 Iniciando sincronização no banco MySQL RDS...");
    for (const user of users) {
      const sub = user.Attributes?.find(attr => attr.Name === "sub")?.Value;
      const email = user.Attributes?.find(attr => attr.Name === "email")?.Value;
      const name = user.Attributes?.find(attr => attr.Name === "name")?.Value || email?.split('@')[0];
      const status = user.Enabled ? "ACTIVE" : "INACTIVE";

      const userId = user.Username || sub; 
      
      if (!userId || !email) {
        continue;
      }

      // Upsert adaptado para MySQL (ON DUPLICATE KEY UPDATE)
      const upsertQuery = `
        INSERT INTO members (id, name, email, role, status, created_at, updated_at)
        VALUES (?, ?, ?, 'ADMIN', ?, NOW(), NOW())
        ON DUPLICATE KEY UPDATE 
            id = VALUES(id),
            name = VALUES(name),
            status = VALUES(status),
            updated_at = NOW()
      `;
      
      await query(upsertQuery, [userId, name, email, status]);
      console.log(`✅  Usuário sincronizado: ${email} -> ID: ${userId}`);
    }

    console.log("🎉 Sincronização finalizada!");
    process.exit(0);

  } catch (error) {
    console.error("❌ Erro ao sincronizar:", error);
    process.exit(1);
  }
}

syncUsers();
