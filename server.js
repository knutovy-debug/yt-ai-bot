const express = require('express');
const app = express();

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Бот работает!');
});

app.get('/auth/youtube', (req, res) => {
  res.send('Авторизация через YouTube временно недоступна. Используй API-ключ.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
