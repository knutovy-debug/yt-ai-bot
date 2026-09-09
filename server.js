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
      fs.writeFileSync(DB_FILE, JSON.stringify({ 
        users: [], 
        settings: [],
        lastCheck: {},
        transcripts: {},
        weekReplies: 0,
        videosProcessed: 0,
        moderatedCount: 0,
        replyLog: [],
        subscriptions: [],
        payments: []
      }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { users: [], settings: [], lastCheck: {}, transcripts: {}, weekReplies: 0, videosProcessed: 0, moderatedCount: 0, replyLog: [], subscriptions: [], payments: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ============ ТАРИФЫ ============
const PLANS = {
  free: { name: 'Бесплатный', price: 0, commentsPerMonth: 50, channels: 1 },
  blogger: { name: 'Блогер', price: 1990, commentsPerMonth: 500, channels: 1 },
  pro: { name: 'Профи', price: 4990, commentsPerMonth: 9999, channels: 3 }
};

// ============ ПОДКЛЮЧЕНИЯ ============
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1'
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ============ TELEGRAM ============
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (e) { console.log('Telegram error:', e.message); }
}

// ============ ПОЛУЧИТЬ КОММЕНТАРИИ (без OAuth) ============
async function getComments(videoId) {
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: {
        part: 'snippet',
        videoId: videoId,
        maxResults: 20,
        key: YOUTUBE_API_KEY
      }
    });
    return response.data.items || [];
  } catch (error) {
    console.log('Ошибка получения комментариев:', error.message);
    return [];
  }
}

// ============ ГЕНЕРАЦИЯ ОТВЕТА ============
async function generateReply(commentText, channelName, tone) {
  const prompt = `
    Ты — ассистент YouTube-канала "${channelName || 'блогер'}".
    Отвечай на комментарии. Тон: ${tone || 'дружелюбный'}.
    КОММЕНТАРИЙ: "${commentText}"
    Ответь коротко, до 30 слов, с вопросом в конце. Не говори, что ты бот.
  `;
  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: commentText }],
    max_tokens: 200,
    temperature: 0.8
  });
  return response.choices[0].message.content.trim();
}

// ============ API ============

// РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  const db = readDB();
  if (db.users.find(u => u.email === email)) return res.status(400).json({ error: 'Пользователь уже существует' });
  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = { id: Date.now().toString(), email, password: hashedPassword, created_at: new Date().toISOString() };
  db.users.push(newUser);
  db.settings.push({ user_id: newUser.id, tone: 'дружелюбный', max_length: 30, check_interval: 5, mode: 'all', manualVideoId: '' });
  db.subscriptions.push({ user_id: newUser.id, plan: 'free', status: 'active', expires_at: null, commentsUsed: 0, month: new Date().toISOString().slice(0, 7) });
  writeDB(db);
  res.json({ success: true, user: { id: newUser.id, email: newUser.email } });
});

// ВХОД
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(401).json({ error: 'Неверный email или пароль' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Неверный email или пароль' });
  const settings = db.settings.find(s => s.user_id === user.id) || { tone: 'дружелюбный', max_length: 30, check_interval: 5, mode: 'all', manualVideoId: '' };
  const sub = db.subscriptions.find(s => s.user_id === user.id) || { plan: 'free', commentsUsed: 0 };
  res.json({ success: true, user: { id: user.id, email: user.email }, settings, subscription: sub });
});

// СТАТУС
app.get('/api/status', (req, res) => {
  const db = readDB();
  const sub = db.subscriptions[0] || { plan: 'free', commentsUsed: 0 };
  const plan = PLANS[sub.plan] || PLANS.free;
  res.json({
    status: 'ok',
    ai: 'DeepSeek готов',
    youtube: 'API-ключ настроен',
    comments: Object.keys(db.lastCheck).length,
    weekReplies: db.weekReplies || 0,
    videosProcessed: db.videosProcessed || 0,
    moderatedCount: db.moderatedCount || 0,
    plan: sub.plan,
    planName: plan.name,
    commentsUsed: sub.commentsUsed || 0,
    commentsLimit: plan.commentsPerMonth
  });
});

// ПОЛУЧИТЬ КОММЕНТАРИИ С ВИДЕО (без OAuth)
app.get('/api/fetch-comments', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({ error: 'Укажи videoId' });

  try {
    const comments = await getComments(videoId);
    const result = comments.map(item => ({
      id: item.id,
      text: item.snippet.topLevelComment.snippet.textDisplay,
      author: item.snippet.topLevelComment.snippet.authorDisplayName
    }));
    res.json({ success: true, comments: result });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// СГЕНЕРИРОВАТЬ ОТВЕТ (без публикации)
app.post('/api/generate-reply', async (req, res) => {
  const { commentText, channelName, tone } = req.body;
  if (!commentText) return res.status(400).json({ error: 'Нет текста' });

  try {
    const reply = await generateReply(commentText, channelName || 'Канал', tone || 'дружелюбный');
    res.json({ success: true, reply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ТЕСТ-ДРАЙВ
app.get('/api/test-drive', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({ error: 'Укажи videoId' });

  try {
    const comments = await getComments(videoId);
    if (!comments || comments.length === 0) {
      return res.json({ error: 'Нет комментариев' });
    }
    const commentText = comments[0].snippet.topLevelComment.snippet.textDisplay;
    const reply = await generateReply(commentText, 'Тестовый канал', 'дружелюбный');
    res.json({ reply });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ПОИСК ВИДЕО
app.get('/api/search-videos', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json({ error: 'Укажи запрос' });

  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: query,
        maxResults: 10,
        type: 'video',
        key: YOUTUBE_API_KEY
      }
    });
    const videos = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle
    }));
    res.json({ success: true, videos });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// НАСТРОЙКИ
app.post('/api/settings', async (req, res) => {
  const { tone, mode, manualVideoId } = req.body;
  const db = readDB();
  if (db.settings.length > 0) {
    db.settings[0].tone = tone || db.settings[0].tone;
    db.settings[0].mode = mode || db.settings[0].mode;
    db.settings[0].manualVideoId = manualVideoId || '';
  }
  writeDB(db);
  res.json({ success: true });
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
  console.log(`📝 Тон ответа: дружелюбный`);
  console.log(`🎯 Режим: только чтение комментариев (без OAuth)`);
});
