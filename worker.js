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

// ===== UI =====
function renderUI() {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<title>Lấy code Netflix</title>
<style>
body{background:#0b0e13;color:#fff;font-family:system-ui;margin:0}
.card{max-width:480px;margin:6vh auto;padding:22px;border-radius:14px;background:#0f141b}
input,button{padding:12px;border-radius:10px;border:none;background:#10161f;color:#fff;width:100%}
button{background:#e50914;font-weight:600;cursor:pointer}
.muted{color:#9aa4b2;font-size:14px}
.badge{display:inline-block;padding:4px 8px;border-radius:8px;background:#10161f;margin-top:6px}
.timer{font-weight:bold;color:#ffcc00}
</style>
</head>
<body>
<div class="card">
  <h2>Lấy code Netflix</h2>
  <p class="muted">Nhập mã để lấy link Netflix</p>
  <input id="code" placeholder="Nhập mã">
  <button onclick="go()">Lấy code</button>
  <div id="out" class="muted"></div>
</div>

<script>
let countdown;

function startTimer(sentTime) {
  const out = document.getElementById('timer');
  clearInterval(countdown);

  const expire = new Date(sentTime).getTime() + 15 * 60 * 1000;

  countdown = setInterval(() => {
    const diff = expire - Date.now();
    if (diff <= 0) {
      out.textContent = "Hết hạn";
      clearInterval(countdown);
      return;
    }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    out.textContent = m + ":" + String(s).padStart(2, "0");
  }, 1000);
}

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
    const device = d.device || "Không xác định";

    out.innerHTML = \`
      <div style="margin-top:10px">
        <div><b>Tiêu đề:</b> \${d.subject || ""}</div>
        <div style="margin-top:4px"><b>Thời gian gửi:</b> \${time}</div>
        <div class="badge">Thiết bị: \${device}</div>
        <div style="margin-top:6px">
          Hết hạn sau: <span id="timer" class="timer">--:--</span>
        </div>
        <div style="margin-top:10px">
          <form method="GET" action="\${d.link}" target="_top">
            <button>Lấy code Netflix</button>
          </form>
        </div>
      </div>
    \`;

    if (d.date) startTimer(d.date);

  } catch(e) {
    out.textContent = "Không thể kết nối máy chủ";
  }
}
</script>
</body>
</html>`;
}

// ===== AUTH =====
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

// ===== API =====
async function handleRequestLink(req, env) {
  const { code } = await req.json();
  const list = (env.CODE_LIST || "").split(",");

  if (!list.includes(code)) {
    return json({ message: "Mã không hợp lệ" }, 403);
  }

  const tokensRaw = await env.TOKENS_KV.get("gmail_tokens");
  if (!tokensRaw) {
    return json({ message: "Chưa auth Gmail. Vào /auth trước" }, 500);
  }

  const tokens = JSON.parse(tokensRaw);

  const msg = await fetchLatestNetflixMail(tokens.access_token);
  if (!msg) return json({ message: "Không tìm thấy mail Netflix" }, 404);

  return json(msg);
}

// ===== GMAIL FETCH (SMART MODE) =====
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

    // Decode body
    const parts = [];
    collectParts(msg.payload, parts);
    const all = parts.join(" ");

    // Chỉ bắt link dạng:
    // https://www.netflix.com/account/....
    const links =
      all.match(/https:\/\/www\.netflix\.com\/account\/[^\s"'<>]*/gi) || [];

    const link = links[0] || null;

    if (link) {
      return { subject, link, date };
    }
  }

  return null;
}

// ===== UTILS =====
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });
}
