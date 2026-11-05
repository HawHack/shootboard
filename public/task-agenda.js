import {dateInZone,validDay} from './deadlines.js';

export function eventPhase(event,now=new Date()) {
 if(event.cancelled)return 'cancelled';
 if(event.all_day||/^\d{4}-\d{2}-\d{2}$/.test(event.start)){
  const today=dateInZone(now,event.timezone);
  return event.end<=today?'past':event.start>today?'future':'current';
 }
 return Date.parse(event.end)<=+now?'past':Date.parse(event.start)>+now?'future':'current';
}

export function sortTaskEvents(events,now=new Date()) {
 const rank={current:0,future:1,past:2,cancelled:3};
 return [...events].sort((a,b)=>{
  const ar=rank[eventPhase(a,now)],br=rank[eventPhase(b,now)];
  return ar-br||(ar>=2?Date.parse(b.end)-Date.parse(a.end):Date.parse(a.start)-Date.parse(b.start))||a.title.localeCompare(b.title,'ru')||String(a.id).localeCompare(String(b.id));
 });
}

// Pure grouping shared by the task page and tests. Input order never controls priority.
export function taskAgenda(tasks,events,now=new Date()) {
 const ordered=sortTaskEvents(events,now),byId=new Map(events.map(e=>[e.id,e])),order=new Map(ordered.map((e,i)=>[e.id,i]));
 const sections=[
  {id:'overdue',title:'Просроченные',hint:'Сначала недавние сроки — проверьте, что ещё нужно завершить.'},
  {id:'today',title:'На сегодня',hint:'Срок выполнения заканчивается сегодня.'},
  {id:'upcoming',title:'Ближайшие сроки',hint:'По порядку: от ближайшей даты к более поздним.'},
  {id:'undated',title:'Без дедлайна',hint:'Сначала текущие съёмки, затем предстоящие и недавно завершённые.'},
  {id:'cancelled',title:'Отменённые мероприятия',hint:'Оставшиеся задачи отменённых съёмок.'},
 ].map(section=>({...section,count:0,days:new Map()}));
 for(const task of tasks){
  const event=byId.get(task.event_id);if(task.done||!event)continue;
  const due=validDay(task.deadline)?task.deadline:null,today=dateInZone(now,task.timezone||event.timezone);
  const bucket=event.cancelled?'cancelled':!due?'undated':due<today?'overdue':due===today?'today':'upcoming';
  const section=sections.find(s=>s.id===bucket),day=due&&bucket!=='cancelled'?due:null;
  if(!section.days.has(day))section.days.set(day,{date:day,events:new Map()});
  const dateGroup=section.days.get(day);
  if(!dateGroup.events.has(event.id))dateGroup.events.set(event.id,{event,tasks:[]});
  dateGroup.events.get(event.id).tasks.push(task);section.count++;
 }
 return sections.filter(s=>s.count).map(section=>({...section,days:[...section.days.values()].sort((a,b)=>section.id==='overdue'?b.date.localeCompare(a.date):String(a.date).localeCompare(String(b.date))).map(day=>({...day,events:[...day.events.values()].sort((a,b)=>order.get(a.event.id)-order.get(b.event.id)).map(group=>({...group,tasks:group.tasks.sort((a,b)=>String(a.shooting_day||'').localeCompare(String(b.shooting_day||''))||a.title.localeCompare(b.title,'ru')||String(a.id).localeCompare(String(b.id)))}))}))}));
}
