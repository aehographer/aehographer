// 기존 grapher 마크다운 파일들을 노션 DB에 일회성 마이그레이션
// 사용법:
//   npm run import:grapher                    # 전체 마이그레이션
//   npm run import:grapher -- --limit 2       # 2개만 (시범)
//   npm run import:grapher -- --dry-run       # 업로드 없이 시뮬레이션
//   npm run import:grapher -- --files=axdrift # 특정 파일명 패턴만

import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = '37e493e8363549bda22f7a59d9301975';
const CONTENT_DIR = 'src/content/grapher';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// --- CLI 인자 파싱 ---
const args = process.argv.slice(2);
const opts = { limit: Infinity, dryRun: false, filter: null };
for (const arg of args) {
  if (arg === '--dry-run') opts.dryRun = true;
  else if (arg.startsWith('--limit=')) opts.limit = parseInt(arg.split('=')[1], 10);
  else if (arg === '--limit') {
    const next = args[args.indexOf(arg) + 1];
    if (next && !next.startsWith('--')) opts.limit = parseInt(next, 10);
  } else if (arg.startsWith('--files=')) opts.filter = arg.split('=')[1];
}

// --- 시리즈 옵션 검증 ---
const VALID_SERIES = ['뼈문과표류기', '셀프유배기', '항해일지', '연뮤덕부정기', '콘텐츠유영기'];
const VALID_GENRES = ['커리어', '일상', '뮤지컬', '연극', '영화', '전시'];

// --- 마크다운 파일 → 노션 페이지 데이터로 변환 ---

function parseMdFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    return { error: 'frontmatter 없음' };
  }

  const [, fmText, body] = fmMatch;
  const fm = {};
  for (const line of fmText.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw.startsWith('[')) {
      fm[key] = [...raw.matchAll(/"([^"]+)"/g)].map((r) => r[1]);
    } else if (raw === 'true' || raw === 'false') {
      fm[key] = raw === 'true';
    } else {
      fm[key] = raw.replace(/^"(.*)"$/, '$1');
    }
  }

  return { fm, body: body.trim() };
}

// --- 슬러그 = 파일명 (확장자 제외) ---

function fileToSlug(filename) {
  return filename.replace(/\.md$/, '');
}

// --- 노션에 같은 슬러그가 이미 있는지 확인 ---

async function findExistingPageBySlug(slug) {
  const res = await notion.databases.query({
    database_id: DB_ID,
    filter: {
      property: '슬러그',
      rich_text: { equals: slug },
    },
    page_size: 1,
  });
  return res.results[0] || null;
}

// --- 마크다운 본문 → 노션 블록 (간단 변환) ---
// 본문을 적당히 단락 단위로 끊어서 paragraph 블록으로 만들기.
// 노션이 이해하는 마크다운 구조(제목/인용/리스트)는 보존.

function bodyToBlocks(body) {
  if (!body) return [];

  const blocks = [];
  const lines = body.split('\n');
  let buffer = [];

  function flushParagraph() {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: chunkRichText(text),
        },
      });
    }
    buffer = [];
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: chunkRichText(line.slice(3).trim()) },
      });
    } else if (line.startsWith('### ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: chunkRichText(line.slice(4).trim()) },
      });
    } else if (line.startsWith('> ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: chunkRichText(line.slice(2).trim()) },
      });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      flushParagraph();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: chunkRichText(line.slice(2).trim()) },
      });
    } else if (line.trim() === '') {
      flushParagraph();
    } else {
      buffer.push(line);
    }
  }
  flushParagraph();

  return blocks;
}

// 노션은 한 rich_text 청크당 최대 2000자. 길면 나눠서 보냄.
function chunkRichText(text) {
  const chunks = [];
  const MAX = 1900;
  for (let i = 0; i < text.length; i += MAX) {
    chunks.push({
      type: 'text',
      text: { content: text.slice(i, i + MAX) },
    });
  }
  return chunks.length > 0 ? chunks : [{ type: 'text', text: { content: '' } }];
}

// --- frontmatter → 노션 properties 변환 ---

