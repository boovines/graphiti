"""
Graphiti Demo Web App

A self-contained demo showcasing Graphiti's knowledge graph capabilities:
document upload with chunking, hybrid search, temporal awareness,
entity deduplication, community detection, and graph visualization.

Usage:
    cd demo && docker-compose up -d  # start Neo4j
    export OPENAI_API_KEY=sk-...
    uvicorn app:app --reload
    # Open http://localhost:8000
"""

import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / '.env')

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel

from graphiti_core import Graphiti
from graphiti_core.edges import EntityEdge
from graphiti_core.nodes import CommunityNode, EntityNode, EpisodeType, EpisodicNode
from graphiti_core.search.search_config_recipes import COMBINED_HYBRID_SEARCH_RRF
from graphiti_core.utils.bulk_utils import RawEpisode

logger = logging.getLogger(__name__)

NEO4J_URI = os.getenv('NEO4J_URI', 'bolt://localhost:7687')
NEO4J_USER = os.getenv('NEO4J_USER', 'neo4j')
NEO4J_PASSWORD = os.getenv('NEO4J_PASSWORD', 'graphiti-demo')

graphiti: Graphiti | None = None
openai_client: AsyncOpenAI | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global graphiti, openai_client
    graphiti = Graphiti(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)
    await graphiti.build_indices_and_constraints()
    openai_client = AsyncOpenAI()
    logger.info('Graphiti initialized, connected to Neo4j at %s', NEO4J_URI)
    yield
    if graphiti:
        await graphiti.close()


logging.basicConfig(level=logging.INFO)

app = FastAPI(title='Graphiti Demo', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=Path(__file__).parent / 'static'), name='static')


# --- Text chunking ---

MAX_CHUNK_CHARS = 3000
MIN_CHUNK_CHARS = 200


