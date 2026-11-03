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
  ui:{selTile:null,selSide:1,filter:null,confirmRestart:0}
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
    var out,prev=this.last.get(key);
    if(fault==='dropout'){
      out={status:'UNKNOWN',risk:null,ts:now,measurements:[]};
    }else{
      var base=null;
      for(var k=1;k<=3;k++){
        if(OBST.has(K(t.q+dq*k,t.r+dr*k))){base=(k-1)*0.8+0.3;break;}
      }
      var jit=function(){return (Math.random()-0.5)*0.06;};
      var meas=[],hit=base!==null;
      var lidarD=hit?Math.max(0.05,base+jit()):null;
      meas.push({type:'lidar',hit:hit,distance:lidarD?+lidarD.toFixed(2):null,ts:now});
      var prevUs=prev&&prev.measurements?prev.measurements.find(function(m){return m.type==='ultrasonic';}):null;
      if(Math.random()<0.7){
        var usD=hit?Math.max(0.05,base+jit()):null;
        meas.push({type:'ultrasonic',hit:hit,distance:usD?+usD.toFixed(2):null,ts:now});
      }else if(prevUs){
        meas.push(prevUs);
      }
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
    if(rq&&S.ui.selTile===rq.tileId){S.ui.selTile=msg.newId;S.ui.selSide=pickDefaultSide(S.tiles.get(msg.newId));}
    log('rx','#'+msg.seq+' tile '+msg.newId+' added (request '+msg.reqId+')');
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
    h+='<button class="chip'+(S.ui.filter===k?' active':'')+(counts[k]?'':' zero')+'" data-act="filter" data-f="'+k+'" aria-pressed="'+(S.ui.filter===k)+'">'+ico(k,15)+'<b>'+counts[k]+'</b> '+LABEL[k].toLowerCase()+(counts[k]===1?' side':' sides')+'</button>';
  });
  setHTML($('chips'),h);
}
function ghostFor(q,r,cls,label){
  var p=px(q,r);
  return '<polygon class="ghost '+cls+'" points="'+hexPts(p.x,p.y,HS-3)+'"/>'+(label?'<text class="ghost-t" x="'+p.x.toFixed(1)+'" y="'+(p.y+4).toFixed(1)+'">'+label+'</text>':'');
}
function renderMap(){
  var L=S.layout;
  if(!L){setHTML($('map'),'<p class="empty" style="padding:24px">Waiting for the first snapshot.</p>');return;}
  var b=L.bounds,o='<svg viewBox="'+b.x.toFixed(0)+' '+b.y.toFixed(0)+' '+b.w.toFixed(0)+' '+b.h.toFixed(0)+'" role="group" aria-label="Tile layout map">';
  o+='<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" style="fill:var(--unknown-soft)"/><line x1="0" y1="0" x2="0" y2="6" style="stroke:var(--unknown)" stroke-width="2" opacity=".55"/></pattern></defs>';
  L.list.forEach(function(c){
    var p=px(c[0],c[1]),k=K(c[0],c[1]);
    o+='<g class="coord-cell"><polygon class="cell'+(L.obst.has(k)?' obst':'')+'" points="'+hexPts(p.x,p.y,HS-1.5)+'"/><text class="coord" x="'+p.x.toFixed(1)+'" y="'+(p.y+10).toFixed(1)+'">('+c[0]+','+c[1]+')</text></g>';
  });
  // planned route dots for cells not built yet
  var built=new Set();S.tiles.forEach(function(t){built.add(K(t.q,t.r));});
  L.routeList.forEach(function(c){
    if(!built.has(K(c[0],c[1]))){var p=px(c[0],c[1]);o+='<circle class="route-dot" cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="4"/>';}
  });
  Object.keys(L.pads).forEach(function(n){
    var c=L.pads[n],p=px(c[0],c[1]);
    o+='<g class="pad"><rect x="'+(p.x-14).toFixed(1)+'" y="'+(p.y-12).toFixed(1)+'" width="28" height="18" rx="6"/><text x="'+p.x.toFixed(1)+'" y="'+(p.y+1).toFixed(1)+'">'+n+'</text></g>';
  });
  // ghosts: pending deploys, then the target of the selected side
  var pend={};
  S.reqs.forEach(function(r){
    if(r.kind==='deploy'&&r.target&&rankOf(r.status)<3&&r.status!=='lost'){
      pend[K(r.target[0],r.target[1])]=1;
      o+=ghostFor(r.target[0],r.target[1],'pending',r.id);
    }
  });
  var sel=S.tiles.get(S.ui.selTile);
  if(sel){
    var tq=sel.q+DIRS[S.ui.selSide][0],tr=sel.r+DIRS[S.ui.selSide][1],tk=K(tq,tr);
    if(L.cells.has(tk)&&!built.has(tk)&&!pend[tk]){
      o+=ghostFor(tq,tr,(L.obst.has(tk)||L.reserved.has(tk))?'bad':'','');
    }
  }
  // tiles
  S.tiles.forEach(function(t){
    var te=tileEff(t),p=px(t.q,t.r),cls=CLS[te.worst];
    var wrong=!L.route.has(K(t.q,t.r));
    var dim=S.ui.filter&&!te.sides.some(function(v){return v.eff===S.ui.filter;});
    var isNew=S.justAdded[t.id]&&Date.now()-S.justAdded[t.id]<900;
    o+='<g class="tile t-'+cls+(wrong?' wrong':'')+(dim?' dim':'')+(isNew?' enter':'')+'" data-act="pick" data-tile="'+t.id+'" tabindex="0" role="button" aria-label="Tile '+t.id+', worst side: '+LABEL[te.worst].toLowerCase()+(wrong?', off the planned route':'')+'">';
    o+='<polygon class="tbody" points="'+hexPts(p.x,p.y,HS-3)+'"/>';
    te.sides.forEach(function(v,i){
      if(!v.eff||v.eff==='CLEAR')return;
      var e=edgeSeg(p.x,p.y,HS-5,i,0.16);
      o+='<line class="edge e-'+CLS[v.eff]+'" x1="'+e[0]+'" y1="'+e[1]+'" x2="'+e[2]+'" y2="'+e[3]+'"/>';
    });
    o+='<text class="tid" x="'+p.x.toFixed(1)+'" y="'+(p.y+(te.worst==='CLEAR'?-1:-4)).toFixed(1)+'">'+t.id+'</text>';
    o+='<text class="coord" x="'+p.x.toFixed(1)+'" y="'+(p.y+10).toFixed(1)+'">('+t.q+','+t.r+')</text>';
    if(te.worst!=='CLEAR')o+=icoAt(te.worst,(p.x-6).toFixed(1),(p.y+5).toFixed(1),12);
    o+='</g>';
  });
  if(sel){var sp=px(sel.q,sel.r);o+='<polygon class="ring" points="'+hexPts(sp.x,sp.y,HS+1.5)+'"/>';}
  o+='</svg>';
  setHTML($('map'),o);
  $('mapWrap').classList.toggle('dim',S.connection!=='live');
}
 
