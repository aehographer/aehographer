// aeho DB(허브 원장) → src/content/aeho/*.md 동기화
// - 여우서가/연뮤덕부정기 relation이 있으면 본문·메타를 원본 페이지에서 최신으로 읽는다 (이중 기록 없음)
// - relation이 없으면(직접 기록) aeho 행 자체의 본문을 사용한다
// - 발행 체크 해제 시 draft: true로 사이트에서 숨김
// 사용법: npm run sync:aeho

import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import fs from 'fs';
import path from 'path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const AEHO_DB = '83a662be75774012b42bc4f0c9ac3493';
const CONTENT_DIR = 'src/content/aeho';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

// 429(rate limit)·5xx는 Retry-After만큼 기다렸다 재시도
async function retryingFetch(url, init, tries = 6) {
  const res = await fetch(url, init);
  if ((res.status === 429 || res.status >= 500) && tries > 0) {
    const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return retryingFetch(url, init, tries - 1);
  }
  return res;
}
const notion = new Client({ auth: NOTION_TOKEN, fetch: retryingFetch });
const n2m = new NotionToMarkdown({ notionClient: notion });

// 콜아웃 블록을 <aside> 태그로 변환
n2m.setCustomTransformer('callout', async (block) => {
  const text = block.callout.rich_text.map((t) => t.plain_text).join('');
  const icon = block.callout.icon?.emoji || '';
  return `<aside>\n${icon} ${text}\n</aside>`;
});

// --- 마크다운 후처리 ---

