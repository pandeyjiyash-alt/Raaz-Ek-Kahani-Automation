/** Zernio may rewrite the media hostname. Match the unique uploaded object name,
 * account, text and schedule; never issue another POST after an uncertain response. */
export function matchingPosts(posts: any[], request: any): any[] {
  const account = (p: any) => p.accountId?._id ?? p.accountId;
  const object = (url: string) => new URL(url).pathname.split('/').pop();
  return posts.filter(p => p.content === request.content &&
    (request.publishNow === true || Date.parse(p.scheduledFor) === Date.parse(request.scheduledFor)) &&
    request.platforms.every((wanted: any) => p.platforms?.some((actual: any) =>
      actual.platform === wanted.platform && account(actual) === account(wanted))) &&
    p.mediaItems?.length === request.mediaItems.length &&
    p.mediaItems.every((m: any, i: number) => {
      const wanted = request.mediaItems[i];
      return m.type === wanted.type && object(m.url) === object(wanted.url) &&
        ['thumbnail','instagramThumbnail'].every(key => !wanted[key] || (m[key] && object(m[key]) === object(wanted[key])));
    }));
}

export async function reconcilePost(api: (endpoint: string) => Promise<any>, request: any) {
  const posts: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(`/posts?limit=100&page=${page}`);
    if (!Array.isArray(result.posts)) throw Error('Cannot reconcile: invalid post list');
    posts.push(...result.posts);
    const pagination = result.pagination;
    if (result.posts.length < 100 || pagination?.hasMore === false || pagination?.hasNextPage === false || page >= pagination?.totalPages) break;
    if (page === 10) throw Error('Post history exceeds recovery limit; preserve marker');
  }
  const matches = matchingPosts(posts, request);
  if (matches.length !== 1) throw Error(`Uncertain submission: found ${matches.length} exact matches; marker retained, no duplicate POST`);
  return matches[0]._id ?? matches[0].id;
}
