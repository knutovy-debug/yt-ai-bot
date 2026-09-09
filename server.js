require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey123';
const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({
        users: [], settings: [], lastCheck: {}, transcripts: {},
        weekReplies: 0, videosProcessed: 0, moderatedCount: 0,
        replyLog: [], pinnedComments: [], videoIdeas: [], competitors: [],
        subscriptions: [], payments: [], processedCommentIds: [],
        channels: [], reviews: []
      }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {
      users: [], settings: [], lastCheck: {}, transcripts: {},
      weekReplies: 0, videosProcessed: 0, moderatedCount: 0,
      replyLog: [], pinnedComments: [], videoIdeas: [], competitors: [],
      subscriptions: [], payments: [], processedCommentIds: [],
      channels: [], reviews: []
    };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const PLANS = {
  free: { name: 'Бесплатный', price: 0, commentsPerMonth: 50, channels: 1 },
  blogger: { name: 'Блогер', price: 1990, commentsPerMonth: 500, channels: 1 },
  pro: { name: 'Профи', price: 4990, commentsPerMonth: 9999, channels: 3 }
};

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1'
});

const BAD_WORDS = ['хуй', 'пизда', 'бля', 'еба', 'залупа', 'мудак', 'пидор', 'гандон', 'шлюха', 'сучка', 'ублюдок', 'тварь', 'дебил', 'идиот', 'кретин', 'долбоёб', 'нахуй', 'похуй', 'ебать', 'блядь', 'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'dick', 'pussy'];
function isToxic(text) { const lower = text.toLowerCase(); for (const word of BAD_WORDS) { if (lower.includes(word)) return true; } return false; }

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

async function getTranscript(videoId, accessToken) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  try {
    const captionsRes = await axios.get('https://www.googleapis.com/youtube/v3/captions', {
      params: { part: 'snippet', videoId: videoId, key: apiKey }
    });
    if (!captionsRes.data.items || captionsRes.data.items.length === 0) return null;
    let captionId = null;
    for (const item of captionsRes.data.items) {
      const lang = item.snippet.language;
      if (lang === 'ru' || lang === 'en') { captionId = item.id; break; }
    }
    if (!captionId) captionId = captionsRes.data.items[0].id;
    const transcriptRes = await axios.get(
      `https://www.googleapis.com/youtube/v3/captions/${captionId}`,
      { params: { tfmt: 'srt', access_token: accessToken } }
    );
    const lines = transcriptRes.data.split('\n');
    let text = [];
    for (const line of lines) {
      if (!line.match(/^\d+$/) && !line.includes('-->') && line.trim() !== '') {
        text.push(line.trim());
      }
    }
    const transcript = text.join(' ');
    return transcript.length > 100 ? transcript : null;
  } catch (error) { return null; }
}

async function generateReply(commentText, transcript, channelName, tone) {
  let context = '';
  if (transcript && transcript.length > 50) {
    context = `СОДЕРЖАНИЕ ВИДЕО (транскрипт):\n${transcript.substring(0, 8000)}\n\nИспользуй этот контекст, чтобы отвечать по делу.`;
  }
  const prompt = `
    Ты — ассистент YouTube-канала "${channelName || 'блогер'}". Отвечай на комментарии. Тон: ${tone || 'дружелюбный'}.
    ${context}
    КОММЕНТАРИЙ: "${commentText}"
    Правила: ответь коротко (до 35 слов), с вопросом в конце. Не говори, что ты бот.
  `;
  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: commentText }],
    max_tokens: 200,
    temperature: 0.8
  });
  return response.choices[0].message.content.trim();
}

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
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    success: true,
    token: token,
    user: { id: user.id, email: user.email },
    settings,
    subscription: sub
  });
});

app.get('/api/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const user = db.users.find(u => u.id === decoded.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    const settings = db.settings.find(s => s.user_id === user.id) || { tone: 'дружелюбный', max_length: 30, check_interval: 5, mode: 'all', manualVideoId: '' };
    const sub = db.subscriptions.find(s => s.user_id === user.id) || { plan: 'free', commentsUsed: 0 };
    const channels = (db.channels || []).filter(c => c.user_id === user.id);
    res.json({
      success: true,
      user: { id: user.id, email: user.email },
      settings,
      subscription: sub,
      channels: channels
    });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

app.get('/api/status', (req, res) => {
  const db = readDB();
  const sub = db.subscriptions[0] || { plan: 'free', commentsUsed: 0 };
  const plan = PLANS[sub.plan] || PLANS.free;
  const channelCount = (db.channels || []).filter(c => c.user_id === db.users[0]?.id).length || 0;
  res.json({
    status: 'ok',
    youtube: channelCount > 0 ? 'подключён' : 'не подключён',
    comments: Object.keys(db.lastCheck || {}).length,
    weekReplies: db.weekReplies || 0,
    videosProcessed: db.videosProcessed || 0,
    moderatedCount: db.moderatedCount || 0,
    plan: sub.plan,
    planName: plan.name,
    commentsUsed: sub.commentsUsed || 0,
    commentsLimit: plan.commentsPerMonth,
    channelCount: channelCount,
    maxChannels: plan.channels
  });
});

let currentOAuthUserId = null;

app.get('/auth/youtube', (req, res) => {
  const userId = req.query.userId;
  if (userId) currentOAuthUserId = userId;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: 'https://ytreply.ru/auth/youtube/callback',
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.force-ssl',
      access_type: 'offline',
      prompt: 'consent'
    });
  res.redirect(authUrl);
});

