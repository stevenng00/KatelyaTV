import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { addCorsHeaders, handleOptionsRequest } from '@/lib/cors';
import { getStorage } from '@/lib/db';
import { searchFromApi } from '@/lib/downstream';

// 使用 Node.js Runtime 以获得更长的执行时间
export const runtime = 'nodejs';

// 处理OPTIONS预检请求
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
    // 检查是否明确要求包含成人内容
    const includeAdult = searchParams.get('include_adult') === 'true';

    // 获取用户的成人内容过滤设置
    let shouldFilterAdult = true;
    if (userName) {
      try {
        const storage = getStorage();
        const userSettings = await storage.getUserSettings(userName);
        shouldFilterAdult = userSettings?.filter_adult_content !== false;
      } catch (error) {
        shouldFilterAdult = true;
      }
    }

    const finalShouldFilter = shouldFilterAdult || !includeAdult;
    const availableSites = finalShouldFilter
      ? await getAvailableApiSites(true)
      : await getAvailableApiSites(false);

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

    // 超激进搜索策略：分批并行处理所有站点
    const batchSize = 25; // 每批25个站点
    const batches = [];

    for (let i = 0; i < availableSites.length; i += batchSize) {
      const batch = availableSites.slice(i, i + batchSize);
      batches.push(batch);
    }

    let allResults: any[] = [];

    // 并行处理所有批次，但限制同时运行的批次数
    const maxConcurrentBatches = 3;
    const batchPromises = [];

    for (let i = 0; i < batches.length; i += maxConcurrentBatches) {
      const currentBatches = batches.slice(i, i + maxConcurrentBatches);

      const currentBatchPromises = currentBatches.map(async (batch) => {
        const batchPromises = batch.map((site) =>
          searchFromApi(site, query).catch(error => {
            console.warn(`Search failed for site ${site.name}:`, error);
            return [];
          })
        );

        const batchResults = await Promise.allSettled(batchPromises);
        return batchResults
          .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
          .flatMap(result => result.value);
      });

      batchPromises.push(Promise.allSettled(currentBatchPromises));
    }

    // 等待所有批次完成
    const allBatchResults = await Promise.allSettled(batchPromises);

    allResults = allBatchResults
      .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
      .flatMap(batchResult =>
        batchResult.value
          .filter((result): result is PromiseFulfilledResult<any[]> => result.status === 'fulfilled')
          .flatMap(result => result.value)
      );

    const cacheTime = await getCacheTime();
    const response = NextResponse.json(
      {
        regular_results: allResults,
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
  } catch (error) {
    console.error('Aggressive search API error:', error);
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