function hexControl(tile){
  var cx=170,cy=158,R=76,sel=S.ui.selSide,te=tileEff(tile),ds=deployState(tile,sel);
  var o='<svg viewBox="0 0 340 300" role="group" aria-label="Sides of tile '+tile.id+'">';
  o+='<polygon class="hex-body" points="'+hexPts(cx,cy,R)+'"/>';
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
  o+='<polygon points="'+hexPts(cx,cy,52)+'"/><text class="lbl" x="'+cx+'" y="'+(cy+2)+'">'+ds.label+'</text><text class="sub" x="'+cx+'" y="'+(cy+22)+'">side '+(sel+1)+', '+SIDE_SHORT[sel]+'</text></g>';
  o+='<g class="rot" data-act="rot" data-dir="-1" tabindex="0" role="button" aria-label="Select previous side"><circle cx="40" cy="44" r="18"/><path d="M45 36l-9 8 9 8"/></g>';
  o+='<g class="rot" data-act="rot" data-dir="1" tabindex="0" role="button" aria-label="Select next side"><circle cx="300" cy="44" r="18"/><path d="M295 36l9 8-9 8"/></g>';
  o+='</svg>';
  return o;
}
function measHTML(v){
  if(v.kind!=='sensor')return '';
  var ms=v.s.measurements||[];
  if(!ms.length)return '<div class="meas"><div class="meas-row"><span>No sensor data reported for this side.</span></div></div>';
  var o='<div class="meas">';
  ms.forEach(function(m){
    var age=m.ts===null?null:Math.max(0,Date.now()-m.ts),stale=age===null||age>STALE_MS;
    var val=m.hit?(Number.isFinite(m.distance)?m.distance.toFixed(2)+' m':'Distance unavailable'):'No hit in range';
    var nm=m.type==='lidar'?'LiDAR':m.type==='ultrasonic'?'Ultrasonic':m.type;
    o+='<div class="meas-row'+(stale?' stale':'')+'"><span class="nm">'+nm+'</span><span class="d">'+val+'</span><span class="age">'+(age===null?'Time unavailable':(age/1000).toFixed(1)+' s ago')+(stale?' (stale)':'')+'</span></div>';
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
  o+='<details class="diagnostics"><summary>Advanced diagnostics</summary><dl>';
  var rows=[
    ['Turntable fault',fault.replace(/_/g,' ')],['Turntable PWM',displayValue(turn.pwmUs,' µs',0)],
    ['Turntable speed',displayValue(turn.speedDegS,'°/s',1)],['Speed gains',compactTelemetry(turn.speedGains)],
    ['Arm angle',displayValue(diag.armAngle,'',1)],['Arm command',compactTelemetry(diag.armCommand)],
    ['Pneumatic pressure',displayValue(diag.pneumaticPressure,'',1)],
    ['Conveyor speed',displayValue(diag.conveyorSpeed,'',2)],['Conveyor PWM',displayValue(diag.conveyorPwmUs,'',0)],
    ['Conveyor gains',compactTelemetry(diag.conveyorGains)],
    ['Dock currents',compactTelemetry(diagnosticSubset(diag.dockSensors,[['top', ['topDockCurrent','top_dock_current_sensor']],['bottom', ['bottomDockCurrent','bottom_dock_current_sensor']]]))],
    ['Dock contact / capture',compactTelemetry(diagnosticSubset(diag.dockSensors,[['top', ['topDockContact','top_dock_contact_sensor']],['bottom contact', ['bottomDockContact','bottom_dock_contact_status']],['bottom capture', ['bottomDockCapture','bottom_dock_capture_status']]]))],
    ['Dock motor PWM',compactTelemetry(diagnosticSubset(diag.dockSensors,[['top', ['topDockMotorPwm','top_dock_motor_pwm_command']],['bottom', ['bottomDockPwm','bottom_dock_pwm_command']]]))],
    ['Range / relative edge',compactTelemetry(diagnosticSubset(diag.dockSensors,[['range', ['bottomDockDistance','bottom_dock_distance_sensors']],['edge angle', ['relativeBottomEdgeAngle','relative_bottom_edge_angle']]]))],
    ['RAPID state',compactTelemetry(diag.rapid)]
  ];
  if(t.lowerBatteryV!==null&&t.lowerBatteryV!==undefined)rows.unshift(['Lower battery',displayValue(t.lowerBatteryV,' V',1)]);
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
  setText($('btnPause'),st&&st.paused?'Resume':'Pause');
  $('btnPause').disabled=!live||!st||st.complete;
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
  renderConn();renderMetrics();renderBanner();renderChips();renderMap();renderInspector();renderActs();renderBench();
}
 
/* ================= interaction ================= */
function act(el){
  var a=el.getAttribute('data-act'),tile=S.tiles.get(S.ui.selTile);
  if(a==='pick'){
    var id=el.getAttribute('data-tile');
    if(id!==S.ui.selTile){S.ui.selTile=id;S.ui.selSide=pickDefaultSide(S.tiles.get(id));}
  }else if(a==='side'){S.ui.selSide=+el.getAttribute('data-side');}
  else if(a==='rot'){S.ui.selSide=(S.ui.selSide+ +el.getAttribute('data-dir')+6)%6;}
  else if(a==='filter'){var f=el.getAttribute('data-f');S.ui.filter=S.ui.filter===f?null:f;}
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
});
document.addEventListener('keydown',function(e){
  var tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input')return;
  var t=e.target.closest?e.target.closest('[data-act]'):null;
  if((e.key==='Enter'||e.key===' ')&&t&&tag!=='button'){e.preventDefault();act(t);return;}
  if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
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
$('btnBench').addEventListener('click',function(){$('bench').hidden=!$('bench').hidden;invalidate();});
$('benchClose').addEventListener('click',function(){$('bench').hidden=true;});
function curTheme(){
  return document.documentElement.getAttribute('data-theme')||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
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
