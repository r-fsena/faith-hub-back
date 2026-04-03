const { CognitoIdentityProviderClient, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");
const mysql = require("mysql2/promise");
require('dotenv').config();

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || "us-east-2" });
const USER_POOL_ID = process.env.USER_POOL_ID;

async function syncCognitoToMySql() {
  if (!USER_POOL_ID) {
    throw new Error("USER_POOL_ID is missing in .env");
  }

  console.log("==> Iniciando Sincronização Cognito -> MySQL <==");
  
  // 1. Fetch AWS Cognito Users
  const command = new ListUsersCommand({ UserPoolId: USER_POOL_ID });
  const response = await cognitoClient.send(command);
  const cognitoUsers = response.Users || [];
  
  console.log(`Encontrados ${cognitoUsers.length} usuários no Cognito.`);

  // 2. Conectar ao MySQL
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'faith-hub',
    ssl: { rejectUnauthorized: false }
  });

  // 3. Inserir ou ignorar
  let inserted = 0;
  for (const user of cognitoUsers) {
    const attributes = user.Attributes || [];
    const getAttr = (name) => attributes.find(a => a.Name === name)?.Value || null;

    const id = getAttr("sub");
    const email = getAttr("email");
    const name = getAttr("name") || email.split('@')[0];
    const phone = getAttr("phone_number") || null;

    if (!id) continue;

    // Verificar se já existe
    const [existing] = await connection.query(`SELECT id FROM members WHERE id = ?`, [id]);
    if (existing.length === 0) {
      console.log(`[+] Inserindo usuário não mapeado: ${email} (${id})`);
      await connection.query(
        `INSERT INTO members (id, name, email, phone, role, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, name, email, phone, 'MEMBER', 'ACTIVE']
      );
      inserted++;
    } else {
      console.log(`[-] Usuário já sincronizado: ${email} (${id})`);
    }
  }

  await connection.end();
  console.log(`\n==> Sincronização concluída! ${inserted} usuários novos inseridos no MySQL.`);
}

syncCognitoToMySql().catch(console.error);
