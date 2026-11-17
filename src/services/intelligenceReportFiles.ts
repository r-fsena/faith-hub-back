import PDFDocument from 'pdfkit';
import font from '../assets/report-font.json';
import {ReportData} from './intelligenceReportData';
import {IntelligenceError} from './intelligenceUsage';
export const REPORT_MAX_BYTES=3*1024*1024;
const clean=(s:unknown)=>String(s??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/[\u2011-\u2014]/g,'-');
export const reportStatus=(s:string)=>({observed:'Histórico observado e revisado',unknown_history:'Sem cobertura histórica suficiente',available:'Fonte disponível',error:'Fonte indisponível',not_available:'Indisponível',not_measured:'Medição em formação',insufficient_sample:'Amostra protegida',partial_coverage:'Cobertura parcial',registered_records:'Registros disponíveis',current_register:'Posição atual',partial:'Cobertura parcial'} as Record<string,string>)[s]||'Confira a cobertura';
const date=(s:string)=>s.slice(0,10).split('-').reverse().join('/');
const end=(s:string)=>new Date(Date.parse(s+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const display=(n:number|null,unit:string)=>n===null?'Indisponível':unit==='BRL_CENTS'?new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(n/100):n.toLocaleString('pt-BR',{maximumFractionDigits:2})+(unit==='percent'?'%':'');
export function csvCell(value:unknown){if(typeof value==='number')return Number.isFinite(value)?String(value):'';const text=clean(value);return '"'+(/^[\s\uFEFF]*[=+\-@\t\r]/.test(text)?"'"+text:text).replace(/"/g,'""')+'"';}
export function reportCsv(data:ReportData):Buffer {
 const header=['Seção','Indicador','Unidade','Atual','Anterior','Situação','Definição','Início','Fim exclusivo','Comparação início','Comparação fim exclusivo','Fuso','Gerado em','Versão das definições','Revisão'];
 const lines=[header.map(csvCell).join(';'),...data.rows.map(row=>[row.section,row.metric,row.unit,row.current??'',row.previous??'',reportStatus(row.status),row.definition,data.period.start,data.period.end,data.period.previousStart,data.period.previousEnd,data.period.timezone,data.generatedAt,data.definitionVersion,data.revision].map(csvCell).join(';'))];
 const result=Buffer.from('\ufeff'+lines.join('\r\n')+'\r\n','utf8');if(result.length>REPORT_MAX_BYTES)throw new IntelligenceError(413,'O CSV ultrapassa 3 MB. Restrinja o escopo.');return result;
}
export async function reportPdf(data:ReportData):Promise<Buffer>{
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:'A4',margins:{top:92,left:40,right:40,bottom:44},font:Buffer.from(font.regular,'base64') as unknown as string,bufferPages:true,autoFirstPage:false,info:{Title:clean(data.title),Author:'Faith Hubs',Subject:'Indicadores agregados no escopo autorizado'}});
  const chunks:Buffer[]=[];let bytes=0,pages=0;
  doc.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>REPORT_MAX_BYTES){doc.destroy(new Error('PDF_SIZE_LIMIT'));return;}chunks.push(chunk);});
  doc.on('error',e=>reject(e.message==='PDF_SIZE_LIMIT'?new IntelligenceError(413,'O PDF ultrapassa 3 MB. Restrinja o escopo.'):e));
  doc.on('end',()=>resolve(Buffer.concat(chunks)));
  try{
   doc.on('pageAdded',()=>{if(++pages>250)throw new IntelligenceError(413,'O PDF excede 250 páginas. Restrinja o período ou as unidades.');doc.fillColor('#0F766E').fontSize(9).text('FAITH HUBS / INTELIGÊNCIA',40,27,{lineBreak:false});doc.fillColor('#172033').fontSize(16).text(clean(data.title),40,45,{width:515,lineBreak:false});doc.fontSize(8).fillColor('#475569').text(`${date(data.period.start)} a ${date(end(data.period.end))} | ${clean(data.scopeLabel)}`,40,69,{width:515,lineBreak:false});doc.y=97;});
   doc.addPage();doc.fontSize(12).fillColor('#172033').text(clean(data.organization),40,doc.y,{width:515});doc.fontSize(8).fillColor('#475569').text(`Gerado em ${new Date(data.generatedAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} (Brasília)\nComparação: ${date(data.period.previousStart)} a ${date(end(data.period.previousEnd))}\nDefinições ${data.definitionVersion} | Revisão ${data.revision.slice(0,16)}`,{width:515});doc.moveDown(1);
   let section='';
   for(const row of data.rows){
    const description=clean(row.metric)+(row.definition?'\n'+clean(row.definition):''),height=Math.max(49,doc.fontSize(8).heightOfString(description,{width:248})+18);
    if(doc.y+height+33>doc.page.height-50){doc.addPage();section='';}
    if(section!==row.section){section=row.section;doc.fontSize(11).fillColor('#0F766E').text(clean(section),40,doc.y,{width:515});doc.moveDown(.4);}
    const y=doc.y;doc.fillColor('#172033').fontSize(9).text(clean(row.metric),40,y,{width:246});doc.fillColor('#64748B').fontSize(8).text(clean(row.definition),40,doc.y+3,{width:246});
    doc.fillColor('#172033').fontSize(10).text(display(row.current,row.unit),300,y,{width:115});doc.fontSize(8).fillColor('#64748B').text('Atual',300,doc.y+3,{width:115});
    doc.fontSize(10).fillColor('#172033').text(display(row.previous,row.unit),430,y,{width:120});doc.fontSize(8).fillColor('#64748B').text('Anterior',430,doc.y+3,{width:120});
    doc.y=y+height;doc.fontSize(7).fillColor('#64748B').text(reportStatus(row.status),40,doc.y,{width:515});doc.y+=15;doc.moveTo(40,doc.y).lineTo(555,doc.y).strokeColor('#E2E8F0').stroke();doc.y+=10;
   }
   if(!data.rows.length)doc.fontSize(10).fillColor('#475569').text('Nenhum registro elegível no período; confira as definições e a cobertura das fontes.');
   doc.moveDown();doc.fillColor('#0F766E').fontSize(12).text('Cobertura e leitura dos indicadores');
   for(const note of data.notes){doc.fontSize(9).fillColor('#475569').text(clean(note),{width:515,paragraphGap:7});}
   const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.fontSize(7).fillColor('#64748B').text(`Uso interno autorizado | Rev. ${data.revision.slice(0,16)} | Página ${i+1} de ${range.count}`,40,doc.page.height-28,{width:515,lineBreak:false});doc.page.margins.bottom=bottom;}
   doc.end();
  }catch(e){doc.destroy();reject(e);}
 });
}
