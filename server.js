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
        pinnedComments: [],
        videoIdeas: [],
        competitors: [],
        subscriptions: [],
        payments: []
      }));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {
      users: [],
      settings: [],
      lastCheck: {},
      transcripts: {},
      weekReplies: 0,
      videosProcessed: 0,
      moderatedCount: 0,
      replyLog: [],
      pinnedComments: [],
      videoIdeas: [],
      competitors: [],
      subscriptions: [],
      payments: []
    };
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

let youtubeTokens = { access_token: null, refresh_token: null };

// ============ ФИЛЬТР ТОКСИЧНЫХ КОММЕНТАРИЕВ ============
const BAD_WORDS = ['хуй', 'пизда', 'бля', 'еба', 'залупа', 'мудак', 'пидор', 'гандон', 'шлюха', 'сучка', 'ублюдок', 'тварь', 'дебил', 'идиот', 'кретин', 'долбоёб', 'нахуй', 'похуй', 'ебать', 'блядь', 'fuck', 'shit', 'asshole', 'bitch', 'cunt', 'dick', 'pussy'];
function isToxic(text) { const lower = text.toLowerCase(); for (const word of BAD_WORDS) { if (lower.includes(word)) return true; } return false; }

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

// ============ ПОЛУЧИТЬ ТРАНСКРИПТ ============
async function getTranscript(videoId) {
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
      { params: { tfmt: 'srt', access_token: youtubeTokens.access_token } }
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

// ============ ГЕНЕРАЦИЯ ОТВЕТА ============
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

// ============ РЕГИСТРАЦИЯ ============
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

// ============ ВХОД ============
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

// ============ СТАТУС ============
app.get('/api/status', (req, res) => {
  const db = readDB();
  const sub = db.subscriptions[0] || { plan: 'free', commentsUsed: 0 };
  const plan = PLANS[sub.plan] || PLANS.free;
  res.json({
    status: 'ok',
    youtube: youtubeTokens.access_token ? 'подключён' : 'не подключён',
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

// ============ YOUTUBE OAuth ============
app.get('/auth/youtube', (req, res) => {
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
    youtubeTokens.access_token = tokenResponse.data.access_token;
    youtubeTokens.refresh_token = tokenResponse.data.refresh_token;
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: youtubeTokens.access_token }
    });
    const channelName = channelResponse.data.items[0]?.snippet?.title || 'Неизвестный канал';
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
          <p>Перенаправление в панель управления через 2 секунды...</p>
          <p><a href="/dashboard.html" style="color: #ff4d4d;">Перейти сейчас</a></p>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.send('❌ Ошибка: ' + error.message);
  }
});

// ============ ТЕСТ-ДРАЙВ ============
app.get('/api/test-drive', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({ error: 'Укажи videoId' });
  try {
    const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: { part: 'snippet', videoId: videoId, maxResults: 1, key: process.env.YOUTUBE_API_KEY }
    });
    if (!commentsRes.data.items || commentsRes.data.items.length === 0) return res.json({ error: 'Нет комментариев' });
    const commentText = commentsRes.data.items[0].snippet.topLevelComment.snippet.textDisplay;
    let transcript = null;
    try {
      const captionsRes = await axios.get('https://www.googleapis.com/youtube/v3/captions', {
        params: { part: 'snippet', videoId: videoId, key: process.env.YOUTUBE_API_KEY }
      });
      if (captionsRes.data.items && captionsRes.data.items.length > 0) transcript = 'Субтитры найдены';
    } catch (e) {}
    const reply = await generateReply(commentText, transcript, 'Тестовый канал', 'дружелюбный');
    res.json({ reply });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// ============ СОЗДАНИЕ ПЛАТЕЖА ============
app.post('/api/create-payment', async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: 'Не указан пользователь или тариф' });
  const db = readDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: 'Неверный тариф' });
  const paymentId = Date.now().toString() + userId.slice(-4);
  const payment = { id: paymentId, userId, email: user.email, plan, amount: planData.price, status: 'pending', created_at: new Date().toISOString() };
  db.payments.push(payment);
  writeDB(db);
  res.json({ paymentId, amount: planData.price, cardNumber: process.env.CARD_NUMBER || '2202 2003 1234 5678', cardHolder: process.env.CARD_HOLDER || 'IVAN IVANOV' });
});

// ============ ПОДТВЕРЖДЕНИЕ ОПЛАТЫ ============
app.post('/api/confirm-payment', async (req, res) => {
  const { userId, paymentId } = req.body;
  if (!userId || !paymentId) return res.status(400).json({ error: 'Укажи userId и paymentId' });
  const db = readDB();
  const payment = db.payments.find(p => p.id === paymentId && p.userId === userId);
  if (!payment) return res.status(404).json({ error: 'Платёж не найден' });
  if (payment.status === 'paid') return res.json({ success: true, message: 'Подписка уже активна' });
  payment.status = 'pending_confirm';
  writeDB(db);
  await sendTelegram(`💳 НОВАЯ ЗАЯВКА НА ОПЛАТУ!\n\nПользователь: ${payment.email}\nТариф: ${PLANS[payment.plan].name}\nСумма: ${payment.amount} ₽\nID: ${paymentId}`);
  res.json({ success: true, message: '✅ Заявка отправлена! Активируем вручную.', requiresManual: true });
});

// ============ АДМИН-АКТИВАЦИЯ ============
app.post('/api/admin-activate', async (req, res) => {
  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: 'Укажи email и план' });
  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
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

