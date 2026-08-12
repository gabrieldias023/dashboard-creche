'use strict';
// posts.js — coleta TODOS os posts da conta (com formato) e grava posts_ig.json.
// Campos por post: data, formato (Reels/Foto/Carrossel/Vídeo), curtidas,
// comentarios, alcance (insight, defensivo), visualizacoes (reels/vídeo),
// permalink, legenda (curta). Roda no GitHub Actions com o secret META_TOKEN.
//
// As mídias e like_count/comments_count vêm direto do edge /me/media (barato e
// confiável). Alcance/visualizações por post vêm de /{id}/insights e são
// OPCIONAIS: se a Meta limitar/negar, gravamos null e seguimos.

const fs = require('fs');
const path = require('path');

const GRAPH_HOST = process.env.GRAPH_HOST || 'https://graph.instagram.com';
const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v23.0';
const BASE = `${GRAPH_HOST}/${GRAPH_VERSION}`;
const TZ = 'America/Sao_Paulo';
const OUT_PATH = path.join(__dirname, 'posts_ig.json');
const WITH_INSIGHTS = process.env.POSTS_INSIGHTS !== '0'; // default: tenta alcance/views por post

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isoToLocalDate(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

async function graphGet(pathAndQuery) {
  const token = process.env.META_TOKEN;
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.error) return body;
    const err = body.error || {};
    const rateLimited = res.status === 429 || [4, 17, 32, 613].includes(err.code);
    if (rateLimited) {
      const wait = Math.min(60000, (attempt + 1) * 15000);
      console.error(`  rate limit (code ${err.code}); esperando ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} ${err.message || ''} (code ${err.code ?? '-'})`);
  }
  throw new Error('rate limit persistente');
}

function mapFormato(m) {
  const p = (m.media_product_type || '').toUpperCase();
  const t = (m.media_type || '').toUpperCase();
  if (p === 'REELS') return 'Reels';
  if (p === 'STORY') return 'Stories';
  if (t === 'CAROUSEL_ALBUM') return 'Carrossel';
  if (t === 'VIDEO') return 'Vídeo';
  return 'Foto';
}

async function getAllMedia() {
  const all = [];
  let next = `/me/media?fields=id,timestamp,media_type,media_product_type,caption,permalink,like_count,comments_count&limit=50`;
  for (let page = 0; page < 200 && next; page++) {
    const body = await graphGet(next);
    for (const m of body.data || []) all.push(m);
    const nextUrl = body?.paging?.next;
    if (nextUrl) {
      const u = new URL(nextUrl);
      u.searchParams.delete('access_token');
      next = u.pathname.replace(`/${GRAPH_VERSION}`, '') + '?' + u.searchParams.toString();
    } else {
      next = null;
    }
    await sleep(200);
  }
  return all;
}

async function mediaMetric(id, metric) {
  try {
    const body = await graphGet(`/${id}/insights?metric=${metric}`);
    const item = (body.data || [])[0];
    const val =
      item?.total_value?.value ??
      (Array.isArray(item?.values) ? item.values[0]?.value : undefined) ??
      null;
    return typeof val === 'number' ? val : null;
  } catch (e) {
    return null; // opcional; não derruba a coleta
  }
}

async function main() {
  if (!process.env.META_TOKEN) {
    console.error('Falta META_TOKEN (secret do GitHub).');
    process.exit(1);
  }
  console.log('Buscando todas as mídias...');
  const media = await getAllMedia();
  console.log(`  ${media.length} posts encontrados.`);

  const posts = [];
  let i = 0;
  for (const m of media) {
    const formato = mapFormato(m);
    let alcance = null;
    let visualizacoes = null;
    if (WITH_INSIGHTS) {
      alcance = await mediaMetric(m.id, 'reach');
      if (formato === 'Reels' || formato === 'Vídeo') {
        visualizacoes = await mediaMetric(m.id, 'views');
      }
      await sleep(250);
    }
    posts.push({
      id: m.id,
      data: m.timestamp ? isoToLocalDate(m.timestamp) : null,
      formato,
      curtidas: typeof m.like_count === 'number' ? m.like_count : 0,
      comentarios: typeof m.comments_count === 'number' ? m.comments_count : 0,
      alcance,
      visualizacoes,
      permalink: m.permalink || null,
      legenda: (m.caption || '').replace(/\s+/g, ' ').slice(0, 120),
    });
    i++;
    if (i % 20 === 0) console.log(`  ...${i} posts processados`);
  }

  posts.sort((a, b) => (String(a.data) < String(b.data) ? -1 : String(a.data) > String(b.data) ? 1 : 0));
  fs.writeFileSync(OUT_PATH, JSON.stringify(posts, null, 2) + '\n', 'utf8');
  console.log(`Pronto. ${posts.length} posts gravados em posts_ig.json.`);
}

main().catch((e) => { console.error('Erro fatal:', e.message); process.exit(1); });
