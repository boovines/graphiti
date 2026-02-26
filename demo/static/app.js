// Graphiti Demo — Frontend Logic

// --- State ---
let network = null;
let graphData = { nodes: [], edges: [], communities: [] };
let highlightedNodeUuids = new Set();

// --- Community color palette ---
const COMMUNITY_COLORS = [
  '#7EB3D4', '#E8A87C', '#85C7A2', '#C89EC4',
  '#D4A574', '#7FC4C4', '#D49090', '#A0B87E',
  '#B8A0D4', '#D4C47E',
];

function getCommunityColor(communityUuid) {
  if (!communityUuid) return '#111';
  const idx = Math.abs(hashCode(communityUuid)) % COMMUNITY_COLORS.length;
  return COMMUNITY_COLORS[idx];
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// --- Upload ---

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const docList = document.getElementById('docList');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length > 0) uploadFiles(files);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) uploadFiles(fileInput.files);
});

async function uploadFiles(files) {
  for (const file of files) {
    await uploadFile(file);
  }
}

async function uploadFile(file) {
  setUploadStatus('loading', `Processing ${file.name}...`);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || 'Upload failed');
    }
    const data = await resp.json();
    setUploadStatus(
      'success',
      `${data.filename}: ${data.num_chunks} chunks, ${data.num_entities} entities, ${data.num_facts} facts, ${data.num_communities} communities`
    );
    await refreshDocuments();
    await refreshGraph();
  } catch (err) {
    setUploadStatus('error', `Error: ${err.message}`);
  }
}

function setUploadStatus(type, message) {
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.textContent = message;
}

async function refreshDocuments() {
  try {
    const resp = await fetch('/api/documents');
    const docs = await resp.json();
    docList.innerHTML = '';
    for (const doc of docs) {
      const item = document.createElement('div');
      item.className = 'doc-item';
      item.innerHTML = `
        <span class="doc-item-name" title="${doc.group_id}">${doc.group_id.replace('doc-', '')}</span>
        <span class="doc-item-meta">${doc.episode_count} chunks</span>
      `;
      docList.appendChild(item);
    }
  } catch (err) {
    console.error('Failed to refresh documents:', err);
  }
}

// --- Chat ---

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

chatSendBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  const query = chatInput.value.trim();
  if (!query) return;

  chatInput.value = '';
  addChatMessage('user', query);

  const thinkingEl = addThinkingIndicator();

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    thinkingEl.remove();

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || 'Chat failed');
    }

    const data = await resp.json();
    addChatMessage('assistant', data.answer, data.sources);

    // Highlight search results in graph
    highlightSearchResults(data.sources);
  } catch (err) {
    thinkingEl.remove();
    addChatMessage('assistant', `Error: ${err.message}`);
  }
}

