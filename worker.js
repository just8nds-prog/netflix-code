export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(renderUI(), {
        headers: { "content-type": "text/html;charset=utf-8" }
      });
    }

    if (url.pathname === "/request-link" && req.method === "POST") {
      return handleRequestLink(req, env);
    }

    if (url.pathname === "/auth") {
      return handleAuth(env);
    }

    if (url.pathname === "/oauth2callback") {
      return handleOAuthCallback(url, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

// ================= UI =================
function renderUI() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lấy code Netflix</title>
<style>
:root {
  --bg:#0b0e13;
  --card:#0f141b;
  --input:#10161f;
  --muted:#9aa4b2;
  --red:#e50914;
}
*{box-sizing:border-box}
body{
  background:var(--bg);
  color:#fff;
  font-family:system-ui;
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:16px;
}
.card{
  width:100%;
  max-width:420px;
  background:var(--card);
  padding:24px;
  border-radius:16px;
  box-shadow:0 20px 50px rgba(0,0,0,.4);
}
h2{text-align:center;margin:0 0 8px}
.muted{
  color:var(--muted);
  font-size:14px;
  text-align:center;
  margin-bottom:16px;
}
.field{margin-bottom:14px}
input{
  width:100%;
  padding:14px;
  border-radius:12px;
  border:none;
  background:var(--input);
  color:#fff;
  font-size:16px;
}
button{
  width:100%;
  padding:14px;
  border-radius:12px;
  border:none;
  background:var(--red);
  color:#fff;
  font-size:16px;
  font-weight:600;
  cursor:pointer;
}
button:hover{opacity:.9}
#out{margin-top:16px;font-size:14px}
.result{
  background:#0b1018;
  border-radius:12px;
  padding:14px;
}
</style>
</head>
<body>
<div class="card">
  <h2>Lấy code Netflix</h2>
  <p class="muted">Nhập mã để lấy link Netflix</p>

  <div class="field">
    <input id="code" placeholder="Nhập mã đơn hàng">
  </div>

  <button onclick="go()">Lấy code</button>
  <div id="out"></div>
</div>

<script>
async function go(){
  const code = document.getElementById('code').value.trim();
  const out = document.getElementById('out');
  out.textContent = "Đang kiểm tra...";

  try {
    const r = await fetch('/request-link', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ code })
    });

    const d = await r.json();
    if(!r.ok){
      out.textContent = d.message || "Lỗi không xác định";
      return;
    }

    const time = d.date ? new Date(d.date).toLocaleString("vi-VN") : "";

    out.innerHTML = \`
      <div class="result">
        <div><b>Tiêu đề:</b> \${d.subject || ""}</div>
        <div style="margin-top:6px"><b>Thời gian gửi:</b> \${time}</div>
        <div style="margin-top:14px">
          <form method="GET" action="\${d.link}" target="_top">
            <button>Lấy code Netflix</button>
          </form>
        </div>
      </div>
    \`;
  } catch(e) {
    out.textContent = "Không thể kết nối máy chủ";
  }
}
</script>
</body>
</html>`;
}

// ================= AUTH =================
function handleAuth(env) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent"
  });

  return Response.redirect(
    "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString(),
    302
  );
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });

  const tokens = await tokenRes.json();
  await env.TOKENS_KV.put("gmail_tokens", JSON.stringify(tokens));

  return new Response("✅ Gmail connected! You can close this tab.");
}

// ================= API =================
async function handleRequestLink(req, env) {
  const { code } = await req.json();
  const list = (env.CODE_LIST || "").split(",");

  if (!list.includes(code)) {
    return json({ message: "Mã không hợp lệ" }, 403);
  }

  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    return json({ message: "Chưa kết nối Gmail. Vào /auth để đăng nhập lần đầu" }, 500);
  }

  const msg = await fetchLatestNetflixMail(accessToken);
  if (!msg) {
    return json({ message: "Không tìm thấy mail Netflix" }, 404);
  }

  return json(msg);
}

// ================= TOKEN AUTO REFRESH =================
async function getValidAccessToken(env) {
  const raw = await env.TOKENS_KV.get("gmail_tokens");
  if (!raw) return null;

  let tokens = JSON.parse(raw);

  // Test token hiện tại
  const test = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  );

  if (test.status !== 401) {
    return tokens.access_token;
  }

  // Refresh token
  if (!tokens.refresh_token) return null;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token"
    })
  });

  const newTokens = await res.json();
  tokens.access_token = newTokens.access_token;
  tokens.expires_in = newTokens.expires_in;

  await env.TOKENS_KV.put("gmail_tokens", JSON.stringify(tokens));

  return tokens.access_token;
}

// ================= GMAIL FETCH =================
async function fetchLatestNetflixMail(accessToken) {
  const q = encodeURIComponent(
    'newer_than:7d from:account.netflix.com subject:(Netflix)'
  );

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const list = await listRes.json();
  if (!list.messages?.length) return null;

  for (const m of list.messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const msg = await msgRes.json();
    const headers = msg.payload.headers || [];

    const subject = headers.find(h => h.name === "Subject")?.value || "";
    const date = headers.find(h => h.name === "Date")?.value || "";

    const parts = [];
    collectParts(msg.payload, parts);
    const all = parts.join(" ");

    const links =
      all.match(/https:\/\/www\.netflix\.com\/account\/[^\s"'<>]*/gi) || [];

    const link = links[0] || null;

    if (link) {
      return { subject, link, date };
    }
  }

  return null;
}

// ================= HELPERS =================
function decodeBase64Url(str) {
  if (!str) return "";
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  try {
    return atob(str);
  } catch {
    return "";
  }
}

function collectParts(p, out) {
  if (!p) return;
  if (p.parts) p.parts.forEach(x => collectParts(x, out));
  if (p.body?.data) out.push(decodeBase64Url(p.body.data));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