function buildProperties(fm, slug) {
  const tags = fm.tags || [];
  const series = tags[0];
  const genre = tags[1];
  const extra = tags.slice(2);

  const properties = {
    제목: { title: [{ text: { content: fm.title || '제목 없음' } }] },
    슬러그: { rich_text: [{ text: { content: slug } }] },
    발행: { checkbox: !fm.draft },
  };

  if (fm.date) {
    properties['날짜'] = { date: { start: fm.date } };
  }

  if (series && VALID_SERIES.includes(series)) {
    properties['시리즈'] = { select: { name: series } };
  }

  if (genre && VALID_GENRES.includes(genre)) {
    properties['장르'] = { select: { name: genre } };
  }

  if (extra.length > 0) {
    properties['태그'] = {
      multi_select: extra.map((t) => ({ name: t })),
    };
  }

  return { properties, series, genre, extra, hasUnknownSeries: series && !VALID_SERIES.includes(series) };
}

// --- 한 파일 처리 ---

async function processFile(filename) {
  const filePath = path.join(CONTENT_DIR, filename);
  const { fm, body, error } = parseMdFile(filePath);
  if (error) {
    return { filename, status: 'error', message: error };
  }

  const slug = fileToSlug(filename);
  const { properties, series, genre, hasUnknownSeries } = buildProperties(fm, slug);

  // 시리즈가 정의된 옵션에 없으면 경고하고 스킵
  if (hasUnknownSeries) {
    return {
      filename,
      status: 'skip',
      message: `알 수 없는 시리즈: "${(fm.tags || [])[0]}"`,
    };
  }

  // 이미 노션에 같은 슬러그로 등록되어 있으면 스킵
  const existing = await findExistingPageBySlug(slug);
  if (existing) {
    return { filename, status: 'skip', message: '이미 노션에 존재 (슬러그 중복)' };
  }

  if (opts.dryRun) {
    return {
      filename,
      status: 'dry-run',
      message: `시리즈=${series || '없음'}, 장르=${genre || '없음'}, 본문=${body.length}자`,
    };
  }

  // 페이지 생성
  const blocks = bodyToBlocks(body);
  await notion.pages.create({
    parent: { database_id: DB_ID },
    properties,
    children: blocks.slice(0, 100), // 노션 API 한 번에 최대 100 블록
  });

  // 100블록 초과분은 추가로 append
  if (blocks.length > 100) {
    const pageRes = await findExistingPageBySlug(slug);
    if (pageRes) {
      for (let i = 100; i < blocks.length; i += 100) {
        await notion.blocks.children.append({
          block_id: pageRes.id,
          children: blocks.slice(i, i + 100),
        });
      }
    }
  }

  return {
    filename,
    status: 'created',
    message: `시리즈=${series || '없음'}, 장르=${genre || '없음'}, 블록=${blocks.length}`,
  };
}

// --- 메인 ---

async function main() {
  let files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md'));

  if (opts.filter) {
    files = files.filter((f) => f.includes(opts.filter));
  }

  files = files.slice(0, opts.limit);

  console.log(`\n📦 마이그레이션 시작 (${opts.dryRun ? 'DRY-RUN' : '실제 업로드'})`);
  console.log(`   대상: ${files.length}개 파일${opts.filter ? ` (필터: "${opts.filter}")` : ''}\n`);

  const summary = { created: 0, skipped: 0, error: 0 };

  for (const file of files) {
    try {
      const result = await processFile(file);
      const icon = { created: '+', skip: '↷', error: '✗', 'dry-run': '·' }[result.status] || '?';
      console.log(`  ${icon} ${file} — ${result.message}`);

      if (result.status === 'created' || result.status === 'dry-run') summary.created++;
      else if (result.status === 'skip') summary.skipped++;
      else if (result.status === 'error') summary.error++;
    } catch (err) {
      console.error(`  ✗ ${file} — 에러: ${err.message}`);
      summary.error++;
    }
  }

  console.log(`\n📊 완료! 생성: ${summary.created}, 스킵: ${summary.skipped}, 에러: ${summary.error}\n`);

  if (opts.dryRun) {
    console.log('💡 DRY-RUN이라 실제 노션에는 아무것도 올라가지 않았어요.');
    console.log('   문제 없어 보이면 --dry-run 빼고 다시 실행하세요.\n');
  }
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err);
  process.exit(1);
});
