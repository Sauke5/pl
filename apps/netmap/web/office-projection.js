/* Pure display projection. Never creates physical links or changes source data. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PLOfficeView = api;
})(globalThis, function() {
  'use strict';
  const collator=new Intl.Collator('en',{numeric:true});
  const compare = (a,b) => collator.compare(String(a),String(b));
  function isSummary(node) {
    if(isNetwork(node))return false;
    return node.id.startsWith('arp:') || Array.isArray(node.details?.arp) ||
      node.id.startsWith('segment:') && (node.details?.macs || []).length > 1;
  }
  function isNetwork(node) {
    if (['switch','router','firewall','hub'].includes(node.kind)) return true;
    const peer = node.details?.lldp || {};
    const capabilities = peer.remote_enabled_capabilities || peer.remote_capabilities || '';
    const explicitModel = [peer.remote_description,peer.remote_system_description,peer.remote_system_name].filter(Boolean).join(' ');
    return /\brouter\b/i.test(String(capabilities)) || (/\bbridge\b/i.test(String(capabilities)) && !/\btelephone\b/i.test(String(capabilities))) || /\b(?:HP\s+)?ProCurve\b[^\n]*\bSwitch\b/i.test(explicitModel);
  }
  const indexes=new WeakMap(), levelCache=new WeakMap(), wanContexts=new WeakMap();
  function isBackboneEdge(edge) { return ['physical','lag','tunnel','routed'].includes(edge.kind) || (edge.kind==='observed' && Boolean(edge.source_port && edge.target_port)); }
  function withWanContext(local, wan) {
    if(!wan || !Array.isArray(wan.nodes) || !Array.isArray(wan.edges))return local;
    let cache=wanContexts.get(local);if(cache?.has(wan))return cache.get(wan);
    if(!cache){cache=new WeakMap();wanContexts.set(local,cache);}
    const localNodes=new Map(local.nodes.map(node=>[node.id,node]));
    const stable=id=>/^device:\d+$/.test(id);
    const wanNodes=new Map(wan.nodes.filter(node=>isNetwork(node) || node.kind==='next_hop').map(node=>[node.id,node]));
    const anchors=new Set([...wanNodes.keys()].filter(id=>stable(id) && localNodes.has(id) && isNetwork(localNodes.get(id))));
    if(!anchors.size){cache.set(wan,local);return local;}
    const warnings=[];
    for(const id of wanNodes.keys())if(localNodes.has(id) && !anchors.has(id)){wanNodes.delete(id);warnings.push('wan_node_id_collision:'+id);}
    const adjacency=new Map([...wanNodes.keys()].map(id=>[id,[]]));
    const pair=edge=>JSON.stringify([edge.source,edge.target].sort(compare));
    const knownEdgeIds=new Map(local.edges.map(edge=>[edge.id,edge])), candidateIds=new Set(), candidateEdges=[];
    for(const edge of wan.edges)if(['physical','lag','observed','routed','tunnel'].includes(edge.kind) && wanNodes.has(edge.source) && wanNodes.has(edge.target)) {
      const existing=knownEdgeIds.get(edge.id);
      if(existing && pair(existing)!==pair(edge)){warnings.push('wan_edge_id_collision:'+edge.id);continue;}
      if(candidateIds.has(edge.id))continue;
      candidateIds.add(edge.id);knownEdgeIds.set(edge.id,existing || edge);candidateEdges.push(edge);
    }
    for(const edge of candidateEdges){adjacency.get(edge.source).push({id:edge.target,edge});adjacency.get(edge.target).push({id:edge.source,edge});}
    const kept=new Set(anchors), queue=[...anchors];
    for(let at=0;at<queue.length;at++)for(const link of adjacency.get(queue[at]))if(!kept.has(link.id)){kept.add(link.id);queue.push(link.id);}
    const terminals=new Set([...anchors,...[...kept].filter(id=>wanNodes.get(id).details?.wan_role==='hub')]);
    const neighbors=new Map([...kept].map(id=>[id,new Set(adjacency.get(id).filter(link=>kept.has(link.id)).map(link=>link.id))]));
    const leaves=[...kept].filter(id=>!terminals.has(id) && neighbors.get(id).size<=1);
    for(let at=0;at<leaves.length;at++) {
      const id=leaves[at];if(!kept.has(id))continue;kept.delete(id);
      for(const next of neighbors.get(id)){neighbors.get(next).delete(id);if(kept.has(next) && !terminals.has(next) && neighbors.get(next).size<=1)leaves.push(next);}
    }
    const addedNodes=[...kept].filter(id=>!localNodes.has(id)).map(id=>wanNodes.get(id));
    const nodes=local.nodes.map(node=> {
      if(!anchors.has(node.id))return node;
      const extra=wanNodes.get(node.id), supplemental={};
      for(const key of ['wan_role','tunnels','routes','routing_observed_at'])if(extra.details?.[key]!==undefined)supplemental[key]=extra.details[key];
      const tunnelNames=new Set((extra.details?.tunnels || []).map(tunnel=>tunnel.name));
      const ports=node.ports || [], names=new Set(ports.map(port=>port.name));
      const missing=(extra.ports || []).filter(port=>!names.has(port.name) && (/^Tunnel/i.test(port.name || '') || tunnelNames.has(port.name)));
      return {...node,details:{...supplemental,...node.details},ports:[...ports,...missing]};
    }).concat(addedNodes);
    const edges=[...local.edges], byEdgeId=new Map(edges.map(edge=>[edge.id,edge])), addedEdgeIds=[];
    for(const edge of candidateEdges)if(kept.has(edge.source) && kept.has(edge.target)) {
      const existing=byEdgeId.get(edge.id);
      if(existing){if(pair(existing)!==pair(edge))warnings.push('wan_edge_id_collision:'+edge.id);continue;}
      edges.push(edge);byEdgeId.set(edge.id,edge);addedEdgeIds.push(edge.id);
    }
    const graph={...local,nodes,edges,context_wan:{generated_at:wan.generated_at || null,observed_at:wan.observed_at || null,
      shared_node_ids:[...anchors],added_node_ids:addedNodes.map(node=>node.id),added_edge_ids:addedEdgeIds,warnings,exit_verified:false}};
    cache.set(wan,graph);return graph;
  }
  function index(raw) {
    if(indexes.has(raw))return indexes.get(raw);
    const byId = new Map(raw.nodes.map(n=>[n.id,n])), adjacency = new Map(raw.nodes.map(n=>[n.id,[]]));
    for (const edge of raw.edges) if (byId.has(edge.source) && byId.has(edge.target)) {
      adjacency.get(edge.source).push({id:edge.target,edge}); adjacency.get(edge.target).push({id:edge.source,edge});
    }
    const networks = raw.nodes.filter(isNetwork), networkIds = new Set(networks.map(n=>n.id));
    // Resolve summary components once. A shared FDB/ARP summary can contain
    // thousands of clients; grouping must not re-walk it for every client.
    const summaryOwners=new Map();
    for(const node of raw.nodes)if(isSummary(node) && !summaryOwners.has(node.id)) {
      const queue=[node.id], seen=new Set(queue);let owner=null;
      for(let at=0;at<queue.length;at++)for(const link of adjacency.get(queue[at]) || []) {
        if(networkIds.has(link.id)) {if(owner===null || compare(link.id,owner)<0)owner=link.id;}
        else if(isSummary(byId.get(link.id)) && !seen.has(link.id)){seen.add(link.id);queue.push(link.id);}
      }
      for(const id of queue)summaryOwners.set(id,owner);
    }
    function primaryOwner(id) {
      if(summaryOwners.has(id))return summaryOwners.get(id);
      let owner=null;
      for(const link of adjacency.get(id) || []) {
        const candidate=networkIds.has(link.id) ? link.id : summaryOwners.get(link.id);
        if(candidate!=null && (owner===null || compare(candidate,owner)<0))owner=candidate;
      }
      return owner;
    }
    // A client can reach a switch through a summary; never traverse other clients.
    function owners(id) {
      const seen = new Set([id]), queue=[id], found=new Set(), supporting=new Set();
      for(let at=0;at<queue.length;at++) for(const link of adjacency.get(queue[at]) || []) {
        if(networkIds.has(link.id)) found.add(link.id);
        else if(!seen.has(link.id) && isSummary(byId.get(link.id))) {seen.add(link.id); supporting.add(link.id); queue.push(link.id);}
      }
      return {owners:[...found].sort(compare), supporting};
    }
    const groups = new Map();
    function group(owner) {
      const key=owner || 'unassigned';
      if(!groups.has(key)) groups.set(key,{id:'ui:clients:'+key,owner:owner || null,members:[],summaries:[]});
      return groups.get(key);
    }
    for(const node of raw.nodes) {
      if(networkIds.has(node.id) || node.kind==='passive') continue;
      const target=group(primaryOwner(node.id));
      (isSummary(node)?target.summaries:target.members).push(node.id);
    }
    for(const item of groups.values()) {item.members.sort(compare);item.summaries.sort(compare);}
    const result={byId,adjacency,networks,networkIds,groups,owners};indexes.set(raw,result);return result;
  }
  // Connectivity context, not a packet-route calculation. Preserve source edges,
  // including alternate links; neither ARP summaries nor parent_id invent cables.
  function pathContext(raw, hitIds, options={}) {
    const ix=index(raw), nodeIds=new Set(), edgeIds=new Set(), backbone=new Set(ix.networkIds), seeds=[];
    for(const node of raw.nodes) if(node.kind==='next_hop') backbone.add(node.id);
    const arp=node=>isSummary(node) && (node.id.startsWith('arp:') || Array.isArray(node.details?.arp));
    const networkEdge=edge=>['physical','lag','observed','routed','tunnel'].includes(edge.kind);
    const infrastructure=new Set(backbone);
    for(const node of raw.nodes) {
      if(node.parent_id)infrastructure.add(node.parent_id);
      if(['vswitch','esxi'].includes(node.kind) || isSummary(node))infrastructure.add(node.id);
    }
    const hitSet=new Set();
    for(const id of hitIds || []) if(ix.byId.has(id))hitSet.add(id);
    const endpointHits=[...hitSet].filter(id=>!infrastructure.has(id)).sort(compare);
    const maxEndpoints=Number.isFinite(options.maxEndpoints) ? Math.max(0,Math.floor(options.maxEndpoints)) : Infinity;
    const omitted=new Set(endpointHits.slice(maxEndpoints));
    for(const id of hitSet)seeds.push(id);
    const counts={totalHitCount:hitSet.size,shownHitCount:hitSet.size-omitted.size,omittedHitCount:omitted.size,limitApplied:omitted.size>0};
    const ancestors=new Set();
    for(const id of seeds) {
      let node=ix.byId.get(id);const seen=new Set();
      while(node?.parent_id && ix.byId.has(node.parent_id) && !seen.has(node.parent_id)) {
        seen.add(node.parent_id);if(ancestors.has(node.parent_id))break;ancestors.add(node.parent_id);node=ix.byId.get(node.parent_id);
      }
    }
    const queue=[...seeds], visited=new Set(), attachmentIds=new Set();
    for(let at=0;at<queue.length;at++) {
      const id=queue[at];if(visited.has(id))continue;visited.add(id);
      const node=ix.byId.get(id);if(!arp(node) && !omitted.has(id))nodeIds.add(id);
      if(backbone.has(id)){attachmentIds.add(id);continue;}
      if(node.parent_id && ancestors.has(node.parent_id)) queue.push(node.parent_id);
      for(const link of ix.adjacency.get(id) || []) {
        const next=ix.byId.get(link.id);if(arp(next))continue;
        const virtual=link.edge.kind==='virtual' && ((node.kind==='vm' && ['vswitch','esxi'].includes(next.kind)) || (node.kind==='vswitch' && next.kind==='esxi') || ancestors.has(next.id));
        // The collector validates the gateway's UUID, vNIC and backing. Follow
        // only its declared downstream-to-gateway direction, never sibling VMs.
        const virtualGateway=link.edge.kind==='routed' && node.kind==='vm' && next.kind==='vm' &&
          link.edge.target===node.id && link.edge.source===next.id &&
          next.id==='vm:'+link.edge.details?.virtual_gateway?.vm_uuid &&
          Boolean(node.parent_id) && node.parent_id===next.parent_id;
        if((backbone.has(next.id) && networkEdge(link.edge)) || (!arp(node) && isSummary(next) && networkEdge(link.edge)) || virtual || virtualGateway || (isSummary(node) && networkEdge(link.edge) && backbone.has(next.id))) {
          // ARP is metadata only; it may identify an owner but contributes no edge.
          if(!arp(node) && !omitted.has(id) && !omitted.has(link.id))edgeIds.add(link.edge.id);
          queue.push(next.id);
        }
      }
    }
    const networkQueue=[...attachmentIds], networkSeen=new Set();
    for(let at=0;at<networkQueue.length;at++) {
      const id=networkQueue[at];if(networkSeen.has(id))continue;networkSeen.add(id);nodeIds.add(id);
      for(const link of ix.adjacency.get(id) || []) if(backbone.has(link.id) && networkEdge(link.edge)) {
        edgeIds.add(link.edge.id);networkQueue.push(link.id);
      }
    }
    const gatewayIds=new Set([...networkSeen].filter(id=>['router','firewall'].includes(ix.byId.get(id).kind)));
    // Peel unrelated dead-end switch branches only in components with a known
    // gateway. Parallel links use one neighbour for degree, but keep every
    // original edge when retained. Cycles remain known alternative connectivity;
    // this deliberately does not claim a computed forwarding route.
    const networkNeighbors=new Map();
    for(const id of networkSeen)networkNeighbors.set(id,new Set((ix.adjacency.get(id) || []).filter(link=>networkSeen.has(link.id) && networkEdge(link.edge)).map(link=>link.id)));
    const gatewayReachable=new Set(gatewayIds), gatewayQueue=[...gatewayIds];
    for(let at=0;at<gatewayQueue.length;at++)for(const next of networkNeighbors.get(gatewayQueue[at]) || [])if(!gatewayReachable.has(next)){gatewayReachable.add(next);gatewayQueue.push(next);}
    const terminals=new Set([...attachmentIds,...gatewayIds]), pruneQueue=[];
    for(const id of gatewayReachable)if(!terminals.has(id) && networkNeighbors.get(id).size<=1)pruneQueue.push(id);
    let prunedNetworkCount=0;
    for(let at=0;at<pruneQueue.length;at++) {
      const id=pruneQueue[at];if(!networkSeen.has(id))continue;
      networkSeen.delete(id);nodeIds.delete(id);prunedNetworkCount++;
      for(const link of ix.adjacency.get(id) || [])if(backbone.has(link.id))edgeIds.delete(link.edge.id);
      for(const next of networkNeighbors.get(id)) {
        networkNeighbors.get(next).delete(id);
        if(networkSeen.has(next) && !terminals.has(next) && networkNeighbors.get(next).size<=1)pruneQueue.push(next);
      }
    }
    const defaultRoutes=[];
    for(const id of gatewayIds) {
      const details=ix.byId.get(id).details || {};
      for(const route of details.routes || []) if(['0.0.0.0/0','::/0','default'].includes(route.prefix || route.destination) && route.active!==false) {
        defaultRoutes.push({nodeId:id,nextHop:route.next_hop || null,interface:route.interface || null,observedAt:details.routing_observed_at || null,stale:Boolean(route.stale || details.stale)});
      }
    }
    const connected=new Set(attachmentIds), connectedQueue=[...attachmentIds], parentChildren=new Map();
    for(const id of nodeIds) {
      const parent=ix.byId.get(id).parent_id;
      if(parent && nodeIds.has(parent)) {if(!parentChildren.has(parent))parentChildren.set(parent,[]);parentChildren.get(parent).push(id);}
    }
    for(let at=0;at<connectedQueue.length;at++) {
      const id=connectedQueue[at], parent=ix.byId.get(id).parent_id;
      const neighbors=(ix.adjacency.get(id) || []).filter(link=>edgeIds.has(link.edge.id)).map(link=>link.id);
      if(parent && nodeIds.has(parent))neighbors.push(parent);
      neighbors.push(...(parentChildren.get(id) || []));
      for(const next of neighbors)if(!connected.has(next)){connected.add(next);connectedQueue.push(next);}
    }
    const unresolvedHitIds=new Set(seeds.filter(id=>!omitted.has(id) && !connected.has(id)));
    // Current graph schema has no verified external-exit/forwarding-path claim.
    // Even a collected default route describes configured forwarding, not exit health.
    return {nodeIds,edgeIds,attachmentIds,gatewayIds,defaultRoutes,unresolvedHitIds,prunedNetworkCount,...counts,
      status:nodeIds.size ? 'incomplete' : 'unresolved',reason:gatewayIds.size ? 'exit_not_verified' : attachmentIds.size ? 'gateway_not_observed' : 'attachment_not_observed',
      semantics:'known_connectivity',exitVerified:false};
  }
  function project(raw, options={}) {
    const ix=index(raw), visible=new Set(), expanded=options.expanded || new Set();
    let mode='overview', context=null;
    if(options.focusId && ix.byId.has(options.focusId)) {
      mode='local'; visible.add(options.focusId);
      for(const link of ix.adjacency.get(options.focusId) || []) {
        visible.add(link.id);
        if (isSummary(ix.byId.get(link.id))) for (const endpoint of ix.adjacency.get(link.id) || []) {
          if (!ix.networkIds.has(endpoint.id)) visible.add(endpoint.id);
        }
      }
    } else if(options.hits) {
      mode='search';
      context=pathContext(raw,options.hits,options);
      context.nodeIds.forEach(id=>visible.add(id));
    } else {
      ix.networks.forEach(n=>visible.add(n.id));
      for(const group of ix.groups.values()) if(expanded.has(group.id)) {
        for(const id of [...group.members,...group.summaries]) {
          visible.add(id);
          ix.owners(id).supporting.forEach(support=>visible.add(support));
        }
      }
    }
    for (const id of [...visible]) if (isSummary(ix.byId.get(id)) && (id.startsWith('arp:') || Array.isArray(ix.byId.get(id)?.details?.arp))) visible.delete(id);
    const nodes=raw.nodes.filter(n=>visible.has(n.id)).map(n=>isSummary(n) ? {...n,kind:'observation_group',name:`Порт ${n.details?.switch_port || '—'} · ${(n.details?.macs || []).length} MAC`} : n), edges=raw.edges.filter(e=>visible.has(e.source)&&visible.has(e.target)&&(!context||context.edgeIds.has(e.id))&&(mode!=='overview'||options.showAllLinks||!ix.networkIds.has(e.source)||!ix.networkIds.has(e.target)||isBackboneEdge(e)));
    if(mode==='overview') for(const group of ix.groups.values()) {
      if(expanded.has(group.id) || options.compactGroups) continue;
      if(!group.members.length && !group.summaries.some(id=>!id.startsWith('arp:') && !Array.isArray(ix.byId.get(id)?.details?.arp)))continue;
      const node={id:group.id,name:group.members.length ? `Подключения · ${group.members.length}` : `Наблюдения · ${group.summaries.length}`,
        kind:'client_group',status:'unknown',ports:[],details:{},_officeGroup:group,
        subtitle:group.owner ? ix.byId.get(group.owner)?.name : 'Без привязки к коммутатору'};
      nodes.push(node);
      if(group.owner) edges.push({id:'ui:group-edge:'+group.id,source:group.owner,target:group.id,source_port:'',target_port:'',kind:'aggregation',confidence:'',status:'',evidence:[],_officeGroup:group});
    }
    if(options.compactGroups) for(let i=0;i<nodes.length;i++) { const group=ix.groups.get(nodes[i].id); if(group)nodes[i]={...nodes[i],_officeConnections:{members:group.members.length,summaries:group.summaries.length}}; }
    return {nodes,edges,groups:ix.groups,mode,index:ix,context,
      totalHitCount:context?.totalHitCount || 0,shownHitCount:context?.shownHitCount || 0,
      omittedHitCount:context?.omittedHitCount || 0,limitApplied:context?.limitApplied || false};
  }
  function networkLevels(raw) {
    if(levelCache.has(raw))return levelCache.get(raw);
    const ix=index(raw), parents=new Map(ix.networks.map(n=>[n.id,n.id]));
    function leader(id) {while(parents.get(id)!==id) id=parents.get(id);return id;}
    const tree=new Map(ix.networks.map(n=>[n.id,[]]));
    const physicalDegree=new Map(ix.networks.map(n=>[n.id,0]));
    for(const e of raw.edges)if(['physical','lag'].includes(e.kind)&&ix.networkIds.has(e.source)&&ix.networkIds.has(e.target)){physicalDegree.set(e.source,physicalDegree.get(e.source)+1);physicalDegree.set(e.target,physicalDegree.get(e.target)+1);}
    const proximity=e=>(physicalDegree.get(e.source)||0)+(physicalDegree.get(e.target)||0);
    const links=raw.edges.filter(e=>ix.networkIds.has(e.source)&&ix.networkIds.has(e.target)&&isBackboneEdge(e)).sort((a,b)=>Number(['physical','lag'].includes(b.kind))-Number(['physical','lag'].includes(a.kind))||proximity(b)-proximity(a)||compare(a.id,b.id));
    for(const edge of links) {
      const a=leader(edge.source),b=leader(edge.target);if(a===b)continue;
      parents.set(a,b);tree.get(edge.source).push(edge.target);tree.get(edge.target).push(edge.source);
    }
    const roots=[...ix.networks].sort((a,b)=>Number(Boolean(b._layoutRoot))-Number(Boolean(a._layoutRoot))||Number(b.details?.wan_role==='hub')-Number(a.details?.wan_role==='hub')||Number(['firewall','router'].includes(b.kind))-Number(['firewall','router'].includes(a.kind))||(tree.get(b.id).length-tree.get(a.id).length)||compare(a.id,b.id));
    const levels=new Map();
    for(const root of roots) if(!levels.has(root.id)) {
      levels.set(root.id,0);const queue=[root.id];
      while(queue.length) {const id=queue.shift();for(const next of tree.get(id).sort(compare))if(!levels.has(next)){levels.set(next,levels.get(id)+1);queue.push(next);}}
    }
    levelCache.set(raw,levels);return levels;
  }
  return {isSummary,isNetwork,index,withWanContext,pathContext,project,networkLevels};
});
