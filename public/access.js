const token=location.hash.slice(1);
history.replaceState(null,'','/access');
(async()=>{try{const r=await fetch('/api/access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});const b=await r.json();if(!r.ok)throw Error(b.error);location.replace('/')}catch(e){document.querySelector('#message').textContent=e.message}})();
