import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {SQSClient,SendMessageCommand} from '@aws-sdk/client-sqs';
import {IntelligenceError} from './intelligenceUsage';
import {REPORT_MAX_BYTES} from './intelligenceReportFiles';
const s3=new S3Client({region:process.env.AWS_REGION||'us-east-2'}),queue=new SQSClient({region:process.env.AWS_REGION||'us-east-2'});
export function reportsConfigured(){return !!process.env.INTELLIGENCE_REPORTS_BUCKET&&!!process.env.INTELLIGENCE_REPORTS_QUEUE_URL;}
const bucket=()=>{if(!process.env.INTELLIGENCE_REPORTS_BUCKET)throw new IntelligenceError(503,'A geração de relatórios aguarda a liberação deste ambiente.');return process.env.INTELLIGENCE_REPORTS_BUCKET;};
export async function enqueueReport(org:string,id:string){if(!process.env.INTELLIGENCE_REPORTS_QUEUE_URL)throw new IntelligenceError(503,'A fila de relatórios aguarda a liberação deste ambiente.');await queue.send(new SendMessageCommand({QueueUrl:process.env.INTELLIGENCE_REPORTS_QUEUE_URL,MessageBody:JSON.stringify({type:'INTELLIGENCE_REPORT_V1',organization_id:org,report_id:id})}));}
export async function saveReportFile(key:string,bytes:Buffer,type:string){if(bytes.length>REPORT_MAX_BYTES)throw new IntelligenceError(413,'Arquivo acima do limite.');await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:bytes,ContentType:type,ServerSideEncryption:'AES256',CacheControl:'private, no-store',Metadata:{purpose:'authorized-intelligence-report'}}));}
export async function readReportFile(key:string){const response=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:key}));if(Number(response.ContentLength)>REPORT_MAX_BYTES)throw new IntelligenceError(413,'Arquivo acima do limite.');const parts:Buffer[]=[];let size=0;for await(const chunk of response.Body as any){size+=chunk.length;if(size>REPORT_MAX_BYTES){(response.Body as any)?.destroy?.();throw new IntelligenceError(413,'Arquivo acima do limite.');}parts.push(Buffer.from(chunk));}return Buffer.concat(parts);}
export async function removeReportFile(key:string){await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:key}));}
