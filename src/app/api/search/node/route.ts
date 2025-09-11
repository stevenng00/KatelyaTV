import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';
import { getStorage } from '@/lib/db';
import { searchFromApi } from '@/lib/downstream';

// 使用 Node.js Runtime 以获得更长的执行时间（60 秒）
export const runtime = 'nodejs';

// 处理OPTIONS预检请求（OrionTV客户端需要）
export async function OPTIONS() {
  return handleOptionsRequest();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  // 从 Authorization header 或 query parameter 获取用户名
  let userName: string | undefined = searchParams.get('user') || undefined;
  if (!userName) {
    const authHeader = request.headers.get('Authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      userName = authHeader.substring(7);
    }
  }

  if (!query) {
    const cacheTime = await getCacheTime();
    const response = NextResponse.json(
      {
        regular_results: [],
        adult_results: []
      },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
    return addCorsHeaders(response);
  }

  try {
    // 检查是否明确要求包含成人内容（用于关闭过滤时的明确请求）
    const includeAdult = searchParams.get('include_adult') === 'true';

    // 获取用户的成人内容过滤设置
    let shouldFilterAdult = true; // 默认过滤
    if (userName) {
      try {
        const storage = getStorage();
        const userSettings = await storage.getUserSettings(userName);
        // 如果用户设置存在且明确设为false，则不过滤；否则默认过滤
        shouldFilterAdult = userSettings?.filter_adult_content !== false;
      } catch (error) {
        // 出错时默认过滤成人内容
        shouldFilterAdult = true;
      }
    }

    // 根据用户设置和明确请求决定最终的过滤策略
    const finalShouldFilter = shouldFilterAdult || !includeAdult;

    // 使用动态过滤方法，但不依赖缓存，实时获取设置
    const availableSites = finalShouldFilter
      ? await getAvailableApiSites(true) // 过滤成人内容
      : await getAvailableApiSites(false); // 不过滤成人内容

    if (!availableSites || availableSites.length === 0) {
      const cacheTime = await getCacheTime();
      const response = NextResponse.json({
        regular_results: [],
        adult_results: []
      }, {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      });
      return addCorsHeaders(response);
    }

    // Node.js Runtime 有更长的超时时间，可以搜索更多源
    const searchPromises = availableSites.map((site) =>
      searchFromApi(site, query).catch(error => {
        // 单个源失败不影响其他源
        console.warn(`Search failed for site ${site.name}:`, error);
        return [];
      })
    );

    // 使用 Promise.allSettled 确保即使部分失败也能返回结果
    const searchResults = await Promise.allSettled(searchPromises);
    const allResults = searchResults
      .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
      .flatMap(result => result.value);

    // 所有结果都作为常规结果返回，因为成人内容源已经在源头被过滤掉了
    const cacheTime = await getCacheTime();
    const response = NextResponse.json(
      {
        regular_results: allResults,
        adult_results: [] // 始终为空，因为成人内容在源头就被过滤了
      },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
    return addCorsHeaders(response);
  } catch (error) {
    console.error('Search API error:', error);
    const response = NextResponse.json(
      {
        regular_results: [],
        adult_results: [],
        error: '搜索失败'
      },
      { status: 500 }
    );
    return addCorsHeaders(response);
  }
}
