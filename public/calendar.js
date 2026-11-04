// Date-only values are calendar dates, not UTC instants. Google end is exclusive.
export function parseDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(String(value))?new Date(value+'T00:00:00'):new Date(value)}
export function dayKey(value){const d=value instanceof Date?value:parseDate(value);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')}
const ordinal=d=>Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86400000;
const dayFromOrdinal=n=>{const d=new Date(n*86400000);return new Date(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())};
export function eventRange(e){
 const start=parseDate(e.start),end=parseDate(e.end);
 if(!Number.isFinite(+start)||!Number.isFinite(+end)||end<=start)return null;
 const allDay=!!e.all_day||/^\d{4}-\d{2}-\d{2}$/.test(e.start);
 const last=new Date(+end-1),firstDay=ordinal(start),lastDay=ordinal(last);
 return {start,end,last,firstDay,lastDay,days:lastDay-firstDay+1,allDay};
}
export function isFinished(e,now=new Date()){const r=eventRange(e);return !r||r.end<=now}
export function monthsAgo(now,count){
 const result=new Date(now),day=result.getDate();result.setDate(1);result.setMonth(result.getMonth()-count);
 result.setDate(Math.min(day,new Date(result.getFullYear(),result.getMonth()+1,0).getDate()));return result;
}
export function filterEvents(events,period='all',now=new Date()){
 const cutoff=period==='recent3'?monthsAgo(now,3):period==='recent6'?monthsAgo(now,6):null;
 return events.filter(e=>{const r=eventRange(e);if(!r)return false;
 if(period==='upcoming')return !e.cancelled&&r.end>now;
 if(period==='past'||cutoff)return r.end<=now&&(!cutoff||r.end>=cutoff);
 return true;
 }).sort((a,b)=>(period==='past'||cutoff?-1:1)*(parseDate(a.start)-parseDate(b.start))||String(a.id).localeCompare(String(b.id)));
}
// Interval coloring: overlapping events have different colors; colors persist across week segments.
export function eventColors(events){
 const ordered=events.map(event=>({event,range:eventRange(event)})).filter(x=>x.range&&!x.event.cancelled)
 .sort((a,b)=>a.range.start-b.range.start||a.range.end-b.range.end||String(a.event.id).localeCompare(String(b.event.id)));
 const active=[],colors=new Map();
 for(const {event,range} of ordered){
 for(let i=active.length-1;i>=0;i--)if(active[i].end<=range.start)active.splice(i,1);
 const used=new Set(active.map(a=>a.color));let color=0;while(used.has(color))color++;
 colors.set(event.id,color);active.push({end:range.end,color});
 }return colors;
}
export function eventColorStyle(index=0){
 const palette=[['#9abef0','#24354c'],['#efb286','#493528'],['#9dd4e8','#263e48'],['#e8ca9d','#463d2d'],['#adb9ee','#30384d'],['#e9aa96','#49342d']];
 const hue=index%2?18+(Math.floor(index/2)*7)%22:202+(Math.floor(index/2)*7)%32;
 const [ink,bg]=palette[index]||[`hsl(${hue} 65% 79%)`,`hsl(${hue} 24% 22%)`];
 return `--event-ink:${ink};--event-bg:${bg}`;
}
export function formatRange(e){
 const r=eventRange(e);if(!r)return 'Даты не указаны';
 const df=d=>d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
 const tf=d=>d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
 const unit=n=>n%10===1&&n%100!==11?'день':n%10>=2&&n%10<=4&&!(n%100>=12&&n%100<=14)?'дня':'дней';
 if(r.allDay)return r.days===1?df(r.start)+' · весь день':df(r.start)+' — '+df(r.last)+' · '+r.days+' '+unit(r.days);
 if(dayKey(r.start)===dayKey(r.end))return df(r.start)+' · '+tf(r.start)+'–'+tf(r.end);
 return df(r.start)+', '+tf(r.start)+' — '+df(r.end)+', '+tf(r.end);
}
export function calendarWeeks(events,year,month){
 const first=new Date(year,month,1),start=ordinal(first)-(first.getDay()+6)%7;
 const count=Math.ceil(((first.getDay()+6)%7+new Date(year,month+1,0).getDate())/7);
 const ranges=events.map(event=>({event,range:eventRange(event)})).filter(x=>x.range);
 return Array.from({length:count},(_,i)=>{
 const weekStart=start+i*7,weekEnd=weekStart+6,occupied=[];
 const segments=ranges.filter(x=>x.range.firstDay<=weekEnd&&x.range.lastDay>=weekStart)
 .sort((a,b)=>a.range.firstDay-b.range.firstDay||b.range.days-a.range.days||String(a.event.id).localeCompare(String(b.event.id)))
 .map(({event,range})=>{
 const from=Math.max(weekStart,range.firstDay)-weekStart,to=Math.min(weekEnd,range.lastDay)-weekStart;
 let lane=0;while(occupied[lane]?.some(([a,b])=>from<=b&&to>=a))lane++;
 (occupied[lane]??=[]).push([from,to]);
 return {event,range,from,to,lane,continuesBefore:range.firstDay<weekStart,continuesAfter:range.lastDay>weekEnd};
 });
 return {days:Array.from({length:7},(_,j)=>dayFromOrdinal(weekStart+j)),segments,lanes:occupied.length};
 });
}
