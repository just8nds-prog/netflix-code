// server.js — KH nhập mã -> xem thời gian email (tiếng Việt) + nút đỏ "Lấy code" để chuyển sang link Netflix
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret",
  resave: false,
  saveUninitialized: true
}));

// hạn chế spam API
const limiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 });
app.use(["/get-link"], limiter);

// ===== Gmail OAuth =====
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/oauth2callback"
);

const TOKENS_PATH = process.env.TOKENS_PATH || path.join(__dirname, "tokens.json");

// Base64 web-safe decoder (Gmail)
function b64decodeWebSafe(str) {
  if (!str) return "";
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  const fixed = pad ? s + "=".repeat(4 - pad) : s;
  return Buffer.from(fixed, "base64").toString("utf8");
}

function loadTokensIfAny() {
  if (fs.existsSync(TOKENS_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    oAuth2Client.setCredentials(tokens);
    return true;
  }
  return false;
}
function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), "utf8");
}

// ==== Auth routes ====
app.get("/auth", (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    prompt: "consent"
  });
  console.log("🔍 AUTH_URL =", url);
  res.send(`
    <h3>🔗 URL ủy quyền đã được in ra terminal (PowerShell)</h3>
    <p>Mở cửa sổ đang chạy <b>node server.js</b>, copy dòng bắt đầu bằng <code>AUTH_URL =</code> và dán vào trình duyệt để đăng nhập Gmail.</p>
  `);
});
app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);

    // ✅ In token ra log để bạn copy từ Render Logs
    console.log("====== TOKEN JSON START ======");
    console.log(JSON.stringify(tokens, null, 2));
    console.log("====== TOKEN JSON END ======");

    // Nếu có thể lưu file (local /tmp), vẫn lưu lại
    try {
      const savePath = process.env.TOKENS_PATH || "/tmp/tokens.json";
      fs.writeFileSync(savePath, JSON.stringify(tokens, null, 2), "utf8");
      console.log("✅ Token đã lưu vào:", savePath);
    } catch (e) {
      console.warn("⚠️ Không thể lưu file token:", e.message);
    }

    res.send(`
      ✅ Đăng nhập Gmail thành công!<br>
      <b>Hãy mở phần Logs trên Render để copy nội dung token.</b><br>
      Sau đó dán vào phần Environment Variable tên <code>TOKENS_JSON</code>.
    `);
  } catch (err) {
    console.error("❌ Lỗi OAuth:", err);
    res.status(500).send("OAuth lỗi: " + (err.message || err));
  }
});

// ===== Mã đơn =====
const rawCodes = (process.env.CODE_LIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const codeStore = new Map(rawCodes.map(c => [c, { used: false, usedAt: null }]));
function checkCode(code) {
  const rec = codeStore.get(code);
  if (!rec) return { ok: false, reason: "Mã không tồn tại." };
  return { ok: true }; // cho dùng nhiều lần
}

// ===== helper: trích nội dung email (ưu tiên HTML, đọc cả attachment) =====
async function extractEmailBody(gmail, messageId, payload) {
  let plainCandidate = null;

  async function walk(p) {
    if (!p) return null;

    // Ưu tiên text/html
    if (p.mimeType === "text/html") {
      if (p.body?.data) return b64decodeWebSafe(p.body.data);
      if (p.body?.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: p.body.attachmentId,
        });
        return b64decodeWebSafe(att.data.data);
      }
    }

    // Lưu text/plain dự phòng
    if (p.mimeType === "text/plain") {
      if (p.body?.data) plainCandidate = b64decodeWebSafe(p.body.data);
      else if (p.body?.attachmentId) {
        const att = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: p.body.attachmentId,
        });
        plainCandidate = b64decodeWebSafe(att.data.data);
      }
    }

    // Duyệt sâu
    if (p.parts && p.parts.length) {
      for (const child of p.parts) {
        const got = await walk(child);
        if (got) return got; // có HTML thì trả ngay
      }
    }

    // Một số mail để data ngay ở payload.body
    if (p.body?.data) return b64decodeWebSafe(p.body.data);
    if (p.body?.attachmentId) {
      const att = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: p.body.attachmentId,
      });
      return b64decodeWebSafe(att.data.data);
    }

    return null;
  }

  const html = await walk(payload);
  return html || plainCandidate || "";
}

// ===== Lấy link "Đúng, đây là tôi" + meta (từ email mới nhất) =====
async function fetchNetflixConfirmLinkWithMeta() {
  if (!loadTokensIfAny()) throw new Error("Server chưa được admin đăng nhập Gmail. Vào /auth trước.");
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

  // ưu tiên đúng sender/subject; thêm truy vấn rộng làm dự phòng
  const queries = [
    'newer_than:120d from:info@account.netflix.com "Lưu ý quan trọng: Cách cập nhật Hộ gia đình Netflix"',
    'newer_than:120d (from:@netflix.com OR from:@mailer.netflix.com) (subject:Netflix OR household OR cập OR update)'
  ];

  const rxButtonHtml = /<a[^>]*href="([^"]+)"[^>]*>(?:[\s\S]*?)Đúng,\s*đây\s*là\s*tôi(?:[\s\S]*?)<\/a>/i;
  const rxUrl = /https?:\/\/[^\s"'<>]*netflix\.com\/account\/update-primary-location[^\s"'<>]*/i;

  for (const q of queries) {
    const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 20 });
    const msgs = list.data.messages || [];
    for (const m of msgs) {
      const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });

      // meta
      const headers = full.data.payload.headers || [];
      const subject = (headers.find(h => h.name === "Subject") || {}).value || "";
      const from = (headers.find(h => h.name === "From") || {}).value || "";
      const date = (headers.find(h => h.name === "Date") || {}).value || "";

      const body = await extractEmailBody(gmail, m.id, full.data.payload);
      if (!body) continue;

      // 1) Bắt đúng nút HTML
      const mBtn = body.match(rxButtonHtml);
      if (mBtn?.[1]) return { link: mBtn[1], subject, from, date };

      // 2) Fallback: URL update-primary-location
      const mUrl = body.match(rxUrl);
      if (mUrl?.[0]) return { link: mUrl[0], subject, from, date };
    }
  }

  throw new Error("Không tìm thấy link 'Đúng, đây là tôi' trong email Netflix gần đây.");
}

