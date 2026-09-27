// 여우서가/연뮤덕부정기에서 aeho 체크된 항목을 aeho DB로 끌어온다.
// 이미 aeho DB에 relation으로 연결된 항목은 건너뛴다 (중복 방지).
// 사용법:
//   npm run pull:aeho                 # 전체 pull
//   npm run pull:aeho -- --dry-run    # 생성 없이 시뮬레이션
//   npm run pull:aeho -- --limit 5    # 5개만

import { Client } from '@notionhq/client';
import fs from 'fs';
import path from 'path';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const AEHO_DB = '83a662be75774012b42bc4f0c9ac3493';
const FOX_DB = 'ee8ca436fbc842e8bb1cf231bce0751f'; // 🦊 여우서가
const YEONMU_DB = '966c704596f24d61bfa687f32448f064'; // 🎟️ 연뮤덕부정기
const CONTENT_DIR = 'src/content/aeho';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN 환경변수가 필요합니다.');
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// --- CLI 인자 ---
const args = process.argv.slice(2);
const opts = { dryRun: args.includes('--dry-run'), limit: Infinity };
const limitIdx = args.findIndex((a) => a === '--limit');
if (limitIdx >= 0) opts.limit = parseInt(args[limitIdx + 1], 10);

// --- 연뮤덕부정기 분류 → 사이트 대분류/소분류 매핑 ---
const YEONMU_MAP = {
  '뮤지컬': ['공연', '뮤지컬'],
  '연극': ['공연', '연극'],
  '클래식': ['공연', '클래식'],
  '발레': ['공연', '발레'],
  '창극/국극/국악': ['공연', '창극/국악'],
  '콘서트': ['공연', '콘서트'],
  '전시/행사': ['전시', ''],
  '영화': ['영화', ''],
  '기타': ['기타', ''],
};

// 여우서가 카테고리는 사이트 소분류와 이름이 같아 그대로 사용
const BOOK_SUBS = ['소설', '에세이', '인문사회', '문화예술', '경영경제', '자기계발', '기타'];

// --- 속성 헬퍼 ---
const getTitle = (page, name) => (page.properties[name]?.title || []).map((t) => t.plain_text).join('');
const getText = (page, name) => (page.properties[name]?.rich_text || []).map((t) => t.plain_text).join('').trim();
const getSelect = (page, name) => page.properties[name]?.select?.name || '';
const getDateStart = (page, name) => page.properties[name]?.date?.start?.split('T')[0] || '';
const getUrl = (page, name) => page.properties[name]?.url || '';
const getRelationIds = (page, name) => (page.properties[name]?.relation || []).map((r) => r.id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 기존 md 파일에서 날짜 읽기 (책 pull 시 사이트 정렬 순서 유지용) ---
function safeFilename(title) {
  // sync-aeho.mjs와 동일 규칙 유지 (?·* 등 glob/URL 특수문자 제거)
  return title.replace(/[/\\:?*"<>|#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function existingDateFor(title) {
  const filePath = path.join(CONTENT_DIR, safeFilename(title) + '.md');
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf-8');
  const m = content.match(/^---\n[\s\S]*?^date:\s*"?(\d{4}-\d{2}-\d{2})"?\s*$[\s\S]*?\n---/m);
  return m ? m[1] : '';
}

// --- DB 전체 조회 ---
async function queryAll(dbId, filter) {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: dbId,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// --- aeho DB 행 생성 ---
async function createAehoRow(props, label) {
  if (opts.dryRun) {
    console.log(`  [dry-run] + ${label}`);
    return;
  }
  await notion.pages.create({
    parent: { database_id: AEHO_DB },
    properties: props,
  });
  console.log(`  + ${label}`);
  await sleep(150);
}

const rt = (s) => ({ rich_text: s ? [{ text: { content: s } }] : [] });

async function main() {
  console.log('aeho DB 기존 행을 확인하는 중...');
  const aehoRows = await queryAll(AEHO_DB);
  const linkedFox = new Set(aehoRows.flatMap((p) => getRelationIds(p, '여우서가')));
  const linkedYeonmu = new Set(aehoRows.flatMap((p) => getRelationIds(p, '연뮤덕부정기')));
  console.log(`aeho DB: ${aehoRows.length}행 (여우서가 연결 ${linkedFox.size}, 연뮤덕 연결 ${linkedYeonmu.size})`);

  let created = 0;
  let skipped = 0;

  // --- 여우서가: aeho 체크된 책 ---
  console.log('\n여우서가에서 aeho 체크된 책을 가져오는 중...');
  const foxChecked = await queryAll(FOX_DB, { property: 'aeho', checkbox: { equals: true } });
  console.log(`체크된 책 ${foxChecked.length}권`);

  for (const page of foxChecked) {
    if (created >= opts.limit) break;
    const title = getTitle(page, '책 제목');
    if (!title || linkedFox.has(page.id)) {
      skipped++;
      continue;
    }
    const category = getSelect(page, '카테고리');
    const date = existingDateFor(title) || page.created_time.split('T')[0];
    const props = {
      '제목': { title: [{ text: { content: title } }] },
      '대분류': { select: { name: '책' } },
      '날짜': { date: { start: date } },
      '발행': { checkbox: true },
      '유입': { select: { name: '여우서가' } },
      '여우서가': { relation: [{ id: page.id }] },
    };
    if (category && BOOK_SUBS.includes(category)) props['소분류'] = { select: { name: category } };
    const oneliner = getText(page, '한줄평');
    if (oneliner) props['한줄평'] = rt(oneliner);
    await createAehoRow(props, `[책] ${title}`);
    created++;
  }

  // --- 연뮤덕부정기: aeho 체크된 관람 기록 ---
  console.log('\n연뮤덕부정기에서 aeho 체크된 기록을 가져오는 중...');
  const yeonmuChecked = await queryAll(YEONMU_DB, { property: 'aeho', checkbox: { equals: true } });
  console.log(`체크된 기록 ${yeonmuChecked.length}건`);

  for (const page of yeonmuChecked) {
    if (created >= opts.limit) break;
    const title = getTitle(page, '이름');
    if (!title || linkedYeonmu.has(page.id)) {
      skipped++;
      continue;
    }
    const bunryu = getSelect(page, '분류');
    const [main, sub] = YEONMU_MAP[bunryu] || ['기타', ''];
    const props = {
      '제목': { title: [{ text: { content: title } }] },
      '대분류': { select: { name: main } },
      '발행': { checkbox: true },
      '유입': { select: { name: '연뮤덕부정기' } },
      '연뮤덕부정기': { relation: [{ id: page.id }] },
    };
    if (sub) props['소분류'] = { select: { name: sub } };
    const date = getDateStart(page, '날짜');
    if (date) props['날짜'] = { date: { start: date } };
    const venue = getSelect(page, '장소');
    if (venue) props['장소'] = rt(venue);
    const seat = getText(page, '좌석');
    if (seat) props['좌석'] = rt(seat);
    const link = getUrl(page, '뮤덕부정기');
    if (link) props['링크'] = { url: link };
    await createAehoRow(props, `[${bunryu || '기타'}] ${title}`);
    created++;
  }

  console.log(`\n완료! 새로 생성: ${created}, 스킵(기존 연결/빈 제목): ${skipped}`);
}

main().catch((err) => {
  console.error('pull 실패:', err.message);
  process.exit(1);
});
