import { normalizeTileTelemetry } from './telemetry.js';

(function(){
'use strict';
 
/* ================= shared world (owned by the server) ================= */
var DIRS=[[0,-1],[1,-1],[1,0],[0,1],[-1,1],[-1,0]];
var SIDE_LABEL=['North','Northeast','Southeast','South','Southwest','Northwest'];
var SIDE_SHORT=['N','NE','SE','S','SW','NW'];
var K=function(q,r){return q+','+r;};
var off=function(c,rw){return [c,rw-((c-(c&1))/2)];};
var COLS=10,ROWS=7,TOTAL=30,RANGE=2.4,STALE_MS=3500;
 
var WORLD=(function(){
  var cells=[];
  for(var c=0;c<COLS;c++)for(var rw=0;rw<ROWS;rw++)cells.push(off(c,rw));
  return {
    cells:cells,
    obstacles:[off(7,1),off(6,0),off(8,3),off(5,5),off(6,5),off(2,1),off(9,4)],
    pads:{S:off(0,5),F:off(9,1),P1:off(3,1),P2:off(7,4)},
    route:[off(1,4),off(2,4),off(3,3),off(4,3),off(5,2),off(6,2),off(7,2),off(8,2)],
    start:[off(1,4),off(2,4),off(3,3),off(4,3),off(5,2),off(6,2)]
  };
})();
var toSet=function(a){var s=new Set();a.forEach(function(p){s.add(K(p[0],p[1]));});return s;};
var BOARD=toSet(WORLD.cells),OBST=toSet(WORLD.obstacles),ROUTE=toSet(WORLD.route);
var RESERVED=toSet(Object.keys(WORLD.pads).map(function(k){return WORLD.pads[k];}));
 
/* ================= console state ================= */
var S={
  connection:'resyncing',      // live | offline | resyncing
  lastSeq:0,layout:null,tiles:new Map(),stats:null,statsAt:0,
  reqs:[],reqCounter:0,buf:new Map(),gapTimer:null,lastMsgAt:Date.now(),offlineSince:0,
  log:[],justAdded:{},raf:0,
  ui:{selTile:null,selSide:1,filter:null,confirmRestart:0,open:false,drawerTab:'tiles',guideMin:(function(){try{return localStorage.getItem('kastor-guide-min')==='1';}catch(e){return false;}})()}
};
var RANK={sending:0,accepted:1,in_progress:2,completed:3,rejected:3,lost:3};
var rankOf=function(s){return RANK[s]===undefined?0:RANK[s];};
var $=function(id){return document.getElementById(id);};
 
function fmtTime(t){return new Date(t).toLocaleTimeString([], {hour12:false});}
function log(kind,text){
  S.log.unshift({t:Date.now(),kind:kind,text:text});
  if(S.log.length>40)S.log.length=40;
  invalidate();
}
function invalidate(){
  if(S.raf)return;
  var run=function(){S.raf=0;renderAll();};
  S.raf=(window.requestAnimationFrame?window.requestAnimationFrame(run):setTimeout(run,16))||1;
}
 
/* ================= simulated link ================= */
var net={
  connected:true,latency:250,dup:false,reorder:false,
  delay:function(){return this.latency*(0.6+Math.random()*0.8);},
  toClient:function(msg){
    var self=this;
    if(!self.connected)return;
    var send=function(extra){
      setTimeout(function(){if(self.connected)receive(JSON.parse(JSON.stringify(msg)));},self.delay()+extra);
    };
    send(self.reorder&&Math.random()<0.45?Math.random()*Math.max(1400,self.latency*1.6):0);
    if(self.dup&&Math.random()<0.4)send(150+Math.random()*500);
  },
  toServer:function(fn){
    var self=this;
    if(!self.connected)return false;
    var run=function(){setTimeout(function(){if(self.connected)fn();},self.delay());};
    run();
    if(self.dup&&Math.random()<0.4)run();
    return true;
  },
  rest:function(fn){
    var self=this;
    setTimeout(function(){if(self.connected)fn(JSON.parse(JSON.stringify(server.snapshot())));},self.delay());
  }
};
 
/* ================= mock server (authoritative) ================= */
function MockServer(){
  this.seq=0;this.reqs=new Map();this.faults=new Map();this.last=new Map();
  this.rejectNext=false;this.epoch=0;this.onConsumed=null;
  this.reset(65000);
}
MockServer.prototype={
  reset:function(base){
    var self=this;
    this.epoch++;
    this.tiles=new Map();this.byCell=new Map();this.nextId=1;
    WORLD.start.forEach(function(p){self.place(p[0],p[1]);});
    this.paused=false;this.complete=false;this.base=base;this.runStart=Date.now();
    this.faults.clear();this.last.clear();
  },
  place:function(q,r){
    var t={id:'T'+(this.nextId++),q:q,r:r};
    this.tiles.set(t.id,t);this.byCell.set(K(q,r),t);return t;
  },
  elapsed:function(now){return this.base+((this.paused||this.complete)?0:now-this.runStart);},
  stats:function(now){
    var wrong=0;
    this.tiles.forEach(function(t){if(!ROUTE.has(K(t.q,t.r)))wrong++;});
    return {elapsed:this.elapsed(now),paused:this.paused,complete:this.complete,used:this.tiles.size,total:TOTAL,wrong:wrong};
  },
  sample:function(t,i,now){
    var key=t.id+':'+i,fault=this.faults.get(key);
    var dq=DIRS[i][0],dr=DIRS[i][1];
    var n=this.byCell.get(K(t.q+dq,t.r+dr));
    if(n){this.last.delete(key);return {joined:n.id};}
    if(fault==='freeze'&&this.last.has(key))return this.last.get(key);
    var out;
    if(fault==='dropout'){
      out={status:'UNKNOWN',risk:null,ts:now,measurements:[]};
    }else{
      var base=null;
      for(var k=1;k<=3;k++){
        if(OBST.has(K(t.q+dq*k,t.r+dr*k))){base=(k-1)*0.8+0.3;break;}
      }
      var jit=function(){return (Math.random()-0.5)*0.06;};
      var meas=[],hit=base!==null;
      var usD=hit?Math.max(0.05,base+jit()):null;
      meas.push({type:'ultrasonic',hit:hit,distance:usD?+usD.toFixed(2):null,ts:now});
      var worst=null;
      meas.forEach(function(m){if(m.hit&&(worst===null||m.distance<worst))worst=m.distance;});
      var status=worst===null?'CLEAR':worst<0.6?'RISK':worst<1.2?'CAUTION':'CLEAR';
      var risk=worst===null?0:Math.round(100*Math.min(1,Math.max(0,1-worst/2)));
      out={status:status,risk:risk,ts:now,measurements:meas};
    }
    this.last.set(key,out);
    return out;
  },
  payload:function(t,now){
    var sides=[];
    for(var i=0;i<6;i++)sides.push(this.sample(t,i,now));
    return {
      id:t.id,q:t.q,r:t.r,sides:sides,
      battery_v:12.1,lower_battery_v:null,
      turntable:{status:'IDLE',fault:'NONE',angle_deg:0,current_edge:0}
    };
  },
  snapshot:function(){
    var now=Date.now(),self=this,tiles=[];
    this.tiles.forEach(function(t){tiles.push(self.payload(t,now));});
    var reqs=[];
    this.reqs.forEach(function(r){reqs.push({id:r.id,status:r.status,progress:r.progress,reason:r.reason});});
    return {type:'snapshot',seq:this.seq,layout:WORLD,tiles:tiles,stats:this.stats(now),requests:reqs};
  },
  emit:function(msg){msg.seq=++this.seq;net.toClient(msg);},
  status:function(r){net.toClient({type:'request_status',id:r.id,status:r.status,progress:r.progress,reason:r.reason});},
  tick:function(){
    var now=Date.now(),self=this,sides=[];
    this.tiles.forEach(function(t){
      for(var i=0;i<6;i++){
        if(self.faults.get(t.id+':'+i)==='freeze')continue;
        var s=self.sample(t,i,now);
        if(!s.joined){var u={tile:t.id,side:i};for(var k in s)u[k]=s[k];sides.push(u);}
      }
    });
    this.emit({type:'sensor_update',sides:sides,stats:this.stats(now)});
  },
  setFault:function(id,i,kind){
    var key=id+':'+i;
    if(kind)this.faults.set(key,kind);else this.faults.delete(key);
    log('srv',kind?('Sensor '+id+' side '+(i+1)+': '+kind):('Sensor '+id+' side '+(i+1)+' restored'));
  },
  handleCommand:function(cmd){
    var self=this;
    if(this.reqs.has(cmd.id)){log('srv','Duplicate command '+cmd.id+' ignored (idempotent)');return;}
    var r={id:cmd.id,kind:cmd.kind,tileId:cmd.tileId,side:cmd.side,status:'accepted',progress:0,reason:null};
    this.reqs.set(cmd.id,r);
    var reject=function(why){r.status='rejected';r.reason=why;self.status(r);log('srv',r.id+' rejected: '+why);};
    if(this.rejectNext){
      this.rejectNext=false;if(this.onConsumed)this.onConsumed();
      return reject('The server refused this command (test bench).');
    }
    var now=Date.now();
    if(cmd.kind==='pause'){
      if(this.paused)return reject('Already paused.');
      this.base=this.elapsed(now);this.paused=true;this.status(r);
      this.emit({type:'stats',stats:this.stats(Date.now())});
      setTimeout(function(){r.status='completed';self.status(r);},250);return;
    }
    if(cmd.kind==='resume'){
      if(!this.paused)return reject('Not paused.');
      this.paused=false;this.runStart=now;this.status(r);
      this.emit({type:'stats',stats:this.stats(Date.now())});
      setTimeout(function(){r.status='completed';self.status(r);},250);return;
    }
    if(cmd.kind==='restart'){
      this.reset(0);this.status(r);
      this.emit(this.snapshot());
      setTimeout(function(){r.status='completed';self.status(r);},300);return;
    }
    if(cmd.kind!=='deploy')return reject('Unknown command.');
    var t=this.tiles.get(cmd.tileId);
    if(!t)return reject('Unknown tile.');
    if(this.paused)return reject('The system is paused.');
    if(this.complete)return reject('The route is already complete.');
    var i=cmd.side;
    if(!(i>=0&&i<6))return reject('Invalid side.');
    var tq=t.q+DIRS[i][0],tr=t.r+DIRS[i][1],tk=K(tq,tr);
    if(!BOARD.has(tk))return reject('The target is outside the working area.');
    if(this.byCell.has(tk))return reject('That side is already joined.');
    if(RESERVED.has(tk))return reject('The target cell is reserved.');
    if(OBST.has(tk))return reject('An obstacle occupies the target cell.');
    var s=this.sample(t,i,now);
    if(s.status==='RISK')return reject('Obstacle within 0.6 m on that side.');
    if(s.status==='UNKNOWN')return reject('The sensor on that side is unknown.');
    if(this.tiles.size>=TOTAL)return reject('No tiles left in reserve.');
    this.status(r);
    var step=0,ep=this.epoch;
    var iv=setInterval(function(){
      if(ep!==self.epoch){clearInterval(iv);r.status='rejected';r.reason='Cancelled by restart.';self.status(r);return;}
      step++;
      if(step<4){r.status='in_progress';r.progress=step*25;self.status(r);return;}
      clearInterval(iv);
      if(self.byCell.has(tk)){r.status='rejected';r.reason='The target cell was taken.';self.status(r);return;}
      var nt=self.place(tq,tr),n2=Date.now(),touched=[nt];
      DIRS.forEach(function(d){var nb=self.byCell.get(K(nt.q+d[0],nt.r+d[1]));if(nb)touched.push(nb);});
      if(WORLD.route.every(function(p){return self.byCell.has(K(p[0],p[1]));})){self.base=self.elapsed(n2);self.complete=true;}
      self.emit({type:'tile_added',newId:nt.id,reqId:r.id,tiles:touched.map(function(x){return self.payload(x,n2);}),stats:self.stats(n2)});
      r.status='completed';r.progress=100;self.status(r);
    },650);
  }
};
var server=new MockServer();
server.onConsumed=function(){$('rejNext').checked=false;};
 
/* ================= console: receiving messages ================= */
function receive(msg){
  S.lastMsgAt=Date.now();
  if(msg.type==='request_status'){applyReqStatus(msg,false);return;}
  if(S.connection!=='live')return;          // a full snapshot is on its way
  if(msg.type==='snapshot'){
    if(msg.seq<S.lastSeq){log('dup','Older snapshot #'+msg.seq+' ignored');return;}
    applySnapshot(msg);return;
  }
  if(msg.seq<=S.lastSeq){log('dup','#'+msg.seq+' '+msg.type+' ignored, already applied');return;}
  if(msg.seq>S.lastSeq+1){
    if(!S.buf.has(msg.seq)){S.buf.set(msg.seq,msg);log('buf','#'+msg.seq+' arrived early, waiting for #'+(S.lastSeq+1));}
    armGap();return;
  }
  applyMsg(msg);drain();
}
function drain(){
  while(S.buf.has(S.lastSeq+1)){
    var m=S.buf.get(S.lastSeq+1);S.buf.delete(m.seq);applyMsg(m);
  }
  if(S.buf.size===0&&S.gapTimer){clearTimeout(S.gapTimer);S.gapTimer=null;}
}
function armGap(){
  if(S.gapTimer)return;
  S.gapTimer=setTimeout(function(){
    S.gapTimer=null;
    if(S.buf.size){log('gap','Missing message never arrived, asking for a fresh snapshot');resync(false);}
  },2000);
}
function applyMsg(msg){
  S.lastSeq=msg.seq;
  if(msg.type==='sensor_update'){
    (msg.docks||msg.sides||[]).forEach(function(u){
      var tileId=u.tile_id===undefined?u.tile:u.tile_id,sideIndex=Number(u.side_index===undefined?u.side:u.side_index),t=S.tiles.get(tileId);
      if(!t||sideIndex<0||sideIndex>5)return;
      if(msg.docks){
        var docks=t.docks.slice();docks[sideIndex]=Object.assign({},u,{side_index:sideIndex});
        var canonical=Object.assign({},t,{sides:undefined,docks:docks});
        S.tiles.set(t.id,normalizeTileTelemetry(canonical));
      }else{
        t.sides=t.sides||[];t.sides[sideIndex]=u;S.tiles.set(t.id,normalizeTileTelemetry(t));
      }
    });
    S.stats=msg.stats;S.statsAt=Date.now();
  }else if(msg.type==='tile_added'){
    msg.tiles.forEach(function(p){var tile=normalizeTileTelemetry(p);S.tiles.set(tile.id,tile);});
    S.stats=msg.stats;S.statsAt=Date.now();
    S.justAdded[msg.newId]=Date.now();
    var rq=S.reqs.find(function(x){return x.id===msg.reqId;});
    if(rq&&S.ui.selTile===rq.tileId){S.ui.selTile=msg.newId;S.ui.selSide=pickDefaultSide(S.tiles.get(msg.newId));if(S.ui.open)afterRender(revealSelected);}
    log('rx','#'+msg.seq+' tile '+msg.newId+' added (request '+msg.reqId+')');
    toast({kind:'ok',title:'Tile '+msg.newId+' placed',tile:msg.newId,ttl:4500});alertFx('placed');
  }else if(msg.type==='stats'){
    S.stats=msg.stats;S.statsAt=Date.now();
    log('rx','#'+msg.seq+' state update, paused: '+(msg.stats.paused?'yes':'no'));
  }
  invalidate();
}
function buildLayout(l){
  var L={list:l.cells,cells:toSet(l.cells),obst:toSet(l.obstacles),route:toSet(l.route),routeList:l.route,pads:l.pads,reserved:toSet(Object.keys(l.pads).map(function(k){return l.pads[k];}))};
  var xs=[],ys=[];
  l.cells.forEach(function(c){var p=px(c[0],c[1]);xs.push(p.x);ys.push(p.y);});
  var pad=HS*1.15;
  L.bounds={x:Math.min.apply(null,xs)-HS-4,y:Math.min.apply(null,ys)-HS*0.9-4,w:Math.max.apply(null,xs)-Math.min.apply(null,xs)+HS*2+8,h:Math.max.apply(null,ys)-Math.min.apply(null,ys)+HS*1.8+8};
  void pad;
  return L;
}
function applySnapshot(snap,outage){
  S.layout=buildLayout(snap.layout);
  S.tiles=new Map();snap.tiles.forEach(function(t){var tile=normalizeTileTelemetry(t);S.tiles.set(tile.id,tile);});
  S.stats=snap.stats;S.statsAt=Date.now();S.lastSeq=snap.seq;
  S.buf.forEach(function(m,k){if(k<=snap.seq)S.buf.delete(k);});
  reconcile(snap.requests||[],outage);
  if(!S.tiles.has(S.ui.selTile)){
    var ids=Array.from(S.tiles.keys());S.ui.selTile=ids[ids.length-1];
    S.ui.selSide=pickDefaultSide(S.tiles.get(S.ui.selTile));
  }
  drain();
  log('rx','Snapshot #'+snap.seq+' applied ('+snap.tiles.length+' tiles)');
  invalidate();
}
function reconcile(list,outage){
  S.reqs.forEach(function(r){
    var was=r.offlineUnknown;r.offlineUnknown=false;
    if(rankOf(r.status)>=3)return;
    var m=list.find(function(x){return x.id===r.id;});
    if(m){applyReqStatus({id:r.id,status:m.status,progress:m.progress,reason:m.reason},true);}
    else if(outage&&(r.status==='sending'||was)){
      r.status='lost';r.reason='The server never received this command. It is safe to send it again.';
      toast({kind:'warn',title:'Command '+r.id+' never arrived',text:'It is safe to send it again.',ttl:10000});
      log('rx',r.id+' never reached the server');
    }
  });
}
function applyReqStatus(msg,quiet){
  var r=S.reqs.find(function(x){return x.id===msg.id;});
  if(!r)return;
  var nr=rankOf(msg.status),cr=r.status==='lost'?0:rankOf(r.status);
  var progressUp=msg.status==='in_progress'&&r.status==='in_progress'&&(msg.progress||0)>(r.progress||0);
  if(nr<cr||(nr===cr&&!progressUp)){
    if(!quiet)log('dup',r.id+' '+msg.status+' ignored (older or repeated)');
    return;
  }
  r.status=msg.status;r.progress=Math.max(r.progress||0,msg.progress||0);
  if(msg.reason)r.reason=msg.reason;
  r.offlineUnknown=false;
  if(!quiet)log('rx',r.id+' '+msg.status.replace('_',' ')+(msg.reason?': '+msg.reason:''));
  if(msg.status==='rejected'){toast({kind:'warn',title:'Command '+r.id+' rejected',text:r.reason||'',tile:r.tileId||null,ttl:10000});alertFx('reject');}
  invalidate();
}
function resync(reconnect){
  net.rest(function(snap){
    applySnapshot(snap,reconnect);
    if(reconnect){S.connection='live';log('net','Back online');}
    invalidate();
  });
}
function onClose(){
  S.connection='offline';S.offlineSince=Date.now();
  S.buf.clear();if(S.gapTimer){clearTimeout(S.gapTimer);S.gapTimer=null;}
  S.reqs.forEach(function(r){if(rankOf(r.status)<3)r.offlineUnknown=true;});
  log('net','Link down. Keeping the last confirmed state.');
}
function onOpen(){
  S.connection='resyncing';log('net','Link up. Fetching a full snapshot.');
  setTimeout(function(){resync(true);},400);
}
 
/* ================= console: sending commands ================= */
function sendCommand(kind,extra){
  extra=extra||{};
  var id='R'+(++S.reqCounter);
  var req={id:id,kind:kind,tileId:extra.tileId||null,side:extra.side===undefined?null:extra.side,target:extra.target||null,status:'sending',progress:0,createdAt:Date.now(),offlineUnknown:false,reason:null};
  S.reqs.unshift(req);if(S.reqs.length>6)S.reqs.length=6;
  var cmd={id:id,kind:kind,tileId:req.tileId,side:req.side};
  var ok=net.toServer(function(){server.handleCommand(JSON.parse(JSON.stringify(cmd)));});
  if(!ok){req.status='lost';req.reason='The link is down. Nothing was sent.';}
  log('tx',id+' '+kind+(req.tileId?(' '+req.tileId+' side '+(req.side+1)):'')+' sent');
  invalidate();
}
 
/* ================= view helpers ================= */
var HS=30,SQ3=Math.sqrt(3);
// Match the frontend's flat-hex axial conversion: x=1.5*q, y=√3*(r+q/2).
// q and r are axial coordinates; pixel positioning is only a view transform.
function px(q,r){return {x:1.5*HS*q,y:HS*SQ3*(r+q/2)};}
function hexPts(cx,cy,s){
  var p=[];
  for(var k=0;k<6;k++){var a=k*Math.PI/3;p.push((cx+s*Math.cos(a)).toFixed(1)+','+(cy+s*Math.sin(a)).toFixed(1));}
  return p.join(' ');
}
function edgeSeg(cx,cy,r,i,inset){
  var a1=(-120+60*i)*Math.PI/180,a2=(-60+60*i)*Math.PI/180;
  var x1=cx+r*Math.cos(a1),y1=cy+r*Math.sin(a1),x2=cx+r*Math.cos(a2),y2=cy+r*Math.sin(a2);
  var dx=x2-x1,dy=y2-y1;
  return [x1+dx*inset,y1+dy*inset,x2-dx*inset,y2-dy*inset].map(function(n){return n.toFixed(1);});
}
var ICONS={
  CLEAR:'<circle cx="8" cy="8" r="7.5" fill="currentColor"/><path d="M4.6 8.4l2.3 2.3 4.5-4.9" fill="none" style="stroke:var(--on)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  CAUTION:'<path d="M8 1.2l7.2 12.9H.8z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8 6v3.4M8 11.5v.1" style="stroke:var(--on)" stroke-width="1.8" stroke-linecap="round"/>',
  RISK:'<path d="M5 .9h6L15.1 5v6L11 15.1H5L.9 11V5z" fill="currentColor"/><path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" style="stroke:var(--on)" stroke-width="1.8" stroke-linecap="round"/>',
  UNKNOWN:'<circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.6 2"/><path d="M6.1 6.3a1.9 1.9 0 1 1 2.9 1.6c-.7.4-1 .8-1 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.7" r=".9" fill="currentColor"/>',
  STALE:'<circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.4V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
};
var CLS={CLEAR:'clear',CAUTION:'caution',RISK:'risk',UNKNOWN:'unknown',STALE:'unknown'};
var LABEL={CLEAR:'Clear',CAUTION:'Caution',RISK:'Risk',UNKNOWN:'Unknown',STALE:'Stale'};
var SEV={CLEAR:1,CAUTION:2,UNKNOWN:3,STALE:3,RISK:4};
function ico(kind,size){
  return '<svg class="ic ic-'+CLS[kind]+'" viewBox="0 0 16 16" width="'+(size||16)+'" height="'+(size||16)+'" aria-hidden="true">'+ICONS[kind]+'</svg>';
}
function icoAt(kind,x,y,size){
  return '<svg class="ic-'+CLS[kind]+'" x="'+x+'" y="'+y+'" width="'+size+'" height="'+size+'" viewBox="0 0 16 16" aria-hidden="true">'+ICONS[kind]+'</svg>';
}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
 
/* one side, as the console should show it */
function sideView(tile,i){
  var d=tile.docks&&tile.docks[i],s=tile.sides&&tile.sides[i];
  if(!d)return {kind:'unknown',eff:'UNKNOWN',occupied:false,blocked:null,clearanceM:null,age:null};
  if(d.occupied&&d.neighborTile)return {kind:'joined',to:d.neighborTile,eff:null,occupied:true,blocked:true,blockReason:d.blockReason};
  var age=d.measuredAt?Math.max(0,Date.now()-Date.parse(d.measuredAt)):null;
  var stale=Boolean(d.stale||age===null||age>STALE_MS);
  var status=d.sensorValid?(stale?'STALE':d.riskState):'UNKNOWN';
  var sensor=s||{status:status,risk:d.riskPercent,ts:d.measuredAt?Date.parse(d.measuredAt):null,measurements:d.measurements||[]};
  if(status==='UNKNOWN')return {kind:'unknown',s:sensor,age:age,eff:'UNKNOWN',occupied:false,blocked:d.blocked,blockReason:d.blockReason,clearanceM:d.clearanceM};
  return {kind:'sensor',s:sensor,age:age,stale:status==='STALE',eff:status,occupied:false,blocked:d.blocked,blockReason:d.blockReason,clearanceM:d.clearanceM};
}
function tileEff(tile){
  var worst='CLEAR',list=[];
  for(var i=0;i<6;i++){
    var v=sideView(tile,i);list.push(v);
    if(v.eff&&SEV[v.eff]>SEV[worst])worst=v.eff;
  }
  return {worst:worst,sides:list};
}
function cellChecks(tile,i){
  var L=S.layout,v=sideView(tile,i);
  var tq=tile.q+DIRS[i][0],tr=tile.r+DIRS[i][1],tk=K(tq,tr);
  if(v.kind==='joined')return {ok:false,why:'Side '+(i+1)+' is joined to '+v.to+'. Pick a free side.'};
  if(v.blocked===true)return {ok:false,why:v.blockReason||'The tile reports this dock as blocked.'};
  if(v.occupied)return {ok:false,why:'This dock is occupied. Pick a free side.'};
  if(!L.cells.has(tk))return {ok:false,why:'This side faces outside the working area.'};
  if(L.reserved.has(tk))return {ok:false,why:'That cell is reserved for the start, finish or a pallet stop.'};
  if(L.obst.has(tk))return {ok:false,why:'An obstacle occupies the target cell.'};
  if(v.kind==='unknown')return {ok:false,why:'Sensor unknown. Deploy is blocked until it reports again.'};
  if(v.stale)return {ok:false,why:'Sensor data is stale ('+Math.round(v.age/1000)+' s old). Deploy is blocked until it updates.'};
  if(v.s.status==='RISK')return {ok:false,why:'Risk: obstacle within 0.6 m. Deploy is blocked.',cls:'risk'};
  return {ok:true,why:v.s.status==='CAUTION'?'Caution: obstacle ahead. Deploy with care.':'Ready. Deploy places the next tile on this side.',cls:v.s.status==='CAUTION'?'caution':''};
}
function pendingFor(tileId,side){
  return S.reqs.find(function(r){return r.kind==='deploy'&&r.tileId===tileId&&r.side===side&&rankOf(r.status)<3;});
}
function deployState(tile,i){
  if(S.connection!=='live')return {ok:false,why:'Offline. Commands are disabled until the link is back.',label:'Offline'};
  var st=S.stats;
  if(st.complete)return {ok:false,why:'Route complete. Restart to run it again.',label:'Done'};
  if(st.paused)return {ok:false,why:'Paused. Resume to deploy.',label:'Paused'};
  if(pendingFor(tile.id,i))return {ok:false,why:'A deploy request for this side is in progress.',label:'Working'};
  if(st.used>=st.total)return {ok:false,why:'No tiles left in reserve.',label:'Empty'};
  var c=cellChecks(tile,i);
  c.label=c.ok?'Deploy':'Blocked';
  return c;
}
function pickDefaultSide(tile){
  var order=[1,2,0,3,5,4];
  for(var k=0;k<order.length;k++){if(cellChecks(tile,order[k]).ok)return order[k];}
  for(var j=0;j<order.length;j++){if(sideView(tile,order[j]).kind!=='joined')return order[j];}
  return 1;
}
function elapsedNow(){
  var st=S.stats;if(!st)return 0;
  var e=st.elapsed;
  if(S.connection==='live'&&!st.paused&&!st.complete)e+=Date.now()-S.statsAt;
  return e;
}
function mmss(ms){var s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');}
 
/* ================= renderers ================= */
function setHTML(el,html){if(el._h!==html){el.innerHTML=html;el._h=html;}}
function setText(el,t){if(el.textContent!==t)el.textContent=t;}
 
function renderConn(){
  var age=(Date.now()-S.lastMsgAt)/1000,cls='',txt='';
  if(S.connection==='offline'){cls='bad';txt='Offline';}
  else if(S.connection==='resyncing'){cls='warn';txt='Syncing with the server';}
  else if(age>6){cls='bad';txt='No data for '+Math.round(age)+' s';}
  else if(age>3){cls='warn';txt='Live, slow: last data '+age.toFixed(1)+' s ago';}
  else{txt='Live, last data '+age.toFixed(1)+' s ago';}
  var el=$('conn');el.className='conn '+cls;
  setHTML(el,'<span class="dot"></span><span>'+txt+'</span>');
}
function renderMetrics(){
  var st=S.stats,frozen=S.connection!=='live'?' frozen':'';
  if(!st){setHTML($('metrics'),'');return;}
  var m=function(l,v){return '<div class="metric'+frozen+'"><div class="v">'+v+'</div><div class="l">'+l+'</div></div>';};
  setHTML($('metrics'),m('Timer',mmss(elapsedNow()))+m('Tiles used',st.used+' of '+st.total)+m('Wrong position',st.wrong));
}
function renderBanner(){
  var el=$('banner'),st=S.stats,cls='banner',html='';
  if(S.connection==='offline'){cls+=' warn';html='Connection lost. Showing the last confirmed state from '+fmtTime(S.offlineSince)+'. Commands are disabled.';}
  else if(S.connection==='resyncing'){cls+=' info';html='Syncing with the server. The layout appears once the first snapshot arrives.';}
  else if(st&&st.complete){cls+=' ok';html='Route complete in '+mmss(st.elapsed)+' with '+st.used+' tiles and '+st.wrong+' in the wrong position.';}
  else if(st&&st.paused){cls+=' info';html='Paused. The timer is stopped and deploy is disabled.';}
  el.className=cls;setHTML(el,html);
}
function renderChips(){
  if(!S.layout){setHTML($('chips'),'');return;}
  var counts={RISK:0,CAUTION:0,UNKNOWN:0,STALE:0};
  S.tiles.forEach(function(t){tileEff(t).sides.forEach(function(v){if(v.eff&&counts[v.eff]!==undefined)counts[v.eff]++;});});
  var order=['RISK','CAUTION','UNKNOWN','STALE'],h='';
  order.forEach(function(k){
    h+='<button class="chip'+(S.ui.filter===k?' active':'')+(counts[k]?'':' zero')+'" data-act="filter" data-f="'+k+'" aria-pressed="'+(S.ui.filter===k)+'">'+ico(k,15)+'<b>'+counts[k]+'</b> '+LABEL[k].toLowerCase()+'</button>';
  });
  setHTML($('chips'),h);
}
/* ================= map: 3D site view ================= */
// World coordinates come from px() (flat, top-down). Every point is projected through the view:
// rotate + scale around the layout center, then tilt the ground (squash y by cos(tilt)) and
// lift by height z (screen-up by z·sin(tilt)). Raised things (tiles, pads, drums) are drawn
// back-to-front so nearer objects cover farther ones. Labels are always drawn upright.
var HT=20,PAD_H=6,DRUM_R=12,DRUM_H=26,TILT_DEG=45,SUN={x:-0.6,y:-0.8};
var VIEW_MIN=0.6,VIEW_MAX=4,ROT_STEP=15,ZOOM_STEP=1.4;
var V={s:1,rot:0,tx:0,ty:0};
try{var savedView=JSON.parse(localStorage.getItem('kastor-view')||'null');if(savedView&&isFinite(savedView.s)&&isFinite(savedView.rot)&&isFinite(savedView.tx)&&isFinite(savedView.ty))V=savedView;}catch(e){}
var M3={on:false,t:0,anim:0};   // t: 0 = flat plan view (default), 1 = full tilt
try{if(localStorage.getItem('kastor-3d')==='1'){M3.on=true;M3.t=1;}}catch(e){}
function camera(){var a=TILT_DEG*M3.t*Math.PI/180;return {k:Math.cos(a),lift:Math.sin(a)};}
function viewCenter(){var b=S.layout.bounds;return {x:b.x+b.w/2,y:b.y+b.h/2};}
function rotVec(x,y,deg){var a=deg*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return {x:x*c-y*s,y:x*s+y*c};}
function P3(x,y,z,cam){var c=viewCenter(),v=rotVec((x-c.x)*V.s,(y-c.y)*V.s,V.rot);return {x:c.x+V.tx+v.x,y:c.y+V.ty+v.y*cam.k-z*V.s*cam.lift};}
function f1(n){return n.toFixed(1);}
function ptsStr(a){return a.map(function(p){return f1(p.x)+','+f1(p.y);}).join(' ');}
function hexVerts(cx,cy,r){var a=[];for(var k=0;k<6;k++){var t=k*Math.PI/3;a.push({x:cx+r*Math.cos(t),y:cy+r*Math.sin(t)});}return a;}
function projHex(cx,cy,r,z,cam){return hexVerts(cx,cy,r).map(function(v){return P3(v.x,v.y,z,cam);});}
function viewBoxFor(cam){
  var b=S.layout.bounds,c=viewCenter(),top=(DRUM_H+8)*cam.lift;
  var vb={x:b.x,y:c.y-b.h*cam.k/2-top,w:b.w,h:b.h*cam.k+top};
  var el=$('mapWrap'),W=el.clientWidth,H=el.clientHeight;
  if(!(W>0&&H>0))return vb;
  // The SVG covers the whole screen; fit the site into the area the floating bars leave free.
  // The box keeps the screen's aspect, so client px -> viewBox stays a linear map (see toVB).
  var I=S.insets||measureInsets();
  var iw=Math.max(80,W-I.l-I.r),ih=Math.max(80,H-I.t-I.b),u=Math.min(iw/vb.w,ih/vb.h);
  return {x:vb.x-(I.l+(iw-vb.w*u)/2)/u,y:vb.y-(I.t+(ih-vb.h*u)/2)/u,w:W/u,h:H/u};
}
// space taken by the floating controls, in CSS px from each edge of the map
function measureInsets(){
  var wr=$('mapWrap').getBoundingClientRect(),g=10,I={t:12,r:12,b:36,l:12};
  var attr=window.matchMedia('(max-width: 920px)').matches?'data-inset-p':'data-inset-l';
  var tb=document.querySelector('.appbar').getBoundingClientRect();
  document.querySelectorAll('['+attr+']').forEach(function(el){
    var r=el.getBoundingClientRect();if(!r.width||!r.height)return;
    var side=el.getAttribute(attr);
    if(side==='top')I.t=Math.max(I.t,r.bottom-wr.top+g);
    else if(side==='bottom')I.b=Math.max(I.b,wr.bottom-r.top+g);
    else if(side==='left')I.l=Math.max(I.l,r.right-wr.left+g);
    else if(side==='right')I.r=Math.max(I.r,wr.right-r.left+g);
  });
  document.documentElement.style.setProperty('--top-h',Math.round(tb.bottom)+'px');
  S.insets=I;return I;
}
// side walls of a hex prism: only faces turned toward the viewer, shaded by a fixed sun
function walls(cx,cy,r,h,cam,pre){
  if(h<=0||cam.lift<0.02)return '';
  var vs=hexVerts(cx,cy,r),top=vs.map(function(v){return P3(v.x,v.y,h,cam);}),bot=vs.map(function(v){return P3(v.x,v.y,0,cam);}),o='';
  for(var k=0;k<6;k++){
    var na=(k*60+30)*Math.PI/180;
    if(Math.sin(na+V.rot*Math.PI/180)<=0.01)continue;
    var lit=Math.cos(na)*SUN.x+Math.sin(na)*SUN.y,j=(k+1)%6;
    o+='<polygon class="wall '+pre+(lit>0?'1':lit>-0.6?'2':'3')+'" points="'+ptsStr([top[k],top[j],bot[j],bot[k]])+'"/>';
  }
  return o;
}
function shadowOff(h,cam){var d=h*(0.3+0.7*cam.lift)*0.55;return {x:-SUN.x*d,y:-SUN.y*d};}
function shadowHex(cx,cy,r,h,cam){var d=shadowOff(h,cam);return '<polygon points="'+ptsStr(projHex(cx+d.x,cy+d.y,r,0,cam))+'"/>';}
// traffic drum, the obstacle marker crews already know from the roadside
function drumSVG(cx,cy,cam){
  var b=P3(cx,cy,0,cam),r=DRUM_R*V.s,ry=r*cam.k,h=DRUM_H*V.s*cam.lift,top=b.y-h;
  var band=function(y1,y2){return 'M'+f1(b.x-r)+','+f1(y1)+'L'+f1(b.x-r)+','+f1(y2)+'A'+f1(r)+','+f1(ry)+' 0 0 0 '+f1(b.x+r)+','+f1(y2)+'L'+f1(b.x+r)+','+f1(y1)+'A'+f1(r)+','+f1(ry)+' 0 0 1 '+f1(b.x-r)+','+f1(y1)+'Z';};
  var o='<g class="drum" aria-hidden="true">';
  if(h>0.5){
    o+='<path class="drum-body" d="'+band(top,b.y)+'"/><path class="drum-band" d="'+band(top+h*0.2,top+h*0.36)+'"/><path class="drum-band" d="'+band(top+h*0.54,top+h*0.7)+'"/><path fill="url(#cyl)" d="'+band(top,b.y)+'"/>';
  }
  o+='<ellipse class="drum-top" cx="'+f1(b.x)+'" cy="'+f1(top)+'" rx="'+f1(r)+'" ry="'+f1(ry)+'"/><ellipse class="drum-ring" cx="'+f1(b.x)+'" cy="'+f1(top)+'" rx="'+f1(r*0.6)+'" ry="'+f1(ry*0.6)+'"/></g>';
  return o;
}
function ghost3(q,r,cls,label,cam,zf){
  var p=px(q,r),foot=projHex(p.x,p.y,HS-3,0,cam),o='<g class="ghost3">';
  o+='<polygon class="ghost '+cls+'" points="'+ptsStr(foot)+'"/>';
  if(cam.lift>0.02){
    var top=projHex(p.x,p.y,HS-3,HT,cam);
    for(var k=0;k<6;k++)o+='<line class="ghost-edge '+cls+'" x1="'+f1(foot[k].x)+'" y1="'+f1(foot[k].y)+'" x2="'+f1(top[k].x)+'" y2="'+f1(top[k].y)+'"/>';
    o+='<polygon class="ghost-top '+cls+'" points="'+ptsStr(top)+'"/>';
  }
  if(label){var ct=P3(p.x,p.y,HT*0.5,cam);o+='<text class="ghost-t" x="'+f1(ct.x)+'" y="'+f1(ct.y)+'">'+label+'</text>';}
  void zf;
  return o+'</g>';
}
function renderMap(){
  var L=S.layout;
  if(!L){setHTML($('map'),'<p class="empty" style="padding:24px">Waiting for the first snapshot.</p>');return;}
  // while a sheet or drawer is open the floating bars shift aside; keep the fit steady meanwhile
  if(!S.ui.open&&!document.body.classList.contains('acts-open'))measureInsets();
  var cam=camera(),vb=viewBoxFor(cam),zf=Math.max(0.85,Math.min(2.4,V.s));
  S.vb=vb;
  var o='<svg viewBox="'+f1(vb.x)+' '+f1(vb.y)+' '+f1(vb.w)+' '+f1(vb.h)+'" style="--z:'+zf.toFixed(3)+'" class="'+(cam.lift<0.05?'flat':'')+'" role="group" aria-label="Tile layout map">';
  o+='<defs><filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="'+(2+2*cam.lift).toFixed(1)+'"/></filter></defs>';
  var built=new Set(),objs=[],ground='',paint='',marks='',shadows='',over='';
  S.tiles.forEach(function(t){built.add(K(t.q,t.r));});
  ground+='<rect class="grid-bg" x="'+f1(vb.x)+'" y="'+f1(vb.y)+'" width="'+f1(vb.w)+'" height="'+f1(vb.h)+'"/><rect class="grid-fill" x="'+f1(vb.x)+'" y="'+f1(vb.y)+'" width="'+f1(vb.w)+'" height="'+f1(vb.h)+'"/>';
  var padCells=new Set(Object.keys(L.pads).map(function(n){return K(L.pads[n][0],L.pads[n][1]);}));
  var baseY=function(x,y){return P3(x,y,0,cam).y;};
  // ground: painted work-zone grid
  L.list.forEach(function(c){
    var p=px(c[0],c[1]),k=K(c[0],c[1]);
    ground+='<polygon class="cell" points="'+ptsStr(projHex(p.x,p.y,HS-1.2,0,cam))+'"/>';
    paint+='<polygon class="grid" points="'+ptsStr(projHex(p.x,p.y,HS-1.2,0,cam))+'"/>';
    if(L.obst.has(k))paint+='<polygon class="keepout" points="'+ptsStr(projHex(p.x,p.y,HS-3,0,cam))+'"/>';
    if(!built.has(k)&&!padCells.has(k)&&!L.obst.has(k)){
      var g=P3(p.x,p.y,0,cam);
      marks+='<text class="coord" x="'+f1(g.x)+'" y="'+f1(g.y+11*V.s*cam.k)+'">('+c[0]+','+c[1]+')</text>';
    }
    if(L.obst.has(k)){
      var d=shadowOff(DRUM_H,cam),sp=P3(p.x+d.x,p.y+d.y,0,cam);
      shadows+='<ellipse cx="'+f1(sp.x)+'" cy="'+f1(sp.y)+'" rx="'+f1(DRUM_R*V.s)+'" ry="'+f1(DRUM_R*V.s*cam.k)+'"/>';
      objs.push({y:baseY(p.x,p.y),h:drumSVG(p.x,p.y,cam)});
    }
  });
  // planned route: painted line on the ground, dots where tiles are still missing
  var rpts=L.routeList.map(function(c){var p=px(c[0],c[1]);return P3(p.x,p.y,0,cam);});
  marks+='<polyline class="route-line" points="'+ptsStr(rpts)+'"/>';
  for(var ri=1;ri<rpts.length;ri++){
    var ra=rpts[ri-1],rb=rpts[ri],ang=Math.atan2(rb.y-ra.y,rb.x-ra.x)*180/Math.PI;
    marks+='<path class="route-arrow" d="M-3.5,-4.5L2.5,0L-3.5,4.5" transform="translate('+f1((ra.x+rb.x)/2)+' '+f1((ra.y+rb.y)/2)+') rotate('+ang.toFixed(1)+') scale('+zf.toFixed(3)+')"/>';
  }
  L.routeList.forEach(function(c){
    if(!built.has(K(c[0],c[1]))){var g=P3(px(c[0],c[1]).x,px(c[0],c[1]).y,0,cam);marks+='<circle class="route-dot" cx="'+f1(g.x)+'" cy="'+f1(g.y)+'" r="'+f1(4.5*zf)+'"/>';}
  });
  // pads: start/finish platforms and wooden pallet stops
  Object.keys(L.pads).forEach(function(n){
    var c=L.pads[n],p=px(c[0],c[1]),r=HS-5,ct=P3(p.x,p.y,PAD_H,cam),end=n==='S'||n==='F';
    shadows+=shadowHex(p.x,p.y,r,PAD_H,cam);
    var h='<g class="pad '+(end?'pad-end':'pad-stop')+'">'+walls(p.x,p.y,r,PAD_H,cam,end?'pw':'ww')+'<polygon class="pad-top" points="'+ptsStr(projHex(p.x,p.y,r,PAD_H,cam))+'"/>';
    if(!end){
      // pallet deck boards
      for(var b=-1;b<=1;b++){var a1=P3(p.x-r*0.62,p.y+b*r*0.42,PAD_H,cam),a2=P3(p.x+r*0.62,p.y+b*r*0.42,PAD_H,cam);h+='<line class="board" x1="'+f1(a1.x)+'" y1="'+f1(a1.y)+'" x2="'+f1(a2.x)+'" y2="'+f1(a2.y)+'"/>';}
    }
    h+='<text class="pad-t" x="'+f1(ct.x)+'" y="'+f1(ct.y)+'">'+({S:'START',F:'FINISH'}[n]||n)+'</text></g>';
    objs.push({y:baseY(p.x,p.y),h:h});
  });
  // ghosts: pending deploys, then the target of the selected side
  var pend={};
  S.reqs.forEach(function(r){
    if(r.kind==='deploy'&&r.target&&rankOf(r.status)<3&&r.status!=='lost'){
      pend[K(r.target[0],r.target[1])]=1;
      var gp=px(r.target[0],r.target[1]);
      objs.push({y:baseY(gp.x,gp.y),h:ghost3(r.target[0],r.target[1],'pending',r.id,cam,zf)});
    }
  });
  var nextKey=S.next&&S.next.target?K(S.next.target[0],S.next.target[1]):null;
  if(nextKey&&!pend[nextKey]&&!built.has(nextKey)){
    var np=px(S.next.target[0],S.next.target[1]);
    objs.push({y:baseY(np.x,np.y),h:ghost3(S.next.target[0],S.next.target[1],'next','NEXT',cam,zf)});
  }
  var sel=S.ui.open?S.tiles.get(S.ui.selTile):null;
  if(sel){
    var tq=sel.q+DIRS[S.ui.selSide][0],tr=sel.r+DIRS[S.ui.selSide][1],tk=K(tq,tr);
    if(L.cells.has(tk)&&!built.has(tk)&&!pend[tk]&&tk!==nextKey){
      var tp=px(tq,tr);
      objs.push({y:baseY(tp.x,tp.y),h:ghost3(tq,tr,(L.obst.has(tk)||L.reserved.has(tk))?'bad':'','',cam,zf)});
    }
  }
  // tiles: raised modules, top plate colored by the worst side
  S.tiles.forEach(function(t){
    var te=tileEff(t),p=px(t.q,t.r),cls=CLS[te.worst],r=HS-3;
    var wrong=!L.route.has(K(t.q,t.r));
    var dim=S.ui.filter&&!te.sides.some(function(v){return v.eff===S.ui.filter;});
    var isNew=S.justAdded[t.id]&&Date.now()-S.justAdded[t.id]<900;
    var ct=P3(p.x,p.y,HT,cam);
    shadows+=shadowHex(p.x,p.y,r,HT,cam);
    var flash=S.flash&&S.flash.id===t.id&&Date.now()<S.flash.until;
    var h='<g class="tile t-'+cls+(wrong?' wrong':'')+(dim?' dim':'')+(isNew?' enter':'')+(flash?' flash':'')+'" data-act="pick" data-tile="'+t.id+'" tabindex="0" role="button" aria-label="Tile '+t.id+', worst side: '+LABEL[te.worst].toLowerCase()+(wrong?', off the planned route':'')+'">';
    h+=walls(p.x,p.y,r,HT,cam,'tw');
    var topPts=ptsStr(projHex(p.x,p.y,r,HT,cam));
    h+='<polygon class="glow" points="'+topPts+'"/><polygon class="tbody" points="'+topPts+'"/><polygon class="sheen" points="'+topPts+'"/>';
    if(flash)h+='<polygon class="flash-ring" points="'+ptsStr(projHex(p.x,p.y,HS+4,HT,cam))+'"/>';
    te.sides.forEach(function(v,i){
      if(!v.eff||v.eff==='CLEAR')return;
      var e=edgeSeg(p.x,p.y,HS-6.5,i,0.16).map(Number),a=P3(e[0],e[1],HT,cam),b=P3(e[2],e[3],HT,cam);
      h+='<line class="edge e-'+CLS[v.eff]+'" x1="'+f1(a.x)+'" y1="'+f1(a.y)+'" x2="'+f1(b.x)+'" y2="'+f1(b.y)+'"/>';
    });
    if(sel&&t.id===sel.id)h+='<polygon class="ring" points="'+ptsStr(projHex(p.x,p.y,HS+0.5,HT,cam))+'"/>';
    var ok=te.worst==='CLEAR';
    h+='<text class="tid" x="'+f1(ct.x-(ok?0:6*zf))+'" y="'+f1(ct.y-3*zf)+'">'+t.id+'</text>';
    if(!ok)h+=icoAt(te.worst,f1(ct.x+3*zf),f1(ct.y-9.5*zf),(13*zf).toFixed(1));
    h+='<text class="coord" x="'+f1(ct.x)+'" y="'+f1(ct.y+8*zf)+'">('+t.q+','+t.r+')</text>';
    h+='</g>';
    objs.push({y:baseY(p.x,p.y),h:h});
    if(sel&&t.id===sel.id){
      over+='<g class="pin" transform="translate('+f1(ct.x)+' '+f1(ct.y-12*zf)+') scale('+zf.toFixed(3)+')" aria-hidden="true"><path d="M0 0C-3-6-10-10-10-18a10 10 0 1 1 20 0c0 8-7 12-10 18z"/><circle cy="-18" r="4"/></g>';
    }
  });
  objs.sort(function(a,b){return a.y-b.y;});
  o+='<g class="ground">'+ground+'</g><g class="paint">'+paint+'</g><g class="shadows" filter="url(#soft)">'+shadows+'</g><g class="marks">'+marks+'</g>';
  o+=objs.map(function(x){return x.h;}).join('')+over+'</svg>';
  setHTML($('map'),o);
  var cr=Math.cos(V.rot*Math.PI/180),sr=Math.sin(V.rot*Math.PI/180),C=viewCenter();
  var ma=V.s*cr,mb=cam.k*V.s*sr,mc=-V.s*sr,md=cam.k*V.s*cr;
  var mtx='matrix('+[ma,mb,mc,md,C.x+V.tx-ma*C.x-mc*C.y,C.y+V.ty-mb*C.x-md*C.y].map(function(n){return n.toFixed(4);}).join(' ')+')';
  if(S.patMtx!==mtx){S.patMtx=mtx;['survey','keepout'].forEach(function(id){var el=document.getElementById(id);if(el)el.setAttribute('patternTransform',mtx);});}
  $('mapWrap').classList.toggle('dim',S.connection!=='live');
}

/* ================= map view: zoom, rotate, pan, tilt ================= */
function contentAt(f){
  var c=viewCenter(),cam=camera(),v=rotVec(f.x-c.x-V.tx,(f.y-c.y-V.ty)/cam.k,-V.rot);
  return {x:c.x+v.x/V.s,y:c.y+v.y/V.s};
}
function placeAt(q,f){
  var c=viewCenter(),cam=camera(),v=rotVec((q.x-c.x)*V.s,(q.y-c.y)*V.s,V.rot);
  V.tx=f.x-c.x-v.x;V.ty=f.y-c.y-v.y*cam.k;
}
function clampScale(s){return Math.min(VIEW_MAX,Math.max(VIEW_MIN,s));}
function clampView(){
  V.s=clampScale(V.s);
  V.rot=((V.rot%360)+540)%360-180;
  var b=S.layout.bounds,m=Math.max(b.w,b.h)*Math.max(V.s,1)*0.55;
  V.tx=Math.max(-m,Math.min(m,V.tx));V.ty=Math.max(-m,Math.min(m,V.ty));
}
// bearing (0 = north, clockwise) -> 8-point compass label
var POINTS=['N','NE','E','SE','S','SW','W','NW'],POINT_NAMES=['north','northeast','east','southeast','south','southwest','west','northwest'];
function compassPoint(deg){return POINTS[Math.round(deg/45)%8];}
function compassName(deg){return POINT_NAMES[Math.round(deg/45)%8];}
function saveView(){try{localStorage.setItem('kastor-view',JSON.stringify(V));}catch(e){}}
// the view is baked into the rendered SVG, so a view change is just a re-render on the next frame
function applyView(){
  var out=$('viewOut');
  var upDeg=Math.round(((360-V.rot)%360+360)%360)%360;
  setText(out,Math.round(V.s*100)+'% · Up: '+compassPoint(upDeg)+' '+upDeg+'°');
  out.classList.toggle('moved',V.s!==1||V.rot!==0||V.tx!==0||V.ty!==0);
  // compass rose: ring and needle turn with the map's north; letters move around it but stay upright
  var needle=document.getElementById('needle');
  if(needle){
    var rt='rotate('+V.rot.toFixed(1)+')';
    needle.setAttribute('transform',rt);document.getElementById('roseRing').setAttribute('transform',rt);
    [['cN',-90],['cE',0],['cS',90],['cW',180]].forEach(function(l){
      var a=(l[1]+V.rot)*Math.PI/180,el=document.getElementById(l[0]);
      el.setAttribute('x',(31*Math.cos(a)).toFixed(1));el.setAttribute('y',(31*Math.sin(a)).toFixed(1));
    });
    var up=Math.round(((360-V.rot)%360+360)%360)%360;
    $('compass').setAttribute('aria-label','Compass. Top of the screen faces '+compassName(up)+' ('+up+'°). Drag around to rotate the map, tap to face north, or use left and right arrow keys.');
  }
  var b=document.querySelector('[data-view="3d"]');
  if(b){b.setAttribute('aria-pressed',String(M3.on));setText(b,M3.on?'3D':'2D');}
  var l3=document.getElementById('lyr3d');if(l3)l3.checked=M3.on;
  invalidate();
}
// client (CSS px) -> viewBox units. The SVG keeps the viewBox aspect (height:auto), so a linear map is exact.
function toVB(cx,cy){
  var svg=$('map').querySelector('svg'),vb=S.vb;
  if(!svg||!vb)return viewCenter();
  var r=svg.getBoundingClientRect();
  return {x:vb.x+(cx-r.left)*vb.w/r.width,y:vb.y+(cy-r.top)*vb.h/r.height};
}
function zoomAbout(f,s){var q=contentAt(f);V.s=clampScale(s);placeAt(q,f);clampView();applyView();}
function rotateAbout(f,deg){var q=contentAt(f);V.rot+=deg;placeAt(q,f);clampView();applyView();}
function snapRotation(){
  var n=Math.round(V.rot/ROT_STEP)*ROT_STEP;
  if(Math.abs(n-V.rot)<4&&S.layout){rotateAbout(viewCenter(),n-V.rot);}
}
function setMode3D(on){
  M3.on=on;
  try{localStorage.setItem('kastor-3d',on?'1':'0');}catch(e){}
  var to=on?1:0,from=M3.t;
  applyView();   // update the button right away; the tilt animates over the next frames
  if(window.cancelAnimationFrame)cancelAnimationFrame(M3.anim);
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce||!window.requestAnimationFrame){M3.t=to;applyView();return;}
  var t0=performance.now();
  var step=function(now){
    var u=Math.min(1,(now-t0)/380);u=u<0.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
    M3.t=from+(to-from)*u;applyView();
    if(u<1)M3.anim=requestAnimationFrame(step);
  };
  M3.anim=requestAnimationFrame(step);
}
function viewCmd(cmd){
  if(!S.layout)return;
  S.userMoved=true;
  var c=viewCenter();
  if(cmd==='in')zoomAbout(c,V.s*ZOOM_STEP);
  else if(cmd==='out')zoomAbout(c,V.s/ZOOM_STEP);
  else if(cmd==='rotl')rotateAbout(c,-ROT_STEP);
  else if(cmd==='rotr')rotateAbout(c,ROT_STEP);
  else if(cmd==='fit'){V={s:1,rot:0,tx:0,ty:0};applyView();}
  else if(cmd==='3d'){setMode3D(!M3.on);return;}
  saveView();
}
applyView();
(function(){
  var wrap=$('mapWrap'),P=new Map(),G=null,dragged=false,lastTap=null;
  function pts(){return Array.from(P.values());}
  function begin(){
    var p=pts();
    if(p.length===1){G={n:1,q:contentAt(toVB(p[0].x,p[0].y)),x0:p[0].x,y0:p[0].y};}
    else if(p.length>=2){
      var a=p[0],b=p[1],mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
      G={n:2,q:contentAt(toVB(mx,my)),s0:V.s,r0:V.rot,d0:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),a0:Math.atan2(b.y-a.y,b.x-a.x)};
    }else G=null;
  }
  wrap.addEventListener('pointerdown',function(e){
    if(!S.layout||e.target.closest('.widget'))return;
    if(e.pointerType==='mouse'&&e.button!==0)return;
    if(P.size===0)dragged=false;
    P.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(e.altKey&&P.size===1&&e.pointerType!=='touch'){
      var v=visibleRect(),cx=(v.l+v.r)/2,cy=(v.t+v.b)/2;
      G={n:'rot',cx:cx,cy:cy,a0:Math.atan2(e.clientY-cy,e.clientX-cx),r0:V.rot,f:toVB(cx,cy)};
      dragged=true;S.userMoved=true;wrap.classList.add('rotating');
      try{wrap.setPointerCapture(e.pointerId);}catch(_){}
      return;
    }
    if(P.size>=2){dragged=true;S.userMoved=true;wrap.classList.add('grabbing');}
    begin();
  });
  wrap.addEventListener('pointermove',function(e){
    if(!P.has(e.pointerId)||!G)return;
    P.set(e.pointerId,{x:e.clientX,y:e.clientY});
    var p=pts();
    if(G.n==='rot'){
      var ra=Math.atan2(e.clientY-G.cy,e.clientX-G.cx);
      rotateAbout(G.f,G.r0+(ra-G.a0)*180/Math.PI-V.rot);return;
    }
    if(G.n===1){
      if(!dragged&&Math.hypot(e.clientX-G.x0,e.clientY-G.y0)<8)return;
      if(!dragged){dragged=true;S.userMoved=true;wrap.classList.add('grabbing');}
      // capture only once it is a drag, so a plain tap still lands on the tile as a click
      try{wrap.setPointerCapture(e.pointerId);}catch(_){}
      placeAt(G.q,toVB(p[0].x,p[0].y));
    }else{
      var a=p[0],b=p[1];
      V.s=clampScale(G.s0*Math.hypot(b.x-a.x,b.y-a.y)/G.d0);
      V.rot=G.r0+(Math.atan2(b.y-a.y,b.x-a.x)-G.a0)*180/Math.PI;
      placeAt(G.q,toVB((a.x+b.x)/2,(a.y+b.y)/2));
    }
    clampView();applyView();
  });
  function end(e){
    if(!P.has(e.pointerId))return;
    var wasPinch=P.size>=2;
    P.delete(e.pointerId);
    if(P.size){begin();return;}
    G=null;wrap.classList.remove('grabbing');wrap.classList.remove('rotating');
    if(wasPinch||dragged){snapRotation();saveView();}
    if(!dragged&&e.type==='pointerup'){
      var now=Date.now();
      if(lastTap&&now-lastTap.t<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<30){
        zoomAbout(toVB(e.clientX,e.clientY),V.s*1.8);saveView();lastTap=null;
      }else lastTap={t:now,x:e.clientX,y:e.clientY};
    }
  }
  wrap.addEventListener('pointerup',end);
  wrap.addEventListener('pointercancel',end);
  // swallow the click that ends a drag or pinch so it doesn't select a tile
  wrap.addEventListener('click',function(e){if(dragged){e.stopPropagation();e.preventDefault();dragged=false;}},true);
  var saveT=0,gesturing=false,GS=null;
  // Safari on a Mac trackpad reports the real two-finger twist and pinch as gesture events
  wrap.addEventListener('gesturestart',function(e){
    if(!S.layout)return;
    e.preventDefault();gesturing=true;S.userMoved=true;
    var f=toVB(e.clientX,e.clientY);GS={f:f,q:contentAt(f),s0:V.s,r0:V.rot};
  });
  wrap.addEventListener('gesturechange',function(e){
    if(!GS)return;
    e.preventDefault();
    V.s=clampScale(GS.s0*e.scale);V.rot=GS.r0+e.rotation;placeAt(GS.q,GS.f);clampView();applyView();
  });
  wrap.addEventListener('gestureend',function(e){
    if(!GS)return;
    e.preventDefault();GS=null;setTimeout(function(){gesturing=false;},120);snapRotation();saveView();
  });
  wrap.addEventListener('wheel',function(e){
    if(!S.layout||e.target.closest('.widget'))return;
    e.preventDefault();S.userMoved=true;
    if(gesturing)return;
    var unit=e.deltaMode===1?16:1,d=e.deltaY*unit,dx=e.deltaX*unit;
    var f=toVB(e.clientX,e.clientY);
    if(e.shiftKey)rotateAbout(f,(d||dx)>0?5:-5);
    else if(!e.ctrlKey&&Math.abs(dx)>Math.abs(d)*1.2&&Math.abs(dx)>0.5){
      // two fingers swiped sideways on a trackpad: fingers to the right turn the map clockwise
      var v=visibleRect();rotateAbout(toVB((v.l+v.r)/2,(v.t+v.b)/2),-dx*0.22);
    }
    else zoomAbout(f,V.s*Math.exp(-d*(e.ctrlKey?0.01:0.0015)));
    clearTimeout(saveT);saveT=setTimeout(function(){snapRotation();saveView();},300);
  },{passive:false});
  var comp=$('compass'),CG=null;
  comp.addEventListener('pointerdown',function(e){
    if(!S.layout)return;
    e.preventDefault();
    var r=comp.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,v=visibleRect();
    CG={cx:cx,cy:cy,a0:Math.atan2(e.clientY-cy,e.clientX-cx),r0:V.rot,moved:false,f:toVB((v.l+v.r)/2,(v.t+v.b)/2)};
    try{comp.setPointerCapture(e.pointerId);}catch(_){}
  });
  comp.addEventListener('pointermove',function(e){
    if(!CG)return;
    var a=Math.atan2(e.clientY-CG.cy,e.clientX-CG.cx),deg=(a-CG.a0)*180/Math.PI;
    if(deg>180)deg-=360;if(deg<-180)deg+=360;
    if(!CG.moved&&Math.abs(deg)<4)return;
    CG.moved=true;S.userMoved=true;rotateAbout(CG.f,CG.r0+deg-V.rot);
  });
  function compEnd(e){
    if(!CG)return;
    if(CG.moved)snapRotation();
    else if(e.type==='pointerup'){S.userMoved=true;rotateAbout(CG.f,-V.rot);}
    CG=null;saveView();
  }
  comp.addEventListener('pointerup',compEnd);
  comp.addEventListener('pointercancel',compEnd);
  comp.addEventListener('keydown',function(e){
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();viewCmd(e.key==='ArrowLeft'?'rotl':'rotr');}
    else if(e.key==='Enter'||e.key===' '){e.preventDefault();var v=visibleRect();rotateAbout(toVB((v.l+v.r)/2,(v.t+v.b)/2),-V.rot);saveView();}
  });
  document.querySelectorAll('.map-tools').forEach(function(g){g.addEventListener('click',function(e){
    var b=e.target.closest('[data-view]');if(b)viewCmd(b.getAttribute('data-view'));
  });});
  document.addEventListener('keydown',function(e){
    var tag=(e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||e.metaKey||e.ctrlKey||e.altKey)return;
    var m={'+':'in','=':'in','-':'out','_':'out','[':'rotl',']':'rotr','0':'fit','3':'3d'}[e.key];
    if(m){e.preventDefault();viewCmd(m);}
  });
})();