// ===== Trang: nhập mã -> hiện thời gian tiếng Việt + nút đỏ "Lấy code" =====
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Lấy code Netflix</title>
<style>
  *{box-sizing:border-box}
  :root{--radius:12px; --h:48px}
  body{background:#0b0e13;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0}
  .card{
    width:min(520px,92vw);
    margin:6vh auto;
    padding:22px;
    border-radius:16px;
    background:#0f141b;
    border:1px solid #ffffff14
  }
  h2{margin:0 0 8px 0;font-size:26px;line-height:1.2}
  .muted{color:#9aa4b2;font-size:14px;margin:0 0 12px 0}
  .stack{display:grid;grid-template-columns:1fr;gap:12px}
  .control{
    width:100%;
    height:var(--h);
    border-radius:var(--radius);
    border:1px solid #ffffff20;
    background:#10161f;
    color:#fff;
    padding:0 14px;
    font-size:16px;
    outline:none;
  }
  .control::placeholder{color:#8a93a3}
  .btn{
    width:100%;
    height:var(--h);
    border-radius:var(--radius);
    border:1px solid #ffffff20;
    background:#1f2937;
    color:#fff;
    font-size:16px;
    cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center
  }
  .btn-red{background:#e50914;border-color:#e50914}
  .btn:active{transform:translateY(1px)}
  .meta{margin-top:10px;color:#9aa4b2}
  @media (max-width:480px){
    .card{padding:16px;border-radius:14px}
    h2{font-size:22px}
    :root{--h:46px;--radius:10px}
  }
</style>
</head>
<body>
  <div class="card">
    <h2>Lấy code Netflix</h2>
    <p class="muted">Nhập mã đơn hàng Netflix</p>

    <div class="stack">
      <input id="code" class="control" placeholder="Nhập mã (vd: ABC123)" />
      <button id="check" class="btn">Kiểm tra email</button>
    </div>

    <div id="meta" class="meta" style="display:none"></div>

    <button id="go" class="btn btn-red" style="display:none;margin-top:12px">Lấy code</button>
    <div id="msg" class="muted" style="margin-top:10px"></div>
  </div>

<script>
  let lastLink = null;

  document.getElementById('check').onclick = async () => {
    const code = document.getElementById('code').value.trim();
    const msg = document.getElementById('msg');
    const meta = document.getElementById('meta');
    const go = document.getElementById('go');
    msg.textContent = '';
    meta.style.display = 'none';
    meta.innerHTML = '';
    go.style.display = 'none';
    lastLink = null;

    if (!code) { msg.textContent = 'Vui lòng nhập mã.'; return; }
    msg.textContent = 'Đang lấy email mới nhất...';

    try {
      const r = await fetch('/get-link', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })});
      const data = await r.json();
      if (!r.ok) { msg.textContent = data.message || 'Không lấy được link.'; return; }
      lastLink = data.link;
      msg.textContent = '';
      meta.style.display = 'block';
      meta.innerHTML = '<div><b>Tiêu đề:</b> ' + (data.subject||'') + '</div>'
                     + '<div><b>From:</b> ' + (data.from||'') + '</div>'
                     + '<div><b>Thời gian gửi:</b> ' + (data.date_vi || data.date || '') + ' (giờ Việt Nam)</div>';
      go.style.display = 'block';
    } catch (e) {
      msg.textContent = 'Lỗi kết nối. Thử lại.';
    }
  };

  document.getElementById('go').onclick = () => {
    if (!lastLink) return;
    window.location.href = lastLink; // chỉ lúc bấm nút đỏ mới chuyển
  };
</script>
</body>
</html>`);
});

// ===== API: trả link + meta + date_vi (format tiếng Việt, giờ VN) =====
app.post("/get-link", async (req, res) => {
  try {
    const { code } = req.body || {};
    const check = checkCode(code);
    if (!check.ok) return res.status(403).json({ message: check.reason || "Mã không hợp lệ." });

    const info = await fetchNetflixConfirmLinkWithMeta(); // {link, subject, from, date}

    // Định dạng tiếng Việt (giờ VN) cho thời gian gửi
    let dateVi = "";
    try {
      const sentAt = new Date(info.date || Date.now());
      dateVi = new Intl.DateTimeFormat("vi-VN", {
        dateStyle: "full",
        timeStyle: "medium",
        timeZone: "Asia/Ho_Chi_Minh"
      }).format(sentAt);
    } catch (_) {}

    return res.json({ ...info, date_vi: dateVi });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi xử lý: " + (err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server chạy ở http://localhost:${PORT}`);
  console.log("→ Admin vào /auth (1 lần) để lưu token Gmail trước khi khách sử dụng.");
});
