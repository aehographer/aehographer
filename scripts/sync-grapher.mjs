import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import fs from 'fs';
import path from 'path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_ID = '37e493e8363549bda22f7a59d9301975'; // ✍️ grapher
const CONTENT_DIR = 'src/content/grapher';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// --- 시리즈+장르 → 파일명 prefix 매핑 ---
// 사이트 frontmatter에는 한글 그대로 들어가고, 파일명만 영문 코드로 변환
const FILE_PREFIX_MAP = {
  '뼈문과표류기': () => 'axdrift',
  '셀프유배기': () => 'exile',
  '항해일지': () => 'logbook',
  '연뮤덕부정기': (genre) => (genre === '연극' ? 'theatre' : 'musical'),
  '콘텐츠유영기': (genre) => {
    if (genre === '영화') return 'movie';
    if (genre === '전시') return 'art';
    return 'content'; // fallback
  },
};

// 콜아웃 블록을 <aside> 태그로 변환 (aeho와 동일)
n2m.setCustomTransformer('callout', async (block) => {
  const text = block.callout.rich_text.map((t) => t.plain_text).join('');
  const icon = block.callout.icon?.emoji || '';
  return `<aside>\n${icon} ${text}\n</aside>`;
});

// --- 마크다운 후처리 ---

function postProcessMarkdown(md) {
  md = md.replace(/^( {4,})(.+)$/gm, (match, indent, text) => text.trim());
  md = md.replace(/\n{3,}/g, '\n\n');
  return md;
}

// --- 노션 속성 → frontmatter 변환 ---

function getTitle(page) {
  const prop = page.properties['제목'];
  if (!prop || prop.type !== 'title') return '';
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

function getMultiSelect(page, name) {
  const prop = page.properties[name];
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map((s) => s.name);
}

function getCheckbox(page, name) {
  const prop = page.properties[name];
  if (!prop || prop.type !== 'checkbox') return false;
  return prop.checkbox;
}

function getDate(page, name) {
  const prop = page.properties[name];
  if (!prop || prop.type !== 'date' || !prop.date) return '';
  return prop.date.start;
}

// --- 날짜 → YYMMDD 변환 ---

function toYYMMDD(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${y.slice(2)}${m}${d}`;
}

// --- 파일명 생성 ---

function buildFilename(page, series, genre) {
  const customSlug = getText(page, '슬러그');
  if (customSlug) {
    return customSlug.endsWith('.md') ? customSlug : `${customSlug}.md`;
  }

  const date = getDate(page, '날짜');
  const yymmdd = toYYMMDD(date);
  const prefixFn = FILE_PREFIX_MAP[series];
  const prefix = prefixFn ? prefixFn(genre) : 'misc';

  if (!yymmdd) {
    // 날짜가 없으면 제목 기반 fallback
    return `${safeFilename(getTitle(page))}.md`;
  }
  return `aeho-${prefix}-${yymmdd}.md`;
}

function safeFilename(title) {
  return title.replace(/[/\\:]/g, ' ').replace(/\s+/g, '-').trim();
}

// --- frontmatter 빌드 ---
// 사이트 호환을 위해 tags = [시리즈, 장르, ...추가태그] 순서로 생성

function buildFrontmatter(page) {
  const title = getTitle(page);
  const date = getDate(page, '날짜') || page.created_time.split('T')[0];
  const series = getSelect(page, '시리즈');
  const genre = getSelect(page, '장르');
  const extraTags = getMultiSelect(page, '태그');
  const published = getCheckbox(page, '발행');

  // tags[0]=시리즈, tags[1]=장르, 그 뒤로 추가 태그
  // 중복 제거 (시리즈/장르가 추가 태그에 이미 있으면 빼기)
  const tags = [];
  if (series) tags.push(series);
  if (genre) tags.push(genre);
  for (const t of extraTags) {
    if (!tags.includes(t)) tags.push(t);
  }

  return {
    title,
    date,
    tags,
    draft: !published,
  };
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

// --- 메인 ---

async function main() {
  if (!fs.existsSync(CONTENT_DIR)) {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
  }

  console.log('노션 그래퍼 DB에서 페이지를 가져오는 중...');
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

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const page of pages) {
    const title = getTitle(page);
    if (!title) {
      skipped++;
      continue;
    }

    const series = getSelect(page, '시리즈');
    const genre = getSelect(page, '장르');
    const filename = buildFilename(page, series, genre);
    const filePath = path.join(CONTENT_DIR, filename);
    const fileExists = fs.existsSync(filePath);

    let notionUpdated = false;
    if (fileExists) {
      const localMtime = fs.statSync(filePath).mtime;
      const notionEdited = new Date(page.last_edited_time);
      notionUpdated = notionEdited > localMtime;
    }

    let hasLocalImages = false;
    if (fileExists) {
      const content = fs.readFileSync(filePath, 'utf-8');
      hasLocalImages = content.includes('](/images/');
    }

    const needBody = !fileExists || (notionUpdated && !hasLocalImages);

    const fm = buildFrontmatter(page);

    if (needBody) {
      const mdBlocks = await n2m.pageToMarkdown(page.id);
      const mdResult = n2m.toMarkdownString(mdBlocks);
      const body = postProcessMarkdown((mdResult.parent || '').trim());
      const content = serializeFrontmatter(fm) + '\n\n' + body + '\n';
      fs.writeFileSync(filePath, content, 'utf-8');
      if (!fileExists) {
        created++;
        console.log(`  + ${filename}`);
      } else {
        updated++;
        console.log(`  ↻ ${filename} (노션에서 수정됨)`);
      }
    } else {
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