/* ================= tile details sheet + activity drawer ================= */
// The map owns the screen. Tapping a tile slides its details in (right side in landscape,
// bottom sheet in portrait); the map pans so that tile is not hidden behind the sheet.
var PORTRAIT=window.matchMedia('(max-width: 920px)');
function setSheet(id,open){
  var el=$(id);el.classList.toggle('open',open);
  if(open)el.removeAttribute('inert');else el.setAttribute('inert','');
}
function afterRender(fn){
  if(!window.requestAnimationFrame){setTimeout(fn,40);return;}
  requestAnimationFrame(function(){requestAnimationFrame(fn);});
}
function openTile(id){
  if(!S.tiles.has(id))return;
  if(id!==S.ui.selTile){S.ui.selTile=id;S.ui.selSide=pickDefaultSide(S.tiles.get(id));}
  if(PORTRAIT.matches)toggleActs(false);
  if(!S.ui.open){S.preView={tx:V.tx,ty:V.ty};S.userMoved=false;}
  S.ui.open=true;setSheet('insp',true);document.body.classList.add('tile-open');
  // the map area shrinks beside the panel (CSS transition); check the tile's position once it has settled
  invalidate();setTimeout(revealSelected,320);
}
function closeTile(){
  if(!S.ui.open)return;
  S.ui.open=false;setSheet('insp',false);document.body.classList.remove('tile-open');invalidate();
  // slide back to where the operator was, unless they moved the map themselves meanwhile
  if(S.preView&&!S.userMoved)animatePan(S.preView);
  S.preView=null;
}
function animatePan(to){
  var from={x:V.tx,y:V.ty},reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  to={x:to.tx===undefined?to.x:to.tx,y:to.ty===undefined?to.y:to.ty};
  if(reduce||!window.requestAnimationFrame){V.tx=to.x;V.ty=to.y;applyView();saveView();return;}
  var t0=performance.now();
  var step=function(now){
    var u=Math.min(1,(now-t0)/300);u=1-Math.pow(1-u,3);
    V.tx=from.x+(to.x-from.x)*u;V.ty=from.y+(to.y-from.y)*u;applyView();
    if(u<1)requestAnimationFrame(step);else saveView();
  };
  requestAnimationFrame(step);
}
function toggleActs(force){
  var open=force===undefined?!$('actsSheet').classList.contains('open'):force;
  if(open&&PORTRAIT.matches)closeTile();
  setSheet('actsSheet',open);$('btnActs').setAttribute('aria-expanded',String(open));
  document.body.classList.toggle('acts-open',open);
  if(typeof PANELS!=='undefined')setDrawerTab(S.ui.drawerTab);
}
// pan (animated) so the selected tile sits in the part of the map the sheets leave visible
function revealSelected(){
  var t=S.tiles.get(S.ui.selTile),svg=$('map').querySelector('svg');
  if(!t||!S.layout||!S.vb||!svg||!S.ui.open)return;
  var vis=visibleRect();
  if(vis.r-vis.l<80||vis.b-vis.t<80)return;
  var p=px(t.q,t.r),sp=P3(p.x,p.y,HT*0.5,camera()),r=svg.getBoundingClientRect(),vb=S.vb;
  var cx=r.left+(sp.x-vb.x)*r.width/vb.w,cy=r.top+(sp.y-vb.y)*r.height/vb.h;
  var mx=(vis.r-vis.l)*0.15,my=(vis.b-vis.t)*0.15;
  if(cx>vis.l+mx&&cx<vis.r-mx&&cy>vis.t+my&&cy<vis.b-my)return;
  var from={x:V.tx,y:V.ty};
  placeAt(p,toVB((vis.l+vis.r)/2,(vis.t+vis.b)/2));clampView();
  var to={x:V.tx,y:V.ty};V.tx=from.x;V.ty=from.y;
  animatePan(to);
}
$('inspClose').addEventListener('click',closeTile);
function closePops(){}
function renderSoundBtn(){var b=$('btnSound');setText(b,AU.on?'On':'Off');b.setAttribute('aria-pressed',String(AU.on));}
$('btnSound').addEventListener('click',function(){AU.on=!AU.on;try{localStorage.setItem('kastor-sound',AU.on?'1':'0');}catch(e){}renderSoundBtn();if(AU.on){unlockAudio();setTimeout(function(){alertFx('placed');},50);}});
setTimeout(renderSoundBtn,0);
$('actsClose').addEventListener('click',function(){toggleActs(false);});
if(window.ResizeObserver)new ResizeObserver(function(){invalidate();}).observe($('mapWrap'));
else window.addEventListener('resize',invalidate);

