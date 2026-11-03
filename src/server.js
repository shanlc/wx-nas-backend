/**
 * wx-nas-backend
 * 微信小程序自托管后端，目标部署环境：群晖 NAS Docker / Container Manager。
 *
 * 能力：
 *  1. 微信登录：wx.login() 拿到 code -> code2Session 换 openid -> 发 JWT
 *  2. 用户资料：GET/PUT /api/user/me
 *  3. 通用数据：/api/data/:collection，替代云开发数据库。
 *     每个集合按 openid 隔离：用户只能读写自己的记录（除非将来加管理员角色）。
 *  4. 文件上传/下载：/api/upload、/api/files/:id，替代云存储，文件落盘到 DATA_DIR/uploads
 *  5. 批量导入：/api/data/:collection/import，用于从微信云开发导出 JSON 后迁移
 *
 * 数据全部存在 SQLite 文件里：DATA_DIR/app.db，Docker 里把 DATA_DIR 映射到 NAS 文件夹即可持久化。
 * 不要把 WECHAT_SECRET / JWT_SECRET 写进代码或 Git，只放 .env / 群晖环境变量里。
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const JWT_SECRET = process.env.JWT_SECRET || '';
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';
const ALLOW_DEV_LOGIN = process.env.ALLOW_DEV_LOGIN === 'true';
const MAX_BODY = process.env.MAX_BODY || '5mb';

if (!JWT_SECRET) {
  console.error('[fatal] 请设置 JWT_SECRET 环境变量（随机长字符串），不要用默认值。');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    openid TEXT PRIMARY KEY,
    nickname TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    profile TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT NOT NULL,
    owner_openid TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_owner ON records(collection, owner_openid, id DESC);
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    owner_openid TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

const now = () => new Date().toISOString();
const safeCollection = (name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name);

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));

app.get('/health', (req, res) => res.json({ ok: true, time: now() }));

function signToken(openid) {
  return jwt.sign({ openid }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'unauthorized', message: '缺少 token，请先登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'unauthorized', message: 'token 无效或已过期' });
  }
}
function upsertUser(openid) {
  const t = now();
  db.prepare(`INSERT INTO users (openid, nickname, avatar_url, profile, created_at, updated_at)
    VALUES (?, '', '', '{}', ?, ?)
    ON CONFLICT(openid) DO UPDATE SET updated_at = excluded.updated_at`).run(openid, t, t);
  return db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);
}
function publicUser(row) {
  if (!row) return null;
  let profile = {};
  try { profile = JSON.parse(row.profile || '{}'); } catch { profile = {}; }
  return { openid: row.openid, nickname: row.nickname, avatarUrl: row.avatar_url, profile, createdAt: row.created_at, updatedAt: row.updated_at };
}

// ---- 微信登录 ----
app.post('/api/auth/login', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'bad_request', message: '缺少 code（wx.login() 返回的）' });
  if (!WECHAT_APPID || !WECHAT_SECRET) {
    return res.status(500).json({ error: 'not_configured', message: '服务器未配置 WECHAT_APPID / WECHAT_SECRET' });
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(WECHAT_APPID)}&secret=${encodeURIComponent(WECHAT_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.openid) {
    return res.status(400).json({ error: 'wechat_error', message: '微信换取 openid 失败', detail: data.errmsg || '' });
  }
  const user = upsertUser(data.openid);
  res.json({ token: signToken(data.openid), user: publicUser(user) });
});

// 仅本地联调用：生产部署必须保持 ALLOW_DEV_LOGIN=false
app.post('/api/auth/dev-login', (req, res) => {
  if (!ALLOW_DEV_LOGIN) return res.status(403).json({ error: 'forbidden', message: '未开启开发登录' });
  const { openid } = req.body || {};
  if (!openid) return res.status(400).json({ error: 'bad_request', message: '缺少 openid' });
  const user = upsertUser(String(openid));
  res.json({ token: signToken(String(openid)), user: publicUser(user) });
});

// ---- 用户资料 ----
app.get('/api/user/me', auth, (req, res) => {
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE openid = ?').get(req.user.openid)) });
});
app.put('/api/user/me', auth, (req, res) => {
  const { nickname = '', avatarUrl = '', profile = {} } = req.body || {};
  const t = now();
  db.prepare('UPDATE users SET nickname = ?, avatar_url = ?, profile = ?, updated_at = ? WHERE openid = ?')
    .run(String(nickname).slice(0, 100), String(avatarUrl).slice(0, 500), JSON.stringify(profile || {}), t, req.user.openid);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE openid = ?').get(req.user.openid)) });
});

// ---- 通用数据（替代云数据库） ----
app.post('/api/data/:collection', auth, (req, res) => {
  const { collection } = req.params;
  if (!safeCollection(collection)) return res.status(400).json({ error: 'bad_collection' });
  const t = now();
  const info = db.prepare('INSERT INTO records (collection, owner_openid, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(collection, req.user.openid, JSON.stringify(req.body || {}), t, t);
  res.json({ id: info.lastInsertRowid });
});
app.post('/api/data/:collection/import', auth, (req, res) => {
  const { collection } = req.params;
  if (!safeCollection(collection)) return res.status(400).json({ error: 'bad_collection' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 1000) return res.status(400).json({ error: 'bad_request', message: 'items 须为 1~1000 条的数组' });
  const t = now();
  const insert = db.prepare('INSERT INTO records (collection, owner_openid, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction(() => { for (const it of items) insert.run(collection, req.user.openid, JSON.stringify(it || {}), t, t); });
  tx();
  res.json({ imported: items.length });
});
app.get('/api/data/:collection', auth, (req, res) => {
  const { collection } = req.params;
  if (!safeCollection(collection)) return res.status(400).json({ error: 'bad_collection' });
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 20)));
  const total = db.prepare('SELECT COUNT(*) c FROM records WHERE collection = ? AND owner_openid = ?').get(collection, req.user.openid).c;
  const rows = db.prepare('SELECT * FROM records WHERE collection = ? AND owner_openid = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(collection, req.user.openid, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, list: rows.map(r => ({ id: r.id, ...JSON.parse(r.data), _createdAt: r.created_at, _updatedAt: r.updated_at })) });
});
app.get('/api/data/:collection/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM records WHERE id = ? AND collection = ? AND owner_openid = ?').get(req.params.id, req.params.collection, req.user.openid);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ id: row.id, ...JSON.parse(row.data) });
});
app.put('/api/data/:collection/:id', auth, (req, res) => {
  const info = db.prepare('UPDATE records SET data = ?, updated_at = ? WHERE id = ? AND collection = ? AND owner_openid = ?')
    .run(JSON.stringify(req.body || {}), now(), req.params.id, req.params.collection, req.user.openid);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});
app.delete('/api/data/:collection/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM records WHERE id = ? AND collection = ? AND owner_openid = ?')
    .run(req.params.id, req.params.collection, req.user.openid);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// ---- 文件上传/下载（替代云存储） ----
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 },
});
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'bad_request', message: '请以 form-data 的 file 字段上传' });
  const id = req.file.filename;
  db.prepare('INSERT INTO files (id, owner_openid, original_name, stored_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user.openid, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, now());
  res.json({ id, url: `/api/files/${id}`, originalName: req.file.originalname, size: req.file.size });
});
app.get('/api/files/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.owner_openid !== req.user.openid) return res.status(403).json({ error: 'forbidden' });
  res.sendFile(path.join(UPLOAD_DIR, row.stored_name));
});

app.use((req, res) => res.status(404).json({ error: 'not_found', message: '接口不存在' }));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`wx-nas-backend listening on ${PORT}, DATA_DIR=${DATA_DIR}`);
});