app.get('/auth/youtube/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('❌ Ошибка: код не получен');
  try {
    const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'https://ytreply.ru/auth/youtube/callback',
      grant_type: 'authorization_code'
    });
    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;

    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: accessToken }
    });

    if (!channelResponse.data.items || channelResponse.data.items.length === 0) {
      return res.send('❌ У этого аккаунта нет YouTube-канала');
    }

    const channelId = channelResponse.data.items[0].id;
    const channelName = channelResponse.data.items[0].snippet.title;

    const db = readDB();

    const existingChannel = (db.channels || []).find(c => c.channel_id === channelId);
    if (existingChannel) {
      existingChannel.access_token = accessToken;
      existingChannel.refresh_token = refreshToken;
      existingChannel.token_expires_at = new Date(Date.now() + 3600 * 1000).toISOString();
      writeDB(db);
      return res.send(`
        <h1>✅ Канал "${channelName}" уже был подключён!</h1>
        <p>Токены обновлены.</p>
        <p><a href="/dashboard.html">📊 Перейти в панель управления</a></p>
      `);
    }

    const userId = currentOAuthUserId || (db.users[0]?.id);
    if (!userId) {
      return res.send('❌ Ошибка: пользователь не найден. Сначала зарегистрируйся.');
    }

    const userChannels = (db.channels || []).filter(c => c.user_id === userId);
    const userSub = db.subscriptions.find(s => s.user_id === userId) || { plan: 'free' };
    const maxChannels = PLANS[userSub.plan]?.channels || 1;

    if (userChannels.length >= maxChannels) {
      return res.send(`
        <h1>❌ Достигнут лимит каналов</h1>
        <p>Твой тариф позволяет подключить максимум ${maxChannels} канал(ов).</p>
        <p><a href="/dashboard.html">📊 Перейти в панель управления</a></p>
      `);
    }

    if (!db.channels) db.channels = [];
    db.channels.push({
      user_id: userId,
      channel_id: channelId,
      channel_name: channelName,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    writeDB(db);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="refresh" content="2;url=/dashboard.html">
        <style>
          body { font-family: sans-serif; background: #0b0b0b; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; text-align: center; }
          .container { max-width: 500px; }
          h1 { color: #00c850; }
          p { color: #888; }
          .loader { width: 40px; height: 40px; border: 4px solid #1a1a1a; border-top: 4px solid #00c850; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="loader"></div>
          <h1>✅ Канал "${channelName}" подключен!</h1>
          <p>Теперь у тебя ${userChannels.length + 1} канал(ов) из ${maxChannels}.</p>
          <p><a href="/dashboard.html" style="color: #ff4d4d;">Перейти сейчас</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.send('❌ Ошибка: ' + error.message);
  }
});

app.get('/api/channels', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    const channels = (db.channels || []).filter(c => c.user_id === decoded.userId);
    res.json({ channels });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

app.delete('/api/channels/:channelId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    if (!db.channels) db.channels = [];
    const channelIndex = db.channels.findIndex(c => c.channel_id === req.params.channelId && c.user_id === decoded.userId);
    if (channelIndex === -1) return res.status(404).json({ error: 'Канал не найден' });
    db.channels.splice(channelIndex, 1);
    writeDB(db);
    res.json({ success: true });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

app.get('/api/reviews', (req, res) => {
  const db = readDB();
  if (!db.reviews) db.reviews = [];
  const approved = db.reviews.filter(r => r.approved !== false);
  res.json({ reviews: approved });
});

app.post('/api/reviews', async (req, res) => {
  const { name, text, rating } = req.body;
  if (!name || !text || !rating) {
    return res.status(400).json({ error: 'Имя, текст и оценка обязательны' });
  }
  const db = readDB();
  if (!db.reviews) db.reviews = [];
  db.reviews.push({
    id: Date.now().toString(),
    name: name.trim(),
    text: text.trim(),
    rating: parseInt(rating) || 5,
    approved: false,
    created_at: new Date().toISOString()
  });
  writeDB(db);
  await sendTelegram(`💬 НОВЫЙ ОТЗЫВ!\n\nАвтор: ${name}\nОценка: ${rating}⭐\nТекст: ${text}`);
  res.json({ success: true, message: 'Спасибо за отзыв! Он появится после проверки.' });
});

app.get('/api/admin/reviews', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = readDB();
    if (!db.reviews) db.reviews = [];
    res.json({ reviews: db.reviews });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

app.post('/api/admin/review/approve', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { reviewId } = req.body;
    if (!reviewId) return res.status(400).json({ error: 'Укажи ID' });
    const db = readDB();
    if (!db.reviews) db.reviews = [];
    const review = db.reviews.find(r => r.id === reviewId);
    if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
    review.approved = true;
    writeDB(db);
    res.json({ success: true });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

app.delete('/api/admin/review/:reviewId', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Нет токена' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { reviewId } = req.params;
    const db = readDB();
    if (!db.reviews) db.reviews = [];
    db.reviews = db.reviews.filter(r => r.id !== reviewId);
    writeDB(db);
    res.json({ success: true });
  } catch (error) {
    res.status(401).json({ error: 'Невалидный токен' });
  }
});

async function processComments() {
  const db = readDB();
  const channels = db.channels || [];
  if (channels.length === 0) return;

  const userSettings = db.settings[0] || { tone: 'дружелюбный', mode: 'all', manualVideoId: '' };
  const userSub = db.subscriptions[0] || { plan: 'free', commentsUsed: 0 };
  const plan = PLANS[userSub.plan] || PLANS.free;

  if (userSub.commentsUsed >= plan.commentsPerMonth) {
    console.log(`⚠️ Лимит комментариев исчерпан (${userSub.commentsUsed}/${plan.commentsPerMonth})`);
    return;
  }

  if (!db.processedCommentIds) db.processedCommentIds = [];

  let totalReplied = 0;

  for (const channel of channels) {
    const accessToken = channel.access_token;
    const channelName = channel.channel_name;
    const channelId = channel.channel_id;

    try {
      let videoIds = [];
      if (userSettings.mode === 'manual' && userSettings.manualVideoId) {
        videoIds = [userSettings.manualVideoId];
      } else if (userSettings.mode === 'latest') {
        const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: { part: 'snippet', channelId, order: 'date', maxResults: 1, type: 'video', key: process.env.YOUTUBE_API_KEY }
        });
        if (searchRes.data.items?.length > 0) videoIds = [searchRes.data.items[0].id.videoId];
      } else {
        const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: { part: 'snippet', channelId, order: 'date', maxResults: 50, type: 'video', key: process.env.YOUTUBE_API_KEY }
        });
        if (searchRes.data.items?.length > 0) videoIds = searchRes.data.items.map(item => item.id.videoId);
      }

      if (videoIds.length === 0) continue;

      for (const videoId of videoIds) {
        if (userSub.commentsUsed >= plan.commentsPerMonth) break;
        const lastCheck = db.lastCheck[videoId] || 0;
        let transcript = db.transcripts[videoId] || null;
        if (!transcript) { transcript = await getTranscript(videoId, accessToken); if (transcript) { db.transcripts[videoId] = transcript; writeDB(db); } }

        const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
          params: { part: 'snippet', videoId, maxResults: 20, key: process.env.YOUTUBE_API_KEY }
        });
        if (!commentsRes.data.items) continue;

        for (const item of commentsRes.data.items) {
          if (userSub.commentsUsed >= plan.commentsPerMonth) break;
          const commentId = item.id;
          const commentText = item.snippet.topLevelComment.snippet.textDisplay;
          const publishedAt = new Date(item.snippet.topLevelComment.snippet.publishedAt).getTime();

          if (db.processedCommentIds.includes(commentId)) continue;
          if (publishedAt <= lastCheck) continue;
          if (isToxic(commentText)) { db.moderatedCount = (db.moderatedCount || 0) + 1; continue; }

          try {
            const reply = await generateReply(commentText, transcript, channelName, userSettings.tone || 'дружелюбный');
            await axios.post('https://www.googleapis.com/youtube/v3/comments', {
              snippet: { parentId: commentId, textOriginal: reply }
            }, { params: { part: 'snippet', access_token: accessToken } });

            totalReplied++;
            userSub.commentsUsed = (userSub.commentsUsed || 0) + 1;
            db.weekReplies = (db.weekReplies || 0) + 1;
            db.replyLog.push({ comment: commentText, reply, videoId, channelName, timestamp: new Date().toISOString() });
            db.processedCommentIds.push(commentId);
            if (db.replyLog.length > 100) db.replyLog.shift();
            if (db.processedCommentIds.length > 500) db.processedCommentIds.shift();
          } catch (e) { console.log('Ошибка:', e.message); }
        }
        if (commentsRes.data.items.length > 0) { db.lastCheck[videoId] = Date.now(); db.videosProcessed = (db.videosProcessed || 0) + 1; }
      }
    } catch (error) {
      console.log(`❌ Ошибка с каналом ${channelName}:`, error.message);
    }
  }

  writeDB(db);
  if (totalReplied > 0) {
    await sendTelegram(`✅ Бот ответил на ${totalReplied} комментариев (по ${channels.length} каналам)\n📊 ${userSub.commentsUsed}/${plan.commentsPerMonth}`);
  }
}

