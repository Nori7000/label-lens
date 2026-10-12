// ラベルレンズのサーバー側（Cloudflare Pages Functions）。
//   POST /api/checkout  … 1週間無料お試し付きの定期購入（Stripe Checkout）を始める
//   POST /api/portal    … 契約の確認・解約（Stripe カスタマーポータル）
//   POST /api/webhook   … Stripe からの通知で会員状態を更新する
//   POST /api/read      … 会員だけ：袋の裏の写真を AI で読み取る
// 秘密のキーはすべて Cloudflare の環境変数に置く（README 参照）。ブラウザには出さない。

const DAILY_READS = 100;   // 1人1日あたりのAI読み取り上限（費用の上振れ防止）
const MAX_IMAGE = 4_000_000; // base64 の文字数上限

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers:{ 'Content-Type':'application/json' } });
const fail = (error, status = 400) => json({ error }, status);

export async function onRequestPost({ request, env, params }){
  try {
    switch (params.action){
      case 'checkout': return await checkout(request, env);
      case 'portal':   return await portal(request, env);
      case 'webhook':  return await webhook(request, env);
      case 'read':     return await read(request, env);
      default:         return fail('not_found', 404);
    }
  } catch(e){
    console.error(e);
    return fail('server_error', 500);
  }
}

