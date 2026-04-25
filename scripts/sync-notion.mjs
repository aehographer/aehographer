import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import fs from 'fs';
import path from 'path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = 'ee8ca436fbc842e8bb1cf231bce0751f';
const CONTENT_DIR = 'src/content/aeho';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 콜아웃 블록을 <aside> 태그로 변환
n2m.setCustomTransformer('callout', async (block) => {
  const text = block.callout.rich_text.map((t) => t.plain_text).join('');
  const icon = block.callout.icon?.emoji || '';
  return `<aside>\n${icon} ${text}\n</aside>`;
});

// --- 마크다운 후처리 ---

function postProcessMarkdown(md) {
  // 1. 들여쓰기(중첩 paragraph) → 일반 문단으로 변환
  md = md.replace(/^( {4,})(.+)$/gm, (match, indent, text) => text.trim());

  // 2. 여우로운 감상 섹션 제거 (oneliner는 별도 추출)
  md = md.replace(/## .*여우로운 감상[\s\S]*?---\n*/m, '');

  // 연속 빈 줄 정리
  md = md.replace(/\n{3,}/g, '\n\n');

  return md;
}

// --- 여우로운 감상에서 한줄평 추출 ---

async function extractOneliner(pageId) {
  const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  for (let i = 0; i < blocks.results.length; i++) {
    const b = blocks.results[i];
    if (b.type === 'heading_2') {
      const text = b.heading_2.rich_text.map((t) => t.plain_text).join('');
      if (text.includes('여우로운 감상')) {
        const next = blocks.results[i + 1];
        if (next && next.type === 'quote') {
          return next.quote.rich_text.map((t) => t.plain_text).join('').trim();
        }
      }
    }
  }
  return '';
}

// --- 노션 속성 → frontmatter 변환 ---

function getTitle(page) {
  const prop = page.properties['책 제목'];
  return prop.title.map((t) => t.plain_text).join('');
}

function getText(page, name) {
  const prop = page.properties[name];
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map((t) => t.plain_text).join('').trim();
}

function getSelect(page, name) {
  const prop = page.properties[name];
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select.name;
}

function getDate(page) {
  return page.created_time.split('T')[0];
}

function buildFrontmatter(page, existing, oneliner) {
  const title = getTitle(page);
  const author = getText(page, '지은이');
  const publisher = getText(page, '출판사');
  const category = getSelect(page, '카테고리');
  const notionOneliner = getText(page, '한줄평');
  const date = existing.date || getDate(page);
  const tags = category ? ['책', category] : ['책'];

  const fm = {
    title,
    tags,
    date,
  };

  // 사이트 전용 필드 보존 (기존 파일에 있던 값)
  if (existing.featured != null) fm.featured = existing.featured;
  if (existing.image) fm.image = existing.image;
  if (existing.imagePosition) fm.imagePosition = existing.imagePosition;
  if (existing.imageFit) fm.imageFit = existing.imageFit;
  if (existing.hideHeader) fm.hideHeader = existing.hideHeader;

  // 한줄평 우선순위: 노션 한줄평 속성 > 여우로운 감상에서 추출 > 기존 파일
  const resolvedOneliner = notionOneliner || oneliner || existing.oneliner || '';
  if (resolvedOneliner) fm.oneliner = resolvedOneliner;

  if (existing.memo) fm.memo = existing.memo;
  if (author) fm.author = author;
  if (publisher) fm.publisher = publisher;
  if (existing.link) fm.link = existing.link;

  return fm;
}

// --- frontmatter 직렬화 ---

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fm)) {
    if (val == null) continue;
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.map((v) => `"${v}"`).join(', ')}]`);
    } else if (typeof val === 'boolean') {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === 'number') {
      lines.push(`${key}: ${val}`);
    } else {
      lines.push(`${key}: "${val}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// --- 기존 파일에서 frontmatter 파싱 ---

function parseExistingFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw.startsWith('[')) {
      result[key] = [...raw.matchAll(/"([^"]+)"/g)].map((r) => r[1]);
    } else if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true';
    } else if (/^\d+$/.test(raw)) {
      result[key] = parseInt(raw, 10);
    } else {
      result[key] = raw.replace(/^"(.*)"$/, '$1');
    }
  }
  return result;
}

// --- 파일명 안전화 ---

function safeFilename(title) {
  return title.replace(/[/\\:]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- 메인 ---

async function main() {
  console.log('노션 DB에서 페이지를 가져오는 중...');
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  console.log(`총 ${pages.length}개 페이지 발견`);

  const existingFiles = new Set(
    fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md'))
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const page of pages) {
    const title = getTitle(page);
    if (!title) {
      skipped++;
      continue;
    }

    const filename = safeFilename(title) + '.md';
    const filePath = path.join(CONTENT_DIR, filename);
    const isNew = !fs.existsSync(filePath);

    // 여우로운 감상에서 한줄평 추출
    const oneliner = await extractOneliner(page.id);

    // 기존 frontmatter 읽기
    const existing = parseExistingFrontmatter(filePath);

    // frontmatter 생성
    const fm = buildFrontmatter(page, existing, oneliner);

    if (isNew) {
      const mdBlocks = await n2m.pageToMarkdown(page.id);
      const mdResult = n2m.toMarkdownString(mdBlocks);
      const body = postProcessMarkdown((mdResult.parent || '').trim());
      const content = serializeFrontmatter(fm) + '\n\n' + body + '\n';
      fs.writeFileSync(filePath, content, 'utf-8');
      created++;
      console.log(`  + ${filename}`);
    } else {
      // 기존 파일: frontmatter만 교체, 본문은 보존
      const oldContent = fs.readFileSync(filePath, 'utf-8');
      const fmEnd = oldContent.match(/^---\n[\s\S]*?\n---\n/);
      const existingBody = fmEnd ? oldContent.slice(fmEnd[0].length) : '';
      const content = serializeFrontmatter(fm) + '\n' + existingBody;
      fs.writeFileSync(filePath, content, 'utf-8');
      updated++;
    }
  }

  console.log(`\n완료! 새로 생성: ${created}, 업데이트: ${updated}, 스킵: ${skipped}`);
}

main().catch((err) => {
  console.error('동기화 실패:', err.message);
  process.exit(1);
});