app.get('/api/test-reply', async (req, res) => { await processComments(); res.json({ status: '✅ Проверка выполнена' }); });
app.get('/api/get-ideas', async (req, res) => { const db = readDB(); res.json({ ideas: db.videoIdeas || [] }); });
app.get('/api/get-competitors', async (req, res) => { const db = readDB(); res.json({ competitors: db.competitors || [] }); });
app.get('/api/video-ideas', async (req, res) => {
  const db = readDB();
  const allComments = db.replyLog || [];
  if (allComments.length === 0) return res.json({ error: 'Нет комментариев' });
  const commentsText = allComments.slice(0, 20).map(c => c.comment).join('\n');
  const prompt = `Проанализируй комментарии и предложи 5 идей для видео.\n${commentsText}`;
  try {
    const response = await deepseek.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Идеи' }],
      max_tokens: 500,
      temperature: 0.9
    });
    const ideas = response.choices[0].message.content.trim().split('\n').filter(line => line.trim());
    db.videoIdeas = ideas;
    writeDB(db);
    res.json({ ideas });
  } catch (error) { res.json({ error: error.message }); }
});
app.get('/api/test-drive', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({ error: 'Укажи videoId' });
  try {
    const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: { part: 'snippet', videoId: videoId, maxResults: 1, key: process.env.YOUTUBE_API_KEY }
    });
    if (!commentsRes.data.items || commentsRes.data.items.length === 0) return res.json({ error: 'Нет комментариев' });
    const commentText = commentsRes.data.items[0].snippet.topLevelComment.snippet.textDisplay;
    const reply = await generateReply(commentText, null, 'Тестовый канал', 'дружелюбный');
    res.json({ reply });
  } catch (error) { res.json({ error: error.message }); }
});
app.post('/api/create-payment', async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: 'Не указан пользователь или тариф' });
  const db = readDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Неверный тариф' });
  const paymentId = Date.now().toString() + userId.slice(-4);
  if (!db.payments) db.payments = [];
  db.payments.push({ id: paymentId, userId, email: user.email, plan, amount: planData.price, status: 'pending', created_at: new Date().toISOString() });
  writeDB(db);
  res.json({ paymentId, amount: planData.price, cardNumber: process.env.CARD_NUMBER || '2202 2003 1234 5678', cardHolder: process.env.CARD_HOLDER || 'IVAN IVANOV' });
});
app.post('/api/confirm-payment', async (req, res) => {
  const { userId, paymentId } = req.body;
  if (!userId || !paymentId) return res.status(400).json({ error: 'Укажи userId и paymentId' });
  const db = readDB();
  if (!db.payments) db.payments = [];
  const payment = db.payments.find(p => p.id === paymentId && p.userId === userId);
  if (!payment) return res.status(404).json({ error: 'Платёж не найден' });
  if (payment.status === 'paid') return res.json({ success: true, message: 'Подписка уже активна' });
  payment.status = 'pending_confirm';
  writeDB(db);
  await sendTelegram(`💳 НОВАЯ ЗАЯВКА НА ОПЛАТУ!\n\nПользователь: ${payment.email}\nТариф: ${PLANS[payment.plan].name}\nСумма: ${payment.amount} ₽\nID: ${paymentId}`);
  res.json({ success: true, message: '✅ Заявка отправлена! Активируем вручную.', requiresManual: true });
});
app.post('/api/admin-activate', async (req, res) => {
  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'Укажи email и план' });
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (!db.subscriptions) db.subscriptions = [];
  const existingSub = db.subscriptions.find(s => s.user_id === user.id);
  if (existingSub) {
    existingSub.plan = plan;
    existingSub.status = 'active';
    existingSub.commentsUsed = 0;
    existingSub.month = new Date().toISOString().slice(0, 7);
  } else {
    db.subscriptions.push({ user_id: user.id, plan, status: 'active', expires_at: null, commentsUsed: 0, month: new Date().toISOString().slice(0, 7) });
  }
  writeDB(db);
  await sendTelegram(`✅ Админ активировал тариф "${PLANS[plan].name}" для ${email}`);
  res.json({ success: true, message: `✅ Подписка "${PLANS[plan].name}" активирована для ${email}` });
});
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

setInterval(() => { processComments(); }, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
});