/* ---------- Supabase ---------- */
function adminHeaders(env, extra = {}){
  const h = { apikey:env.SUPABASE_SERVICE_KEY, 'Content-Type':'application/json', ...extra };
  if (/^eyJ/.test(env.SUPABASE_SERVICE_KEY)) h.Authorization = 'Bearer ' + env.SUPABASE_SERVICE_KEY;
  return h;
}
const rest = (env, path) => env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
async function currentUser(request, env){
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (!token) return null;
  const r = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', { headers:{ apikey:env.SUPABASE_ANON_KEY, Authorization:'Bearer ' + token } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}
async function getSub(env, userId){
  const r = await fetch(rest(env, `ll_subscriptions?user_id=eq.${userId}&select=*`), { headers:adminHeaders(env) });
  const rows = r.ok ? await r.json() : [];
  return rows[0] || null;
}
async function upsertSub(env, row){
  const r = await fetch(rest(env, 'll_subscriptions?on_conflict=user_id'), { method:'POST',
    headers:adminHeaders(env, { Prefer:'resolution=merge-duplicates,return=minimal' }), body:JSON.stringify({ ...row, updated_at:new Date().toISOString() }) });
  if (!r.ok) throw new Error('upsert ll_subscriptions ' + r.status + ' ' + await r.text());
}
const isMember = s => s && (s.status === 'trialing' || s.status === 'active') && new Date(s.current_period_end) > new Date();

/* ---------- Stripe ---------- */
function form(obj, prefix = '', out = new URLSearchParams()){
  for (const [k, v] of Object.entries(obj)){
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(env, path, body){
  const r = await fetch('https://api.stripe.com/v1/' + path, { method:'POST',
    headers:{ Authorization:'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type':'application/x-www-form-urlencoded' }, body:form(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('stripe ' + path + ' ' + r.status + ' ' + JSON.stringify(j.error || j));
  return j;
}

async function checkout(request, env){
  const user = await currentUser(request, env);
  if (!user) return fail('login', 401);
  const price = env.STRIPE_PRICE_MONTHLY;
  let sub = await getSub(env, user.id);
  if (isMember(sub)) return fail('already_member', 409);
  let customer = sub && sub.stripe_customer_id;
  if (!customer){
    customer = (await stripe(env, 'customers', { email:user.email, metadata:{ user_id:user.id } })).id;
    await upsertSub(env, { user_id:user.id, stripe_customer_id:customer });
  }
  const site = env.SITE_URL.replace(/\/$/, '');
  const trial = !(sub && sub.trial_used);
  const session = await stripe(env, 'checkout/sessions', {
    mode:'subscription', customer, client_reference_id:user.id, locale:'ja',
    line_items:{ 0:{ price, quantity:1 } },
    payment_method_collection:'always',
    subscription_data:{ metadata:{ user_id:user.id },
      trial_period_days:trial ? 7 : null,
      trial_settings:trial ? { end_behavior:{ missing_payment_method:'cancel' } } : null },
    success_url:site + '/?checkout=done', cancel_url:site + '/?checkout=cancel'
  });
  return json({ url:session.url });
}

async function portal(request, env){
  const user = await currentUser(request, env);
  if (!user) return fail('login', 401);
  const sub = await getSub(env, user.id);
  if (!sub || !sub.stripe_customer_id) return fail('no_customer', 404);
  const s = await stripe(env, 'billing_portal/sessions', { customer:sub.stripe_customer_id, return_url:env.SITE_URL, locale:'ja' });
  return json({ url:s.url });
}

/* Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${body}`)) */
async function verifyStripe(body, header, secret){
  const parts = Object.fromEntries((header || '').split(',').map(x => x.split('=')).filter(x => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = (header || '').split(',').filter(x => x.startsWith('v1=')).map(x => x.slice(3));
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + body)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}
async function webhook(request, env){
  const body = await request.text();
  if (!await verifyStripe(body, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET)) return fail('bad_signature', 400);
  const ev = JSON.parse(body);
  if (!/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) return json({ ok:true, ignored:ev.type });
  const s = ev.data.object;
  const userId = s.metadata && s.metadata.user_id;
  if (!userId) return json({ ok:true, ignored:'no user_id' });
  const item = s.items && s.items.data && s.items.data[0];
  const end = s.status === 'trialing' && s.trial_end ? s.trial_end : (s.current_period_end || (item && item.current_period_end) || 0);
  await upsertSub(env, {
    user_id:userId, stripe_customer_id:s.customer, stripe_subscription_id:s.id,
    status:ev.type.endsWith('deleted') ? 'canceled' : s.status,
    plan:item && item.price && item.price.recurring ? item.price.recurring.interval : null,
    current_period_end:new Date(end * 1000).toISOString(),
    cancel_at_period_end:!!s.cancel_at_period_end,
    trial_used:true
  });
  return json({ ok:true });
}

/* ---------- AI reading (members only) ---------- */
const PROMPT = `画像は日本の食品パッケージの一括表示（名称・原材料名・栄養成分表示など）です。
画像に書かれている文字だけを書き写してください。推測で補ったり、言い換えたりしないでください。読めない項目は null にしてください。
次の形の JSON だけを返してください。
{"name": "商品名。なければ名称", "category": "「種類別」または「名称」欄の文字（例：ラクトアイス、清涼飲料水、木綿豆腐）", "ingredients": "原材料名の欄を、表示どおりに一続きで（「／」も含める）", "juice_percent": 果汁の%表示があれば数値、なければ null, "nutrition": {"per": "表示の単位（例：100g当たり）", "energy_kcal": 数値またはnull, "sugar_g": 糖質または糖類の数値またはnull, "carbs_g": 炭水化物の数値またはnull, "salt_g": 食塩相当量の数値またはnull}}`;
const num = v => v == null || v === '' || isNaN(Number(v)) ? null : Number(v);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

async function read(request, env){
  const user = await currentUser(request, env);
  if (!user) return fail('login', 401);
  if (!isMember(await getSub(env, user.id))) return fail('not_member', 403);
  const { image, jan } = await request.json().catch(() => ({}));
  if (typeof image !== 'string' || !image || image.length > MAX_IMAGE) return fail('bad_image', 400);

  // daily limit
  const JST = 9 * 3600e3, DAY = 86400e3;
  const since = new Date(Math.floor((Date.now() + JST) / DAY) * DAY - JST); // 0:00 JST today
  const cnt = await fetch(rest(env, `ll_reads?user_id=eq.${user.id}&at=gte.${since.toISOString()}&select=id`), { headers:adminHeaders(env, { Prefer:'count=exact', Range:'0-0' }) });
  const total = Number((cnt.headers.get('Content-Range') || '').split('/')[1] || 0);
  if (total >= DAILY_READS) return fail('too_many', 429);
  await fetch(rest(env, 'll_reads'), { method:'POST', headers:adminHeaders(env, { Prefer:'return=minimal' }), body:JSON.stringify({ user_id:user.id }) });

  const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST',
    headers:{ 'x-api-key':env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' },
    body:JSON.stringify({ model:env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens:1500,
      messages:[{ role:'user', content:[{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:image } }, { type:'text', text:PROMPT }] }] }) });
  if (!r.ok){ console.error('anthropic', r.status, await r.text()); return fail('ai_error', 502); }
  const out = await r.json();
  const text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  let d = null; try { d = m && JSON.parse(m[0]); } catch(e){}
  if (!d || !d.ingredients) return fail('no_ingredients', 422);
  const n = d.nutrition && typeof d.nutrition === 'object' ? d.nutrition : {};
  const label = { name:str(d.name, 80), category:str(d.category, 40), ingredients:str(d.ingredients, 2000), juice_percent:num(d.juice_percent),
    nutrition:{ per:str(n.per, 30), energy_kcal:num(n.energy_kcal), sugar_g:num(n.sugar_g), carbs_g:num(n.carbs_g), salt_g:num(n.salt_g) } };
  if (label.juice_percent != null && (label.juice_percent < 0 || label.juice_percent > 100)) label.juice_percent = null;

  let saved = false;
  if (typeof jan === 'string' && /^(\d{8}|\d{13})$/.test(jan)){
    const ins = await fetch(rest(env, 'll_products?on_conflict=jan'), { method:'POST',
      headers:adminHeaders(env, { Prefer:'resolution=ignore-duplicates,return=representation' }), body:JSON.stringify({ jan, ...label, added_by:user.id }) });
    saved = ins.ok && (await ins.json()).length > 0;
  }
  return json({ label, saved });
}
