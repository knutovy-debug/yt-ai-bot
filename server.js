require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ JSON-БАЗА ДАННЫХ ============
const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], settings: [] }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { users: [], settings: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ============ ПОДКЛЮЧЕНИЯ ============
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1'
});

let youtubeTokens = {
  access_token: null,
  refresh_token: null
};

// ============ РЕГИСТРАЦИЯ ============
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }

  const db = readDB();

  if (db.users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: Date.now().toString(),
    email,
    password: hashedPassword,
    created_at: new Date().toISOString()
  };

  db.users.push(newUser);
  db.settings.push({ user_id: newUser.id, tone: 'дружелюбный', max_length: 30, check_interval: 5 });

  writeDB(db);

  res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
});

// ============ ВХОД ============
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }

  const db = readDB();
  const user = db.users.find(u => u.email === email);

  if (!user) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const settings = db.settings.find(s => s.user_id === user.id) || { tone: 'дружелюбный', max_length: 30, check_interval: 5 };

  res.json({
    success: true,
    user: { id: user.id, email: user.email },
    settings
  });
});

// ============ СТАТУС ============
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    ai: 'DeepSeek готов',
    youtube: youtubeTokens.access_token ? 'подключён' : 'не подключён',
    comments: 0,
    interval: 5
  });
});

// ============ YOUTUBE ============
app.get('/auth/youtube', (req, res) => {
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: 'http://localhost:3000/auth/youtube/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
      access_type: 'offline',
      prompt: 'consent'
    });
  res.redirect(authUrl);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send('❌ Ошибка: код не получен');
  }

  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'http://localhost:3000/auth/youtube/callback',
      grant_type: 'authorization_code'
    });

    youtubeTokens.access_token = tokenResponse.data.access_token;
    youtubeTokens.refresh_token = tokenResponse.data.refresh_token;

    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: {
        part: 'snippet',
        mine: true,
        access_token: youtubeTokens.access_token
      }
    });

    const channelName = channelResponse.data.items[0]?.snippet?.title || 'Неизвестный канал';

    res.send(`
      <h1>✅ Канал "${channelName}" подключен!</h1>
      <p><a href="/dashboard.html">📊 Перейти в панель управления</a></p>
      <p><a href="/api/test-reply">▶️ Проверить ответы</a></p>
    `);

  } catch (error) {
    res.send('❌ Ошибка подключения: ' + error.message);
  }
});

// ============ AI ОТВЕТ ============
app.post('/api/process-comment', async (req, res) => {
  const { commentText, channelName, tone } = req.body;

  if (!commentText) {
    return res.status(400).json({ error: 'Нет текста' });
  }

  try {
    const prompt = `
      Ты ассистент YouTube-канала "${channelName || 'блогер'}".
      Отвечай на комментарии. Тон: ${tone || 'дружелюбный'}.
      Комментарий: "${commentText}"
      Ответь коротко, до 30 слов, с вопросом в конце.
    `;

    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: commentText }],
      max_tokens: 150,
      temperature: 0.7
    });

    res.json({ success: true, reply: response.choices[0].message.content.trim() });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ ТЕСТОВЫЙ ОТВЕТ ============
app.get('/api/test-reply', async (req, res) => {
  if (!youtubeTokens.access_token) {
    return res.json({ error: 'Подключи YouTube через /auth/youtube' });
  }

  try {
    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: youtubeTokens.access_token }
    });

    const channelId = channelRes.data.items[0]?.id;

    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId: channelId,
        order: 'date',
        maxResults: 1,
        type: 'video',
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (!searchRes.data.items || searchRes.data.items.length === 0) {
      return res.json({ error: 'Нет видео на канале' });
    }

    const videoId = searchRes.data.items[0].id.videoId;

    const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: {
        part: 'snippet',
        videoId: videoId,
        maxResults: 5,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (!commentsRes.data.items || commentsRes.data.items.length === 0) {
      return res.json({ message: 'Нет комментариев' });
    }

    let replied = 0;
    for (const item of commentsRes.data.items) {
      const commentId = item.id;
      const commentText = item.snippet.topLevelComment.snippet.textDisplay;

      try {
        const prompt = `
          Ты ассистент YouTube-канала.
          Отвечай на комментарии дружелюбно.
          Комментарий: "${commentText}"
          Ответь коротко, до 30 слов, с вопросом в конце.
        `;

        const aiRes = await deepseek.chat.completions.create({
          model: 'deepseek-chat',
          messages: [{ role: 'system', content: prompt }, { role: 'user', content: commentText }],
          max_tokens: 150,
          temperature: 0.7
        });

        await axios.post(
          'https://www.googleapis.com/youtube/v3/comments',
          {
            snippet: {
              parentId: commentId,
              textOriginal: aiRes.choices[0].message.content.trim()
            }
          },
          {
            params: {
              part: 'snippet',
              access_token: youtubeTokens.access_token
            }
          }
        );

        replied++;
      } catch (e) {
        console.log('Ошибка:', e.message);
      }
    }

    res.json({ status: `✅ Ответил на ${replied} комментариев` });

  } catch (error) {
    res.json({ error: error.message });
  }
});

// ============ НАСТРОЙКИ ============
app.post('/api/settings', async (req, res) => {
  const { tone } = req.body;
  res.json({ success: true });
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
  console.log(`📝 Тон ответа: ${process.env.BOT_TONE || 'дружелюбный'}`);
});