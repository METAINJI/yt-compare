// GET /api/analyze?url=<유튜브 링크 또는 영상 ID>
// 환경 변수: YOUTUBE_API_KEY (Cloudflare Pages > Settings > Variables and Secrets)

const MAX_PAGES = 5; // 댓글 100개 x 5페이지 = 최대 500개 (할당량: 페이지당 1유닛)

const STOP = new Set([
  '그리고', '하지만', '그런데', '그래서', '진짜', '너무', '정말', '이거', '저거', '그거', '영상', '이게', '저도',
  '근데', '그냥', '완전', '이제', '아니', '여기', '저기', 'the', 'and', 'this', 'that', 'you', 'for', 'are',
  'with', 'have', 'was', 'but', 'not', 'its', 'just', 'like', 'very', 'from', 'they', 'what', 'who', 'all',
]);
// 간단한 조사/어미 제거 (형태소 분석기가 아니므로 완벽하지 않음)
const JOSA = /(으로|에서|에게|한테|부터|까지|처럼|보다|이랑|입니다|했던|하는|네요|해요|은|는|이|가|을|를|의|에|도|로|과|와|만|들|랑)$/;

function getVideoId(s) {
  s = (s || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1, 12);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/);
    if (m) return m[2];
  } catch (e) {}
  return null;
}

async function yt(path, params, key) {
  const u = new URL('https://www.googleapis.com/youtube/v3/' + path);
  u.search = new URLSearchParams({ ...params, key }).toString();
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) {
    const err = new Error(j.error?.message || 'YouTube API 오류');
    err.reason = j.error?.errors?.[0]?.reason;
    throw err;
  }
  return j;
}

function tokenize(text) {
  const out = [];
  const words = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[가-힣]+|[a-z]{3,}/g) || [];
  for (let w of words) {
    if (/[가-힣]/.test(w)) {
      const stripped = w.replace(JOSA, '');
      if (stripped.length >= 2) w = stripped;
    }
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export async function onRequestGet({ request, env }) {
  const key = env.YOUTUBE_API_KEY;
  if (!key) return json({ error: '서버에 YOUTUBE_API_KEY가 설정되지 않았습니다.' }, 500);

  const id = getVideoId(new URL(request.url).searchParams.get('url'));
  if (!id) return json({ error: '유튜브 링크 형식을 확인해 주세요.' }, 400);

  try {
    const v = await yt('videos', { part: 'snippet,statistics', id }, key);
    const item = v.items?.[0];
    if (!item) return json({ error: '영상을 찾을 수 없습니다. (비공개이거나 삭제된 영상일 수 있어요)' }, 404);

    // 댓글 수집
    const comments = [];
    let commentsDisabled = false;
    let pageToken;
    try {
      for (let i = 0; i < MAX_PAGES; i++) {
        const c = await yt('commentThreads', {
          part: 'snippet', videoId: id, maxResults: 100, order: 'relevance',
          textFormat: 'plainText', ...(pageToken && { pageToken }),
        }, key);
        for (const t of c.items || []) {
          const s = t.snippet.topLevelComment.snippet;
          comments.push({
            author: s.authorDisplayName,
            text: s.textDisplay,
            likes: s.likeCount,
            publishedAt: s.publishedAt,
            replies: t.snippet.totalReplyCount,
          });
        }
        pageToken = c.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      if (e.reason === 'commentsDisabled') commentsDisabled = true;
      else throw e;
    }

    // 단어 빈도
    const freq = new Map();
    for (const c of comments) for (const w of tokenize(c.text)) freq.set(w, (freq.get(w) || 0) + 1);
    const words = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);

    const st = item.statistics;
    return json({
      id,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      stats: {
        views: Number(st.viewCount || 0),
        likes: st.likeCount != null ? Number(st.likeCount) : null, // 비공개일 수 있음
        comments: st.commentCount != null ? Number(st.commentCount) : null,
      },
      commentsDisabled,
      analyzedComments: comments.length,
      topComments: [...comments].sort((a, b) => b.likes - a.likes).slice(0, 10),
      words,
    });
  } catch (e) {
    const quota = e.reason === 'quotaExceeded';
    return json({ error: quota ? 'YouTube API 일일 할당량을 초과했습니다.' : e.message }, quota ? 429 : 502);
  }
}
