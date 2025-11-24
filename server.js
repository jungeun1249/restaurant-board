const express = require('express');
const bodyParser = require('body-parser');
const methodOverride = require('method-override');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const expressLayouts = require('express-ejs-layouts');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

if (!fs.existsSync('./data')) fs.mkdirSync('./data');
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database(path.join(__dirname, 'data', 'board.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    profile_image TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    title TEXT,
    content TEXT,
    image TEXT,
    rating INTEGER,
    createdAt TEXT,
    lat REAL,
    lng REAL,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    postId INTEGER,
    userId INTEGER,
    content TEXT,
    createdAt TEXT,
    FOREIGN KEY(postId) REFERENCES posts(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  db.run(`ALTER TABLE posts ADD COLUMN lat REAL`, err => {
    if (err && !err.message.includes('duplicate column')) {
      console.error(err.message);
    }
  });

  db.run(`ALTER TABLE posts ADD COLUMN lng REAL`, err => {
    if (err && !err.message.includes('duplicate column')) {
      console.error(err.message);
    }
  });
});

app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(expressLayouts);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use(
  session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
  })
);

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

app.get('/register', (req, res) =>
  res.render('register', { title: '회원가입' })
);

app.post('/register', (req, res) => {
  const { username, password } = req.body;
  db.run(
    `INSERT INTO users (username, password) VALUES (?, ?)`,
    [username, String(password)],
    err => {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).send('이미 존재하는 사용자명입니다.');
        }
        return res.status(500).send('회원가입 실패');
      }
      res.send('회원가입 완료. <a href="/login">로그인하기</a>');
    }
  );
});

app.get('/login', (req, res) => res.render('login', { title: '로그인' }));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get(
    `SELECT * FROM users WHERE username = ? AND password = ?`,
    [username, password],
    (err, user) => {
      if (err) return res.status(500).send('DB 오류: ' + err.message);
      if (!user)
        return res
          .status(401)
          .send('로그인 실패: 아이디 또는 비밀번호가 틀렸습니다');
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.profileImage = user.profile_image;
      res.redirect('/');
    }
  );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/profile', requireLogin, (req, res) => {
  res.render('confirm-password', { title: '내 정보 확인' });
});

app.post('/profile', requireLogin, (req, res) => {
  const { password } = req.body;
  db.get(
    `SELECT * FROM users WHERE id = ?`,
    [req.session.userId],
    (err, user) => {
      if (err || !user) return res.redirect('/');
      if (user.password !== password) {
        return res.send(
          '<script>alert("비밀번호가 일치하지 않습니다.");history.back();</script>'
        );
      }
      res.render('profile', { title: '내 정보 수정', user });
    }
  );
});

app.put(
  '/profile',
  requireLogin,
  upload.single('profileImage'),
  (req, res) => {
    const { username, newPassword } = req.body;
    const profileImage = req.file ? req.file.filename : null;
    let sql = `UPDATE users SET username = ?`;
    const params = [username];
    if (newPassword && newPassword.trim()) {
      sql += `, password = ?`;
      params.push(newPassword);
    }
    if (profileImage) {
      sql += `, profile_image = ?`;
      params.push(profileImage);
    }
    sql += ` WHERE id = ?`;
    params.push(req.session.userId);

    db.run(sql, params, err => {
      if (err) return res.send('정보 수정 실패');
      req.session.username = username;
      if (profileImage) req.session.profileImage = profileImage;
      res.redirect('/');
    });
  }
);

app.delete('/profile', requireLogin, (req, res) => {
  db.run(
    `DELETE FROM users WHERE id = ?`,
    [req.session.userId],
    err => {
      if (err) return res.send('탈퇴 실패');
      req.session.destroy(() => res.redirect('/register'));
    }
  );
});

app.get('/', requireLogin, (req, res) => {
  const query = req.query.q ? req.query.q.trim() : '';
  const sort = req.query.sort || 'date';
  const orderKey = req.query.order === 'asc' ? 'asc' : 'desc';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const sortColumnMap = {
    title: 'posts.title',
    rating: 'posts.rating',
    date: 'posts.id'
  };
  const sortCol = sortColumnMap[sort] || sortColumnMap.date;
  let sql = `
    SELECT posts.*, users.username
    FROM posts
    JOIN users ON posts.userId = users.id
    ${query ? 'WHERE posts.title LIKE ? OR posts.content LIKE ?' : ''}
    ORDER BY ${sortCol} ${order}
  `;
  const params = query ? [`%${query}%`, `%${query}%`] : [];

  db.all(sql, params, (err, posts) => {
    if (err) return res.status(500).send('DB 오류');
    res.render('index', {
      title: '게시판 목록',
      posts,
      query,
      sort,
      order: orderKey
    });
  });
});

app.get('/write', requireLogin, (req, res) =>
  res.render('write', { title: '글쓰기' })
);

