const express = require('express');
const app = express();

// Раздаём статические файлы (лендинг, дашборд)
app.use(express.static('public'));

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Заглушка для API (чтобы не было 404)
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', message: 'Бот работает' });
});

app.post('/api/register', (req, res) => {
  res.json({ success: true, message: 'Регистрация временно отключена' });
});

app.post('/api/login', (req, res) => {
  res.json({ success: true, message: 'Вход временно отключен' });
});

app.get('/auth/youtube', (req, res) => {
  res.send('Авторизация YouTube временно отключена. Используй API-ключ.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
