import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const grapher = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/grapher' }),
  schema: z.object({
    title: z.string(),
    date: z.string(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const aeho = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/aeho' }),
  schema: z.object({
    title: z.string(),
    tags: z.array(z.string()).default([]),
    date: z.string(),
    image: z.string().optional(),
    imagePosition: z.string().optional(), // 헤더 이미지 위치: 'top' | 'center' | 'bottom' | '50% 30%' 등
    imageFit: z.enum(['cover', 'contain']).optional(), // 'cover'(기본, 잘림) | 'contain'(전체)
    hideHeader: z.boolean().optional(),   // true면 상세 페이지 헤더 이미지 숨김
    featured: z.number().optional(),      // 메인 페이지 노출 순서 (숫자 있는 것만 노출, 오름차순)
    oneliner: z.string().optional(),
    memo: z.string().optional(),
    draft: z.boolean().default(false),
    // 장르별 전용 필드
    author: z.string().optional(),        // 책: 저자
    publisher: z.string().optional(),     // 책: 출판사
    venue: z.string().optional(),         // 공연/영화/전시: 장소
    seat: z.string().optional(),          // 공연/영화: 좌석
    casting: z.string().optional(),       // 뮤지컬/연극: 캐스팅
    artist: z.string().optional(),        // 전시: 작가 / 음악: 아티스트
    channel: z.string().optional(),       // 영상: 채널명
    link: z.string().optional(),          // 관련 링크 (인스타, 블로그 등)
  }),
});

export const collections = { grapher, aeho };
