// Restore only the S3 object-write permission required by authenticated presigned uploads.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),assert=require('node:assert/strict');
require('dotenv').config({quiet:true});
const aws=args=>JSON.parse(execFileSync('aws',[...args,'--region','us-east-2','--output','json'],{encoding:'utf8',env:{...process.env,AWS_PAGER:''}})||'{}');
const bucket=process.env.S3_MEDIA_BUCKET||'faith-hub-media-bucket-rafaelsena';
const statement={Sid:'TenantScopedMediaUploads',Effect:'Allow',Action:['s3:PutObject'],Resource:`arn:aws:s3:::${bucket}/*/*`};
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const apply=process.argv.includes('--apply');const dir=process.env.FAITH_HUB_MEDIA_POLICY_BACKUP_DIR||'/tmp/faith-media-upload-policy';
if(apply){fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700)}
for(const stage of ['dev','prod']){
 const role=`faith-hub-backend-${stage}-us-east-2-lambdaRole`,policy=`faith-hub-backend-${stage}-lambda`;
 const before=aws(['iam','get-role-policy','--role-name',role,'--policy-name',policy]).PolicyDocument;
 const previous=before.Statement.find(s=>s.Sid===statement.Sid);if(previous)assert.deepEqual(previous,statement,'An existing media statement differs; review before changing it.');
 const after=previous?before:{...before,Statement:[...before.Statement,statement]};
 if(apply&&!previous){const backup=path.join(dir,stage+'-before.json'),candidate=path.join(dir,stage+'-after.json');fs.writeFileSync(backup,JSON.stringify(before,null,2),{mode:0o600});fs.writeFileSync(candidate,JSON.stringify(after,null,2),{mode:0o600});aws(['iam','put-role-policy','--role-name',role,'--policy-name',policy,'--policy-document','file://'+candidate]);const actual=aws(['iam','get-role-policy','--role-name',role,'--policy-name',policy]).PolicyDocument;assert.deepEqual(actual,after);}
 console.log(JSON.stringify({stage,role,apply,changed:apply&&!previous,statement,beforeHash:digest(before),afterHash:digest(after),existingPermissionsPreserved:true}));
}