/* ================= guided next step ================= */
// Suggests the next deploy along the planned route: the first route cell that has no tile yet,
// placed from a neighboring tile whose side toward it is safe right now.
function tileAt(q,r){var f=null;S.tiles.forEach(function(t){if(t.q===q&&t.r===r)f=t;});return f;}
function routeState(){
  var built=new Set();S.tiles.forEach(function(t){built.add(K(t.q,t.r));});
  var list=S.layout.routeList,done=0,next=-1;
  list.forEach(function(c,i){if(built.has(K(c[0],c[1])))done++;else if(next<0)next=i;});
  return {list:list,built:built,done:done,next:next};
}
function nextStep(){
  var st=S.stats;
  if(!S.layout||!st)return {kind:'wait',title:'Connecting to the site…',text:'The layout appears once the first snapshot arrives.'};
  if(S.connection!=='live')return {kind:'offline',title:'Offline',text:'Showing the last confirmed state. Commands are disabled until the link is back.'};
  if(st.complete)return {kind:'done',title:'Route complete',text:'Finished in '+mmss(st.elapsed)+' with '+st.used+' tiles, '+st.wrong+' off route.'};
  if(st.paused)return {kind:'paused',title:'Mission stopped',text:'Everything is holding still. Resume when the work zone is safe.'};
  var pend=S.reqs.find(function(r){return r.kind==='deploy'&&rankOf(r.status)<3&&r.status!=='lost';});
  var rs=routeState();
  if(pend){
    return {kind:'working',req:pend,target:null,title:'Placing tile from '+pend.tileId,
      text:'Toward side '+(pend.side+1)+' ('+SIDE_SHORT[pend.side]+'). '+(pend.status==='sending'?'Waiting for the server…':pend.status==='accepted'?'Accepted by the server.':'In progress, '+pend.progress+'%.')};
  }
  if(rs.next<0)return {kind:'done',title:'Route complete',text:'Every route cell has a tile.'};
  var target=rs.list[rs.next],opts=[];
  for(var i=0;i<6;i++){
    var from=tileAt(target[0]-DIRS[i][0],target[1]-DIRS[i][1]);
    if(from)opts.push({tile:from,side:i,ds:deployState(from,i)});
  }
  var step='Step '+(rs.done+1)+' of '+rs.list.length;
  if(!opts.length)return {kind:'stuck',step:step,target:target,title:'Next route cell is not reachable yet',text:'No placed tile touches ('+target[0]+','+target[1]+'). Open a tile and extend toward it.'};
  var best=opts.find(function(o){return o.ds.ok;})||opts[0];
  var v=sideView(best.tile,best.side),dist=v.clearanceM===null||v.clearanceM===undefined?'':' Clearance '+v.clearanceM.toFixed(1)+' m.';
  return {kind:best.ds.ok?'go':'blocked',step:step,tile:best.tile,side:best.side,target:target,ds:best.ds,
    title:'Deploy from '+best.tile.id+' → side '+(best.side+1)+' ('+SIDE_LABEL[best.side]+')',
    text:best.ds.ok?(best.ds.cls==='caution'?'Caution: obstacle ahead. Deploy with care.'+dist:'Side is clear.'+dist+' Places a tile at ('+target[0]+','+target[1]+').'):best.ds.why};
}
function renderGuide(){
  var n=S.next||{kind:'wait',title:'',text:''},o='';
  var cls={go:'g-go',blocked:'g-blocked',working:'g-working',paused:'g-paused',offline:'g-offline',done:'g-done',stuck:'g-blocked',wait:'g-wait'}[n.kind];
  o+='<div class="g-body"><span class="g-eyebrow">'+(n.step?esc(n.step)+' · ':'')+({go:'Next step',blocked:'Next step blocked',working:'Working',paused:'Stopped',offline:'No connection',done:'Done',stuck:'Next step',wait:'Starting'}[n.kind])+'</span>';
  o+='<strong class="g-title">'+esc(n.title)+'</strong><span class="g-text'+(n.ds&&n.ds.cls==='caution'?' caution':'')+'">'+esc(n.text)+'</span>';
  if(n.kind==='working'){
    var st=n.req.status==='sending'?1:n.req.status==='accepted'?2:3,bars='';
    for(var i=1;i<=4;i++)bars+='<i class="'+(i<=st?'on':'')+'"></i>';
    o+='<span class="g-steps" aria-hidden="true">'+bars+'</span>';
  }
  o+='</div><div class="g-actions">';
  if(n.kind==='go')o+='<button class="btn g-primary" data-act="gdeploy">Deploy</button>';
  if(n.kind==='paused')o+='<button class="btn g-resume" data-act="gresume">Resume</button>';
  if(n.target)o+='<button class="btn" data-act="gshow">Show me</button>';
  if(n.tile)o+='<button class="btn" data-act="gdetails">Details</button>';
  o+='</div>';
  var head=n.kind==='go'?'Next: '+(n.tile?n.tile.id+' → side '+(n.side+1)+' ('+SIDE_SHORT[n.side]+')':''):n.title;
  if(S.ui.guideMin){
    o='<button class="g-pill" data-act="gtoggle" aria-expanded="false" aria-label="Show next step"><span class="g-dot"></span>'+esc(head)+'<span class="g-chev" aria-hidden="true">▴</span></button>';
  }else{
    o='<button class="g-min" data-act="gtoggle" aria-expanded="true" aria-label="Minimize next step">▾</button>'+o;
  }
  var el=$('guide');el.className='guide widget '+cls+(S.ui.guideMin?' min':'');setHTML(el,o);
}
function renderStop(){
  var st=S.stats,live=S.connection==='live',b=$('btnPause'),paused=st&&st.paused;
  b.disabled=!live||!st||st.complete;
  b.classList.toggle('resume',!!paused);
  b.setAttribute('aria-label',paused?'Resume the mission':'Stop the mission');
  setHTML(b,paused?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Resume</span>':'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg><span>Stop</span>');
}

/* ================= route progress strip ================= */
function renderProgress(){
  if(!S.layout||!S.stats){setHTML($('progress'),'<span class="pg-text">Waiting for the site…</span>');return;}
  var rs=routeState(),segs='';
  rs.list.forEach(function(c,i){
    var state=rs.built.has(K(c[0],c[1]))?'done':i===rs.next?'next':'todo';
    segs+='<button class="pg-seg '+state+'" data-act="flycell" data-q="'+c[0]+'" data-r="'+c[1]+'" aria-label="Route cell '+(i+1)+' ('+c[0]+','+c[1]+'), '+(state==='done'?'placed':state==='next'?'next to place':'not placed')+'"></button>';
  });
  var counts={RISK:0,CAUTION:0,UNKNOWN:0,STALE:0};
  S.tiles.forEach(function(t){tileEff(t).sides.forEach(function(v){if(v.eff&&counts[v.eff]!==undefined)counts[v.eff]++;});});
  var stat='';
  ['RISK','CAUTION','UNKNOWN','STALE'].forEach(function(k){
    if(counts[k])stat+='<button class="pg-stat s-'+CLS[k]+'" data-act="status" data-f="'+k+'">'+ico(k,14)+counts[k]+' '+LABEL[k].toLowerCase()+'</button>';
  });
  var left=rs.list.length-rs.done;
  var o='<span class="pg-end">START</span><div class="pg-track">'+segs+'</div><span class="pg-end">FINISH</span>';
  o+='<span class="pg-text"><b>'+rs.done+' of '+rs.list.length+'</b> placed · '+(left?left+' to go':'done')+(S.stats.wrong?' · '+S.stats.wrong+' off route':'')+'</span>'+stat;
  setHTML($('progress'),o);
}

/* ================= mini-map ================= */
function visibleRect(){
  var wr=$('mapWrap').getBoundingClientRect(),I=S.insets||{t:0,r:0,b:0,l:0};
  var v={l:wr.left+I.l,t:wr.top+I.t,r:wr.right-I.r,b:wr.bottom-I.b};
  if(S.ui.open){
    if(PORTRAIT.matches)v.b=Math.min(v.b,window.innerHeight-$('insp').offsetHeight);
    else v.r=Math.min(v.r,window.innerWidth-$('insp').offsetWidth-24);
  }
  if(!PORTRAIT.matches&&$('actsSheet').classList.contains('open'))v.l=Math.max(v.l,$('actsSheet').offsetWidth+24);
  if(v.r-v.l<80){v.l=wr.left;v.r=wr.right;}
  if(v.b-v.t<80){v.t=wr.top;v.b=wr.bottom;}
  return v;
}
function renderMinimap(){
  var el=$('minimap');
  document.body.classList.toggle('zoomed',V.s>1.15);
  if(!S.layout||!el.offsetParent){return;}
  var L=S.layout,b=L.bounds,o='<svg viewBox="'+f1(b.x)+' '+f1(b.y)+' '+f1(b.w)+' '+f1(b.h)+'" aria-hidden="true">';
  L.list.forEach(function(c){var p=px(c[0],c[1]),k=K(c[0],c[1]);o+='<polygon class="mm-cell'+(L.obst.has(k)?' obst':'')+'" points="'+hexPts(p.x,p.y,HS-2)+'"/>';});
  o+='<polyline class="mm-route" points="'+L.routeList.map(function(c){var p=px(c[0],c[1]);return f1(p.x)+','+f1(p.y);}).join(' ')+'"/>';
  Object.keys(L.pads).forEach(function(n){var p=px(L.pads[n][0],L.pads[n][1]);o+='<polygon class="mm-pad" points="'+hexPts(p.x,p.y,HS-6)+'"/>';});
  S.tiles.forEach(function(t){var p=px(t.q,t.r);o+='<polygon class="mm-tile t-'+CLS[tileEff(t).worst]+'" points="'+hexPts(p.x,p.y,HS-3)+'"/>';});
  if(S.next&&S.next.target){var np=px(S.next.target[0],S.next.target[1]);o+='<polygon class="mm-next" points="'+hexPts(np.x,np.y,HS-3)+'"/>';}
  if(S.vb&&$('map').querySelector('svg')){
    var v=visibleRect(),corners=[[v.l,v.t],[v.r,v.t],[v.r,v.b],[v.l,v.b]].map(function(c){return contentAt(toVB(c[0],c[1]));});
    o+='<polygon class="mm-view" points="'+corners.map(function(p){return f1(p.x)+','+f1(p.y);}).join(' ')+'"/>';
  }
  o+='</svg>';
  el.style.aspectRatio=(b.w/b.h).toFixed(3);
  setHTML(el,o);
}
(function(){
  var el=$('minimap'),down=false;
  function go(e){
    var svg=el.querySelector('svg');if(!svg||!S.layout)return;
    var r=svg.getBoundingClientRect(),b=S.layout.bounds;
    var w={x:b.x+(e.clientX-r.left)*b.w/r.width,y:b.y+(e.clientY-r.top)*b.h/r.height};
    var v=visibleRect();
    S.userMoved=true;placeAt(w,toVB((v.l+v.r)/2,(v.t+v.b)/2));clampView();applyView();
  }
  el.addEventListener('pointerdown',function(e){down=true;try{el.setPointerCapture(e.pointerId);}catch(_){}go(e);});
  el.addEventListener('pointermove',function(e){if(down)go(e);});
  el.addEventListener('pointerup',function(){down=false;saveView();});
  el.addEventListener('pointercancel',function(){down=false;});
})();

/* ================= fly the map to a tile or cell ================= */
function animateView(to,ms){
  var from={s:V.s,tx:V.tx,ty:V.ty};
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduce||!window.requestAnimationFrame){V.s=to.s;V.tx=to.tx;V.ty=to.ty;applyView();saveView();return;}
  var t0=performance.now();
  var step=function(now){
    var u=Math.min(1,(now-t0)/(ms||450));u=u<0.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2;
    V.s=from.s+(to.s-from.s)*u;V.tx=from.tx+(to.tx-from.tx)*u;V.ty=from.ty+(to.ty-from.ty)*u;applyView();
    if(u<1)requestAnimationFrame(step);else saveView();
  };
  requestAnimationFrame(step);
}
function flyToWorld(w,minScale){
  if(!S.layout||!S.vb)return;
  var keep={s:V.s,tx:V.tx,ty:V.ty},v=visibleRect();
  V.s=clampScale(Math.max(V.s,minScale||1.5));
  placeAt(w,toVB((v.l+v.r)/2,(v.t+v.b)/2));clampView();
  var to={s:V.s,tx:V.tx,ty:V.ty};V.s=keep.s;V.tx=keep.tx;V.ty=keep.ty;
  S.userMoved=true;animateView(to);
}
function flyToTile(id){
  var t=S.tiles.get(id);if(!t)return;
  flyToWorld(px(t.q,t.r));
  S.flash={id:id,until:Date.now()+2600};invalidate();
}

