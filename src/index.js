// Cloudflare Workers の入口。/api/* はサーバー処理（src/api.js）、それ以外は public/ の画面をそのまま返す。
import { onRequestPost } from './api.js';

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')){
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status:405 });
      return onRequestPost({ request, env, params:{ action:url.pathname.slice('/api/'.length) } });
    }
    return env.ASSETS.fetch(request);
  }
};
