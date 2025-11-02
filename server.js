// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage });

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// --- SQLite DB ---
const db = new sqlite3.Database(path.join(__dirname, 'db.sqlite'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author TEXT,
    text TEXT,
    community TEXT,
    created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    filename TEXT,
    mime TEXT,
    FOREIGN KEY(post_id) REFERENCES posts(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    type TEXT,
    user TEXT,
    created_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT,
    user TEXT,
    text TEXT,
    created_at INTEGER
  )`);
});

// --- Helpers ---
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

// --- API ---
// Create post (multipart: text, author, community, files...)
app.post('/api/posts', upload.array('files', 6), async (req, res) => {
  try {
    const { text = '', author = 'Anônimo', community = '' } = req.body;
    const id = uuidv4();
    const now = Date.now();
    await runAsync(`INSERT INTO posts (id, author, text, community, created_at) VALUES (?, ?, ?, ?, ?)`, [id, author, text, community, now]);

    const files = req.files || [];
    for (const f of files) {
      await runAsync(`INSERT INTO media (id, post_id, filename, mime) VALUES (?, ?, ?, ?)`, [uuidv4(), id, f.filename, f.mimetype]);
    }

    const post = await getAsync(`SELECT * FROM posts WHERE id = ?`, [id]);
    res.json({ success: true, post });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get paginated posts (feed global) — returns page & limit
app.get('/api/posts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(50, parseInt(req.query.limit || '8'));
    const offset = (page - 1) * limit;

    const rows = await allAsync(`SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
    // attach media, reaction counts, comment counts
    const posts = await Promise.all(rows.map(async (p) => {
      const media = await allAsync(`SELECT filename, mime FROM media WHERE post_id = ?`, [p.id]);
      const reactions = await allAsync(`SELECT type, COUNT(*) as cnt FROM reactions WHERE post_id = ? GROUP BY type`, [p.id]);
      const comments = await allAsync(`SELECT COUNT(*) as cnt FROM comments WHERE post_id = ?`, [p.id]);
      const reactionObj = {};
      reactions.forEach(r => reactionObj[r.type] = r.cnt);
      return {
        ...p,
        created_at: p.created_at,
        media: media.map(m => ({ url: `/uploads/${m.filename}`, mime: m.mime })),
        reactions: reactionObj,
        comments_count: comments[0] ? comments[0].cnt : 0
      };
    }));

    res.json({ success: true, page, limit, posts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete post
app.delete('/api/posts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // remove media files from disk
    const media = await allAsync(`SELECT filename FROM media WHERE post_id = ?`, [id]);
    for (const m of media) {
      const file = path.join(UPLOAD_DIR, m.filename);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    await runAsync(`DELETE FROM media WHERE post_id = ?`, [id]);
    await runAsync(`DELETE FROM reactions WHERE post_id = ?`, [id]);
    await runAsync(`DELETE FROM comments WHERE post_id = ?`, [id]);
    await runAsync(`DELETE FROM posts WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reaction (like / unlike) — simple append; client can call to toggle
app.post('/api/posts/:id/reactions', async (req, res) => {
  try {
    const post_id = req.params.id;
    const { type = 'like', user = 'anonymous' } = req.body;
    const id = uuidv4();
    const now = Date.now();
    await runAsync(`INSERT INTO reactions (id, post_id, type, user, created_at) VALUES (?, ?, ?, ?, ?)`, [id, post_id, type, user, now]);
    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Comments
app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const post_id = req.params.id;
    const { user = 'anonymous', text = '' } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Texto vazio' });
    const id = uuidv4();
    const now = Date.now();
    await runAsync(`INSERT INTO comments (id, post_id, user, text, created_at) VALUES (?, ?, ?, ?, ?)`, [id, post_id, user, text, now]);
    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single post fetch (optional)
app.get('/api/posts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const post = await getAsync(`SELECT * FROM posts WHERE id = ?`, [id]);
    if (!post) return res.status(404).json({ success: false, error: 'not found' });
    const media = await allAsync(`SELECT filename, mime FROM media WHERE post_id = ?`, [id]);
    post.media = media.map(m => ({ url: `/uploads/${m.filename}`, mime: m.mime }));
    res.json({ success: true, post });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API rodando em http://localhost:${PORT}`));