/* ================= alerts: toasts, sound, vibration ================= */
var AU={ctx:null,on:true};
try{if(localStorage.getItem('kastor-sound')==='0')AU.on=false;}catch(e){}
function unlockAudio(){
  if(!AU.ctx){try{var A=window.AudioContext||window.webkitAudioContext;if(A)AU.ctx=new A();}catch(e){}}
  if(AU.ctx&&AU.ctx.state==='suspended')AU.ctx.resume();
}
document.addEventListener('pointerdown',function(){AU.tapped=true;unlockAudio();},true);
document.addEventListener('keydown',unlockAudio,true);
function tone(f,start,dur,type,vol){
  var c=AU.ctx,o=c.createOscillator(),g=c.createGain(),t=c.currentTime+start;
  o.type=type||'sine';o.frequency.value=f;
  g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(vol||0.18,t+0.015);g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
  o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+dur+0.05);
}
var SOUNDS={
  risk:[[880,0,.16,'square'],[660,.2,.16,'square'],[880,.4,.16,'square'],[660,.6,.2,'square']],
  warn:[[600,0,.18,'triangle'],[600,.25,.18,'triangle']],
  reject:[[196,0,.4,'sawtooth',.14]],
  offline:[[660,0,.2,'triangle'],[440,.24,.35,'triangle']],
  online:[[440,0,.14],[660,.16,.2]],
  placed:[[740,0,.1],[988,.11,.14]],
  done:[[523,0,.15],[659,.17,.15],[784,.34,.32]]
};
var VIBES={risk:[220,100,220,100,220],warn:[120,80,120],reject:[380],offline:[300,150,300],online:[60],placed:[40],done:[90,60,90,60,160]};
function alertFx(kind){
  if(!AU.on)return;
  if(AU.ctx&&AU.ctx.state==='running'){try{(SOUNDS[kind]||[]).forEach(function(t){tone(t[0],t[1],t[2],t[3],t[4]);});}catch(e){}}
  // browsers only allow vibration after the user has touched the page
  if(navigator.vibrate&&AU.tapped){try{navigator.vibrate(VIBES[kind]||0);}catch(e){}}
}
var TOASTS=[],toastSeq=0;
function toast(o){
  if(o.key&&TOASTS.some(function(t){return t.key===o.key;}))return;
  o.id=++toastSeq;TOASTS.unshift(o);
  if(TOASTS.length>4)TOASTS.length=4;
  if(!o.sticky)setTimeout(function(){dismissToast(o.id);},o.ttl||8000);
  renderToasts();
}
// update an existing alert in place (or add it); only brand-new problems are added when isNew is false
function upsertToast(o,isNew){
  var ex=TOASTS.find(function(t){return t.key===o.key;});
  if(ex){if(ex.title!==o.title||ex.text!==o.text){ex.title=o.title;ex.text=o.text;renderToasts();}return;}
  if(isNew)toast(o);
}
function dismissToast(id){var n=TOASTS.length;TOASTS=TOASTS.filter(function(t){return t.id!==id;});if(TOASTS.length!==n)renderToasts();}
function resolveToast(key){var n=TOASTS.length;TOASTS=TOASTS.filter(function(t){return t.key!==key;});if(TOASTS.length!==n)renderToasts();}
function renderToasts(){
  var icon={risk:'RISK',warn:'CAUTION',ok:'CLEAR',info:'UNKNOWN'};
  setHTML($('toasts'),TOASTS.map(function(t){
    return '<div class="toast t-'+t.kind+'" role="'+(t.kind==='risk'?'alert':'status')+'">'+ico(icon[t.kind]||'UNKNOWN',22)+'<div class="toast-body"><b>'+esc(t.title)+'</b>'+(t.text?'<span>'+esc(t.text)+'</span>':'')+'</div><div class="toast-actions">'+(t.tile?'<button class="btn small" data-act="tshow" data-tile="'+esc(t.tile)+'">Show me</button>':'')+'<button class="btn small close" data-act="tclose" data-id="'+t.id+'" aria-label="Dismiss">✕</button></div></div>';
  }).join(''));
}
var EV={risk:null,unk:null,conn:null,wasOffline:false,complete:null};
function checkEvents(){
  if(S.connection!==EV.conn){
    if(S.connection==='offline'){EV.wasOffline=true;toast({kind:'risk',title:'Connection lost',text:'Showing the last confirmed state. Commands are disabled.',sticky:true,key:'offline'});alertFx('offline');}
    else if(S.connection==='live'&&EV.wasOffline){EV.wasOffline=false;resolveToast('offline');toast({kind:'ok',title:'Back online',text:'Live data restored.',ttl:4000});alertFx('online');}
    EV.conn=S.connection;
  }
  if(!S.layout||!S.stats||S.connection!=='live')return;
  // one alert per tile (listing its sides), so several bad sides don't stack up over the map
  var risk=new Set(),unk=new Set(),byTile={risk:{},unk:{}};
  S.tiles.forEach(function(t){tileEff(t).sides.forEach(function(v,i){
    var kind=v.eff==='RISK'?'risk':(v.eff==='UNKNOWN'||v.eff==='STALE')?'unk':null;
    if(!kind)return;
    (kind==='risk'?risk:unk).add(t.id+':'+i);
    (byTile[kind][t.id]=byTile[kind][t.id]||[]).push(i);
  });});
  var sidesTxt=function(list){return (list.length>1?'sides ':'side ')+list.map(function(i){return (i+1)+' ('+SIDE_SHORT[i]+')';}).join(', ');};
  [['risk',risk,EV.risk,'risk','Risk on ','Obstacle within 0.6 m. Deploy on '+'that side is blocked.'],
   ['unk',unk,EV.unk,'warn','Sensor issue on ','No current reading. Treat it as unsafe.']].forEach(function(cfg){
    var kind=cfg[0],now=cfg[1],prev=cfg[2];
    if(!prev)return;
    var fresh=false;
    Object.keys(byTile[kind]).forEach(function(id){
      var list=byTile[kind][id],isNew=list.some(function(i){return !prev.has(id+':'+i);});
      if(isNew)fresh=true;
      var text=kind==='risk'?(list.length>1?'Obstacles within 0.6 m. Deploy on those sides is blocked.':'Obstacle within 0.6 m. Deploy on that side is blocked.'):cfg[5];
      upsertToast({kind:cfg[3],title:cfg[4]+id+': '+sidesTxt(list),text:text,tile:id,sticky:true,key:kind+':'+id},isNew);
    });
    TOASTS.filter(function(t){return t.key&&t.key.indexOf(kind+':')===0&&!byTile[kind][t.key.slice(kind.length+1)];}).forEach(function(t){resolveToast(t.key);});
    if(fresh)alertFx(kind==='risk'?'risk':'warn');
  });
  EV.risk=risk;EV.unk=unk;
  if(EV.complete===false&&S.stats.complete){toast({kind:'ok',title:'Route complete',text:'Finished in '+mmss(S.stats.elapsed)+'.',ttl:10000});alertFx('done');}
  EV.complete=!!S.stats.complete;
}