function addChatMessage(role, text, sources) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message message-${role}`;

  let html = `<div class="message-bubble">${escapeHtml(text)}</div>`;

  if (sources && role === 'assistant') {
    html += buildSourcesHtml(sources);
  }

  msgDiv.innerHTML = html;
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Add toggle listeners
  const toggle = msgDiv.querySelector('.sources-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const content = toggle.nextElementSibling;
      content.classList.toggle('open');
      const arrow = toggle.querySelector('.arrow');
      arrow.textContent = content.classList.contains('open') ? '\u25BE' : '\u25B8';
    });
  }
}

function buildSourcesHtml(sources) {
  const factCount = sources.facts?.length || 0;
  const entityCount = sources.entities?.length || 0;
  const communityCount = sources.communities?.length || 0;
  const total = factCount + entityCount + communityCount;

  if (total === 0) return '';

  let html = `<div class="message-sources">`;
  html += `<div class="sources-toggle"><span class="arrow">\u25B8</span> ${total} sources from knowledge graph</div>`;
  html += `<div class="sources-content">`;

  if (factCount > 0) {
    html += `<div class="sources-section">`;
    html += `<div class="sources-section-title">Facts (${factCount})</div>`;
    for (const fact of sources.facts) {
      let temporal = '';
      if (fact.valid_at) temporal += `valid: ${fact.valid_at.split('T')[0]}`;
      if (fact.invalid_at) temporal += ` invalid: ${fact.invalid_at.split('T')[0]}`;
      html += `<div class="source-item">
        <strong>${escapeHtml(fact.name)}</strong>: ${escapeHtml(fact.fact)}
        ${temporal ? `<br><span class="temporal">${temporal}</span>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  if (entityCount > 0) {
    html += `<div class="sources-section">`;
    html += `<div class="sources-section-title">Entities (${entityCount})</div>`;
    for (const entity of sources.entities) {
      html += `<div class="source-item">
        <strong>${escapeHtml(entity.name)}</strong>${entity.summary ? ': ' + escapeHtml(entity.summary) : ''}
      </div>`;
    }
    html += `</div>`;
  }

  if (communityCount > 0) {
    html += `<div class="sources-section">`;
    html += `<div class="sources-section-title">Communities (${communityCount})</div>`;
    for (const comm of sources.communities) {
      html += `<div class="source-item">
        <strong>${escapeHtml(comm.name)}</strong>${comm.summary ? ': ' + escapeHtml(comm.summary) : ''}
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div></div>`;
  return html;
}

function addThinkingIndicator() {
  const el = document.createElement('div');
  el.className = 'thinking-indicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return el;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// --- Graph Visualization ---

const graphContainer = document.getElementById('graphContainer');
const graphCanvas = document.getElementById('graphCanvas');
const graphEmpty = document.getElementById('graphEmpty');
const graphLegend = document.getElementById('graphLegend');
const nodeDetail = document.getElementById('nodeDetail');
const nodeDetailName = document.getElementById('nodeDetailName');
const nodeDetailLabels = document.getElementById('nodeDetailLabels');
const nodeDetailSummary = document.getElementById('nodeDetailSummary');

async function refreshGraph() {
  try {
    const resp = await fetch('/api/graph');
    graphData = await resp.json();
    renderGraph();
  } catch (err) {
    console.error('Failed to refresh graph:', err);
  }
}

function renderGraph() {
  if (graphData.nodes.length === 0) {
    graphEmpty.style.display = 'flex';
    graphCanvas.style.display = 'none';
    graphLegend.style.display = 'none';
    return;
  }

  graphEmpty.style.display = 'none';
  graphCanvas.style.display = 'block';
  graphLegend.style.display = 'block';

  // Count connections per node
  const connectionCount = {};
  for (const edge of graphData.edges) {
    connectionCount[edge.source] = (connectionCount[edge.source] || 0) + 1;
    connectionCount[edge.target] = (connectionCount[edge.target] || 0) + 1;
  }

  const visNodes = graphData.nodes.map((n) => {
    const isCommunity = n.type === 'community';
    const isHighlighted = highlightedNodeUuids.has(n.uuid);
    const connections = connectionCount[n.uuid] || 1;
    const baseSize = isCommunity ? 20 : Math.min(8 + connections * 3, 25);

    let color, borderColor, borderWidth;
    if (isHighlighted) {
      color = '#f59e0b';
      borderColor = '#d97706';
      borderWidth = 3;
    } else if (isCommunity) {
      color = '#7EB3D4';
      borderColor = '#5a96bc';
      borderWidth = 2;
    } else {
      color = getCommunityColor(n.community_uuid);
      borderColor = color === '#111' ? '#333' : color;
      borderWidth = 1;
    }

    return {
      id: n.uuid,
      label: n.name.length > 20 ? n.name.substring(0, 18) + '...' : n.name,
      title: n.name,
      size: baseSize,
      color: {
        background: color,
        border: borderColor,
        highlight: { background: '#f59e0b', border: '#d97706' },
      },
      borderWidth: borderWidth,
      font: {
        size: isCommunity ? 12 : 10,
        color: isHighlighted ? '#92400e' : '#333',
        face: isCommunity ? 'Playfair Display, serif' : 'Inter, sans-serif',
      },
      shape: isCommunity ? 'diamond' : 'dot',
      _data: n,
    };
  });

  const visEdges = graphData.edges
    .filter((e) => e.name !== 'HAS_MEMBER')
    .map((e) => ({
      from: e.source,
      to: e.target,
      label: e.name.length > 15 ? e.name.substring(0, 13) + '...' : e.name,
      title: e.fact || e.name,
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      color: { color: '#d4d4d4', highlight: '#f59e0b' },
      font: { size: 8, color: '#a3a3a3', face: 'Inter, sans-serif', strokeWidth: 2, strokeColor: '#fff' },
      smooth: { type: 'continuous' },
      width: 1,
    }));

  const data = {
    nodes: new vis.DataSet(visNodes),
    edges: new vis.DataSet(visEdges),
  };

  const options = {
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -30,
        centralGravity: 0.005,
        springLength: 120,
        springConstant: 0.04,
        damping: 0.4,
      },
      stabilization: { iterations: 150 },
    },
    interaction: {
      hover: true,
      tooltipDelay: 200,
    },
    layout: {
      improvedLayout: true,
    },
  };

  if (network) {
    network.destroy();
  }

  network = new vis.Network(graphCanvas, data, options);

  network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const nodeData = graphData.nodes.find((n) => n.uuid === nodeId);
      if (nodeData) showNodeDetail(nodeData);
    } else {
      hideNodeDetail();
    }
  });
}

function showNodeDetail(node) {
  nodeDetailName.textContent = node.name;
  nodeDetailLabels.innerHTML = '';
  for (const label of node.labels || []) {
    const tag = document.createElement('span');
    tag.className = `label-tag${label === 'Community' ? ' community' : ''}`;
    tag.textContent = label;
    nodeDetailLabels.appendChild(tag);
  }
  nodeDetailSummary.textContent = node.summary || 'No summary available';
  nodeDetail.classList.add('visible');
}

function hideNodeDetail() {
  nodeDetail.classList.remove('visible');
}

function highlightSearchResults(sources) {
  highlightedNodeUuids.clear();

  if (sources.entities) {
    for (const e of sources.entities) {
      highlightedNodeUuids.add(e.uuid);
    }
  }
  if (sources.facts) {
    for (const f of sources.facts) {
      if (f.source_node_uuid) highlightedNodeUuids.add(f.source_node_uuid);
      if (f.target_node_uuid) highlightedNodeUuids.add(f.target_node_uuid);
    }
  }
  if (sources.communities) {
    for (const c of sources.communities) {
      highlightedNodeUuids.add(c.uuid);
    }
  }

  renderGraph();
}

// --- Clear Graph ---

document.getElementById('clearGraphBtn').addEventListener('click', async () => {
  if (!confirm('Clear all data from the knowledge graph?')) return;

  try {
    await fetch('/api/graph', { method: 'DELETE' });
    graphData = { nodes: [], edges: [], communities: [] };
    highlightedNodeUuids.clear();
    renderGraph();
    docList.innerHTML = '';
    uploadStatus.className = 'upload-status';
    chatMessages.innerHTML = `
      <div class="message message-assistant">
        <div class="message-bubble">
          Graph cleared. Upload a document to get started.
        </div>
      </div>
    `;
  } catch (err) {
    console.error('Failed to clear graph:', err);
  }
});

// --- Init ---

refreshDocuments();
refreshGraph();
