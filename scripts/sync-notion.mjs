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

// 중첩 paragraph(들여쓰기)를 <aside>로 변환
const originalTransformer = n2m.pageToMarkdown.bind(n2m);
const origToMd = n2m.toMarkdownString.bind(n2m);

// notion-to-md가 children을 4칸 들여쓰기로 렌더링하므로, 후처리로 <aside>로 변환
function postProcessMarkdown(md) {
  return md.replace(/^( {4,})(.+)$/gm, (match, indent, text) => {
    return `<aside>\n${text.trim()}\n</aside>`;
  });
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
  // 생성일(created_time)에서 날짜 추출
  return page.created_time.split('T')[0];
}

function buildFrontmatter(page, existing) {
  const title = getTitle(page);
  const author = getText(page, '지은이');
  const publisher = getText(page, '출판사');
  const category = getSelect(page, '카테고리');
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
  if (existing.oneliner) fm.oneliner = existing.oneliner;
  if (existing.memo) fm.memo = existing.memo;

  if (author) fm.author = author;
  if (publisher) fm.publisher = publisher;

  // 기존 link 보존, 노션 링크 파일은 나중에 확장 가능
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
    // 배열
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
  // 파일시스템에서 쓸 수 없는 문자 제거
  return title.replace(/[/\\:]/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- 메인 ---

async function main() {
  // 1. 노션 DB에서 모든 페이지 가져오기
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

  // 2. 기존 파일 목록
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

    // 기존 frontmatter 읽기 (있으면 보존)
    const existing = parseExistingFrontmatter(filePath);

    // frontmatter 생성
    const fm = buildFrontmatter(page, existing);

    if (isNew) {
      // 새 파일: 노션 본문을 마크다운으로 변환해서 쓰기
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
