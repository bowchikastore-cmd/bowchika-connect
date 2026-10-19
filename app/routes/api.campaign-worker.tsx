import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getWhatsAppConfig, sendAndPersistWhatsAppMessage, getConfiguredWhatsAppShop, isWhatsAppInboxSendingEnabled } from "../whatsapp.server";
import { buildWhatsAppTemplatePayload, normalizeE164Phone, parseWhatsAppTemplateInput } from "../whatsapp-shared";

const json=(body:object,status=200)=>Response.json(body,{status});
const isAuthorized=(request:Request)=>{
  const secret=(process.env.CAMPAIGN_WORKER_SECRET??"").trim();
  const supplied=(request.headers.get("authorization")??"").replace(/^Bearer\s+/i,"").trim();
  return secret.length>=32 && supplied.length===secret.length && supplied===secret;
};
export const loader=async({request}:LoaderFunctionArgs)=>{
  if(!isAuthorized(request)) return new Response("Not found",{status:404});
  return json({ok:true,service:"campaign-worker"});
};
const resolveValue=(path:string,snapshot:Record<string,any>,campaign:Record<string,any>)=>{
  if(path==="custom") return "";
  if(path==="mediaUrl") return String(campaign.mediaUrl??"");
  if(path==="latestOrder.productName"){const order=snapshot.latestOrder;if(!order)return "";try{return JSON.parse(order.lineItemsJson||"[]")[0]?.name??""}catch{return ""}}\n  return path.split(".").reduce<any>((value,key)=>value==null?undefined:value[key],snapshot);
};
export const action=async({request}:ActionFunctionArgs)=>{
  if(request.method!=="POST") return new Response("Method not allowed",{status:405});
  if(!isAuthorized(request)) return new Response("Not found",{status:404});
  if(!isWhatsAppInboxSendingEnabled()) return json({error:"WhatsApp sending is disabled by the existing safety switch."},503);\n  const configuredShop=getConfiguredWhatsAppShop();
  if(!configuredShop) return json({error:"WhatsApp shop configuration missing."},503);
  let config;
  try { config=getWhatsAppConfig(); } catch { return json({error:"WhatsApp API configuration missing."},503); }
  const now=new Date();
  const campaigns=await prisma.whatsAppCampaign.findMany({
    where:{shop:configuredShop,status:{in:["QUEUED","SCHEDULED"]},OR:[{scheduledAt:null},{scheduledAt:{lte:now}}]},
    orderBy:{createdAt:"asc"},take:3,
  });
  let processed=0;
  for(const campaign of campaigns){
    const pending=await prisma.whatsAppCampaignRecipient.findMany({
      where:{campaignId:campaign.id,shop:campaign.shop,status:"QUEUED"},
      orderBy:{queuedAt:"asc"},take:10,
    });
    if(campaign.status==="SCHEDULED") await prisma.whatsAppCampaign.updateMany({where:{id:campaign.id,shop:campaign.shop,status:"SCHEDULED"},data:{status:"SENDING"}});
    for(const recipient of pending){
      const current=recipient.customerId?await prisma.shopifyCustomerMirror.findFirst({where:{id:recipient.customerId,shop:campaign.shop},select:{whatsappOptIn:true,phone:true}}):null;
      const phone=normalizeE164Phone(current?.phone??recipient.phoneNumber);
      if(!current?.whatsappOptIn || !phone || phone!==normalizeE164Phone(recipient.phoneNumber)){
        await prisma.whatsAppCampaignRecipient.update({where:{id:recipient.id},data:{status:"SKIPPED",error:"WhatsApp opt-in is missing/revoked or recipient phone changed."}});
        processed++; continue;
      }
      const snapshot=JSON.parse(recipient.snapshotJson||"{}") as Record<string,any>;
      const mapping=JSON.parse(campaign.variableMappingJson||"{}") as Record<string,string>;
      const requirementsInput:Record<string,any>={};
      const get=(section:string,key:string)=>{const path=mapping[section+"."+key]??"name";return String(path==="custom"?(mapping["custom."+section+"."+key]??""):resolveValue(path,snapshot,campaign)??"").trim();};
      const templateComponents=JSON.parse(campaign.templateComponents) as Array<Record<string,any>>;
      const bodyVars=[...new Set([...(templateComponents.find(c=>String(c.type).toUpperCase()==="BODY")?.text?.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)??[])].map((m:RegExpMatchArray)=>m[1]))];
      const headerText=templateComponents.find(c=>String(c.type).toUpperCase()==="HEADER"&&String(c.format).toUpperCase()==="TEXT")?.text as string|undefined;
      const headerVars=[...new Set([...(headerText?.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)??[])].map(m=>m[1]))];
      const headerImage=templateComponents.some(c=>String(c.type).toUpperCase()==="HEADER"&&String(c.format).toUpperCase()==="IMAGE");
      if(headerVars.length) requirementsInput.header={values:headerVars.map(key=>get("header",key))};
      if(headerImage) requirementsInput.header={value:campaign.mediaUrl??"",mediaType:"url"};
      if(bodyVars.length) requirementsInput.body=bodyVars.map(key=>get("body",key));
      const buttonInputs:Record<string,string[]>={};
      templateComponents.filter(c=>String(c.type).toUpperCase()==="BUTTONS").forEach(component=>component.buttons?.forEach((button:any,index:number)=>{
        const matches=[...(String(button.url??"").matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g))].map(m=>m[1]);
        if(matches.length) buttonInputs[String(index)]=matches.map(key=>get("button"+index,key));
      }));
      if(Object.keys(buttonInputs).length) requirementsInput.buttons=buttonInputs;
      try {
        const parsed=parseWhatsAppTemplateInput(JSON.stringify(requirementsInput),campaign.templateComponents);
        const result=await sendAndPersistWhatsAppMessage(prisma,config,buildWhatsAppTemplatePayload(phone,campaign.templateName,campaign.templateLanguage,parsed.components),{
          shop:campaign.shop,phoneNumber:phone,clientRequestId:"campaign-recipient:"+recipient.id,type:"TEMPLATE",text:parsed.preview,
        });
        if(result.error) {
          await prisma.whatsAppCampaignRecipient.update({where:{id:recipient.id},data:{status:"FAILED",error:"WhatsApp provider rejected or could not accept this message.",failedAt:new Date(),attempts:{increment:1}}});
        } else {
          await prisma.whatsAppCampaignRecipient.update({where:{id:recipient.id},data:{status:"SENT",whatsappMessageId:result.pendingMessage.messageId,sentAt:new Date(),error:null,attempts:{increment:1}}});
        }
      } catch {
        await prisma.whatsAppCampaignRecipient.update({where:{id:recipient.id},data:{status:"FAILED",error:"Template mapping or send preparation failed; review the mapping before retrying.",failedAt:new Date(),attempts:{increment:1}}});
      }
      processed++;
    }
    const counts=await prisma.whatsAppCampaignRecipient.groupBy({by:["status"],where:{campaignId:campaign.id},_count:{_all:true}});
    const terminal=counts.every(c=>["SENT","DELIVERED","READ","FAILED","SKIPPED"].includes(c.status));
    if(terminal) await prisma.whatsAppCampaign.updateMany({where:{id:campaign.id,shop:campaign.shop},data:{status:counts.some(c=>c.status==="FAILED")?"COMPLETED_WITH_ERRORS":"COMPLETED"}});
  }
  return json({ok:true,processed,campaigns:campaigns.length});
};