function postProcessMarkdown(md) {
  // 들여쓰기(중첩 paragraph) → 일반 문단
  md = md.replace(/^( {4,})(.+)$/gm, (match, indent, text) => text.trim());
  // 여우로운 감상 섹션 제거 (oneliner는 별도 추출)
  md = md.replace(/## .*여우로운 감상[\s\S]*?---\n*/m, '');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md;
}

// --- 여우로운 감상에서 한줄평 추출 (여우서가 원본용) ---

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

// --- 본문 속 노션 이미지 → 로컬 저장 ---

async function downloadBodyImages(md, dirName) {
  const dir = path.join('public/images/aeho', dirName);
  let firstImage = null;
  const matches = [...md.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g)];
  let idx = 0;

  for (const m of matches) {
    const [full, alt, url] = m;
    idx++;

    let fname = decodeURIComponent((url.split('?')[0].split('/').pop()) || '');
    if (!fname || !/\.[a-zA-Z0-9]+$/.test(fname)) {
      fname = alt && /\.[a-zA-Z0-9]+$/.test(alt) ? alt : `image-${idx}.jpg`;
    }

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`    ! 이미지 다운로드 실패(${res.status}): ${fname}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fname), buf);

      const localRaw = `/images/aeho/${dirName}/${fname}`;
      const localEnc = `/images/aeho/${encodeURIComponent(dirName)}/${encodeURIComponent(fname)}`;
      md = md.replace(full, `![${fname}](${localEnc})`);
      if (!firstImage) firstImage = localRaw;
      console.log(`    ↓ 이미지 저장: ${dirName}/${fname}`);
    } catch (e) {
      console.log(`    ! 이미지 오류: ${fname} (${e.message})`);
    }
  }

  return { md, firstImage };
}

// --- 속성 헬퍼 ---

const getTitle = (page, name) => (page.properties[name]?.title || []).map((t) => t.plain_text).join('');
const getText = (page, name) => (page.properties[name]?.rich_text || []).map((t) => t.plain_text).join('').trim();
const getSelect = (page, name) => page.properties[name]?.select?.name || '';
const getCheckbox = (page, name) => page.properties[name]?.checkbox || false;
const getDateStart = (page, name) => page.properties[name]?.date?.start?.split('T')[0] || '';
const getUrl = (page, name) => page.properties[name]?.url || '';
const getRelationId = (page, name) => page.properties[name]?.relation?.[0]?.id || '';

// --- 파일명 ---

function safeFilename(title) {
  // ?와 * 등은 glob/URL에서 특수문자라 파일명에서 제거 (Astro glob 로더가 ?를 와일드카드로 해석함)
  return title.replace(/[/\\:?*"<>|#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function toYYMMDD(isoDate) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-');
  return `${y.slice(2)}${m}${d}`;
}

function buildFilename(row, main, date) {
  const customSlug = getText(row, '슬러그');
  if (customSlug) {
    return customSlug.endsWith('.md') ? customSlug : `${customSlug}.md`;
  }
  const base = safeFilename(getTitle(row, '제목'));
  // 책은 기존 파일명 유지(제목.md), 비책은 재관람 대비 날짜 suffix
  if (main === '책') return `${base}.md`;
  const yymmdd = toYYMMDD(date);
  return yymmdd ? `${base}-${yymmdd}.md` : `${base}.md`;
}

// --- 기존 파일 frontmatter 파싱 ---

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

// --- frontmatter 직렬화 ---

function serializeFrontmatter(fm) {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fm)) {
    if (val == null || val === '') continue;
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

// --- DB 전체 조회 ---

async function queryAll(dbId) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- 메인 ---

async function main() {
  if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });

  console.log('aeho DB에서 행을 가져오는 중...');
  const rows = await queryAll(AEHO_DB);
  console.log(`총 ${rows.length}행 발견`);

  const touched = new Set();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const title = getTitle(row, '제목');
    if (!title) {
      skipped++;
      continue;
    }

    const main = getSelect(row, '대분류');
    const foxId = getRelationId(row, '여우서가');
    const yeonmuId = getRelationId(row, '연뮤덕부정기');
    const sourceId = foxId || yeonmuId;

    // 원본 페이지 조회 (메타 최신화 + last_edited 비교용)
    let source = null;
    if (sourceId) {
      try {
        source = await notion.pages.retrieve({ page_id: sourceId });
      } catch (e) {
        console.log(`  ! 원본 조회 실패(${title}): ${e.code}`);
      }
    }

    // 날짜: aeho 행 > 원본(연뮤덕) > 기존 파일 > 생성일 순
    const rowDate = getDateStart(row, '날짜');
    const sourceDate = source && yeonmuId ? getDateStart(source, '날짜') : '';

    const filename = buildFilename(row, main, rowDate || sourceDate);
    const filePath = path.join(CONTENT_DIR, filename);
    const fileExists = fs.existsSync(filePath);
    const existing = parseExistingFrontmatter(filePath);
    touched.add(filename);

    const date = rowDate || sourceDate || existing.date || row.created_time.split('T')[0];

    // 본문 갱신 필요 여부
    let notionUpdated = false;
    if (fileExists) {
      const localMtime = fs.statSync(filePath).mtime;
      const editedTimes = [new Date(row.last_edited_time)];
      if (source) editedTimes.push(new Date(source.last_edited_time));
      notionUpdated = Math.max(...editedTimes.map((d) => d.getTime())) > localMtime.getTime();
    }

    let hasLocalImages = false;
    let isLocked = false;
    if (fileExists) {
      const content = fs.readFileSync(filePath, 'utf-8');
      hasLocalImages = content.includes('](/images/');
      isLocked = /^lockedBody:\s*true$/m.test(content.match(/^---\n([\s\S]*?)\n---/)?.[1] || '');
    }

    const needBody = !fileExists || (notionUpdated && !hasLocalImages && !isLocked);

    // --- 한줄평: aeho 행 > 여우서가 속성 > 여우로운 감상 추출 > 기존 파일 ---
    let oneliner = getText(row, '한줄평');
    if (!oneliner && source && foxId) oneliner = getText(source, '한줄평');
    if (!oneliner && foxId) oneliner = await extractOneliner(foxId);
    if (!oneliner) oneliner = existing.oneliner || '';

    // --- frontmatter 구성 (기존 aeho 파일과 필드 순서 동일하게) ---
    const sub = getSelect(row, '소분류');
    const tags = [main, sub].filter(Boolean);
    const fm = { title, tags, date };

    if (existing.featured != null) fm.featured = existing.featured;
    if (existing.image) fm.image = existing.image;
    if (existing.imagePosition) fm.imagePosition = existing.imagePosition;
    if (existing.imageFit) fm.imageFit = existing.imageFit;
    if (existing.hideHeader) fm.hideHeader = existing.hideHeader;
    if (oneliner) fm.oneliner = oneliner;
    fm.memo = getText(row, '메모') || existing.memo || '';

    // 장르별 필드: 원본(여우서가) 메타는 매 sync 최신화, 나머지는 aeho 행 값
    if (source && foxId) {
      fm.author = getText(source, '지은이');
      fm.publisher = getText(source, '출판사');
    } else {
      fm.author = existing.author || '';
      fm.publisher = existing.publisher || '';
    }
    fm.venue = getText(row, '장소') || (source && yeonmuId ? getSelect(source, '장소') : '') || existing.venue || '';
    fm.seat = getText(row, '좌석') || (source && yeonmuId ? getText(source, '좌석') : '') || existing.seat || '';
    fm.casting = getText(row, '캐스팅') || existing.casting || '';
    fm.artist = getText(row, '아티스트') || existing.artist || '';
    fm.channel = getText(row, '채널') || existing.channel || '';
    fm.link = getUrl(row, '링크') || existing.link || '';
    if (!getCheckbox(row, '발행')) fm.draft = true;
    if (existing.lockedBody === true) fm.lockedBody = true;

    if (needBody) {
      // 본문: 원본 페이지 우선, 없으면 aeho 행 자체
      const bodyPageId = sourceId || row.id;
      const mdBlocks = await n2m.pageToMarkdown(bodyPageId);
      const mdResult = n2m.toMarkdownString(mdBlocks);
      let body = postProcessMarkdown((mdResult.parent || '').trim());

      const imgResult = await downloadBodyImages(body, safeFilename(title));
      body = imgResult.md;
      if (!fm.image && imgResult.firstImage) fm.image = imgResult.firstImage;

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
      // frontmatter만 교체, 본문 보존
      const oldContent = fs.readFileSync(filePath, 'utf-8');
      const fmEnd = oldContent.match(/^---\n[\s\S]*?\n---\n/);
      const existingBody = fmEnd ? oldContent.slice(fmEnd[0].length) : '';
      const content = serializeFrontmatter(fm) + '\n' + existingBody;
      if (content !== oldContent) updated++;
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }

  // aeho DB에 없는 md 파일 경고 (자동 삭제하지 않음)
  const orphans = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md') && !touched.has(f));
  if (orphans.length) {
    console.log(`\n⚠ aeho DB에 대응 행이 없는 파일 ${orphans.length}개 (자동 삭제 안 함):`);
    orphans.forEach((f) => console.log(`  - ${f}`));
  }

  console.log(`\n완료! 새로 생성: ${created}, 업데이트: ${updated}, 스킵: ${skipped}`);
}

main().catch((err) => {
  console.error('동기화 실패:', err.message);
  process.exit(1);
});
