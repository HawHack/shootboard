import {eventRange,filterEvents} from './calendar.js';
export function eventStatus(event,now=new Date()){
 if(event.cancelled)return 'Отменено';const r=eventRange(event);if(!r)return 'Даты не указаны';
 return r.end<=now?'Завершено':r.start<=now?'Идёт сейчас':'Предстоит';
}
export function orderedEvents(events,period,now=new Date()){
 const selected=period==='active'?filterEvents(events,'upcoming',now):period==='upcoming'?events.filter(e=>!e.cancelled&&eventRange(e)?.start>now):filterEvents(events,period,now);
 const rank=e=>e.cancelled?3:eventStatus(e,now)==='Идёт сейчас'?0:eventStatus(e,now)==='Предстоит'?1:2;
 return selected.sort((a,b)=>rank(a)-rank(b)||(rank(a)>=2?eventRange(b).end-eventRange(a).end:eventRange(a).start-eventRange(b).start)||String(a.id).localeCompare(String(b.id)));
}
export function pageOf(events,page=1,size=4){const pages=Math.max(1,Math.ceil(events.length/size)),current=Math.min(pages,Math.max(1,page));return {items:events.slice((current-1)*size,current*size),page:current,pages,total:events.length,from:events.length?(current-1)*size+1:0,to:Math.min(current*size,events.length)}}
export function overlapCount(event,events){const r=eventRange(event);if(!r||event.cancelled)return 0;return events.filter(other=>{const o=eventRange(other);return other.id!==event.id&&!other.cancelled&&o&&r.start<o.end&&o.start<r.end}).length}