/* ================= tiles & activity drawer ================= */
var PANELS={tiles:['paneTiles','Tiles','btnTiles'],acts:['paneActs','Activity','btnActs'],legend:['paneLegend','Legend','btnLegend'],layers:['paneLayers','Layers','btnLayers'],settings:['paneSettings','Settings','btnMenu']};
function setDrawerTab(tab){
  if(!PANELS[tab])tab='tiles';
  S.ui.drawerTab=tab;
  var open=$('actsSheet').classList.contains('open');
  Object.keys(PANELS).forEach(function(k){
    var P=PANELS[k],on=open&&k===tab;
    $(P[0]).hidden=k!==tab;
    $(P[2]).setAttribute('aria-expanded',String(on));$(P[2]).classList.toggle('active',on);
  });
  setText($('panelTitle'),PANELS[tab][1]);
  invalidate();
}
function toggleDrawer(tab){
  var open=$('actsSheet').classList.contains('open');
  if(open&&S.ui.drawerTab===tab){toggleActs(false);}
  else{toggleActs(true);}
  setDrawerTab(tab);
}
document.querySelectorAll('.ab[data-panel]').forEach(function(b){b.addEventListener('click',function(){toggleDrawer(b.getAttribute('data-panel'));});});
// map layers: simple visibility switches, remembered per device
var LAYERS={lyrRoute:'hide-route',lyrKeepout:'hide-keepout',lyrCoords:'hide-coords',lyrGrid:'hide-grid'};
Object.keys(LAYERS).forEach(function(id){
  var el=$(id),cls=LAYERS[id];
  try{if(localStorage.getItem('kastor-'+id)==='0')el.checked=false;}catch(e){}
  var apply=function(){$('mapWrap').classList.toggle(cls,!el.checked);};
  el.addEventListener('change',function(){apply();try{localStorage.setItem('kastor-'+id,el.checked?'1':'0');}catch(e){}});
  apply();
});
$('lyr3d').addEventListener('change',function(e){setMode3D(e.target.checked);});
$('tileSort').addEventListener('change',function(){invalidate();});
function renderTileList(){
  if(!$('actsSheet').classList.contains('open')||S.ui.drawerTab!=='tiles')return;
  var L=S.layout;if(!L){setHTML($('tileList'),'<p class="empty">Waiting for the first snapshot.</p>');return;}
  var rows=[];
  S.tiles.forEach(function(t){
    var te=tileEff(t);
    if(S.ui.filter&&!te.sides.some(function(v){return v.eff===S.ui.filter;}))return;
    rows.push({t:t,te:te,bat:t.telemetry&&t.telemetry.batteryV,off:!L.route.has(K(t.q,t.r)),joined:te.sides.filter(function(v){return v.kind==='joined';}).length});
  });
  var by=$('tileSort').value,num=function(id){return parseInt(String(id).replace(/\D/g,''),10)||0;};
  rows.sort(function(a,b){
    if(by==='id')return num(a.t.id)-num(b.t.id);
    if(by==='battery')return (a.bat===null||a.bat===undefined?99:a.bat)-(b.bat===null||b.bat===undefined?99:b.bat);
    if(by==='route')return (b.off-a.off)||num(a.t.id)-num(b.t.id);
    return SEV[b.te.worst]-SEV[a.te.worst]||num(a.t.id)-num(b.t.id);
  });
  if(!rows.length){setHTML($('tileList'),'<p class="empty">No tiles match this filter.</p>');return;}
  setHTML($('tileList'),'<ul class="tlist">'+rows.map(function(r){
    var w=r.te.worst,bad=r.te.sides.filter(function(v){return v.eff&&v.eff!=='CLEAR';}).map(function(v,i){return v;}).length;
    return '<li><button class="trow s-'+CLS[w]+(S.ui.open&&S.ui.selTile===r.t.id?' sel':'')+'" data-act="listpick" data-tile="'+esc(r.t.id)+'">'+
      '<span class="tr-id">'+esc(r.t.id)+'<small>('+r.t.q+','+r.t.r+')</small></span>'+
      '<span class="tr-st">'+ico(w,18)+LABEL[w]+(bad>1?' <small>· '+bad+' sides</small>':'')+'</span>'+
      '<span class="tr-meta"><span>'+(r.bat===null||r.bat===undefined?'—':r.bat.toFixed(1)+' V')+'</span><span>'+r.joined+'/6 joined</span>'+(r.off?'<span class="off">Off route</span>':'')+'</span></button></li>';
  }).join('')+'</ul>');
}

