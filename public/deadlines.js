export const defaultZone = 'Asia/Krasnoyarsk';
export function validZone(zone) { if(typeof zone!=='string'||!zone)return defaultZone;try { new Intl.DateTimeFormat('en',{timeZone:zone}).format(); return zone; } catch { return defaultZone; } }
export function dateInZone(value,zone=defaultZone) {
 if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:validZone(zone),year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
 const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(day,n) { const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); }
export function validDay(day) { return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day; }
export function shootingDays(event) {
 const first=dateInZone(event.start,event.timezone),last=event.all_day||/^\d{4}-\d{2}-\d{2}$/.test(event.start)?addDays(dateInZone(event.end,event.timezone),-1):dateInZone(new Date(Date.parse(event.end)-1).toISOString(),event.timezone);
 const days=[];for(let day=first;day<=last;day=addDays(day,1)){if(days.length>=366)throw Error('Выберите мероприятие длительностью не более года');days.push(day);}return days;
}
export function deliveryDeadline(kind,day){return addDays(day,kind==='video'?3:22);}
export function deadlineInfo(task,now=new Date()) {
 if(!task.deadline)return null;const today=dateInZone(now,task.timezone),n=Math.round((Date.parse(task.deadline)-Date.parse(today))/86400000);
 return {label:task.done?'Выполнено':n<0?`Просрочено на ${-n} дн.`:n===0?'Сегодня':`Осталось ${n} дн.`,late:!task.done&&n<0,today:!task.done&&n===0};
}
