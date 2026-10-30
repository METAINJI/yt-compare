import { onRequestGet } from '../functions/api/analyze.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/analyze') return onRequestGet({ request, env });
    return env.ASSETS.fetch(request);
  },
};
