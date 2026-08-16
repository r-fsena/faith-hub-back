const { spawn } = require('child_process');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

console.log('🚀 Iniciando deploy Serverless na AWS...');
console.log('Região AWS:', process.env.AWS_REGION || 'us-east-2');
console.log('Database Host:', process.env.DB_HOST);

const env = {
  ...process.env,
  CI: '1',
  SLS_TELEMETRY_DISABLED: '1',
  SERVERLESS_UPDATE_NOTIFIER_DISABLED: '1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || 'us-east-2'
};

const slsBin = path.resolve(__dirname, 'node_modules/.bin/serverless');

const child = spawn(slsBin, ['deploy', '--verbose'], {
  env,
  stdio: 'inherit',
  cwd: __dirname
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('\n🎉 Deploy concluído com sucesso!');
  } else {
    console.error(`\n❌ Deploy finalizou com código de saída: ${code}`);
  }
  process.exit(code);
});

child.on('error', (err) => {
  console.error('❌ Erro ao disparar processo Serverless:', err);
  process.exit(1);
});