/* ================= scale bar and pointer readout ================= */
// Centre-to-centre spacing of neighbouring tiles. Taken from the mock sensor model, where an obstacle
// k cells away reads (k-1)*0.8+0.3 m; replace with the real tile pitch from the hardware spec.
var TILE_PITCH_M=0.8;
function renderScale(){
  var svg=$('map').querySelector('svg'),el=$('scalebar');
  if(!svg||!S.vb){setHTML(el,'');return;}
  var pxPerM=svg.getBoundingClientRect().width/S.vb.w*V.s*(HS*SQ3/TILE_PITCH_M);
  var steps=[0.1,0.2,0.25,0.5,1,2,2.5,5,10,20,50],n=steps[steps.length-1];
  for(var i=0;i<steps.length;i++){if(steps[i]*pxPerM>=60){n=steps[i];break;}}
  var label=(M3.t>0.05?'≈ ':'')+(n<1?Math.round(n*100)+' cm':n+' m');
  setHTML(el,'<div class="sb-bar" style="width:'+Math.round(n*pxPerM)+'px"></div><span>'+label+'</span>');
}
function cellAt(clientX,clientY){
  var w=contentAt(toVB(clientX,clientY));
  var q=(2/3*w.x)/HS,r=(-1/3*w.x+SQ3/3*w.y)/HS,y=-q-r;
  var rq=Math.round(q),rr=Math.round(r),ry=Math.round(y);
  var dq=Math.abs(rq-q),dr=Math.abs(rr-r),dy=Math.abs(ry-y);
  if(dq>dr&&dq>dy)rq=-rr-ry;else if(dr>dy)rr=-rq-ry;
  return [rq,rr];
}
(function(){
  var wrap=$('mapWrap');
  wrap.addEventListener('pointermove',function(e){
    if(!S.layout||e.pointerType==='touch'||e.target.closest('.widget'))return;
    var c=cellAt(e.clientX,e.clientY),on=S.layout.cells.has(K(c[0],c[1]));
    setText($('cellOut'),on?'Cell '+c[0]+', '+c[1]:'Off site');
  });
  wrap.addEventListener('pointerleave',function(){setText($('cellOut'),'');});
})();

