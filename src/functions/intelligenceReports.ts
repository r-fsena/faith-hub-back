import type {SQSEvent,SQSBatchResponse} from 'aws-lambda';
import {processReport} from '../services/intelligenceReports';
export async function intelligenceReportsWorker(event:SQSEvent):Promise<SQSBatchResponse>{
 const batchItemFailures:Array<{itemIdentifier:string}>=[];
 for(const record of event.Records){try{await processReport(JSON.parse(record.body));}catch{console.error('Report processing deferred',{messageId:record.messageId});batchItemFailures.push({itemIdentifier:record.messageId});}}
 return{batchItemFailures};
}
