import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';
import { getStorage } from '@/lib/db';
import { searchFromApi } from '@/lib/downstream';

// 使用 Edge Runtime 以获得更好的性能，但注意 10 秒超时限制
export const runtime = 'edge';

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

    // 添加整体超时控制，确保在 Edge Runtime 的 10 秒限制内完成
    const overallController = new AbortController();
    const overallTimeoutId = setTimeout(() => overallController.abort(), 9000); // 留 1 秒缓冲

    try {
      // 增加并发搜索数量以提高结果数量，同时保持性能
      const maxConcurrentSearches = 20; // 大幅增加并发数量

      // 优先搜索最可靠的站点（根据名称判断）
      const prioritySites = availableSites.filter(site =>
        site.name.includes('火鸟') ||
        site.name.includes('量子') ||
        site.name.includes('非凡') ||
        site.name.includes('永久') ||
        site.name.includes('百度') ||
        site.name.includes('1080') ||
        site.name.includes('360') ||
        site.name.includes('CK') ||
        site.name.includes('U酷') ||
        site.name.includes('ikun')
      );

      const otherSites = availableSites.filter(site =>
        !prioritySites.includes(site)
      );

      // 优先搜索可靠的站点，然后搜索其他站点
      const sitesToSearch = [
        ...prioritySites.slice(0, Math.min(15, prioritySites.length)),
        ...otherSites.slice(0, maxConcurrentSearches - Math.min(15, prioritySites.length))
      ];

      // 搜索所有可用的资源站（已根据用户设置动态过滤）
      // 使用 Promise.allSettled 来并行处理所有搜索请求
      const searchPromises = sitesToSearch.map((site) =>
        searchFromApi(site, query).catch(error => {
          // 单个源失败不影响其他源
          console.warn(`Search failed for site ${site.name}:`, error);
          return [];
        })
      );

      // 使用 Promise.allSettled 确保即使部分失败也能返回结果
      const searchResults = await Promise.allSettled(searchPromises);
      let allResults = searchResults
        .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
        .flatMap(result => result.value);

      // 如果结果数量较少且还有剩余时间，尝试搜索更多站点
      if (allResults.length < 100 && availableSites.length > maxConcurrentSearches) {
        try {
          const remainingSites = availableSites.slice(maxConcurrentSearches, maxConcurrentSearches + 15);
          const additionalPromises = remainingSites.map((site) =>
            searchFromApi(site, query).catch(error => {
              console.warn(`Additional search failed for site ${site.name}:`, error);
              return [];
            })
          );

          const additionalResults = await Promise.allSettled(additionalPromises);
          const additionalData = additionalResults
            .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
            .flatMap(result => result.value);

          allResults = [...allResults, ...additionalData];
        } catch (error) {
          console.warn('Additional search failed:', error);
        }
      }

      clearTimeout(overallTimeoutId);

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
    } catch (overallError) {
      clearTimeout(overallTimeoutId);
      throw overallError;
    }
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
