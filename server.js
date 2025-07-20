const express = require('express');
const app = express();
const path = require('path');

// Головна сторінка сайту
app.get('/', (req, res) => {
  res.send('Hello! This is the website running together with the Telegram bot.');
});

// Якщо потрібно віддавати статичні файли, розкоментуйте:
// app.use(express.static(path.join(__dirname, 'public')));

// Запускаємо Telegram-бота
require('./bot.js'); // Ваш бот вже має запускатися самостійно

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Website is running on http://localhost:${PORT}`);
}); 