/* ================= display size (whole-console scale) ================= */
var UI_SCALES=[0.8,0.9,1,1.1,1.25,1.4,1.6],uiScale=1;
function applyUiScale(){
  document.documentElement.style.zoom=uiScale===1?'':String(uiScale);
  setText($('scaleOut'),Math.round(uiScale*100)+'%');
  $('btnScaleDown').disabled=uiScale<=UI_SCALES[0];
  $('btnScaleUp').disabled=uiScale>=UI_SCALES[UI_SCALES.length-1];
}
function stepUiScale(dir){
  var i=UI_SCALES.indexOf(uiScale);if(i<0)i=2;
  uiScale=UI_SCALES[Math.max(0,Math.min(UI_SCALES.length-1,i+dir))];
  try{localStorage.setItem('kastor-ui-scale',String(uiScale));}catch(e){}
  applyUiScale();
}
try{var savedScale=parseFloat(localStorage.getItem('kastor-ui-scale'));if(UI_SCALES.indexOf(savedScale)>=0)uiScale=savedScale;}catch(e){}
$('btnScaleDown').addEventListener('click',function(){stepUiScale(-1);});
$('btnScaleUp').addEventListener('click',function(){stepUiScale(1);});
applyUiScale();
 
function hexControl(tile){
  var cx=170,cy=158,R=76,sel=S.ui.selSide,te=tileEff(tile),ds=deployState(tile,sel);
  var o='<svg viewBox="0 0 340 300" role="group" aria-label="Sides of tile '+tile.id+'">';
  o+='<polygon class="hex-base" points="'+hexPts(cx,cy+8,R)+'"/><polygon class="hex-body" points="'+hexPts(cx,cy,R)+'"/>';
  for(var i=0;i<6;i++){
    var v=te.sides[i],st=v.kind==='joined'?'joined':v.eff==='STALE'?'stale':CLS[v.eff];
    var e=edgeSeg(cx,cy,R+11,i,0.1);
    var na=(-90+60*i)*Math.PI/180,nx=cx+(R+38)*Math.cos(na),ny=cy+(R+38)*Math.sin(na);
    var desc=v.kind==='joined'?'joined to '+v.to:LABEL[v.eff].toLowerCase();
    o+='<g class="seg s-'+st+(i===sel?' sel':'')+'" data-act="side" data-side="'+i+'" tabindex="0" role="button" aria-pressed="'+(i===sel)+'" aria-label="Side '+(i+1)+', '+SIDE_LABEL[i]+', '+desc+'">';
    o+='<line class="hit" x1="'+e[0]+'" y1="'+e[1]+'" x2="'+e[2]+'" y2="'+e[3]+'"/>';
    o+='<line class="segline" x1="'+e[0]+'" y1="'+e[1]+'" x2="'+e[2]+'" y2="'+e[3]+'"/>';
    o+='<circle class="num" cx="'+nx.toFixed(1)+'" cy="'+ny.toFixed(1)+'" r="13"/><text class="numt" x="'+nx.toFixed(1)+'" y="'+ny.toFixed(1)+'">'+(i+1)+'</text></g>';
  }
  o+='<g class="deploy'+(ds.ok?'':' off')+'" data-act="deploy" tabindex="0" role="button" aria-disabled="'+(!ds.ok)+'" aria-label="'+ds.label+' toward side '+(sel+1)+'">';
  o+='<polygon class="deploy-base" points="'+hexPts(cx,cy+6,52)+'"/><g class="press"><polygon class="deploy-top" points="'+hexPts(cx,cy,52)+'"/><text class="lbl" x="'+cx+'" y="'+(cy+2)+'">'+ds.label+'</text><text class="sub" x="'+cx+'" y="'+(cy+22)+'">side '+(sel+1)+', '+SIDE_SHORT[sel]+'</text></g></g>';
  o+='<g class="rot" data-act="rot" data-dir="-1" tabindex="0" role="button" aria-label="Select previous side"><circle cx="40" cy="44" r="18"/><path d="M45 36l-9 8 9 8"/></g>';
  o+='<g class="rot" data-act="rot" data-dir="1" tabindex="0" role="button" aria-label="Select next side"><circle cx="300" cy="44" r="18"/><path d="M295 36l9 8-9 8"/></g>';
  o+='</svg>';
  return o;
}
function measHTML(v){
  if(v.kind!=='sensor')return '';
  var ms=(v.s.measurements||[]).filter(function(m){var type=String(m.type||m.sensor_type||m.sensorType||'').toLowerCase();return type.indexOf('ultrasonic')!==-1||type==='us';});
  if(!ms.length)return '<div class="meas"><div class="meas-row"><span>No ultrasonic sensor data reported for this side.</span></div></div>';
  var o='<div class="meas">';
  ms.forEach(function(m){
    var age=m.ts===null?null:Math.max(0,Date.now()-m.ts),stale=age===null||age>STALE_MS;
    var val=m.hit?(Number.isFinite(m.distance)?m.distance.toFixed(2)+' m':'Distance unavailable'):'No hit in range';
    o+='<div class="meas-row'+(stale?' stale':'')+'"><span class="nm">Ultrasonic</span><span class="d">'+val+'</span><span class="age">'+(age===null?'Time unavailable':(age/1000).toFixed(1)+' s ago')+(stale?' (stale)':'')+'</span></div>';
  });
  o+='</div>';
  return o;
}
function readoutHTML(tile,i){
  var v=sideView(tile,i),name='Side '+(i+1)+', '+SIDE_LABEL[i];
  var checks=cellChecks(tile,i),blocked=v.blocked===true||!checks.ok;
  var clearance=v.clearanceM===null?'—':v.clearanceM.toFixed(1)+' m';
  var sensorValidity=v.kind==='joined'?'N/A':v.kind==='sensor'&&!v.stale?'Valid':v.eff==='STALE'?'Stale':'Invalid';
  var sideFacts='<div class="side-facts"><div class="side-fact"><span class="k">Clearance</span><span class="v">'+clearance+'</span></div><div class="side-fact"><span class="k">Occupied</span><span class="v">'+(v.occupied?'Yes':'No')+'</span></div><div class="side-fact"><span class="k">Sensor</span><span class="v">'+sensorValidity+'</span></div><div class="side-fact '+(blocked?'blocked':'available')+'"><span class="k">Deploy</span><span class="v">'+(blocked?'Blocked':'Available')+'</span></div></div>';
  if(v.kind==='joined'){
    return '<div class="ro"><h3>'+name+'</h3>'+sideFacts+'<p class="empty">Joined to tile '+esc(v.to)+'. A joined side is occupied and cannot accept another tile.</p></div>';
  }
  var e=v.eff,head='',sub='',s=v.s;
  var ageS=v.age===null?'—':(v.age/1000).toFixed(1);
  if(e==='UNKNOWN'){head='Unknown: no reading';sub='Treat this side as unsafe until it reports again.';}
  else if(e==='STALE'){head='Stale: last status '+Math.round(v.age/1000)+' s old';sub='Last known status was '+LABEL[s.status].toLowerCase()+'. It is not shown as current.';}
  else if(e==='CLEAR'){head='Clear';sub='No obstacle close enough to flag.';}
  else if(e==='CAUTION'){head='Caution: obstacle ahead';sub='Slow approach advised.';}
  else{head='Risk: obstacle very close';sub='Deploy is blocked below 0.6 m.';}
  var risk=v.kind==='sensor'&&s.risk!==null?s.risk+'<small>%</small>':'—';
  var rcls=s&&s.status==='RISK'?'risk':s&&s.status==='CAUTION'?'caution':'';
  var o='<div class="ro"><h3>'+name+'</h3><div class="ro-head">'+ico(e,26)+'<div><strong>'+head+'</strong><span>'+sub+'</span></div></div>';
  o+=sideFacts;
  o+='<div class="stats2"><div class="stat"><div class="k">Risk</div><div class="n">'+risk+'</div><div class="bar"><i class="'+rcls+'" style="width:'+(v.kind==='sensor'&&s.risk!==null?s.risk:0)+'%"></i></div></div>';
  o+='<div class="stat"><div class="k">Status updated</div><div class="n">'+(v.kind==='sensor'||v.kind==='unknown'?ageS+'<small> s ago</small>':'—')+'</div></div></div>';
  o+=measHTML(v)+'</div>';
  return o;
}
function displayValue(value,unit,digits){
  if(value===null||value===undefined||value==='')return 'Not reported';
  return (typeof value==='number'?value.toFixed(digits===undefined?1:digits):String(value))+(unit||'');
}
function compactTelemetry(value){
  if(value===null||value===undefined)return 'Not reported';
  var text=typeof value==='string'?value:JSON.stringify(value);
  return esc(text.length>96?text.slice(0,93)+'…':text);
}
function diagnosticSubset(source,fields){
  if(!source||typeof source!=='object'||Array.isArray(source))return source;
  var subset={};
  fields.forEach(function(field){
    var value=field[1].map(function(key){return source[key];}).find(function(candidate){return candidate!==undefined&&candidate!==null;});
    if(value!==undefined)subset[field[0]]=value;
  });
  return Object.keys(subset).length?subset:source;
}
function deviceStatusHTML(tile){
  var t=tile.telemetry||{},turn=t.turntable||{},diag=t.diagnostics||{};
  var status=turn.status||'UNKNOWN',fault=turn.fault||'UNKNOWN';
  var battery=displayValue(t.batteryV,' V',1);
  var angle=displayValue(turn.angleDeg,'°',1);
  var edge=turn.currentEdge===null||turn.currentEdge===undefined?'—':String(turn.currentEdge);
  var o='<div class="device-status"><div class="device-grid">';
  o+='<div class="device-item"><span class="k">Battery</span><span class="v">'+battery+'</span></div>';
  o+='<div class="device-item"><span class="k">Turntable</span><span class="v">'+esc(status.replace(/_/g,' '))+'</span></div>';
  o+='<div class="device-item"><span class="k">Angle · edge</span><span class="v">'+angle+' · '+edge+'</span></div></div>';
  if(fault!=='NONE'&&fault!=='UNKNOWN')o+='<div class="fault-alert" role="alert">Turntable fault: '+esc(fault.replace(/_/g,' '))+'</div>';
  // Only readings an operator in the field acts on: faults, power/air supply, and whether the
  // docks latched and lined up. Controller internals (gains, PWM, speeds, arm/conveyor, RAPID)
  // belong to engineering tools, not this console.
  o+='<details class="diagnostics"><summary>Advanced diagnostics</summary><dl>';
  var rows=[
    ['Turntable fault',fault.replace(/_/g,' ')],
    ['Pneumatic pressure',displayValue(diag.pneumaticPressure,'',1)],
    ['Dock latch (contact / capture)',compactTelemetry(diagnosticSubset(diag.dockSensors,[['top contact', ['topDockContact','top_dock_contact_sensor']],['bottom contact', ['bottomDockContact','bottom_dock_contact_status']],['bottom capture', ['bottomDockCapture','bottom_dock_capture_status']]]))],
    ['Dock motor current',compactTelemetry(diagnosticSubset(diag.dockSensors,[['top', ['topDockCurrent','top_dock_current_sensor']],['bottom', ['bottomDockCurrent','bottom_dock_current_sensor']]]))],
    ['Dock alignment',compactTelemetry(diagnosticSubset(diag.dockSensors,[['range', ['bottomDockDistance','bottom_dock_distance_sensors']],['edge angle', ['relativeBottomEdgeAngle','relative_bottom_edge_angle']]]))]
  ];
  if(t.lowerBatteryV!==null&&t.lowerBatteryV!==undefined)rows.splice(1,0,['Lower battery',displayValue(t.lowerBatteryV,' V',1)]);
  rows.forEach(function(row){o+='<dt>'+esc(row[0])+'</dt><dd>'+row[1]+'</dd>';});
  o+='</dl></details></div>';
  return o;
}
function renderInspector(){
  var tile=S.tiles.get(S.ui.selTile);
  if(!tile){setText($('inspTitle'),'Tile');setHTML($('hexWrap'),'<p class="empty">Waiting for the first snapshot.</p>');setHTML($('deviceStatus'),'');setHTML($('readout'),'');return;}
  var te=tileEff(tile),joined=te.sides.filter(function(v){return v.kind==='joined';}).length;
  setText($('inspTitle'),'Tile '+tile.id);
  setText($('inspSub'),joined+' of 6 sides joined');
  setHTML($('hexWrap'),hexControl(tile));
  var diagnosticsOpen=$('deviceStatus').querySelector('details')&&$('deviceStatus').querySelector('details').open;
  setHTML($('deviceStatus'),deviceStatusHTML(tile));
  if(diagnosticsOpen){var newDetails=$('deviceStatus').querySelector('details');if(newDetails)newDetails.open=true;}
  var ds=deployState(tile,S.ui.selSide);
  var note=$('deployNote');note.className='note '+(ds.cls||'');setText(note,ds.why);
  setHTML($('readout'),readoutHTML(tile,S.ui.selSide));
  var st=S.stats,live=S.connection==='live';
  var confirming=Date.now()-S.ui.confirmRestart<3000;
  setText($('btnRestart'),confirming?'Confirm restart':'Restart');
  $('btnRestart').classList.toggle('danger',confirming);
  $('btnRestart').disabled=!live;
}
function actText(r){
  var lab=r.kind==='deploy'?'Deploy from '+r.tileId+' to side '+(r.side+1)+' ('+SIDE_SHORT[r.side]+')':r.kind==='pause'?'Pause the mission':r.kind==='resume'?'Resume the mission':'Restart the layout';
  var cls='',txt='',n=1,bad=false;
  if(r.status==='sending'){
    var w=Math.round((Date.now()-r.createdAt)/1000);
    if(r.offlineUnknown){txt='Outcome unknown while offline. It will be checked when the link returns.';cls='warn';}
    else if(w>=4){txt='Still waiting for an acknowledgment ('+w+' s).';cls='warn';}
    else txt='Sent, waiting for the server.';
    n=1;
  }else if(r.status==='accepted'){txt=r.offlineUnknown?'Accepted earlier. Current outcome unknown while offline.':'Accepted by the server.';cls=r.offlineUnknown?'warn':'';n=2;}
  else if(r.status==='in_progress'){txt=r.offlineUnknown?'In progress at last contact. Current outcome unknown while offline.':'In progress, '+r.progress+'%.';cls=r.offlineUnknown?'warn':'';n=3;}
  else if(r.status==='completed'){txt='Done, confirmed by the server.';cls='good';n=4;}
  else if(r.status==='rejected'){txt='Rejected. '+(r.reason||'');cls='bad';n=1;bad=true;}
  else{txt=r.reason||'Not sent.';cls='bad';n=1;bad=true;}
  var steps='';
  for(var i=1;i<=4;i++)steps+='<i class="'+(i<=n?'on':'')+(i<=n&&bad?' bad':'')+(i<=n&&r.status==='completed'?' done':'')+'"></i>';
  return '<li><span class="t">'+esc(lab)+'</span><span class="time">'+fmtTime(r.createdAt)+' '+r.id+'</span><span class="s '+cls+'">'+esc(txt)+'</span><span class="steps" aria-hidden="true">'+steps+'</span></li>';
}
function renderActs(){
  var pending=S.reqs.filter(function(r){return rankOf(r.status)<3&&r.status!=='lost';}).length,badge=$('actsBadge');
  badge.hidden=!pending;setText(badge,String(pending));
  if(!S.reqs.length){setHTML($('acts'),'<p class="empty">No commands yet. Select a tile and a side, then press Deploy.</p>');return;}
  setHTML($('acts'),'<ol class="acts">'+S.reqs.map(actText).join('')+'</ol>');
}
function renderBench(){
  if($('bench').hidden)return;
  var h='';
  S.log.slice(0,12).forEach(function(l){
    var tag={tx:'sent',rx:'received',dup:'ignored',buf:'buffered',gap:'resync',net:'link',srv:'server'}[l.kind]||l.kind;
    h+='<li class="k-'+l.kind+'"><time>'+fmtTime(l.t)+'</time><span class="tag">'+tag+'</span><span>'+esc(l.text)+'</span></li>';
  });
  setHTML($('log'),h);
  setText($('btnNet'),net.connected?'Disconnect':'Reconnect');
  var tile=S.tiles.get(S.ui.selTile),f=tile?server.faults.get(tile.id+':'+S.ui.selSide):null,joined=tile&&sideView(tile,S.ui.selSide).kind==='joined';
  setText($('fNote'),tile?('Tile '+tile.id+', side '+(S.ui.selSide+1)+(joined?' is joined, so it has no sensor.':f?': sensor is '+(f==='freeze'?'frozen (data will go stale).':'dropped out (reports unknown).'):': sensor is healthy.')):'');
  ['fFreeze','fDrop','fFix'].forEach(function(id){$(id).disabled=!tile||joined;});
}
function renderAll(){
  S.next=nextStep();checkEvents();
  renderConn();renderMetrics();renderBanner();renderProgress();renderChips();renderMap();renderScale();renderMinimap();renderGuide();renderStop();renderInspector();renderActs();renderTileList();renderBench();
}
 
