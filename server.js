require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const OpenAI = require('openai');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ ПОДКЛЮЧЕНИЯ ============
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1'
});

let youtubeTokens = {
  access_token: null,
  refresh_token: null
};

// Telegram
let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Настройки
const BOT_TONE = process.env.BOT_TONE || 'дружелюбный';

// ============ ОТПРАВКА В TELEGRAM ============
async function sendTelegram(message) {
  // Telegram отключен
  console.log('📝 ' + message);
}

// ============ ПОЛУЧИТЬ ТРАНСКРИПТ ВИДЕО ============
async function getTranscript(videoId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/captions', {
      params: {
        part: 'snippet',
        videoId: videoId,
        key: apiKey
      }
    });
    if (response.data.items && response.data.items.length > 0) {
      // Берем первый субтитр (обычно английский или автоматический)
      return 'Субтитры найдены, но для полного текста нужен доступ к файлу. Пока используем базовый режим.';
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ============ ГЕНЕРАЦИЯ ОТВЕТА (С ТРАНСКРИПТОМ) ============
async function generateSmartReply(commentText, transcript, channelName) {
  const tone = BOT_TONE;
  let context = '';
  if (transcript) {
    context = `Контекст видео (транскрипт):\n${transcript.substring(0, 3000)}\n\n`;
  }

  const prompt = `
    Ты — ассистент YouTube-канала "${channelName || 'блогер'}".
    Отвечай на комментарии зрителей. Твой тон: ${tone}.
    ${context}
    Комментарий зрителя: "${commentText}"
    Ответь коротко (до 30 слов), естественно, с вопросом в конце.
  `;

  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: commentText }],
    max_tokens: 200,
    temperature: 0.8
  });

  return response.choices[0].message.content.trim();
}

// ============ ОБРАБОТКА НОВЫХ КОММЕНТАРИЕВ ============
async function processNewComments() {
  const accessToken = youtubeTokens.access_token;
  if (!accessToken) {
    console.log('❌ Токен не найден');
    return;
  }

  try {
    // 1. Получаем канал
    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: accessToken }
    });
    const channelName = channelRes.data.items[0]?.snippet?.title || 'Канал';

    // 2. Получаем последнее видео
    const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        channelId: channelRes.data.items[0].id,
        order: 'date',
        maxResults: 1,
        type: 'video',
        key: process.env.YOUTUBE_API_KEY
      }
    });
    if (!searchRes.data.items || searchRes.data.items.length === 0) return;
    const videoId = searchRes.data.items[0].id.videoId;

    // 3. Получаем транскрипт (если есть)
    const transcript = await getTranscript(videoId);

    // 4. Получаем комментарии
    const commentsRes = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
      params: {
        part: 'snippet',
        videoId: videoId,
        maxResults: 10,
        key: process.env.YOUTUBE_API_KEY
      }
    });

    if (!commentsRes.data.items || commentsRes.data.items.length === 0) return;

    let repliesCount = 0;
    let replyLog = '';

    for (const item of commentsRes.data.items) {
      const commentId = item.id;
      const commentText = item.snippet.topLevelComment.snippet.textDisplay;

      // Проверяем, не отвечали ли уже (можно хранить в БД, но пока пропускаем)
      try {
        const replyText = await generateSmartReply(commentText, transcript, channelName);

        await axios.post(
          'https://www.googleapis.com/youtube/v3/comments',
          { snippet: { parentId: commentId, textOriginal: replyText } },
          { params: { part: 'snippet', access_token: accessToken } }
        );

        repliesCount++;
        replyLog += `💬 ${commentText.substring(0, 30)}...\n↳ ${replyText}\n\n`;
      } catch (e) {
        console.log('Ошибка ответа:', e.message);
      }
    }

    // Отправляем отчёт в Telegram
    if (repliesCount > 0) {
      await sendTelegram(
        `✅ <b>Бот ответил на ${repliesCount} комментариев</b>\n` +
        `📹 Видео: https://youtu.be/${videoId}\n\n` +
        replyLog
      );
    } else {
      await sendTelegram(`ℹ️ Новых комментариев для ответа не найдено.`);
    }

  } catch (error) {
    console.log('Ошибка в processNewComments:', error.message);
  }
}

// ============ HTTP-ЭНДПОИНТЫ ============

app.get('/', (req, res) => res.send('🤖 Бот работает!'));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    ai: 'DeepSeek готов',
    youtube: youtubeTokens.access_token ? 'подключён' : 'не подключён',
    tone: BOT_TONE
  });
});

// OAuth
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
  if (!code) return res.send('❌ Ошибка: код не получен');

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: 'http://localhost:3000/auth/youtube/callback',
      grant_type: 'authorization_code'
    });

    youtubeTokens.access_token = tokenRes.data.access_token;
    youtubeTokens.refresh_token = tokenRes.data.refresh_token;

    const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      params: { part: 'snippet', mine: true, access_token: youtubeTokens.access_token }
    });

    const channelName = channelRes.data.items[0]?.snippet?.title || 'Неизвестный канал';

    res.send(`
      <h1>✅ Канал "${channelName}" подключен!</h1>
      <p>Бот автоматически проверяет комментарии каждые 5 минут.</p>
      <p><a href="/api/test-reply">▶️ Тестовый ответ</a></p>
    `);
  } catch (error) {
    res.send('❌ Ошибка: ' + error.message);
  }
});

// Тестовый ответ на последний комментарий
app.get('/api/test-reply', async (req, res) => {
  if (!youtubeTokens.access_token) {
    return res.json({ error: 'Подключи YouTube через /auth/youtube' });
  }
  await processNewComments();
  res.json({ status: '✅ Проверка выполнена, результат в Telegram (если настроен)' });
});

// ============ ЗАПУСК АВТОМАТИЧЕСКОЙ ПРОВЕРКИ ============
setInterval(() => {
  if (youtubeTokens.access_token) {
    console.log('🔄 Автоматическая проверка комментариев...');
    processNewComments();
  }
}, 5 * 60 * 1000); // 5 минут

// ============ ЗАПУСК СЕРВЕРА ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер на http://localhost:${PORT}`);
  console.log(`📝 Тон ответа: ${BOT_TONE}`);
  sendTelegram('🚀 Бот запущен и готов к работе!');
});