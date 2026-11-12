const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {aws:call}=require('./production-aws.cjs');
const {APPS,ACCOUNT,REGION,ensure}=require('./production-release-policy.cjs');
const aws=(service,operation,...args)=>{const data={};for(let i=0;i<args.length;i+=2){const key=args[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());data[key]=key==='maxResults'?Number(args[i+1]):args[i+1];}return call(service,operation,args.length?data:undefined);};
ensure(process.argv.length===3,'Uso: node scripts/snapshot-production.cjs arquivo-novo.json');
ensure(!fs.existsSync(process.argv[2]),'Baseline já existe; não sobrescrever.');
const hash=x=>createHash('sha256').update(JSON.stringify(x ?? null)).digest('hex');
const identity=aws('sts','get-caller-identity');
ensure(identity.Account===ACCOUNT,'Conta AWS incorreta');
const data={capturedAt:new Date().toISOString(),account:identity.Account,operator:identity.Arn,region:'us-east-2',frontends:[],functions:[],limitations:['Backend source HEAD does not attest deployed function source; per-function CodeSha256 is the baseline.','No database schema inventory or migration application in this stage.','Both dev and prod backend stages serve production.']};
for(const [name,id] of [...Object.entries(APPS).map(([name,a])=>[name,a.id])]){
 const app=aws('amplify','get-app','--app-id',id).app;
 const branches=aws('amplify','list-branches','--app-id',id).branches;
 const item={name,id,repository:app.repository,autoBuild:app.enableBranchAutoBuild,autoBranchCreation:app.enableAutoBranchCreation,customRulesCount:app.customRules?.length||0,customRulesSha256:hash(app.customRules),buildSpec:app.buildSpec,environmentSha256:hash(app.environmentVariables),branches:[]};
 for(const b of branches){const jobs=aws('amplify','list-jobs','--app-id',id,'--branch-name',b.branchName,'--max-results','10').jobSummaries;item.branches.push({name:b.branchName,stage:b.stage,autoBuild:b.enableAutoBuild,preview:b.enablePullRequestPreview,environmentSha256:hash(b.environmentVariables),jobs:jobs.map(j=>({id:j.jobId,status:j.status,commit:j.commitId,type:j.jobType,start:j.startTime,end:j.endTime}))});}
 data.frontends.push(item);
}
const funcs=aws('lambda','list-functions').Functions.filter(f=>f.FunctionName.startsWith('faith-hub-backend-'));
data.functions=funcs.map(f=>({name:f.FunctionName,arn:f.FunctionArn,runtime:f.Runtime,handler:f.Handler,codeSha256:f.CodeSha256,revisionId:f.RevisionId,lastModified:f.LastModified,environmentSha256:hash(f.Environment?.Variables||{}),layers:(f.Layers||[]).map(l=>l.Arn)}));
data.apis=[];
for(const id of ['usl72lj2m5','566n5qz7te']){const api=aws('apigatewayv2','get-api','--api-id',id);const routes=aws('apigatewayv2','get-routes','--api-id',id);const integrations=aws('apigatewayv2','get-integrations','--api-id',id);data.apis.push({id,endpoint:api.ApiEndpoint,routes:routes.Items.map(r=>({key:r.RouteKey,target:r.Target})),integrations:integrations.Items.map(i=>({id:i.IntegrationId,uri:i.IntegrationUri}))});}
const out=process.argv[2];fs.writeFileSync(out,JSON.stringify(data,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({file:out,functions:data.functions.length,frontends:data.frontends.map(a=>({name:a.name,auto:a.autoBuild,branches:a.branches.map(b=>({name:b.name,auto:b.autoBuild,latest:b.jobs[0]}))}))}));