/* ================= interaction ================= */
function act(el){
  var a=el.getAttribute('data-act'),tile=S.tiles.get(S.ui.selTile);
  if(a==='pick'){openTile(el.getAttribute('data-tile'));}else if(a==='side'){S.ui.selSide=+el.getAttribute('data-side');}
  else if(a==='rot'){S.ui.selSide=(S.ui.selSide+ +el.getAttribute('data-dir')+6)%6;}
  else if(a==='filter'){var f=el.getAttribute('data-f');S.ui.filter=S.ui.filter===f?null:f;}
  else if(a==='status'){S.ui.filter=el.getAttribute('data-f');toggleActs(true);setDrawerTab('tiles');}
  else if(a==='listpick'){var lid=el.getAttribute('data-tile');openTile(lid);flyToTile(lid);}
  else if(a==='tshow'){flyToTile(el.getAttribute('data-tile'));}
  else if(a==='tclose'){dismissToast(+el.getAttribute('data-id'));}
  else if(a==='flycell'){flyToWorld(px(+el.getAttribute('data-q'),+el.getAttribute('data-r')));}
  else if(a==='gresume'){sendCommand('resume');}
  else if(a==='gtoggle'){S.ui.guideMin=!S.ui.guideMin;try{localStorage.setItem('kastor-guide-min',S.ui.guideMin?'1':'0');}catch(e){}}
  else if(a==='gshow'&&S.next&&S.next.target){flyToWorld(px(S.next.target[0],S.next.target[1]));if(S.next.tile)S.flash={id:S.next.tile.id,until:Date.now()+2600};}
  else if(a==='gdetails'&&S.next&&S.next.tile){openTile(S.next.tile.id);S.ui.selSide=S.next.side;}
  else if(a==='gdeploy'&&S.next&&S.next.kind==='go'){
    var g=S.next;S.ui.selTile=g.tile.id;S.ui.selSide=g.side;
    sendCommand('deploy',{tileId:g.tile.id,side:g.side,target:[g.target[0],g.target[1]]});
  }
  else if(a==='deploy'&&tile){
    var ds=deployState(tile,S.ui.selSide);
    if(ds.ok){
      var i=S.ui.selSide;
      sendCommand('deploy',{tileId:tile.id,side:i,target:[tile.q+DIRS[i][0],tile.r+DIRS[i][1]]});
    }
  }
  invalidate();
}
document.addEventListener('click',function(e){
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if(t)act(t);
  else if(e.target.closest&&e.target.closest('#map'))closeTile();   // tap on empty ground
});
document.addEventListener('keydown',function(e){
  var tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input')return;
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if((e.key==='Enter'||e.key===' ')&&t&&tag!=='button'){e.preventDefault();act(t);return;}
  if(e.key==='Escape'){if(S.ui.open)closeTile();else toggleActs(false);return;}
  if(S.ui.open&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){
    S.ui.selSide=(S.ui.selSide+(e.key==='ArrowRight'?1:-1)+6)%6;invalidate();
  }
});
$('btnPause').addEventListener('click',function(){
  if(S.stats)sendCommand(S.stats.paused?'resume':'pause');
});
$('btnRestart').addEventListener('click',function(){
  if(Date.now()-S.ui.confirmRestart<3000){S.ui.confirmRestart=0;sendCommand('restart');}
  else{S.ui.confirmRestart=Date.now();}
  invalidate();
});
$('btnBench').addEventListener('click',function(){closePops();$('bench').hidden=!$('bench').hidden;invalidate();});
$('benchClose').addEventListener('click',function(){$('bench').hidden=true;});
function curTheme(){
  return document.documentElement.getAttribute('data-theme')||'light';
}
$('btnTheme').addEventListener('click',function(){
  var n=curTheme()==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',n);
  try{localStorage.setItem('kastor-theme',n);}catch(e){}
});
try{var saved=localStorage.getItem('kastor-theme');if(saved)document.documentElement.setAttribute('data-theme',saved);}catch(e){}
 
$('btnNet').addEventListener('click',function(){
  if(net.connected){net.connected=false;onClose();}
  else{net.connected=true;onOpen();}
  invalidate();
});
$('lat').addEventListener('input',function(e){net.latency=+e.target.value;$('latOut').textContent=e.target.value+' ms';});
$('dup').addEventListener('change',function(e){net.dup=e.target.checked;});
$('reord').addEventListener('change',function(e){net.reorder=e.target.checked;});
$('rejNext').addEventListener('change',function(e){server.rejectNext=e.target.checked;});
function fault(kind){
  var t=S.tiles.get(S.ui.selTile);if(!t)return;
  server.setFault(t.id,S.ui.selSide,kind);invalidate();
}
$('fFreeze').addEventListener('click',function(){fault('freeze');});
$('fDrop').addEventListener('click',function(){fault('dropout');});
$('fFix').addEventListener('click',function(){fault(null);});
 
/* ================= boot ================= */
setInterval(function(){server.tick();},800);
setInterval(invalidate,400);
renderAll();
resync(true);
window.__kastor={S:S,net:net,server:server};
})();
