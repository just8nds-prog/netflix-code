// server.js — Netflix Code (Render-compatible version)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const { google } = require("googleapis");
const dayjs = require("dayjs");
require("dayjs/locale/vi");

const app = express();
app.set("trust proxy", 1); // ✅ Fix Render proxy issue
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// ===== Rate limit =====
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
});
app.use(["/request-link", "/auth"], limiter);

// ===== Gmail OAuth =====
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback"
);

const TOKENS_PATH =
  process.env.TOKENS_PATH ||
  (process.env.RENDER ? "/tmp/tokens.json" : path.join(__dirname, "tokens.json"));

// ✅ Load token từ Render Env trước
function loadTokensIfAny() {
  try {
    if (process.env.TOKENS_JSON) {
      const tokens = JSON.parse(process.env.TOKENS_JSON);
      oAuth2Client.setCredentials(tokens);
      console.log("✅ Loaded tokens from env TOKENS_JSON");
      return true;
    }
    if (fs.existsSync(TOKENS_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
      oAuth2Client.setCredentials(tokens);
      console.log("✅ Loaded tokens from file:", TOKENS_PATH);
      return true;
    }
  } catch (e) {
    console.warn("⚠️ loadTokensIfAny error:", e.message);
  }
  return false;
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
    console.log("💾 Saved tokens to:", TOKENS_PATH);
  } catch (e) {
    console.warn("⚠️ Cannot write tokens file:", e.message);
  }
}

// ===== Auth =====
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    prompt: "consent",
  });
  console.log("🔍 AUTH_URL =", url);
  res.send(`
    <h3>🔗 URL ủy quyền đã được in ra terminal (PowerShell)</h3>
    <p>Hoặc click <a href="${url}" target="_blank">tại đây để đăng nhập Gmail</a>.</p>
  `);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);
    console.log("====== TOKEN JSON START ======");
    console.log(JSON.stringify(tokens, null, 2));
    console.log("====== TOKEN JSON END ======");
    saveTokens(tokens);
    res.send("✅ Đăng nhập Gmail thành công! Token đã lưu (xem log Render).");
  } catch (err) {
    res.status(500).send("OAuth lỗi: " + (err.message || err));
  }
});

// ===== CODE LIST =====
const rawCodes = (process.env.CODE_LIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const codeStore = new Map(rawCodes.map((c) => [c, true]));

// ===== Gmail fetch =====
async function fetchNetflixConfirmLinkWithMeta() {
  if (!loadTokensIfAny()) {
    throw new Error("Server chưa được admin đăng nhập Gmail. Vào /auth trước.");
  }
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  const q = [
    "newer_than:60d",
    "(from:no-reply@netflix.com OR from:@mailer.netflix.com)",
    "(subject:'Lưu ý quan trọng: Cách cập nhật Hộ gia đình Netflix')",
  ].join(" ");

  const list = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 5,
  });
  const msgs = list.data.messages || [];
  if (!msgs.length)
    throw new Error("Không thấy email Netflix phù hợp trong 60 ngày.");

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: msgs[0].id,
    format: "full",
  });

  const headers = msg.data.payload.headers || [];
  const subject = headers.find((h) => h.name === "Subject")?.value || "";
  const from = headers.find((h) => h.name === "From")?.value || "";
  const date = headers.find((h) => h.name === "Date")?.value || "";

  // Lấy link "Đúng, đây là tôi"
  const parts = [];
  function collectParts(p) {
    if (!p) return;
    if (p.parts) p.parts.forEach(collectParts);
    else if (p.body?.data) {
      const text = Buffer.from(p.body.data, "base64").toString("utf8");
      parts.push(text);
    }
  }
  collectParts(msg.data.payload);
  const allText = parts.join(" ");
  const match = allText.match(
    /(https?:\/\/[^\s"'<>]*netflix[^\s"'<>]*update-primary-location[^\s"'<>]*)/i
  );
  const link = match ? match[0] : null;

  return {
    subject,
    from,
    date,
    link,
  };
}

// ===== UI =====
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lấy code Netflix</title>
<style>
  body{background:#0b0e13;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;padding:0}
  .card{max-width:480px;margin:6vh auto;padding:22px;border-radius:14px;background:#0f141b;border:1px solid #ffffff10}
  input,button{padding:12px;border-radius:10px;border:1px solid #ffffff10;background:#10161f;color:#fff;font-size:16px;width:100%;box-sizing:border-box}
  button{background:#e50914;border-color:#e50914;cursor:pointer;font-weight:600}
  button:hover{background:#b0060f}
  .muted{color:#9aa4b2;font-size:14px}
  .row{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
  .col{flex:1 1 100%}
  @media(min-width:480px){.col{flex:1}}
</style>
</head>
<body>
  <div class="card">
    <h2>Lấy code Netflix</h2>
    <p class="muted">Nhập <b>mã đơn hàng Netflix</b> để xem email mới nhất.</p>
    <div class="row">
      <input id="code" placeholder="Nhập mã đơn hàng Netflix">
      <button id="btn">Lấy code</button>
    </div>
    <div id="msg" class="row muted"></div>
    <div id="result" class="row"></div>
  </div>
<script>
  document.getElementById('btn').onclick = async () => {
    const code = document.getElementById('code').value.trim();
    const msg = document.getElementById('msg');
    const result = document.getElementById('result');
    msg.textContent = ''; result.innerHTML = '';
    if (!code) { msg.textContent = 'Vui lòng nhập mã.'; return; }
    msg.textContent = 'Đang kiểm tra...';
    try {
      const r = await fetch('/request-link', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ code })
      });
      const data = await r.json();
      if (!r.ok) { msg.textContent = data.message || 'Lỗi'; return; }
      msg.textContent = '';
      const dateVN = new Date(data.date).toLocaleString('vi-VN');
      result.innerHTML = '<div style="background:#071022;padding:14px;border-radius:8px;">'
        + '<div><b>Tiêu đề:</b> ' + (data.subject||'') + '</div>'
        + '<div><b>Thời gian gửi:</b> ' + dateVN + '</div>'
        + '<div style="margin-top:10px;text-align:center">'
        + '<a href="' + data.link + '" target="_blank" rel="noreferrer">'
        + '<button style="width:100%;padding:12px;background:#e50914;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:bold">Lấy code Netflix</button>'
        + '</a></div></div>';
    } catch(e) {
      msg.textContent = 'Không thể kết nối máy chủ.';
    }
  };
</script>
</body>
</html>`);
});

// ===== API =====
app.post("/request-link", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ message: "Thiếu mã." });
    if (!codeStore.has(code))
      return res.status(403).json({ message: "Mã không hợp lệ." });

    const info = await fetchNetflixConfirmLinkWithMeta();
    if (!info.link)
      return res.status(404).json({ message: "Không tìm thấy link trong email gần nhất." });
    return res.json(info);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi xử lý: " + (err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server chạy ở http://localhost:${PORT}`);
  console.log("→ Admin vào /auth (1 lần) để lưu token Gmail trước khi khách sử dụng.");
});
