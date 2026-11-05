/* Geometry only. The pinned ELK worker is embedded by the existing asset build. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PLElkLayout=api.create({root});
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const NETWORK=new Set(['switch','router','firewall','hub','network','gateway','virtual-switch']);
  const ordered=items=>[...items].sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));
  const finite=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
  function rank(request,id){return Number(request.ranks?.[id])||0;}
  function virtualGateways(request){
    const nodes=new Map(request.nodes.map(n=>[String(n.id),n])),groups=new Map(),edgeIds=new Set();
    for(const edge of request.edges){
      const source=nodes.get(String(edge.source)),target=nodes.get(String(edge.target));
      if(edge.kind!=='routed'||source?.kind!=='vm'||target?.kind!=='vm'||!source.parent_id||source.parent_id!==target.parent_id||
         source.id!=='vm:'+edge.details?.virtual_gateway?.vm_uuid)continue;
      if(!groups.has(source.id))groups.set(source.id,new Set());
      groups.get(source.id).add(target.id);edgeIds.add(String(edge.id));
    }
    return {groups,edgeIds};
  }
  function key(request){
    const gateways=virtualGateways(request);
    return JSON.stringify({schema:gateways.groups.size?'compact-vm-gateway-1':'compact-2',scope:request.scope||'',aspect:Math.max(1,Math.min(8,Math.round((request.width||1200)/(request.height||800)*2))),
      nodes:ordered(request.nodes).map(n=>[String(n.id),rank(request,n.id),NETWORK.has(n.kind)?'network':'endpoint']),
      edges:ordered(request.edges).map(e=>{const value=[String(e.id),String(e.source),String(e.target),e.source_port||'',e.target_port||''];if(gateways.groups.size)value.push(gateways.edgeIds.has(String(e.id)));return value;}),
      previous:request.interactive?ordered(request.nodes).map(n=>[n.id,request.previous?.[n.id]?.x,request.previous?.[n.id]?.y]):null});
  }
  function graph(request){
    const leaves=request.nodes.filter(n=>!NETWORK.has(n.kind)).length;
    const aspect=Math.max(.5,Math.min(4,(request.width||1200)/(request.height||800)));
    const gateways=virtualGateways(request),gatewaySplits=new Map();
    for(const members of gateways.groups.values()){
      const columns=Math.max(2,Math.min(4,Math.ceil(Math.sqrt(members.size*aspect))));
      for(const id of members)gatewaySplits.set(id,Math.ceil(members.size/columns));
    }
    // ELK distributes sibling layers; keep the number of sublayers responsive
    // to viewport shape without assigning any node positions ourselves.
    const split=leaves>8?Math.max(2,Math.min(12,Math.round(Math.sqrt(leaves*.65/aspect)))):1;
    const children=ordered(request.nodes).map(n=>{
      const child={id:String(n.id),width:260,height:128,ports:[],layoutOptions:{'elk.portConstraints':'FIXED_ORDER'}};
      const nodeSplit=gateways.groups.has(n.id)?1:gatewaySplits.get(n.id)??split;
      if(!NETWORK.has(n.kind)&&(split>1||gateways.groups.size))child.layoutOptions['elk.layered.layerUnzipping.layerSplit']=String(nodeSplit);
      const previous=request.previous?.[n.id];
      if(request.interactive&&!gateways.groups.size&&finite(previous)){child.x=previous.x-130;child.y=previous.y-54;}
      return child;
    });
    const nodes=new Map(children.map(n=>[n.id,n]));
    const reversed=new Set();
    function port(id,side,name,edgeId){
      const node=nodes.get(id);
      if(!node)throw new Error('ELK edge references a missing node');
      const portId=JSON.stringify([id,side,name?['port',String(name)]:['edge',String(edgeId)]]);
      if(!node.ports.some(p=>p.id===portId))node.ports.push({id:portId,width:4,height:4,layoutOptions:{'elk.port.side':side}});
      return portId;
    }
    const edges=ordered(request.edges).map(e=>{
      const source=String(e.source),target=String(e.target);
      const reverse=!gateways.edgeIds.has(String(e.id))&&(rank(request,source)>rank(request,target)||(rank(request,source)===rank(request,target)&&source.localeCompare(target,'en')>0));
      if(reverse)reversed.add(String(e.id));
      return {id:String(e.id),sources:[port(reverse?target:source,'SOUTH',reverse?e.target_port:e.source_port,e.id)],
        targets:[port(reverse?source:target,'NORTH',reverse?e.source_port:e.target_port,e.id)]};
    });
    for(const n of children){n.ports.sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));n.ports.forEach((p,i)=>p.layoutOptions['elk.port.index']=String(i));}
    const layoutOptions={'elk.algorithm':'layered','elk.direction':'DOWN','elk.edgeRouting':'ORTHOGONAL','elk.randomSeed':'1',
      'elk.spacing.nodeNode':'24','elk.spacing.edgeNode':'12','elk.spacing.edgeEdge':'8','elk.padding':'[top=16,left=16,bottom=16,right=16]',
      'elk.layered.spacing.nodeNodeBetweenLayers':'56','elk.layered.spacing.edgeNodeBetweenLayers':'12','elk.layered.spacing.edgeEdgeBetweenLayers':'8',
      'elk.layered.layerUnzipping.strategy':'ALTERNATING','elk.layered.compaction.postCompaction.strategy':'LEFT_RIGHT_CONSTRAINT_LOCKING',
      'elk.layered.nodePlacement.strategy':leaves>80?'LINEAR_SEGMENTS':'NETWORK_SIMPLEX','elk.layered.nodePlacement.favorStraightEdges':'false',
      'elk.layered.considerModelOrder.strategy':'NODES_AND_EDGES','elk.layered.mergeEdges':'false'};
    if(request.interactive&&!gateways.groups.size)Object.assign(layoutOptions,{'elk.layered.cycleBreaking.strategy':'INTERACTIVE',
      'elk.layered.layering.strategy':'INTERACTIVE','elk.layered.crossingMinimization.semiInteractive':'true','elk.separateConnectedComponents':'false'});
    const input={id:'root',layoutOptions,children,edges};
    if(gateways.groups.size){
      // A compound keeps these VM sublayers local instead of interleaving them
      // with unrelated hosts. All positions and routes are still produced by ELK.
      layoutOptions['elk.hierarchyHandling']='INCLUDE_CHILDREN';
      // ELK 0.12's model-order crossing comparator cannot handle compound ports.
      layoutOptions['elk.layered.considerModelOrder.strategy']='NONE';
      const claimed=new Set();
      for(const [gateway,members] of gateways.groups){
        const ids=new Set([gateway,...members]);
        if([...ids].some(id=>claimed.has(id)))continue;
        ids.forEach(id=>claimed.add(id));
        const portOwners=new Map(children.flatMap(n=>n.ports.map(p=>[p.id,n.id])));
        const internal=edge=>ids.has(portOwners.get(edge.sources[0]))&&ids.has(portOwners.get(edge.targets[0]));
        const compound={id:'ui:vm-gateway:'+gateway,layoutOptions:{...layoutOptions},
          children:input.children.filter(n=>ids.has(n.id)),edges:input.edges.filter(internal)};
        input.children=input.children.filter(n=>!ids.has(n.id)).concat(compound);
        input.edges=input.edges.filter(edge=>!internal(edge));
      }
    }
    return {input,reversed};
  }
  function result(output,reversed,duration){
    const positions={},routes={},edges=[];
    function flatten(container,x=0,y=0){
      for(const n of container.children||[]){
        if(!finite(n))throw new Error('ELK returned invalid node coordinates');
        if(n.children)flatten(n,x+n.x,y+n.y);
        else positions[n.id]={x:x+n.x+130,y:y+n.y+54};
      }
      for(const edge of container.edges||[])edges.push({edge,x,y});
    }
    flatten(output);
    for(const {edge:e,x,y} of edges){
      const sections=e.sections||[];
      const same=(a,b)=>finite(a)&&finite(b)&&a.x===b.x&&a.y===b.y;
      let section=sections.find(s=>!sections.some(other=>other!==s&&same(other.endPoint,s.startPoint)));
      const remainingSections=new Set(sections),path=[];
      while(section){
        if(!path.length)path.push(section.startPoint);
        path.push(...section.bendPoints||[],section.endPoint);remainingSections.delete(section);
        const next=[...remainingSections].filter(s=>same(section.endPoint,s.startPoint));
        if(next.length>1)throw new Error('ELK returned a branching edge route');
        section=next[0];
      }
      if(!sections.length||remainingSections.size)throw new Error('ELK returned a disconnected edge route');
      const points=path.map(p=>({x:p.x+x,y:p.y+y}));
      if(points.length<2||!points.every(finite))throw new Error('ELK returned invalid edge coordinates');
      if(reversed.has(e.id))points.reverse();
      let length=0;const lengths=[];
      for(let i=1;i<points.length;i++){const d=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);length+=d;lengths.push(d);}
      let remaining=length/2,label=points[0];
      for(let i=0;i<lengths.length;i++){if(remaining<=lengths[i]){const t=lengths[i]?remaining/lengths[i]:0;label={x:points[i].x+(points[i+1].x-points[i].x)*t,y:points[i].y+(points[i+1].y-points[i].y)*t};break;}remaining-=lengths[i];}
      routes[e.id]={points,label};
    }
    if(!Number.isFinite(output.width)||!Number.isFinite(output.height))throw new Error('ELK returned invalid bounds');
    return {positions,routes,width:output.width,height:output.height,duration_ms:duration,engine:'elkjs@0.12.0'};
  }
  function create(config={}){
    const host=config.root||globalThis,cache=new Map(),pending=new Map();
    let engine=null,worker=null,blobURL=null,running=false,queued=null;
    function dispose(){
      if(worker)worker.terminate();
      if(blobURL)host.URL.revokeObjectURL(blobURL);
      engine=null;worker=null;blobURL=null;
    }
    function getEngine(){
      if(engine)return engine;
      if(config.engineFactory){engine=config.engineFactory();return engine;}
      if(!host.ELK||!host.Worker||!host.PL_ELK_WORKER_SOURCE)throw new Error('ELK worker is unavailable');
      blobURL=host.URL.createObjectURL(new host.Blob([host.PL_ELK_WORKER_SOURCE],{type:'application/javascript'}));
      engine=new host.ELK({workerFactory:()=>{worker=new host.Worker(blobURL);return worker;}});
      return engine;
    }
    async function compute(request){
      const {input,reversed}=graph(request),start=Date.now();let timer;
      try{
        const output=await Promise.race([getEngine().layout(input),new Promise((_,reject)=>{timer=setTimeout(()=>{dispose();reject(new Error('ELK layout deadline exceeded'));},config.deadline||4000);})]);
        const value=result(output,reversed,Date.now()-start);
        if(Object.keys(value.positions).length!==request.nodes.length||Object.keys(value.routes).length!==request.edges.length)throw new Error('ELK returned an incomplete graph');
        value.key=key({...request,interactive:false});
        return value;
      }catch(error){dispose();throw error;}finally{clearTimeout(timer);}
    }
    function layout(request){
      const id=key(request);
      if(cache.has(id)){const value=cache.get(id);cache.delete(id);cache.set(id,value);return Promise.resolve(value);}
      if(pending.has(id))return pending.get(id);
      let resolve,reject;
      const work=new Promise((accept,decline)=>{resolve=accept;reject=decline;});
      const record={id,request,resolve,reject};
      pending.set(id,work);
      if(running){
        if(queued){
          const error=new Error('ELK layout superseded by a newer request');error.code='ELK_SUPERSEDED';
          pending.delete(queued.id);queued.reject(error);
        }
        queued=record;
      }else start(record);
      return work;
    }
    function start(record){
      running=true;
      compute(record.request).then(value=>{
        cache.set(record.id,value);while(cache.size>24)cache.delete(cache.keys().next().value);
        record.resolve(value);
      },error=>record.reject(error)).then(()=>{
        pending.delete(record.id);running=false;
        if(queued){const next=queued;queued=null;start(next);}
      });
    }
    return {layout,dispose,keyFor:request=>key({...request,interactive:false}),clear:()=>cache.clear()};
  }
  return {create,key,keyFor:request=>key({...request,interactive:false}),graph,result};
});
