// ============ ОТЗЫВЫ ============
app.get('/api/reviews', (req, res) => {
  const db = readDB();
  if (!db.reviews) db.reviews = [];
  // Показываем только одобренные отзывы
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
    approved: false, // по умолчанию не одобрено
    created_at: new Date().toISOString()
  });
  writeDB(db);
  await sendTelegram(`💬 НОВЫЙ ОТЗЫВ!\n\nАвтор: ${name}\nОценка: ${rating}⭐\nТекст: ${text}`);
  res.json({ success: true, message: 'Спасибо за отзыв! Он появится после проверки.' });
});

// ===== АДМИН: ОДОБРИТЬ ОТЗЫВ =====
app.post('/api/admin/review/approve', async (req, res) => {
  const { reviewId } = req.body;
  if (!reviewId) return res.status(400).json({ error: 'Укажи ID' });
  const db = readDB();
  if (!db.reviews) db.reviews = [];
  const review = db.reviews.find(r => r.id === reviewId);
  if (!review) return res.status(404).json({ error: 'Отзыв не найден' });
  review.approved = true;
  writeDB(db);
  res.json({ success: true });
});

// ===== АДМИН: УДАЛИТЬ ОТЗЫВ =====
app.delete('/api/admin/review/:reviewId', async (req, res) => {
  const { reviewId } = req.params;
  const db = readDB();
  if (!db.reviews) db.reviews = [];
  db.reviews = db.reviews.filter(r => r.id !== reviewId);
  writeDB(db);
  res.json({ success: true });
});