app.post(
  '/write',
  requireLogin,
  upload.single('image'),
  (req, res) => {
    const { title, content, rating, lat, lng } = req.body;
    const createdAt = new Date().toLocaleString();
    const userId = req.session.userId;
    const image = req.file ? req.file.filename : null;
    db.run(
      `INSERT INTO posts (userId, title, content, image, rating, createdAt, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, title, content, image, rating, createdAt, lat || null, lng || null],
      err => {
        if (err) return res.status(500).send('글 저장 실패');
        res.redirect('/');
      }
    );
  }
);

app.get('/post/:id', requireLogin, (req, res) => {
  const postId = req.params.id;
  db.get(
    `SELECT posts.*, users.username
     FROM posts
     JOIN users ON posts.userId = users.id
     WHERE posts.id = ?`,
    [postId],
    (err, post) => {
      if (err || !post) return res.status(404).send('해당 게시글이 없습니다.');
      db.all(
        `SELECT comments.*, users.username
         FROM comments
         JOIN users ON comments.userId = users.id
         WHERE postId = ?
         ORDER BY comments.id DESC`,
        [postId],
        (err, comments) => {
          if (err) return res.status(500).send('댓글 조회 실패');
          res.render('post', { title: post.title, post, comments });
        }
      );
    }
  );
});

app.post('/post/:id/comments', requireLogin, (req, res) => {
  const postId = req.params.id;
  const content = req.body.comment;
  const createdAt = new Date().toLocaleString();
  const userId = req.session.userId;
  db.run(
    `INSERT INTO comments (postId, userId, content, createdAt)
     VALUES (?, ?, ?, ?)`,
    [postId, userId, content, createdAt],
    err => {
      if (err) return res.status(500).send('댓글 저장 실패');
      res.redirect(`/post/${postId}`);
    }
  );
});

app.get('/comments/:id/edit', requireLogin, (req, res) => {
  const commentId = req.params.id;
  db.get(`SELECT * FROM comments WHERE id = ?`, [commentId], (err, comment) => {
    if (err || !comment || comment.userId !== req.session.userId)
      return res.status(403).send('권한이 없습니다.');
    res.render('edit-comment', { title: '댓글 수정', comment });
  });
});

app.put('/comments/:id', requireLogin, (req, res) => {
  const commentId = req.params.id;
  const content = req.body.content;
  db.get(`SELECT * FROM comments WHERE id = ?`, [commentId], (err, comment) => {
    if (err || !comment || comment.userId !== req.session.userId)
      return res.status(403).send('권한이 없습니다.');
    db.run(
      `UPDATE comments SET content = ? WHERE id = ?`,
      [content, commentId],
      err => {
        if (err) return res.status(500).send('댓글 수정 실패');
        res.redirect(`/post/${comment.postId}`);
      }
    );
  });
});

app.delete('/comments/:id', requireLogin, (req, res) => {
  const commentId = req.params.id;
  db.get(`SELECT * FROM comments WHERE id = ?`, [commentId], (err, comment) => {
    if (err || !comment || comment.userId !== req.session.userId)
      return res.status(403).send('권한이 없습니다.');
    db.run(`DELETE FROM comments WHERE id = ?`, [commentId], err => {
      if (err) return res.status(500).send('댓글 삭제 실패');
      res.redirect(`/post/${comment.postId}`);
    });
  });
});

app.get('/edit/:id', requireLogin, (req, res) => {
  db.get(`SELECT * FROM posts WHERE id = ?`, [req.params.id], (err, post) => {
    if (err || !post || post.userId !== req.session.userId)
      return res.status(403).send('권한이 없습니다.');
    res.render('edit', { post, title: '글 수정' });
  });
});

app.put(
  '/edit/:id',
  requireLogin,
  upload.single('image'),
  (req, res) => {
    const { title, content, rating, lat, lng } = req.body;
    const image = req.file ? req.file.filename : null;

    db.get(
      `SELECT * FROM posts WHERE id = ?`,
      [req.params.id],
      (err, post) => {
        if (err || !post || post.userId !== req.session.userId)
          return res.status(403).send('권한이 없습니다.');

        const updatedImage = image || post.image;
        db.run(
          `UPDATE posts
           SET title = ?, content = ?, image = ?, rating = ?, lat = ?, lng = ?
           WHERE id = ?`,
          [title, content, updatedImage, rating, lat || null, lng || null, req.params.id],
          err => {
            if (err) return res.status(500).send('수정 실패');
            res.redirect(`/post/${req.params.id}`);
          }
        );
      }
    );
  }
);

app.delete('/delete/:id', requireLogin, (req, res) => {
  const postId = req.params.id;
  db.get(`SELECT * FROM posts WHERE id = ?`, [postId], (err, post) => {
    if (err || !post || post.userId !== req.session.userId)
      return res.status(403).send('권한이 없습니다.');
    db.run(`DELETE FROM posts WHERE id = ?`, [postId], err => {
      if (err) return res.status(500).send('글 삭제 실패');
      db.run(`DELETE FROM comments WHERE postId = ?`, [postId], err => {
        if (err) return res.status(500).send('댓글 삭제 실패');
        res.redirect('/');
      });
    });
  });
});

app.listen(port, () => {
  console.log(`http://localhost:${port}`);
});
