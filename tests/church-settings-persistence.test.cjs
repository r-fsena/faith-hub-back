process.env.AWS_EC2_METADATA_DISABLED='true';
const {test,beforeEach}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
let records,user,failRead,writes;
const clone=v=>JSON.parse(JSON.stringify(v));
function mock(file,exports){const p=require.resolve(file);require.cache[p]={id:p,filename:p,loaded:true,exports}}
mock('../src/db/index.ts',{apiResponse:(statusCode,data)=>({statusCode,body:JSON.stringify(data)}),query:async(sql,args=[])=>{
 assert.equal((sql.match(/\?/g)||[]).length,args.length,sql);
 if(sql.includes('FROM church_settings')){if(failRead)throw Error('DB_UNAVAILABLE');let found;
 if(sql.includes('organization_id <>'))found=records.filter(s=>s.id===args[0]&&s.organization_id!==args[1]);
 else found=records.filter(s=>s.organization_id===args[0]||s.id===args[0]||s.pwa_slug===args[0]);
 return{rows:clone(found.slice(0,1))};}
 if(sql.includes('INSERT INTO church_settings')){writes++;const columns=sql.match(/church_settings \(([\s\S]*?)\) VALUES/)[1].split(',').map(v=>v.trim());const row=Object.fromEntries(columns.map((k,i)=>[k,args[i]]));const index=records.findIndex(s=>s.id===row.id);if(index<0)records.push(row);else records[index]={...records[index],...row};return{rows:{affectedRows:1}};}
 if(sql.includes('UPDATE organizations')||sql.includes('INSERT INTO security_audit_logs'))return{rows:{affectedRows:1}};
 throw Error('Unexpected SQL '+sql);
}});
mock('../src/services/pwaExperienceService.ts',{publishedExperience:async()=>({enabled:false,config:null})});
const auth=require('../src/services/authMiddleware.ts');auth.requireAuth=async()=>user?{user}:{errorResponse:{statusCode:401,body:'{}'}};
const {updateSettings,getSettings}=require('../src/functions/churchSettings.ts');const config=require('../src/config/pwaExperience.ts');
const welcome={enabled:true,hero_image_url:'https://church.example/first.jpg',headline:'Bem-vindo à Palavra Viva',subtitle:'Nossa comunidade',allow_guest_browse:true,slides:[{badge:'CONNECT',title:'Participe',description:'Caminhe conosco',image_url:'https://church.example/second.jpg'}]};
const event=body=>({httpMethod:'POST',headers:{},body:JSON.stringify({organization_id:'org-a',...body})});
beforeEach(()=>{user={userId:'admin',role:'ADMIN',organizationId:'org-a',campusIds:['all'],isSuperAdmin:false};writes=0;failRead=false;records=[{id:'original-settings',organization_id:'org-a',church_name:'Palavra Viva',pwa_slug:'palavra-viva',welcome_screen_config:JSON.stringify(welcome),bible_config:JSON.stringify({default_version:'acf'}),address_city:'Florianópolis',cnpj:null}]});
test('save reuses the tenant record even when an older client fabricates a slug ID; all welcome screens survive readback',async()=>{
 const changed={...welcome,headline:'Primeira tela atualizada',hero_image_url:'https://church.example/new-first.jpg',slides:[{...welcome.slides[0],title:'Segunda tela atualizada',image_url:'https://church.example/new-second.jpg'}]};
 const result=await updateSettings(event({id:'settings_palavra_viva',welcome_screen_config:changed}));assert.equal(result.statusCode,200);assert.equal(JSON.parse(result.body).settings.id,'original-settings');assert.equal(records.length,1);
 const read=await getSettings({queryStringParameters:{organization_id:'org-a'}});assert.equal(read.statusCode,200);assert.deepEqual(JSON.parse(read.body).welcome_screen_config,changed);
});
test('partial identity save preserves welcome screens, Bible configuration, address and null institutional document',async()=>{
 const result=await updateSettings(event({church_name:'Palavra Viva Church'}));assert.equal(result.statusCode,200);assert.deepEqual(JSON.parse(records[0].welcome_screen_config),welcome);assert.deepEqual(JSON.parse(records[0].bible_config),{default_version:'acf'});assert.equal(records[0].address_city,'Florianópolis');assert.equal(records[0].cnpj,null);
});
test('foreign record ID cannot transfer or alter another tenant configuration',async()=>{
 records.push({id:'foreign-settings',organization_id:'org-b'});const before=clone(records);const result=await updateSettings(event({id:'foreign-settings'}));assert.equal(result.statusCode,403);assert.equal(writes,0);assert.deepEqual(records,before);
});
test('read failure is explicit instead of falsely returning default settings with HTTP 200',async()=>{
 failRead=true;const old=console.error;console.error=()=>{};try{assert.equal((await getSettings({queryStringParameters:{organization_id:'org-a'}})).statusCode,503)}finally{console.error=old}
});
test('unauthenticated and cross-tenant mutations are rejected before any write',async()=>{
 user=null;assert.equal((await updateSettings(event({}))).statusCode,401);user={role:'ADMIN',organizationId:'org-b',isSuperAdmin:false};assert.equal((await updateSettings(event({}))).statusCode,403);assert.equal(writes,0);
});
test('monochrome palettes are readable in both modes and do not classify colored tenants as monochrome',()=>{
 const mono=config.resolveExperience({}, {theme:config.monochromePalettes()});assert.equal(config.isMonochromeExperience(mono),true);assert.deepEqual(config.contrastIssues(mono),[]);assert.equal(config.contrast(mono.theme.light.text,mono.theme.light.background),21);assert.equal(config.isMonochromeExperience(config.defaultExperience()),false);
});