// ============ ПАРСИНГ КОНКУРЕНТОВ ============
app.get('/api/competitors', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json({ error: 'Укажи запрос' });
  try {
    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: { part: 'snippet', q: query, maxResults: 10, type: 'video', key: process.env.YOUTUBE_API_KEY }
    });
    const results = [];
    for (const item of searchRes.data.items) {
      const videoId = item.id.videoId;
      const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
        params: { part: 'snippet', videoId, maxResults: 5, key: process.env.YOUTUBE_API_KEY }
      });
      const comments = commentsRes.data.items?.map(c => c.snippet.topLevelComment.snippet.textDisplay) || [];
      results.push({ title: item.snippet.title, videoId, channelName: item.snippet.channelTitle, comments: comments.slice(0, 5) });
    }
    res.json({ results });
  } catch (error) { res.json({ error: error.message }); }
});

// ============ ГЕНЕРАЦИЯ ИДЕЙ ============
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

// ============ ЗАКРЕПЛЕНИЕ ============
app.get('/api/pin-comment', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.json({ error: 'Укажи videoId' });
  try {
    const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: { part: 'snippet', videoId, maxResults: 10, order: 'relevance', key: process.env.YOUTUBE_API_KEY }
    });
    if (!commentsRes.data.items || commentsRes.data.items.length === 0) return res.json({ error: 'Нет комментариев' });
    const best = commentsRes.data.items[0];
    res.json({ success: true, comment: best.snippet.topLevelComment.snippet.textDisplay });
  } catch (error) { res.json({ error: error.message }); }
});

// ============ ОСНОВНАЯ ФУНКЦИЯ ============
async function processComments() {
  if (!youtubeTokens.access_token) return;
  try {
    const db = readDB();
    const sub = db.subscriptions[0] || { plan: 'free', commentsUsed: 0 };
    const plan = PLANS[sub.plan] || PLANS.free;
    if (sub.commentsUsed >= plan.commentsPerMonth) return;
    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: youtubeTokens.access_token }
    });
    const channelId = channelRes.data.items[0]?.id;
    const channelName = channelRes.data.items[0]?.snippet?.title || 'Канал';
    const settings = db.settings[0] || { mode: 'all', manualVideoId: '' };
    let videoIds = [];
    if (settings.mode === 'manual' && settings.manualVideoId) {
      videoIds = [settings.manualVideoId];
    } else if (settings.mode === 'latest') {
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
    if (videoIds.length === 0) return;
    let totalReplied = 0;
    for (const videoId of videoIds) {
      if (sub.commentsUsed >= plan.commentsPerMonth) break;
      const lastCheck = db.lastCheck[videoId] || 0;
      let transcript = db.transcripts[videoId] || null;
      if (!transcript) { transcript = await getTranscript(videoId); if (transcript) { db.transcripts[videoId] = transcript; writeDB(db); } }
      const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
        params: { part: 'snippet', videoId, maxResults: 20, key: process.env.YOUTUBE_API_KEY }
      });
      if (!commentsRes.data.items) continue;
      for (const item of commentsRes.data.items) {
        if (sub.commentsUsed >= plan.commentsPerMonth) break;
        const commentId = item.id;
        const commentText = item.snippet.topLevelComment.snippet.textDisplay;
        const publishedAt = new Date(item.snippet.topLevelComment.snippet.publishedAt).getTime();
        if (publishedAt <= lastCheck) continue;
        if (isToxic(commentText)) { db.moderatedCount = (db.moderatedCount || 0) + 1; continue; }
        try {
          const reply = await generateReply(commentText, transcript, channelName, settings.tone || 'дружелюбный');
          await axios.post('https://www.googleapis.com/youtube/v3/comments', {
            snippet: { parentId: commentId, textOriginal: reply }
          }, { params: { part: 'snippet', access_token: youtubeTokens.access_token } });
          totalReplied++;
          sub.commentsUsed = (sub.commentsUsed || 0) + 1;
          db.weekReplies = (db.weekReplies || 0) + 1;
          db.replyLog.push({ comment: commentText, reply, videoId, timestamp: new Date().toISOString() });
          if (db.replyLog.length > 100) db.replyLog.shift();
        } catch (e) { console.log('Ошибка:', e.message); }
      }
      if (commentsRes.data.items.length > 0) { db.lastCheck[videoId] = Date.now(); db.videosProcessed = (db.videosProcessed || 0) + 1; }
    }
    writeDB(db);
    if (totalReplied > 0) {
      await sendTelegram(`✅ Бот ответил на ${totalReplied} комментариев\n📊 ${sub.commentsUsed}/${plan.commentsPerMonth}`);
    }
  } catch (error) { console.log('❌ Ошибка:', error.message); }
}

// ============ API ============
app.get('/api/test-reply', async (req, res) => { await processComments(); res.json({ status: '✅ Проверка выполнена' }); });
app.get('/api/get-ideas', async (req, res) => { const db = readDB(); res.json({ ideas: db.videoIdeas || [] }); });
app.get('/api/get-competitors', async (req, res) => { const db = readDB(); res.json({ competitors: db.competitors || [] }); });

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

// ============ АВТОЗАПУСК ============
setInterval(() => { processComments(); }, 5 * 60 * 1000);

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
  console.log(`📝 Тон ответа: ${process.env.BOT_TONE || 'дружелюбный'}`);
});