def chunk_text(text: str) -> list[str]:
    """Split text into chunks by paragraphs, splitting large paragraphs on sentences."""
    paragraphs = re.split(r'\n\s*\n', text.strip())
    chunks: list[str] = []
    current_chunk = ''

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(current_chunk) + len(para) + 2 <= MAX_CHUNK_CHARS:
            current_chunk = (current_chunk + '\n\n' + para).strip()
        else:
            if current_chunk:
                chunks.append(current_chunk)
            if len(para) > MAX_CHUNK_CHARS:
                sentences = re.split(r'(?<=[.!?])\s+', para)
                current_chunk = ''
                for sentence in sentences:
                    if len(current_chunk) + len(sentence) + 1 <= MAX_CHUNK_CHARS:
                        current_chunk = (current_chunk + ' ' + sentence).strip()
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)
                        current_chunk = sentence
            else:
                current_chunk = para

    if current_chunk and len(current_chunk) >= MIN_CHUNK_CHARS:
        chunks.append(current_chunk)
    elif current_chunk and chunks:
        chunks[-1] = chunks[-1] + '\n\n' + current_chunk
    elif current_chunk:
        chunks.append(current_chunk)

    return chunks


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from PDF bytes using pdfplumber."""
    import io

    import pdfplumber

    text_parts = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                text_parts.append(page_text)
    return '\n\n'.join(text_parts)


# --- API Models ---


class ChatRequest(BaseModel):
    query: str
    group_ids: list[str] | None = None


class ChatResponse(BaseModel):
    answer: str
    sources: dict


# --- Routes ---


@app.get('/')
async def index():
    return FileResponse(Path(__file__).parent / 'static' / 'index.html')


@app.post('/api/upload')
async def upload_document(file: UploadFile):
    """Upload a document, chunk it, and ingest into the knowledge graph."""
    if not graphiti:
        raise HTTPException(status_code=503, detail='Graphiti not initialized')

    try:
        filename = file.filename or 'unknown'
        content_bytes = await file.read()

        if filename.lower().endswith('.pdf'):
            text = extract_text_from_pdf(content_bytes)
        else:
            text = content_bytes.decode('utf-8', errors='replace')

        if not text.strip():
            raise HTTPException(status_code=400, detail='Document is empty')

        chunks = chunk_text(text)
        if not chunks:
            raise HTTPException(status_code=400, detail='No content to ingest')

        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', filename)
        group_id = f'doc-{safe_name}'
        now = datetime.now(timezone.utc)

        raw_episodes = [
            RawEpisode(
                name=f'{filename} — chunk {i + 1}',
                content=chunk,
                source_description=f'Document: {filename}',
                source=EpisodeType.text,
                reference_time=now,
            )
            for i, chunk in enumerate(chunks)
        ]

        logger.info(f'Ingesting {len(raw_episodes)} chunks from {filename}...')

        result = await graphiti.add_episode_bulk(
            bulk_episodes=raw_episodes,
            group_id=group_id,
        )

        logger.info(f'Ingestion complete. Building communities...')

        # Build communities after ingestion
        await graphiti.build_communities(group_ids=[group_id])

        return {
            'filename': filename,
            'group_id': group_id,
            'num_chunks': len(chunks),
            'num_entities': len(result.nodes),
            'num_facts': len(result.edges),
            'num_communities': len(result.communities),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception('Upload failed')
        raise HTTPException(status_code=500, detail=str(e))


@app.post('/api/chat')
async def chat(request: ChatRequest):
    """Search the knowledge graph and synthesize an answer."""
    if not graphiti or not openai_client:
        raise HTTPException(status_code=503, detail='Service not initialized')

    try:
        results = await graphiti.search_(
            query=request.query,
            config=COMBINED_HYBRID_SEARCH_RRF,
            group_ids=request.group_ids,
        )

        # Format context from search results
        context_parts = []

        if results.edges:
            facts = []
            for edge in results.edges:
                fact_str = f'- {edge.fact}'
                if edge.valid_at:
                    fact_str += f' (valid from: {edge.valid_at.strftime("%Y-%m-%d")})'
                if edge.invalid_at:
                    fact_str += f' (invalid after: {edge.invalid_at.strftime("%Y-%m-%d")})'
                facts.append(fact_str)
            context_parts.append(
                'FACTS (relationships in the knowledge graph):\n' + '\n'.join(facts)
            )

        if results.nodes:
            entities = [
                f'- {node.name}: {node.summary}' for node in results.nodes if node.summary
            ]
            if entities:
                context_parts.append('ENTITIES:\n' + '\n'.join(entities))

        if results.communities:
            communities = [
                f'- {comm.name}: {comm.summary}'
                for comm in results.communities
                if comm.summary
            ]
            if communities:
                context_parts.append('KNOWLEDGE COMMUNITIES:\n' + '\n'.join(communities))

        context = '\n\n'.join(context_parts) if context_parts else 'No relevant information found.'

        # Synthesize answer with LLM
        completion = await openai_client.chat.completions.create(
            model=os.getenv('OPENAI_MODEL', 'gpt-4.1-mini'),
            messages=[
                {
                    'role': 'system',
                    'content': (
                        'You are a helpful assistant that answers questions based on information '
                        'from a knowledge graph. Use the provided context to answer the question. '
                        'If the context does not contain enough information, say so. '
                        'Reference specific facts and entities when possible.'
                    ),
                },
                {
                    'role': 'user',
                    'content': f'Context from knowledge graph:\n\n{context}\n\nQuestion: {request.query}',
                },
            ],
            temperature=0.3,
        )

        answer = completion.choices[0].message.content or 'No answer generated.'

        # Build sources response
        sources = {
            'facts': [
                {
                    'uuid': e.uuid,
                    'name': e.name,
                    'fact': e.fact,
                    'source_node_uuid': e.source_node_uuid,
                    'target_node_uuid': e.target_node_uuid,
                    'valid_at': e.valid_at.isoformat() if e.valid_at else None,
                    'invalid_at': e.invalid_at.isoformat() if e.invalid_at else None,
                }
                for e in results.edges
            ],
            'entities': [
                {
                    'uuid': n.uuid,
                    'name': n.name,
                    'summary': n.summary,
                    'labels': n.labels,
                }
                for n in results.nodes
            ],
            'communities': [
                {
                    'uuid': c.uuid,
                    'name': c.name,
                    'summary': c.summary,
                }
                for c in results.communities
            ],
        }

        return {'answer': answer, 'sources': sources}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception('Chat failed')
        raise HTTPException(status_code=500, detail=str(e))


@app.get('/api/graph')
async def get_graph(group_id: str | None = None):
    """Get all nodes and edges for graph visualization."""
    if not graphiti:
        raise HTTPException(status_code=503, detail='Graphiti not initialized')

    group_ids = [group_id] if group_id else None

    if not group_ids:
        # Get all group_ids from episodes
        docs = await _get_document_groups()
        group_ids = [d['group_id'] for d in docs]

    if not group_ids:
        return {'nodes': [], 'edges': [], 'communities': []}

    nodes = await EntityNode.get_by_group_ids(graphiti.driver, group_ids)
    edges = await EntityEdge.get_by_group_ids(graphiti.driver, group_ids)
    communities = await CommunityNode.get_by_group_ids(graphiti.driver, group_ids)

    # Build community membership map
    from graphiti_core.edges import CommunityEdge

    community_edges = await CommunityEdge.get_by_group_ids(graphiti.driver, group_ids)
    node_community_map: dict[str, str] = {}
    for ce in community_edges:
        node_community_map[ce.target_node_uuid] = ce.source_node_uuid

    vis_nodes = [
        {
            'uuid': n.uuid,
            'name': n.name,
            'summary': n.summary,
            'labels': n.labels,
            'community_uuid': node_community_map.get(n.uuid),
            'type': 'entity',
        }
        for n in nodes
    ]

    for c in communities:
        vis_nodes.append(
            {
                'uuid': c.uuid,
                'name': c.name,
                'summary': c.summary,
                'labels': ['Community'],
                'community_uuid': None,
                'type': 'community',
            }
        )

    vis_edges = [
        {
            'uuid': e.uuid,
            'source': e.source_node_uuid,
            'target': e.target_node_uuid,
            'name': e.name,
            'fact': e.fact,
            'valid_at': e.valid_at.isoformat() if e.valid_at else None,
            'invalid_at': e.invalid_at.isoformat() if e.invalid_at else None,
        }
        for e in edges
    ]

    # Add community membership edges
    for ce in community_edges:
        vis_edges.append(
            {
                'uuid': ce.uuid,
                'source': ce.source_node_uuid,
                'target': ce.target_node_uuid,
                'name': 'HAS_MEMBER',
                'fact': '',
                'valid_at': None,
                'invalid_at': None,
            }
        )

    return {
        'nodes': vis_nodes,
        'edges': vis_edges,
        'communities': [
            {'uuid': c.uuid, 'name': c.name, 'summary': c.summary} for c in communities
        ],
    }


async def _get_document_groups() -> list[dict]:
    """Get all document group_ids with episode counts."""
    if not graphiti:
        return []

    # Query for distinct group_ids and counts
    query = """
    MATCH (e:Episodic)
    RETURN e.group_id AS group_id, count(e) AS episode_count
    ORDER BY group_id
    """
    records, _, _ = await graphiti.driver.execute_query(query)

    return [
        {'group_id': r['group_id'], 'episode_count': r['episode_count']}
        for r in records
        if r['group_id']
    ]


@app.get('/api/documents')
async def list_documents():
    """List all ingested documents with their group_ids and episode counts."""
    if not graphiti:
        raise HTTPException(status_code=503, detail='Graphiti not initialized')
    return await _get_document_groups()


@app.delete('/api/graph')
async def clear_graph():
    """Clear all data from the graph."""
    if not graphiti:
        raise HTTPException(status_code=503, detail='Graphiti not initialized')

    docs = await _get_document_groups()
    for doc in docs:
        group_id = doc['group_id']
        # Delete edges
        try:
            edges = await EntityEdge.get_by_group_ids(graphiti.driver, [group_id])
            for edge in edges:
                await edge.delete(graphiti.driver)
        except Exception:
            pass
        # Delete nodes
        try:
            nodes = await EntityNode.get_by_group_ids(graphiti.driver, [group_id])
            for node in nodes:
                await node.delete(graphiti.driver)
        except Exception:
            pass
        # Delete episodes
        try:
            episodes = await EpisodicNode.get_by_group_ids(graphiti.driver, [group_id])
            for episode in episodes:
                await episode.delete(graphiti.driver)
        except Exception:
            pass
        # Delete communities
        try:
            communities = await CommunityNode.get_by_group_ids(graphiti.driver, [group_id])
            for comm in communities:
                await comm.delete(graphiti.driver)
        except Exception:
            pass

    return {'status': 'cleared'}
