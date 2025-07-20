require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: false }));

// Проста авторизація
app.get('/', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Невірний пароль!' });
  }
});

app.get('/dashboard', (req, res) => {
  res.render('dashboard');
});

const PORT = process.env.ADMIN_PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛡️  Admin panel running on http://localhost:${PORT}`);
}); 