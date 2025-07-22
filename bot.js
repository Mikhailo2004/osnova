require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cron = require('node-cron');

// Перевірка наявності токена
if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'your-telegram-bot-token-here') {
  console.log('❌ Помилка: TELEGRAM_BOT_TOKEN не встановлений!');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const db = new sqlite3.Database(process.env.DATABASE_PATH || './data/bot.db');

// Оптимізовані структури даних
const userStates = new Map();
const messageTracker = new Map();
const userActivityTracker = new Map();
const userSessionTracker = new Map();

// Кеш для курсів валют (зменшує навантаження на API)
const currencyCache = {
  rates: new Map(),
  lastUpdate: null,
  cacheTimeout: 2 * 60 * 60 * 1000 // 2 години
};

// Додаємо підтримку адаптивного інтервалу оновлення валют
const CURRENCY_UPDATE_INTERVAL_MINUTES = parseInt(process.env.CURRENCY_UPDATE_INTERVAL_MINUTES, 10) || 30;

// Оптимізована функція відстеження повідомлень
function trackMessage(userId, messageId, type = 'bot') {
  if (!messageTracker.has(userId)) {
    messageTracker.set(userId, []);
  }
  
  const userMessages = messageTracker.get(userId);
  userMessages.push({ id: messageId, type, timestamp: Date.now() });
  
  // Зберігаємо тільки останні 10 повідомлень (зменшено для швидкості)
  if (userMessages.length > 10) {
    userMessages.shift();
  }
  
  userActivityTracker.set(userId, Date.now());
}

// Оптимізована функція відстеження сесії
function trackUserSession(userId) {
  const sessionId = Date.now();
  userSessionTracker.set(userId, sessionId);
  return sessionId;
}

function isNewSession(userId) {
  return !userSessionTracker.has(userId);
}

// Оптимізоване очищення неактивних користувачів
function cleanupInactiveUsers() {
  const now = Date.now();
  const inactiveThreshold = 60 * 60 * 1000; // 1 година (збільшено для стабільності)
  
  let cleanedCount = 0;
  for (const [userId, lastActivity] of userActivityTracker.entries()) {
    if (now - lastActivity > inactiveThreshold) {
      cleanupUserData(userId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🧹 Очищено ${cleanedCount} неактивних користувачів`);
  }
}

// Запускаємо очищення кожні 15 хвилин (зменшено навантаження)
setInterval(cleanupInactiveUsers, 15 * 60 * 1000);

// Оптимізована функція очищення повідомлень
async function clearAllUserMessages(ctx, keepMenuId = null) {
  try {
    const userId = ctx.from.id;
    const userMessages = messageTracker.get(userId) || [];
    
    const botMessages = userMessages.filter(msg => msg.type === 'bot');
    const messagesToDelete = keepMenuId 
      ? botMessages.filter(msg => msg.id !== keepMenuId)
      : botMessages;
    
    let deletedCount = 0;
    for (const message of messagesToDelete) {
      const success = await safeDeleteMessage(ctx, message.id);
      if (success) {
        deletedCount++;
        const index = userMessages.findIndex(msg => msg.id === message.id);
        if (index > -1) {
          userMessages.splice(index, 1);
        }
      }
    }
    
    if (deletedCount > 0) {
      console.log(`🧹 Видалено ${deletedCount} повідомлень`);
    }
  } catch (error) {
    console.error('❌ Помилка очищення:', error);
  }
}

async function clearChat(ctx) {
  try {
    await clearAllUserMessages(ctx);
  } catch (error) {
    console.error('❌ Помилка очищення чату:', error);
  }
}

async function clearChatForNewSession(ctx) {
  try {
    await clearAllUserMessages(ctx);
  } catch (error) {
    console.error('❌ Помилка очищення чату:', error);
  }
}

// Оптимізована функція видалення повідомлень
async function safeDeleteMessage(ctx, messageId) {
  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, messageId);
    return true;
  } catch (error) {
    return false;
  }
}

// Функція для отримання публічної URL з ngrok
async function getNgrokUrl() {
  try {
    const response = await axios.get('http://localhost:4040/api/tunnels', {
      timeout: 5000
    });
    
    if (response.data && response.data.tunnels && response.data.tunnels.length > 0) {
      return response.data.tunnels[0].public_url;
    }
  } catch (error) {
    console.log('Ngrok API недоступний, використовуємо локальну URL');
  }
  
  return null;
}

// Оптимізовані функції показу меню
async function showMainMenu(ctx) {
  try {
    const user = ctx.from;
    await dbManager.saveUser(user);
    
    const menu = await createMainMenu(user.id);
    const welcomeMessage = await ctx.reply(
      '👋 Вітаю! Я сучасний Telegram-бот з покращеною системою планування, нагадуваннями та конвертером валют!\n\n💡 Меню залишається доступним для зручності навігації.',
      menu
    );
    
    trackMessage(user.id, welcomeMessage.message_id);
  } catch (error) {
    console.error('Помилка показу меню:', error);
  }
}

async function showMainMenuForNewSession(ctx) {
  try {
    const user = ctx.from;
    await clearChatForNewSession(ctx);
    await dbManager.saveUser(user);
    
    const menu = await createMainMenu(user.id);
    const welcomeMessage = await ctx.reply(
      '👋 Вітаю! Я сучасний Telegram-бот з покращеною системою планування, нагадуваннями та конвертером валют!\n\n💡 Меню залишається доступним для зручності навігації.',
      menu
    );
    
    trackMessage(user.id, welcomeMessage.message_id);
    trackUserSession(user.id);
  } catch (error) {
    console.error('Помилка показу меню для нової сесії:', error);
  }
}

// Клас для роботи з валютними курсами
class CurrencyConverter {
  constructor() {
    this.exchangeRates = new Map();
    this.currencies = {
      USD: { flag: '🇺🇸', name: 'Долар США' },
      EUR: { flag: '🇪🇺', name: 'Євро' },
      UAH: { flag: '🇺🇦', name: 'Гривня' },
      GBP: { flag: '🇬🇧', name: 'Фунт стерлінгів' },
      PLN: { flag: '🇵🇱', name: 'Злотий' },
      CZK: { flag: '🇨🇿', name: 'Чеська крона' },
      JPY: { flag: '🇯🇵', name: 'Єна' },
      CNY: { flag: '🇨🇳', name: 'Юань' },
      TRY: { flag: '🇹🇷', name: 'Турецька ліра' },
      EGP: { flag: '🇪🇬', name: 'Єгипетський фунт' }
    };
    this.lastUpdate = null;
    this.updateInterval = 2 * 60 * 60 * 1000; // 2 години
  }

  async initialize() {
    console.log('💱 Ініціалізація конвертера валют...');
    await this.updateExchangeRates();
    
    // Автоматичне оновлення курсів
    setInterval(() => {
      this.updateExchangeRates().catch(error => {
        console.error('❌ Помилка автооновлення курсів:', error);
      });
    }, this.updateInterval);
    
    console.log('✅ Конвертер валют готовий до роботи');
  }

  async updateExchangeRates() {
    try {
      console.log('📡 Отримання курсів валют від НБУ...');
      
      const response = await axios.get('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', {
        timeout: 10000 // 10 секунд таймаут
      });

      if (response.data && Array.isArray(response.data)) {
        this.exchangeRates.clear();
        
        // Додаємо USD як базову валюту
        this.exchangeRates.set('USD', { rate: 1, change: 0 });
        
        // Обробляємо отримані курси
        response.data.forEach(item => {
          if (this.currencies[item.cc]) {
            this.exchangeRates.set(item.cc, {
              rate: parseFloat(item.rate),
              change: parseFloat(item.rate) - parseFloat(item.rate_prev || item.rate)
            });
          }
        });
        
        this.lastUpdate = new Date();
        console.log(`✅ Курси валют оновлено: ${this.exchangeRates.size} валют`);
        console.log(`📅 Останнє оновлення: ${this.lastUpdate.toLocaleString('uk-UA')}`);
      } else {
        throw new Error('Неправильний формат даних від НБУ');
      }
    } catch (error) {
      console.error('❌ Помилка оновлення курсів:', error.message);
      this.setBackupRates();
    }
  }

  setBackupRates() {
    // Резервні курси на випадок недоступності API
    const backupRates = {
      USD: { rate: 1, change: 0 },
      EUR: { rate: 0.915, change: 0.005 },
      UAH: { rate: 39.5, change: -0.2 },
      GBP: { rate: 0.782, change: 0.011 },
      PLN: { rate: 3.95, change: -0.03 },
      CZK: { rate: 23.0, change: 0.8 },
      JPY: { rate: 150.0, change: -0.1 },
      CNY: { rate: 7.2, change: 0.4 },
      TRY: { rate: 32.0, change: -1.2 },
      EGP: { rate: 31.0, change: 0.7 }
    };

    this.exchangeRates.clear();
    Object.entries(backupRates).forEach(([currency, data]) => {
      this.exchangeRates.set(currency, data);
    });
    
    this.lastUpdate = new Date();
    console.log('⚠️ Використовуються резервні курси валют');
  }

  convert(amount, fromCurrency, toCurrency) {
    if (!this.exchangeRates.has(fromCurrency) || !this.exchangeRates.has(toCurrency)) {
      throw new Error('Непідтримувана валюта');
    }

    const fromRate = this.exchangeRates.get(fromCurrency).rate;
    const toRate = this.exchangeRates.get(toCurrency).rate;
    
    const uahAmount = amount * fromRate;
    const result = uahAmount / toRate;
    
    return {
      amount: amount,
      fromCurrency: fromCurrency,
      toCurrency: toCurrency,
      result: result,
      rate: toRate / fromRate,
      date: this.lastUpdate
    };
  }

  getCurrencies() {
    return this.currencies;
  }

  getExchangeRates() {
    return this.exchangeRates;
  }

  isSupported(currency) {
    return this.currencies.hasOwnProperty(currency);
  }

  formatResult(conversion) {
    const fromCurrency = this.currencies[conversion.fromCurrency];
    const toCurrency = this.currencies[conversion.toCurrency];
    
    const formatAmount = (amount) => {
      if (amount >= 1000000) {
        return (amount / 1000000).toFixed(2) + 'M';
      } else if (amount >= 1000) {
        return (amount / 1000).toFixed(2) + 'K';
      } else {
        return amount.toFixed(2);
      }
    };
    
    return {
      from: `${fromCurrency.flag} ${formatAmount(conversion.amount)} ${conversion.fromCurrency}`,
      to: `${toCurrency.flag} ${formatAmount(conversion.result)} ${conversion.toCurrency}`,
      rate: `1 ${conversion.fromCurrency} = ${conversion.rate.toFixed(4)} ${conversion.toCurrency}`,
      reverseRate: `1 ${conversion.toCurrency} = ${(1 / conversion.rate).toFixed(4)} ${conversion.fromCurrency}`,
      date: conversion.date ? conversion.date.toLocaleDateString('uk-UA') : 'Невідомо'
    };
  }

  formatExchangeRatesForAmount(amount = 100) {
    const rates = this.getExchangeRates();
    const currencies = this.getCurrencies();
    let message = `📊 Курси обміну для ${amount} USD:\n\n`;
    
    const usdRate = rates.get('USD')?.rate || 1;
    
    rates.forEach((rateData, currency) => {
      if (currency !== 'USD') {
        const currencyInfo = currencies[currency];
        const rate = (rateData.rate / usdRate) * amount;
        const formattedRate = rate >= 1 ? rate.toFixed(2) : rate.toFixed(4);
        const change = rateData.change ? ` (${rateData.change > 0 ? '+' : ''}${rateData.change.toFixed(2)}%)` : '';
        message += `${currencyInfo.flag} ${currency}: ${formattedRate}${change}\n`;
      }
    });
    
    message += `\n📅 Останнє оновлення: ${this.lastUpdate ? this.lastUpdate.toLocaleString('uk-UA') : 'Невідомо'}`;
    message += `\n💡 Курси від Національного банку України`;
    
    return message;
  }

  formatExchangeRatesForCurrency(baseCurrency, amount = 100) {
    const rates = this.getExchangeRates();
    const currencies = this.getCurrencies();
    
    if (!rates.has(baseCurrency)) {
      throw new Error('Непідтримувана валюта');
    }
    
    let message = `📊 Курси обміну для ${amount} ${baseCurrency}:\n\n`;
    
    const baseRate = rates.get(baseCurrency).rate;
    
    rates.forEach((rateData, currency) => {
      if (currency !== baseCurrency) {
        const currencyInfo = currencies[currency];
        const rate = (rateData.rate / baseRate) * amount;
        const formattedRate = rate >= 1 ? rate.toFixed(2) : rate.toFixed(4);
        const change = rateData.change ? ` (${rateData.change > 0 ? '+' : ''}${rateData.change.toFixed(2)}%)` : '';
        message += `${currencyInfo.flag} ${currency}: ${formattedRate}${change}\n`;
      }
    });
    
    message += `\n📅 Останнє оновлення: ${this.lastUpdate ? this.lastUpdate.toLocaleString('uk-UA') : 'Невідомо'}`;
    message += `\n💡 Курси від Національного банку України`;
    
    return message;
  }

  async startAutoUpdate() {
    // Оновлення при старті
    await this.updateExchangeRates();
    // Автоматичне оновлення з інтервалом
    setInterval(async () => {
      try {
        await this.updateExchangeRates();
      } catch (error) {
        console.error('❌ Помилка автооновлення курсів:', error);
      }
    }, CURRENCY_UPDATE_INTERVAL_MINUTES * 60 * 1000);
  }
}

// Клас для роботи з базою даних
class DatabaseManager {
  constructor(database) {
    this.db = database;
    this.version = 3; // Версія схеми БД
  }

  // Ініціалізація бази даних
  async initialize() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        try {
          // Створюємо таблицю версій
          this.db.run(`CREATE TABLE IF NOT EXISTS db_version (
            version INTEGER PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`);

          // Створюємо основні таблиці
          this.createTables();
          
          // Виконуємо міграції
          this.runMigrations().then(() => {
            console.log('✅ База даних успішно ініціалізована');
            resolve();
          }).catch(reject);

        } catch (error) {
          reject(error);
        }
      });
    });
  }

  // Створення таблиць
  createTables() {
    // Таблиця користувачів
    this.db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
      settings TEXT DEFAULT '{}',
      reminder_time TEXT DEFAULT '07:00',
      reminder_enabled INTEGER DEFAULT 1
    )`);

    // Таблиця планів на завтра
    this.db.run(`CREATE TABLE IF NOT EXISTS tomorrow_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_text TEXT NOT NULL,
      plan_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed INTEGER DEFAULT 0,
      completed_at DATETIME,
      priority INTEGER DEFAULT 1,
      category TEXT DEFAULT 'general',
      notes TEXT,
      tags TEXT,
      reminder_sent INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Таблиця категорій
    this.db.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#007AFF',
      icon TEXT DEFAULT '📁',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Таблиця статистики
    this.db.run(`CREATE TABLE IF NOT EXISTS statistics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      plans_created INTEGER DEFAULT 0,
      plans_completed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )`);

    // Таблиця нагадувань
    this.db.run(`CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_id INTEGER,
      reminder_date TEXT NOT NULL,
      reminder_time TEXT NOT NULL,
      message TEXT,
      repeat_type TEXT DEFAULT 'none',
      sent INTEGER DEFAULT 0
    )`);

    // Створюємо індекси для швидкості
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_plans_user_date ON tomorrow_plans(user_id, plan_date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_plans_created ON tomorrow_plans(created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_activity ON users(last_activity DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_statistics_user_date ON statistics(user_id, date)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_date_time ON reminders(reminder_date, reminder_time)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent)`);

    // Тригер для автоматичного оновлення updated_at
    this.db.run(`CREATE TRIGGER IF NOT EXISTS update_plans_timestamp 
                AFTER UPDATE ON tomorrow_plans 
                BEGIN
                  UPDATE tomorrow_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
                END`);

    // Тригер для оновлення статистики
    this.db.run(`CREATE TRIGGER IF NOT EXISTS update_statistics_on_plan_create
                AFTER INSERT ON tomorrow_plans
                BEGIN
                  INSERT OR REPLACE INTO statistics (user_id, date, plans_created)
                  VALUES (NEW.user_id, NEW.plan_date, 
                    COALESCE((SELECT plans_created FROM statistics WHERE user_id = NEW.user_id AND date = NEW.plan_date), 0) + 1);
                END`);

    this.db.run(`CREATE TRIGGER IF NOT EXISTS update_statistics_on_plan_complete
                AFTER UPDATE ON tomorrow_plans
                WHEN NEW.completed = 1 AND OLD.completed = 0
                BEGIN
                  INSERT OR REPLACE INTO statistics (user_id, date, plans_completed)
                  VALUES (NEW.user_id, NEW.plan_date, 
                    COALESCE((SELECT plans_completed FROM statistics WHERE user_id = NEW.user_id AND date = NEW.plan_date), 0) + 1);
                END`);

    // Тригер для створення нагадувань
    this.db.run(`CREATE TRIGGER IF NOT EXISTS create_reminder_on_plan_create
                AFTER INSERT ON tomorrow_plans
                BEGIN
                  INSERT INTO reminders (user_id, plan_id, reminder_date, reminder_time, message)
                  SELECT 
                    NEW.user_id, 
                    NEW.id, 
                    NEW.plan_date, 
                    COALESCE((SELECT reminder_time FROM users WHERE id = NEW.user_id), '07:00'),
                    'Не забудь виконати свої плани на ' || NEW.plan_date || '! 📝'
                  WHERE (SELECT reminder_enabled FROM users WHERE id = NEW.user_id) = 1;
                END`);
  }

  // Виконання міграцій
  async runMigrations() {
    return new Promise((resolve, reject) => {
      this.db.get("SELECT version FROM db_version ORDER BY version DESC LIMIT 1", (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        const currentVersion = row ? row.version : 0;
        
        if (currentVersion < this.version) {
          this.migrateFromVersion(currentVersion).then(resolve).catch(reject);
        } else {
          resolve();
        }
      });
    });
  }

  // Міграція з поточної версії
  async migrateFromVersion(fromVersion) {
    console.log(`🔄 Міграція БД з версії ${fromVersion} до ${this.version}`);

    if (fromVersion < 1) {
      await this.migrateToVersion1();
    }

    if (fromVersion < 2) {
      await this.migrateToVersion2();
    }

    if (fromVersion < 3) {
      await this.migrateToVersion3();
    }

    // Оновлюємо версію БД
    return new Promise((resolve, reject) => {
      this.db.run("INSERT OR REPLACE INTO db_version (version) VALUES (?)", [this.version], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // Міграція до версії 1
  async migrateToVersion1() {
    return new Promise((resolve, reject) => {
      // Перевіряємо чи існує стара таблиця
      this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tomorrow_plans'", (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (row) {
          // Перевіряємо структуру старої таблиці
          this.db.all("PRAGMA table_info(tomorrow_plans)", (err, columns) => {
            if (err) {
              reject(err);
              return;
            }

            const columnNames = columns.map(col => col.name);
            const migrations = [];

            // Додаємо відсутні колонки
            if (!columnNames.includes('created_at')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN created_at DATETIME");
            }
            if (!columnNames.includes('updated_at')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN updated_at DATETIME");
            }
            if (!columnNames.includes('completed_at')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN completed_at DATETIME");
            }
            if (!columnNames.includes('priority')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN priority INTEGER DEFAULT 1");
            }
            if (!columnNames.includes('category')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN category TEXT DEFAULT 'general'");
            }
            if (!columnNames.includes('notes')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN notes TEXT");
            }
            if (!columnNames.includes('tags')) {
              migrations.push("ALTER TABLE tomorrow_plans ADD COLUMN tags TEXT");
            }

            // Виконуємо міграції
            let completed = 0;
            if (migrations.length === 0) {
              resolve();
              return;
            }

            migrations.forEach(migration => {
              this.db.run(migration, (err) => {
                if (err) {
                  console.error('Помилка міграції:', err);
                }
                completed++;
                if (completed === migrations.length) {
                  // Оновлюємо значення для існуючих записів
                  this.updateExistingRecords();
                  resolve();
                }
              });
            });
          });
        } else {
          resolve();
        }
      });
    });
  }

  // Міграція до версії 2
  async migrateToVersion2() {
    return new Promise((resolve, reject) => {
      // Додаємо нові функції для версії 2
      this.db.run("ALTER TABLE users ADD COLUMN settings TEXT DEFAULT '{}'", (err) => {
        if (err && !err.message.includes('duplicate column')) {
          console.error('Помилка додавання settings:', err);
        }
        resolve();
      });
    });
  }

  // Міграція до версії 3 (нагадування)
  async migrateToVersion3() {
    return new Promise((resolve, reject) => {
      // Додаємо колонки для нагадувань
      const migrations = [
        "ALTER TABLE users ADD COLUMN reminder_time TEXT DEFAULT '07:00'",
        "ALTER TABLE users ADD COLUMN reminder_enabled INTEGER DEFAULT 1",
        "ALTER TABLE tomorrow_plans ADD COLUMN reminder_sent INTEGER DEFAULT 0"
      ];

      let completed = 0;
      migrations.forEach(migration => {
        this.db.run(migration, (err) => {
          if (err && !err.message.includes('duplicate column')) {
            console.error('Помилка міграції нагадувань:', err);
          }
          completed++;
          if (completed === migrations.length) {
            resolve();
          }
        });
      });
    });
  }

  // Оновлення існуючих записів
  updateExistingRecords() {
    this.db.run("UPDATE tomorrow_plans SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL");
    this.db.run("UPDATE tomorrow_plans SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL");
  }

  // Методи для роботи з користувачами
  async saveUser(user) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO users (id, username, first_name, last_name, last_activity) 
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [user.id, user.username, user.first_name, user.last_name],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  async updateUserActivity(userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "UPDATE users SET last_activity = CURRENT_TIMESTAMP WHERE id = ?",
        [userId],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  // Методи для роботи з планами
  async savePlan(userId, planText, category = 'general', priority = 1, notes = '') {
    return new Promise((resolve, reject) => {
      const tomorrow = this.getTomorrowDate();
      
      // Перевіряємо чи вже є план на завтра
      this.db.get(
        "SELECT id FROM tomorrow_plans WHERE user_id = ? AND plan_date = ?",
        [userId, tomorrow],
        (err, existingPlan) => {
          if (err) {
            reject(err);
            return;
          }

          if (existingPlan) {
            // Оновлюємо існуючий план
            this.db.run(
              `UPDATE tomorrow_plans 
               SET plan_text = ?, category = ?, priority = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [planText, category, priority, notes, existingPlan.id],
              function(err) {
                if (err) reject(err);
                else resolve({ id: existingPlan.id, updated: true });
              }
            );
          } else {
            // Створюємо новий план
            this.db.run(
              `INSERT INTO tomorrow_plans (user_id, plan_text, plan_date, category, priority, notes) 
               VALUES (?, ?, ?, ?, ?, ?)`,
              [userId, planText, tomorrow, category, priority, notes],
              function(err) {
                if (err) reject(err);
                else resolve({ id: this.lastID, updated: false });
              }
            );
          }
        }
      );
    });
  }

  async getPlan(userId) {
    return new Promise((resolve, reject) => {
      const tomorrow = this.getTomorrowDate();
      
      this.db.get(
        `SELECT * FROM tomorrow_plans 
         WHERE user_id = ? AND plan_date = ? 
         ORDER BY priority DESC, created_at DESC LIMIT 1`,
        [userId, tomorrow],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getPlans(userId, limit = 10) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM tomorrow_plans 
         WHERE user_id = ? 
         ORDER BY plan_date DESC, priority DESC, created_at DESC 
         LIMIT ?`,
        [userId, limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async markPlanCompleted(planId, userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE tomorrow_plans 
         SET completed = 1, completed_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND user_id = ?`,
        [planId, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  async deletePlan(planId, userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "DELETE FROM tomorrow_plans WHERE id = ? AND user_id = ?",
        [planId, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  // Методи для статистики
  async getStatistics(userId, days = 7) {
    return new Promise((resolve, reject) => {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split('T')[0];

      this.db.all(
        `SELECT * FROM statistics 
         WHERE user_id = ? AND date >= ? 
         ORDER BY date DESC`,
        [userId, startDateStr],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Методи для нагадувань
  async getPendingReminders() {
    return new Promise((resolve, reject) => {
      const now = new Date();
      const currentDate = now.toISOString().split('T')[0];
      const currentTime = now.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit' 
      });

      this.db.all(
        `SELECT r.*, u.first_name, u.username, p.plan_text 
         FROM reminders r 
         JOIN users u ON r.user_id = u.id 
         LEFT JOIN tomorrow_plans p ON r.plan_id = p.id
         WHERE r.reminder_date = ? 
         AND r.reminder_time <= ? 
         AND r.sent = 0 
         AND u.reminder_enabled = 1`,
        [currentDate, currentTime],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async markReminderSent(reminderId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE reminders 
         SET sent = 1, sent_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [reminderId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  async updateUserReminderSettings(userId, reminderTime, reminderEnabled) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE users 
         SET reminder_time = ?, reminder_enabled = ? 
         WHERE id = ?`,
        [reminderTime, reminderEnabled ? 1 : 0, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  async getUserReminderSettings(userId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        "SELECT reminder_time, reminder_enabled FROM users WHERE id = ?",
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  // Створення нагадування з конкретною датою та часом
  async createCustomReminder(userId, planId, reminderDate, reminderTime, message, repeatType = 'none') {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO reminders (user_id, plan_id, reminder_date, reminder_time, message, repeat_type) VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, planId, reminderDate, reminderTime, message, repeatType],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  // Отримання всіх нагадувань користувача
  async getUserReminders(userId) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT r.*, p.plan_text 
         FROM reminders r 
         LEFT JOIN tomorrow_plans p ON r.plan_id = p.id
         WHERE r.user_id = ? 
         ORDER BY r.reminder_date DESC, r.reminder_time DESC`,
        [userId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Видалення нагадування
  async deleteReminder(reminderId, userId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        "DELETE FROM reminders WHERE id = ? AND user_id = ?",
        [reminderId, userId],
        function(err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  // Допоміжні методи
  getTomorrowDate() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  getCurrentDate() {
    return new Date().toISOString().split('T')[0];
  }

  // Генерація дат для календаря
  generateCalendarDates() {
    const dates = [];
    const today = new Date();
    
    // Генеруємо дати на наступні 30 днів
    for (let i = 0; i < 30; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      dates.push({
        date: date.toISOString().split('T')[0],
        display: date.toLocaleDateString('uk-UA', {
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        }),
        isToday: i === 0,
        isTomorrow: i === 1
      });
    }
    
    return dates;
  }

  // Генерація часових слотів
  generateTimeSlots() {
    const slots = [];
    
    // Генеруємо часові слоти з 6:00 до 22:00 кожні 30 хвилин
    for (let hour = 6; hour <= 22; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        slots.push({
          time: time,
          display: time
        });
      }
    }
    
    return slots;
  }
}

// Створюємо екземпляр менеджера БД
const dbManager = new DatabaseManager(db);

// Створюємо екземпляр конвертера валют
const currencyConverter = new CurrencyConverter();
currencyConverter.startAutoUpdate().catch(console.error);

// Система нагадувань
class ReminderSystem {
  constructor(bot, dbManager) {
    this.bot = bot;
    this.dbManager = dbManager;
    this.checkInterval = null;
  }

  // Запуск системи нагадувань
  start() {
    console.log('⏰ Система нагадувань запущена');
    
    // Перевіряємо нагадування кожну хвилину
    this.checkInterval = setInterval(() => {
      this.checkAndSendReminders();
    }, 60000); // 60 секунд

    // Перша перевірка через 10 секунд після запуску
    setTimeout(() => {
      this.checkAndSendReminders();
    }, 10000);
  }

  // Зупинка системи нагадувань
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('⏰ Система нагадувань зупинена');
    }
  }

  // Перевірка та відправка нагадувань
  async checkAndSendReminders() {
    try {
      const reminders = await this.dbManager.getPendingReminders();
      
      console.log(`🔍 Перевірка нагадувань: знайдено ${reminders.length} нагадувань`);
      
      for (const reminder of reminders) {
        await this.sendReminder(reminder);
      }
    } catch (error) {
      console.error('❌ Помилка при перевірці нагадувань:', error);
    }
  }

  // Відправка нагадування
  async sendReminder(reminder) {
    try {
      const now = new Date();
      const reminderDateTime = new Date(`${reminder.reminder_date}T${reminder.reminder_time}`);
      
      console.log(`⏰ Перевірка нагадування ${reminder.id}:`);
      console.log(`   Поточний час: ${now.toLocaleString()}`);
      console.log(`   Час нагадування: ${reminderDateTime.toLocaleString()}`);
      console.log(`   Користувач: ${reminder.user_id}`);
      
      // Перевіряємо чи нагадування ще актуальне
      if (now >= reminderDateTime) {
        const message = `⏰ Нагадування!\n\n${reminder.message}\n\n📅 Дата: ${reminder.reminder_date}\n⏰ Час: ${reminder.reminder_time}`;
        
        if (reminder.plan_text) {
          message += `\n\n📝 План:\n${reminder.plan_text}`;
        }
        
        await this.bot.telegram.sendMessage(reminder.user_id, message, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '👁️ Подивитися план', callback_data: 'view_plan' }],
              [{ text: '✅ Позначити виконаним', callback_data: 'mark_completed' }],
              [{ text: '🔙 Назад до меню', callback_data: 'back_to_menu' }]
            ]
          }
        });

        // Позначаємо нагадування як відправлене
        await this.dbManager.markReminderSent(reminder.id);
        
        console.log(`✅ Нагадування відправлено користувачу ${reminder.user_id}`);
        // Якщо повторюване нагадування — створюємо нове
        if (reminder.repeat_type && reminder.repeat_type !== 'none') {
          const nextDate = this.getNextReminderDate(reminder.reminder_date, reminder.repeat_type);
          if (nextDate) {
            await this.dbManager.createCustomReminder(
              reminder.user_id,
              reminder.plan_id,
              nextDate,
              reminder.reminder_time,
              reminder.message,
              reminder.repeat_type
            );
          }
        }
      } else {
        console.log(`⏳ Нагадування ${reminder.id} ще не настав час`);
      }
    } catch (error) {
      console.error(`❌ Помилка при відправці нагадування користувачу ${reminder.user_id}:`, error);
    }
  }

  startAutoCheck() {
    // Перевірка при старті
    this.checkAndSendReminders().catch(console.error);
    // Автоматична перевірка з інтервалом
    setInterval(async () => {
      try {
        await this.checkAndSendReminders();
      } catch (error) {
        console.error('❌ Помилка авто-перевірки нагадувань:', error);
      }
    }, REMINDER_CHECK_INTERVAL_SECONDS * 1000);
  }

  getNextReminderDate(currentDate, repeatType) {
    const date = new Date(currentDate);
    switch (repeatType) {
      case 'daily':
        date.setDate(date.getDate() + 1);
        break;
      case 'weekly':
        date.setDate(date.getDate() + 7);
        break;
      case 'monthly':
        date.setMonth(date.getMonth() + 1);
        break;
      default:
        return null;
    }
    return date.toISOString().slice(0, 10);
  }
}

// Функція для створення головного меню
async function createMainMenu(userId) {
  const isAdmin = checkIfAdmin(userId);
  
  const buttons = [
    [Markup.button.callback('📋 Допомога', 'help')],
    [Markup.button.callback('ℹ️ Інформація', 'info')],
    [Markup.button.callback('📝 План на завтра', 'tomorrow_plan')],
    [Markup.button.callback('💱 Конвертер валют', 'currency_converter')],
    [Markup.button.callback('📊 Статистика', 'statistics')],
    [Markup.button.callback('⏰ Налаштування нагадувань', 'reminder_settings')]
  ];
  
  // Додаємо кнопку адмін-панелі тільки для адмінів
  if (isAdmin) {
    // Отримуємо публічну URL з ngrok
    const ngrokUrl = await getNgrokUrl();
    const adminUrl = ngrokUrl || process.env.ADMIN_URL || 'http://localhost:3000';
    
    // Перевіряємо чи URL валідний для Telegram (HTTPS або публічний домен)
    if (adminUrl.startsWith('https://') || adminUrl.includes('ngrok.io')) {
      buttons.push([Markup.button.url('🛡️ Адмін панель', adminUrl)]);
      console.log(`🔗 Адмін панель доступна за URL: ${adminUrl}`);
    } else {
      buttons.push([Markup.button.callback('🛡️ Адмін панель', 'admin_panel')]);
      console.log('⚠️ Адмін панель недоступна через ngrok, використовується callback');
    }
  }
  
  return Markup.inlineKeyboard(buttons);
}

// Перевірка чи користувач адмін
function checkIfAdmin(userId) {
  // Поки що всі адміни (можна змінити логіку)
  return true;
}

// Функція для форматування дати
function formatDate(dateString) {
  if (!dateString) return 'Невідомо';
  
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    return 'Невідомо';
  }
  
  return date.toLocaleDateString('uk-UA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

// Обробка команди /start (залишаємо для сумісності)
bot.start(async (ctx) => {
  await showMainMenuForNewSession(ctx);
});

// Оптимізований обробник повідомлень
bot.on('message', async (ctx) => {
  try {
    const state = userStates.get(ctx.from.id);
    
    // Оновлюємо активність користувача
    userActivityTracker.set(ctx.from.id, Date.now());
    
    // Перевіряємо чи це нова сесія
    if (isNewSession(ctx.from.id)) {
      console.log(`🔄 Нова сесія виявлена для користувача ${ctx.from.id}`);
      await clearChatForNewSession(ctx);
      trackUserSession(ctx.from.id);
      await showMainMenuForNewSession(ctx);
      return;
    }
    
    // Обробляємо різні стани користувача
    if (state && state.waitingForPlan) {
      await handlePlanInput(ctx);
    } else if (state && state.waitingForReminderTime) {
      await handleReminderTimeInput(ctx);
    } else if (state && state.creatingReminder && state.step === 'entering_message') {
      await handleReminderMessageInput(ctx);
    } else if (state && state.convertingCurrency && state.step === 'entering_amount') {
      await handleCurrencyAmountInput(ctx);
    } else if (state && state.enteringAmountForRates) {
      await handleRatesAmountInput(ctx);
    } else {
      // Якщо це звичайне повідомлення і користувач не в активному стані, показуємо меню
      await showMainMenu(ctx);
    }
  } catch (error) {
    console.error('Помилка обробки повідомлення:', error);
  }
});

// Команда для оновлення меню
bot.command('menu', async (ctx) => {
  await showMainMenu(ctx);
});

// Команда для очищення чату (повне очищення)
bot.command('clear', async (ctx) => {
  try {
    await clearAllUserMessages(ctx);
    
    const menu = await createMainMenu(ctx.from.id);
    const clearMessage = await ctx.reply(
      '🧹 Чат повністю очищено!\n\n💡 Тепер чат чистий і зручний для навігації.',
      menu
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, clearMessage.message_id);
    
    console.log(`🧹 Повне очищення чату для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при очищенні чату:', error);
  }
});

// Конвертер валют
bot.action('currency_converter', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const buttons = [
      [Markup.button.callback('💱 Конвертувати валюту', 'convert_currency')],
      [Markup.button.callback('⚡ Швидка конвертація', 'quick_convert')],
      [Markup.button.callback('📊 Курси валют', 'exchange_rates')],
      [Markup.button.callback('🔄 Оновити курси', 'refresh_rates')],
      [Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const messageText = '💱 Конвертер валют:\n\n💡 Оберіть дію:\n\n💱 Конвертувати валюту - конвертувати будь-яку суму\n⚡ Швидка конвертація - популярні суми\n📊 Курси валют - подивитися поточні курси\n🔄 Оновити курси - оновити курси від НБУ';
    
    try {
      await ctx.editMessageText(messageText, menu);
    } catch (editError) {
      // Якщо повідомлення не змінилося, просто ігноруємо помилку
      if (editError.description && editError.description.includes('message is not modified')) {
        console.log(`ℹ️ Повідомлення не змінилося для користувача ${ctx.from.id}`);
        return;
      }
      throw editError;
    }
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, ctx.callbackQuery.message.message_id);
    
    console.log(`💱 Показано конвертер валют для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при показі конвертера валют:', error);
  }
});

// Швидка конвертація
bot.action('quick_convert', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const buttons = [
      [Markup.button.callback('💰 100 USD', 'quick_100_usd')],
      [Markup.button.callback('💰 1000 USD', 'quick_1000_usd')],
      [Markup.button.callback('💰 100 EUR', 'quick_100_eur')],
      [Markup.button.callback('💰 1000 EUR', 'quick_1000_eur')],
      [Markup.button.callback('💰 1000 UAH', 'quick_1000_uah')],
      [Markup.button.callback('💰 10000 UAH', 'quick_10000_uah')],
      [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx,
      '⚡ Швидка конвертація:\n\n💡 Оберіть популярну суму для конвертації:',
      menu
    );
  } catch (error) {
    console.error('Помилка при швидкій конвертації:', error);
  }
});

// Обробка швидкої конвертації
bot.action(/quick_(\d+)_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const amount = parseInt(ctx.match[1]);
    const currency = ctx.match[2].toUpperCase();
    
    // Перевіряємо чи валюта підтримується
    if (!currencyConverter.isSupported(currency)) {
      await safeEditMessage(ctx,
        `❌ Валюта ${currency} не підтримується.`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до швидкої конвертації', 'quick_convert')]])
      );
      return;
    }
    
    // Показуємо курси для обраної суми
    const message = currencyConverter.formatExchangeRatesForCurrency(currency, amount);
    
    const buttons = [
      [Markup.button.callback('💱 Конвертувати іншу суму', 'convert_currency')],
      [Markup.button.callback('📊 Курси валют', 'exchange_rates')],
      [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx, message, menu);
    
    console.log(`⚡ Швидка конвертація: ${amount} ${currency} для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при швидкій конвертації:', error);
  }
});

// Конвертація валют
bot.action('convert_currency', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      convertingCurrency: true,
      step: 'entering_amount'
    });
    
    const buttons = [
      [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx,
      '💱 Конвертація валют:\n\n💰 Введіть суму для конвертації:\n\n💡 Наприклад: 100',
      menu
    );
  } catch (error) {
    console.error('Помилка при конвертації валют:', error);
  }
});

// Курси валют
bot.action('exchange_rates', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const rates = currencyConverter.getExchangeRates();
    const currencies = currencyConverter.getCurrencies();
    
    if (rates.size > 0) {
      // Показуємо курси для 100 USD за замовчуванням
      const message = currencyConverter.formatExchangeRatesForAmount(100);
      
      const buttons = [
        [Markup.button.callback('💰 Ввести суму', 'enter_amount_for_rates')],
        [Markup.button.callback('🏦 Змінити базову валюту', 'select_base_currency')],
        [Markup.button.callback('🔄 Оновити курси', 'refresh_rates')],
        [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      await safeEditMessage(ctx, message, menu);
    } else {
      await safeEditMessage(ctx,
        '❌ Курси валют недоступні. Спробуйте оновити курси.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]])
      );
    }
  } catch (error) {
    console.error('Помилка при показі курсів валют:', error);
  }
});

// Вибір базової валюти для курсів
bot.action('select_base_currency', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      selectingBaseCurrency: true,
      step: 'selecting_currency'
    });
    
    const buttons = createCurrencyButtons('base_currency', null);
    buttons.push([Markup.button.callback('🔙 Назад до курсів', 'exchange_rates')]);
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx,
      '🏦 Оберіть базову валюту для курсів:\n\n💡 Курси будуть показані відносно обраної валюти',
      menu
    );
  } catch (error) {
    console.error('Помилка при виборі базової валюти:', error);
  }
});

// Обробка вибору базової валюти
bot.action(/base_currency_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const selectedCurrency = ctx.match[1];
    const userState = userStates.get(ctx.from.id);
    
    if (userState && userState.selectingBaseCurrency) {
      // Очищаємо стан
      userStates.delete(ctx.from.id);
      
      // Показуємо курси для обраної валюти (100 одиниць)
      const message = currencyConverter.formatExchangeRatesForCurrency(selectedCurrency, 100);
      
      const buttons = [
        [Markup.button.callback('💰 Ввести суму', 'enter_amount_for_rates')],
        [Markup.button.callback('🏦 Змінити базову валюту', 'select_base_currency')],
        [Markup.button.callback('🔄 Оновити курси', 'refresh_rates')],
        [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      await safeEditMessage(ctx, message, menu);
      
      console.log(`🏦 Змінено базову валюту на ${selectedCurrency} для користувача ${ctx.from.id}`);
    }
  } catch (error) {
    console.error('Помилка при виборі базової валюти:', error);
  }
});

// Введення суми для курсів
bot.action('enter_amount_for_rates', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      enteringAmountForRates: true,
      step: 'entering_amount'
    });
    
    const buttons = [
      [Markup.button.callback('🔙 Назад до курсів', 'exchange_rates')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx,
      '💰 Введіть суму для перегляду курсів:\n\n💡 Наприклад: 100, 1000, 50.5\n\n💱 Курси будуть показані відносно USD',
      menu
    );
  } catch (error) {
    console.error('Помилка при введенні суми для курсів:', error);
  }
});

// Оновлення курсів
bot.action('refresh_rates', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    await safeEditMessage(ctx, '🔄 Оновлення курсів валют...');
    
    await currencyConverter.updateExchangeRates();
    
    const buttons = [
      [Markup.button.callback('📊 Подивитися курси', 'exchange_rates')],
      [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await safeEditMessage(ctx,
      '✅ Курси валют оновлено!\n\n📅 Останнє оновлення: ' + 
      (currencyConverter.lastUpdate ? currencyConverter.lastUpdate.toLocaleString('uk-UA') : 'Невідомо'),
      menu
    );
  } catch (error) {
    console.error('Помилка при оновленні курсів:', error);
    await safeEditMessage(ctx,
      '❌ Помилка при оновленні курсів. Спробуйте ще раз.',
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]])
    );
  }
});

// Обробка натискань кнопок
bot.action('help', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const helpMessage = await ctx.editMessageText(
      '📋 Допомога:\n\n/start - Головне меню\n/menu - Оновити меню\n/clear - Очистити чат\n/help - Ця довідка\n/info - Інформація про бота\n/tomorrow_plan - План на завтра\n/currency_converter - Конвертер валют\n/statistics - Статистика\n/reminder_settings - Налаштування нагадувань',
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]])
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, helpMessage.message_id);
    
    console.log(`📋 Показано допомогу для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при показі допомоги:', error);
  }
});

bot.action('info', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const infoMessage = await ctx.editMessageText(
      'ℹ️ Інформація:\n\n🤖 Версія: 4.0.0\n📅 Створено: 2024\n💻 Технології: Node.js, Telegraf, SQLite\n🗄️ База даних: Покращена система з міграціями\n⏰ Нагадування: Автоматичні повідомлення\n💱 Конвертер: Реальні курси від НБУ\n🧹 Чат: Автоматичне очищення при нових сесіях',
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]])
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, infoMessage.message_id);
    
    console.log(`ℹ️ Показано інформацію для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при показі інформації:', error);
  }
});

// Обробка кнопки адмін панелі
bot.action('admin_panel', async (ctx) => {
  try {
    const userId = ctx.from.id;
    
    if (!checkIfAdmin(userId)) {
      await ctx.answerCbQuery('❌ Доступ заборонено!');
      return;
    }
    
    // Отримуємо публічну URL з ngrok
    const ngrokUrl = await getNgrokUrl();
    const adminUrl = ngrokUrl || process.env.ADMIN_URL || 'http://localhost:3000';
    
    if (adminUrl.startsWith('https://') || adminUrl.includes('ngrok.io')) {
      await ctx.answerCbQuery('🔗 Відкриваю адмін панель...');
      
      // Відправляємо повідомлення з посиланням
      await ctx.reply(
        `🛡️ **Адмін панель**\n\n🔗 [Відкрити адмін панель](${adminUrl})\n\n🔑 **Пароль:** admin123\n\n💡 Натисніть на посилання вище для доступу до адмін панелі.`,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [Markup.button.url('🛡️ Відкрити адмін панель', adminUrl)],
              [Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]
            ]
          }
        }
      );
    } else {
      await ctx.answerCbQuery('⚠️ Адмін панель недоступна через ngrok');
      await ctx.reply(
        '⚠️ **Адмін панель недоступна**\n\n🔧 Переконайтеся, що:\n• Ngrok запущений\n• Адмін панель працює\n• Порт 4040 доступний\n\n💡 Спробуйте запустити: `python3 start_admin_with_ngrok.py`',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [Markup.button.callback('🔄 Спробувати знову', 'admin_panel')],
              [Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]
            ]
          }
        }
      );
    }
    
  } catch (error) {
    console.error('Помилка обробки адмін панелі:', error);
    await ctx.answerCbQuery('❌ Помилка доступу до адмін панелі');
  }
});

// Обробка повернення до меню
bot.action('back_to_menu', async (ctx) => {
  try {
    await clearAllUserMessages(ctx);
    await showMainMenu(ctx);
  } catch (error) {
    console.error('Помилка повернення до меню:', error);
  }
});

// Налаштування нагадувань
bot.action('reminder_settings', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Очищаємо чат при вході в налаштування
    await clearChat(ctx);
    
    const settings = await dbManager.getUserReminderSettings(ctx.from.id);
    const status = settings.reminder_enabled ? '✅ Увімкнено' : '❌ Вимкнено';
    
    const buttons = [
      [Markup.button.callback(settings.reminder_enabled ? '❌ Вимкнути нагадування' : '✅ Увімкнути нагадування', 'toggle_reminder')],
      [Markup.button.callback('🕐 Змінити час нагадування', 'change_reminder_time')],
      [Markup.button.callback('📅 Створити нагадування', 'create_reminder')],
      [Markup.button.callback('📋 Мої нагадування', 'my_reminders')],
      [Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const reminderMessage = await ctx.editMessageText(
      `⏰ Налаштування нагадувань:\n\n${status}\n🕐 Час нагадування: ${settings.reminder_time}\n\n💡 Нагадування відправляються щодня о вказаний час, якщо у вас є плани на завтра.`,
      menu
    );
    
    // Очищаємо старі повідомлення через 10 секунд
    setTimeout(async () => {
      await clearBotMessages(ctx, reminderMessage.message_id);
    }, 10000);
    
  } catch (error) {
    console.error('Помилка при показі налаштувань нагадувань:', error);
  }
});

// Створення нагадування
bot.action('create_reminder', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      creatingReminder: true,
      step: 'selecting_date'
    });
    
    const dates = dbManager.generateCalendarDates();
    const buttons = [];
    
    // Створюємо кнопки для дат (по 3 в ряд)
    for (let i = 0; i < dates.length; i += 3) {
      const row = [];
      for (let j = 0; j < 3 && i + j < dates.length; j++) {
        const date = dates[i + j];
        const label = date.isToday ? '📅 Сьогодні' : 
                     date.isTomorrow ? '📅 Завтра' : 
                     date.display;
        row.push(Markup.button.callback(label, `select_date_${date.date}`));
      }
      buttons.push(row);
    }
    
    buttons.push([Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]);
    
    const menu = Markup.inlineKeyboard(buttons);
    await ctx.editMessageText(
      '📅 Оберіть дату для нагадування:\n\n💡 Виберіть дату, коли хочете отримати нагадування.',
      menu
    );
  } catch (error) {
    console.error('Помилка при створенні нагадування:', error);
  }
});

// Обробка вибору дати
bot.action(/select_date_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const selectedDate = ctx.match[1];
    const userState = userStates.get(ctx.from.id);
    
    if (userState && userState.creatingReminder) {
      userState.selectedDate = selectedDate;
      userState.step = 'selecting_time';
      
      const timeSlots = dbManager.generateTimeSlots();
      const buttons = [];
      
      // Створюємо кнопки для часу (по 4 в ряд)
      for (let i = 0; i < timeSlots.length; i += 4) {
        const row = [];
        for (let j = 0; j < 4 && i + j < timeSlots.length; j++) {
          const timeSlot = timeSlots[i + j];
          row.push(Markup.button.callback(timeSlot.display, `select_time_${timeSlot.time}`));
        }
        buttons.push(row);
      }
      
      buttons.push([Markup.button.callback('🔙 Назад до вибору дати', 'create_reminder')]);
      
      const menu = Markup.inlineKeyboard(buttons);
      await ctx.editMessageText(
        `🕐 Оберіть час для нагадування на ${selectedDate}:\n\n💡 Виберіть час, коли хочете отримати нагадування.`,
        menu
      );
    }
  } catch (error) {
    console.error('Помилка при виборі дати:', error);
  }
});

// Обробка вибору часу
bot.action(/select_time_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const selectedTime = ctx.match[1];
    const userState = userStates.get(ctx.from.id);
    
    if (userState && userState.creatingReminder && userState.selectedDate) {
      userState.selectedTime = selectedTime;
      userState.step = 'entering_message';
      
      const buttons = [
        [Markup.button.callback('🔙 Назад до вибору часу', `select_date_${userState.selectedDate}`)]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      await ctx.editMessageText(
        `📝 Введіть текст нагадування:\n\n📅 Дата: ${userState.selectedDate}\n🕐 Час: ${selectedTime}\n\n💡 Напишіть що саме нагадувати.`,
        menu
      );
    }
  } catch (error) {
    console.error('Помилка при виборі часу:', error);
  }
});

// Мої нагадування
bot.action('my_reminders', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const reminders = await dbManager.getUserReminders(ctx.from.id);
    
    if (reminders.length > 0) {
      let message = '📋 Ваші нагадування:\n\n';
      
      reminders.forEach((reminder, index) => {
        const status = reminder.sent ? '✅ Відправлено' : '⏳ Очікує';
        const date = formatDate(reminder.reminder_date);
        message += `${index + 1}. ${date} о ${reminder.reminder_time}\n`;
        message += `   ${status}\n`;
        message += `   📝 ${reminder.message}\n\n`;
      });
      
      const buttons = [
        [Markup.button.callback('🗑️ Видалити нагадування', 'delete_reminder_menu')],
        [Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      await ctx.editMessageText(message, menu);
    } else {
      await ctx.editMessageText(
        '📝 У вас поки немає нагадувань!\n\n💡 Створіть своє перше нагадування.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]])
      );
    }
  } catch (error) {
    console.error('Помилка при отриманні нагадувань:', error);
    await ctx.editMessageText('❌ Помилка при отриманні нагадувань. Спробуйте ще раз.');
  }
});

// Меню видалення нагадування
bot.action('delete_reminder_menu', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const reminders = await dbManager.getUserReminders(ctx.from.id);
    
    if (reminders.length > 0) {
      const buttons = [];
      
      reminders.forEach((reminder, index) => {
        const date = formatDate(reminder.reminder_date);
        buttons.push([Markup.button.callback(
          `🗑️ ${date} о ${reminder.reminder_time}`,
          `delete_reminder_${reminder.id}`
        )]);
      });
      
      buttons.push([Markup.button.callback('🔙 Назад до нагадувань', 'my_reminders')]);
      
      const menu = Markup.inlineKeyboard(buttons);
      await ctx.editMessageText(
        '🗑️ Оберіть нагадування для видалення:',
        menu
      );
    } else {
      await ctx.editMessageText(
        '📝 Немає нагадувань для видалення.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до нагадувань', 'my_reminders')]])
      );
    }
  } catch (error) {
    console.error('Помилка при показі меню видалення:', error);
  }
});

// Видалення нагадування
bot.action(/delete_reminder_(\d+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const reminderId = parseInt(ctx.match[1]);
    const success = await dbManager.deleteReminder(reminderId, ctx.from.id);
    
    if (success) {
      await ctx.editMessageText(
        '✅ Нагадування видалено!\n\n💡 Можете створити нове нагадування.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до нагадувань', 'my_reminders')]])
      );
    } else {
      await ctx.editMessageText(
        '❌ Не вдалося видалити нагадування.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до нагадувань', 'my_reminders')]])
      );
    }
  } catch (error) {
    console.error('Помилка при видаленні нагадування:', error);
    await ctx.editMessageText('❌ Помилка. Спробуйте ще раз.');
  }
});

// Перемикання нагадувань
bot.action('toggle_reminder', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const settings = await dbManager.getUserReminderSettings(ctx.from.id);
    const newStatus = !settings.reminder_enabled;
    
    await dbManager.updateUserReminderSettings(ctx.from.id, settings.reminder_time, newStatus);
    
    const status = newStatus ? '✅ Увімкнено' : '❌ Вимкнено';
    
    const buttons = [
      [Markup.button.callback(newStatus ? '❌ Вимкнути нагадування' : '✅ Увімкнути нагадування', 'toggle_reminder')],
      [Markup.button.callback('🕐 Змінити час нагадування', 'change_reminder_time')],
      [Markup.button.callback('📅 Створити нагадування', 'create_reminder')],
      [Markup.button.callback('📋 Мої нагадування', 'my_reminders')],
      [Markup.button.callback('🔙 Назад до меню', 'back_to_menu')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await ctx.editMessageText(
      `⏰ Налаштування нагадувань:\n\n${status}\n🕐 Час нагадування: ${settings.reminder_time}\n\n💡 Нагадування відправляються щодня о вказаний час, якщо у вас є плани на завтра.`,
      menu
    );
  } catch (error) {
    console.error('Помилка при перемиканні нагадувань:', error);
  }
});

// Зміна часу нагадування
bot.action('change_reminder_time', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      waitingForReminderTime: true,
      step: 'entering_reminder_time'
    });
    
    const buttons = [
      [Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    await ctx.editMessageText(
      '🕐 Введіть час нагадування у форматі HH:MM (наприклад, 07:00):\n\n💡 Нагадування буде відправлятися щодня о вказаний час.',
      menu
    );
  } catch (error) {
    console.error('Помилка при зміні часу нагадування:', error);
  }
});

// Обробка кнопки "План на завтра"
bot.action('tomorrow_plan', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const buttons = [
      [Markup.button.callback('➕ Додати план', 'add_plan')],
      [Markup.button.callback('👁️ Подивитися план', 'view_plan')],
      [Markup.button.callback('📋 Історія планів', 'plan_history')],
      [Markup.button.callback('🔙 Назад', 'back_to_menu')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const planMessage = await ctx.editMessageText(
      '📝 План на завтра:\n\n💡 Оберіть дію:\n\n➕ Додати план - створити новий план\n👁️ Подивитися план - переглянути поточний план\n📋 Історія планів - переглянути всі плани',
      menu
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, planMessage.message_id);
    
    console.log(`📝 Показано меню планів для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при показі меню планів:', error);
  }
});

// Додавання плану
bot.action('add_plan', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Зберігаємо стан користувача
    userStates.set(ctx.from.id, { 
      waitingForPlan: true,
      step: 'entering_plan'
    });
    
    const buttons = [
      [Markup.button.callback('🔙 Назад до меню', 'cancel_plan')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const addPlanMessage = await ctx.editMessageText(
      '📝 Введіть ваш план на завтра:\n\n💡 Наприклад: "Зробити зарядку, прочитати книгу, подзвонити мамі"\n\n💡 Ви можете написати кілька пунктів, розділивши їх комами або новими рядками.\n\n⏰ Нагадування буде відправлено завтра о 7 ранку!',
      menu
    );
    
    // Очищаємо старі повідомлення через 15 секунд
    setTimeout(async () => {
      await clearBotMessages(ctx, addPlanMessage.message_id);
    }, 15000);
    
  } catch (error) {
    console.error('Помилка при додаванні плану:', error);
  }
});

// Скасування створення плану
bot.action('cancel_plan', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    // Очищаємо стан
    userStates.delete(ctx.from.id);
    
    const buttons = [
      [Markup.button.callback('➕ Додати план', 'add_plan')],
      [Markup.button.callback('👁️ Подивитися план', 'view_plan')],
      [Markup.button.callback('📋 Історія планів', 'plan_history')],
      [Markup.button.callback('🔙 Назад', 'back_to_menu')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const cancelMessage = await ctx.editMessageText(
      '📝 План на завтра:\n\n💡 Оберіть дію:\n\n➕ Додати план - створити новий план\n👁️ Подивитися план - переглянути поточний план\n📋 Історія планів - переглянути всі плани',
      menu
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, cancelMessage.message_id);
    
    console.log(`📝 Скасовано створення плану для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при скасуванні плану:', error);
  }
});

// Перегляд плану
bot.action('view_plan', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const plan = await dbManager.getPlan(ctx.from.id);
    
    if (plan) {
      const status = plan.completed ? '✅ Виконано' : '⏳ В очікуванні';
      const priority = plan.priority > 1 ? '🔥 Важливо' : '';
      const category = plan.category !== 'general' ? `📂 ${plan.category}` : '';
      
      const buttons = [
        [Markup.button.callback('✅ Позначити виконаним', `complete_plan_${plan.id}`)],
        [Markup.button.callback('🗑️ Видалити план', `delete_plan_${plan.id}`)],
        [Markup.button.callback('🔙 Назад', 'tomorrow_plan')]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      
      const viewPlanMessage = await ctx.editMessageText(
        `📅 План на ${formatDate(plan.plan_date)}:\n\n📝 ${plan.plan_text}\n\n${status} ${priority} ${category}\n\n📅 Створено: ${formatDate(plan.created_at)}`,
        menu
      );
      
      // Очищаємо старі повідомлення через 10 секунд
      setTimeout(async () => {
        await clearBotMessages(ctx, viewPlanMessage.message_id);
      }, 10000);
      
    } else {
      const noPlanMessage = await ctx.editMessageText(
        '📝 План на завтра ще не створено!\n\n💡 Натисніть "Додати план" щоб створити свій план.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
      
      // Очищаємо старі повідомлення через 8 секунд
      setTimeout(async () => {
        await clearBotMessages(ctx, noPlanMessage.message_id);
      }, 8000);
    }
  } catch (error) {
    console.error('Помилка при перегляді плану:', error);
    await ctx.editMessageText('❌ Помилка при отриманні плану. Спробуйте ще раз.');
  }
});

// Позначення плану як виконаного
bot.action(/complete_plan_(\d+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const planId = parseInt(ctx.match[1]);
    const success = await dbManager.markPlanCompleted(planId, ctx.from.id);
    
    if (success) {
      await ctx.editMessageText(
        '✅ План позначено як виконаний!\n\n🎉 Вітаємо з виконанням плану!',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    } else {
      await ctx.editMessageText(
        '❌ Не вдалося позначити план як виконаний.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    }
  } catch (error) {
    console.error('Помилка при позначенні плану:', error);
    await ctx.editMessageText('❌ Помилка. Спробуйте ще раз.');
  }
});

// Видалення плану
bot.action(/delete_plan_(\d+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const planId = parseInt(ctx.match[1]);
    const success = await dbManager.deletePlan(planId, ctx.from.id);
    
    if (success) {
      await ctx.editMessageText(
        '🗑️ План видалено!\n\n💡 Можете створити новий план.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    } else {
      await ctx.editMessageText(
        '❌ Не вдалося видалити план.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    }
  } catch (error) {
    console.error('Помилка при видаленні плану:', error);
    await ctx.editMessageText('❌ Помилка. Спробуйте ще раз.');
  }
});

// Історія планів
bot.action('plan_history', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const plans = await dbManager.getPlans(ctx.from.id, 5);
    
    if (plans.length > 0) {
      let message = '📋 Ваші останні плани:\n\n';
      
      plans.forEach((plan, index) => {
        const status = plan.completed ? '✅' : '⏳';
        const priority = plan.priority > 1 ? '🔥' : '';
        const date = formatDate(plan.plan_date);
        message += `${status} ${priority} ${date}: ${plan.plan_text}\n\n`;
      });
      
      await ctx.editMessageText(
        message,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    } else {
      await ctx.editMessageText(
        '📝 У вас поки немає планів!\n\n💡 Створіть свій перший план.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'tomorrow_plan')]])
      );
    }
  } catch (error) {
    console.error('Помилка при отриманні історії:', error);
    await ctx.editMessageText('❌ Помилка при отриманні історії. Спробуйте ще раз.');
  }
});

// Статистика
bot.action('statistics', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const stats = await dbManager.getStatistics(ctx.from.id, 7);
    
    if (stats.length > 0) {
      let message = '📊 Ваша статистика за останні 7 днів:\n\n';
      
      stats.forEach((stat, index) => {
        const date = formatDate(stat.date);
        message += `📅 ${date}:\n`;
        message += `   ➕ Створено: ${stat.plans_created || 0}\n`;
        message += `   ✅ Виконано: ${stat.plans_completed || 0}\n\n`;
      });
      
      await ctx.editMessageText(
        message,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'back_to_menu')]])
      );
    } else {
      await ctx.editMessageText(
        '📊 Поки немає статистики!\n\n💡 Створіть плани щоб побачити статистику.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад', 'back_to_menu')]])
      );
    }
  } catch (error) {
    console.error('Помилка при отриманні статистики:', error);
    await ctx.editMessageText('❌ Помилка при отриманні статистики. Спробуйте ще раз.');
  }
});

// Повернення до головного меню
bot.action('back_to_menu', async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const menu = await createMainMenu(ctx.from.id);
    const menuMessage = await ctx.editMessageText(
      '👋 Вітаю! Я сучасний Telegram-бот з покращеною системою планування, нагадуваннями та конвертером валют!\n\n💡 Меню залишається доступним для зручності навігації.',
      menu
    );
    
    // Відстежуємо повідомлення
    trackMessage(ctx.from.id, menuMessage.message_id);
    
    console.log(`🔙 Повернення до меню для користувача ${ctx.from.id}`);
    
  } catch (error) {
    console.error('Помилка при поверненні до меню:', error);
  }
});

// Оптимізована функція створення кнопок валют
function createCurrencyButtons(step, selectedCurrency = null) {
  const currencies = currencyConverter.getCurrencies();
  const buttons = [];
  
  // Створюємо кнопки валют (по 3 в ряд)
  const currencyEntries = Object.entries(currencies);
  for (let i = 0; i < currencyEntries.length; i += 3) {
    const row = [];
    for (let j = 0; j < 3 && i + j < currencyEntries.length; j++) {
      const [code, info] = currencyEntries[i + j];
      const isSelected = selectedCurrency === code;
      const label = `${isSelected ? '✅' : ''} ${info.flag} ${code}`;
      
      // Використовуємо правильний префікс залежно від кроку
      let callbackData;
      switch (step) {
        case 'from':
          callbackData = `from_currency_${code}`;
          break;
        case 'to':
          callbackData = `to_currency_${code}`;
          break;
        case 'base_currency':
          callbackData = `base_currency_${code}`;
          break;
        default:
          callbackData = `${step}_${code}`;
      }
      
      row.push(Markup.button.callback(label, callbackData));
    }
    buttons.push(row);
  }
  
  return buttons;
}

// Обробка вибору валюти "з"
bot.action(/from_currency_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const selectedCurrency = ctx.match[1];
    const userState = userStates.get(ctx.from.id);
    
    if (userState && userState.convertingCurrency && userState.step === 'selecting_from_currency') {
      userState.fromCurrency = selectedCurrency;
      userState.step = 'selecting_to_currency';
      
      const buttons = createCurrencyButtons('to', userState.toCurrency);
      buttons.push([Markup.button.callback('🔙 Назад до вибору валюти "з"', 'convert_currency')]);
      
      const menu = Markup.inlineKeyboard(buttons);
      const currencyInfo = currencyConverter.getCurrencies()[selectedCurrency];
      
      await safeEditMessage(ctx,
        `💱 Конвертація валют:\n\n💰 Сума: ${userState.amount}\n📤 З: ${currencyInfo.flag} ${selectedCurrency}\n📥 В: Оберіть валюту\n\n💡 Оберіть валюту, в яку хочете конвертувати:`,
        menu
      );
      
      console.log(`📤 Валюту "з" обрано: ${selectedCurrency} для користувача ${ctx.from.id}`);
      
    } else {
      console.log(`❌ Неправильний стан користувача ${ctx.from.id} для вибору валюти "з"`);
      await safeEditMessage(ctx,
        '❌ Помилка: необхідно спочатку ввести суму для конвертації.',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]])
      );
    }
  } catch (error) {
    console.error('Помилка при виборі валюти "з":', error);
  }
});

// Обробка вибору валюти "в"
bot.action(/to_currency_(.+)/, async (ctx) => {
  try {
    await dbManager.updateUserActivity(ctx.from.id);
    
    const selectedCurrency = ctx.match[1];
    const userState = userStates.get(ctx.from.id);
    
    if (userState && userState.convertingCurrency && userState.fromCurrency) {
      userState.toCurrency = selectedCurrency;
      
      // Виконуємо конвертацію
      try {
        const conversion = currencyConverter.convert(
          parseFloat(userState.amount),
          userState.fromCurrency,
          selectedCurrency
        );
        
        const formatted = currencyConverter.formatResult(conversion);
        
        const buttons = [
          [Markup.button.callback('💱 Нова конвертація', 'convert_currency')],
          [Markup.button.callback('📊 Курси валют', 'exchange_rates')],
          [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
        ];
        
        const menu = Markup.inlineKeyboard(buttons);
        
        await safeEditMessage(ctx,
          `💱 Результат конвертації:\n\n${formatted.from}\n⬇️\n${formatted.to}\n\n📊 Курс: ${formatted.rate}\n📊 Зворотний курс: ${formatted.reverseRate}\n📅 Дата: ${formatted.date}`,
          menu
        );
        
        // Очищаємо стан
        userStates.delete(ctx.from.id);
        
        console.log(`💱 Конвертація виконана: ${userState.amount} ${userState.fromCurrency} = ${conversion.result.toFixed(2)} ${selectedCurrency} для користувача ${ctx.from.id}`);
        
      } catch (error) {
        console.error('Помилка при конвертації:', error);
        await safeEditMessage(ctx,
          '❌ Помилка при конвертації. Перевірте чи всі валюти підтримуються.',
          Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]])
        );
      }
    } else {
      console.log(`❌ Неправильний стан користувача ${ctx.from.id} для конвертації`);
      await safeEditMessage(ctx,
        '❌ Помилка: необхідно спочатку ввести суму та вибрати валюту "з".',
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]])
      );
    }
  } catch (error) {
    console.error('Помилка при виборі валюти "в":', error);
  }
});

// Обробка текстового повідомлення
bot.on('text', async (ctx) => {
  const userState = userStates.get(ctx.from.id);
  
  if (userState && userState.waitingForPlan) {
    try {
      const planText = ctx.message.text.trim();
      
      // Перевіряємо чи план не порожній
      if (planText.length === 0) {
        await ctx.reply('❌ План не може бути порожнім. Спробуйте ще раз.');
        return;
      }
      
      // Перевіряємо довжину плану
      if (planText.length > 1000) {
        await ctx.reply('❌ План занадто довгий. Максимум 1000 символів.');
        return;
      }
      
      const result = await dbManager.savePlan(ctx.from.id, planText);
      
      // Очищаємо стан
      userStates.delete(ctx.from.id);
      
      const actionText = result.updated ? 'оновлено' : 'збережено';
      
      await ctx.reply(
        `✅ План на завтра ${actionText}!\n\n📝 Ваш план:\n${planText}\n\n⏰ Нагадування буде відправлено завтра о 7 ранку!`,
        Markup.inlineKeyboard([
          [Markup.button.callback('👁️ Подивитися план', 'view_plan')],
          [Markup.button.callback('🔙 Назад до меню', 'tomorrow_plan')]
        ])
      );
    } catch (error) {
      console.error('Помилка при збереженні плану:', error);
      await ctx.reply('❌ Помилка при збереженні плану. Спробуйте ще раз.');
    }
  } else if (userState && userState.waitingForReminderTime) {
    try {
      const timeText = ctx.message.text.trim();
      
      // Перевіряємо формат часу (HH:MM)
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(timeText)) {
        await ctx.reply('❌ Неправильний формат часу! Використовуйте формат HH:MM (наприклад, 07:00)');
        return;
      }
      
      const settings = await dbManager.getUserReminderSettings(ctx.from.id);
      await dbManager.updateUserReminderSettings(ctx.from.id, timeText, settings.reminder_enabled);
      
      // Очищаємо стан
      userStates.delete(ctx.from.id);
      
      await ctx.reply(
        `✅ Час нагадування змінено на ${timeText}!\n\n💡 Нагадування буде відправлятися щодня о ${timeText}, якщо у вас є плани на завтра.`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]])
      );
    } catch (error) {
      console.error('Помилка при зміні часу нагадування:', error);
      await ctx.reply('❌ Помилка при зміні часу нагадування. Спробуйте ще раз.');
    }
  } else if (userState && userState.creatingReminder && userState.step === 'entering_message') {
    try {
      const messageText = ctx.message.text.trim();
      
      // Перевіряємо чи повідомлення не порожнє
      if (messageText.length === 0) {
        await ctx.reply('❌ Текст нагадування не може бути порожнім. Спробуйте ще раз.');
        return;
      }
      
      // Перевіряємо довжину повідомлення
      if (messageText.length > 500) {
        await ctx.reply('❌ Текст нагадування занадто довгий. Максимум 500 символів.');
        return;
      }
      
      // Створюємо нагадування
      const reminderId = await dbManager.createCustomReminder(
        ctx.from.id,
        null, // plan_id може бути null для окремих нагадувань
        userState.selectedDate,
        userState.selectedTime,
        messageText
      );
      
      // Очищаємо стан
      userStates.delete(ctx.from.id);
      
      const selectedDate = formatDate(userState.selectedDate);
      
      await ctx.reply(
        `✅ Нагадування створено!\n\n📅 Дата: ${selectedDate}\n🕐 Час: ${userState.selectedTime}\n📝 Текст: ${messageText}\n\n⏰ Нагадування буде відправлено вказаного дня о вказаний час.`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📋 Мої нагадування', 'my_reminders')],
          [Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]
        ])
      );
    } catch (error) {
      console.error('Помилка при створенні нагадування:', error);
      await ctx.reply('❌ Помилка при створенні нагадування. Спробуйте ще раз.');
    }
  } else if (userState && userState.convertingCurrency && userState.step === 'entering_amount') {
    try {
      const amountText = ctx.message.text.trim();
      
      // Перевіряємо чи сума є числом
      const amount = parseFloat(amountText.replace(',', '.'));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Неправильна сума! Введіть додатне число.');
        return;
      }
      
      // Перевіряємо максимальну суму
      if (amount > 1000000) {
        await ctx.reply('❌ Сума занадто велика! Максимум 1,000,000.');
        return;
      }
      
      userState.amount = amount;
      userState.step = 'selecting_from_currency';
      
      const buttons = createCurrencyButtons('from', null);
      buttons.push([Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]);
      
      const menu = Markup.inlineKeyboard(buttons);
      const currencyMessage = await ctx.reply(
        `💰 Введена сума: ${amount}\n\n💱 Оберіть валюту, з якої конвертуємо:`,
        menu
      );
      
      // Відстежуємо повідомлення
      trackMessage(ctx.from.id, currencyMessage.message_id);
      
      console.log(`💰 Сума ${amount} введена для конвертації користувачем ${ctx.from.id}`);
      
    } catch (error) {
      console.error('Помилка при обробці суми:', error);
      await ctx.reply('❌ Помилка при обробці суми. Спробуйте ще раз.');
    }
    return;
  } else if (userState && userState.enteringAmountForRates) {
    try {
      const amountText = ctx.message.text.trim();
      
      // Перевіряємо чи сума є числом
      const amount = parseFloat(amountText);
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Неправильна сума! Введіть додатне число.');
        return;
      }
      
      // Перевіряємо максимальну суму
      if (amount > 1000000) {
        await ctx.reply('❌ Сума занадто велика! Максимум 1,000,000.');
        return;
      }
      
      // Очищаємо стан
      userStates.delete(ctx.from.id);
      
      // Показуємо курси для введеної суми (за замовчуванням USD)
      const message = currencyConverter.formatExchangeRatesForAmount(amount);
      
      const buttons = [
        [Markup.button.callback('💰 Ввести іншу суму', 'enter_amount_for_rates')],
        [Markup.button.callback('🏦 Змінити базову валюту', 'select_base_currency')],
        [Markup.button.callback('🔄 Оновити курси', 'refresh_rates')],
        [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
      ];
      
      const menu = Markup.inlineKeyboard(buttons);
      const ratesMessage = await ctx.reply(message, menu);
      
      // Відстежуємо повідомлення
      trackMessage(ctx.from.id, ratesMessage.message_id);
      
      console.log(`📊 Показано курси для суми ${amount} користувачу ${ctx.from.id}`);
      
    } catch (error) {
      console.error('Помилка при обробці суми для курсів:', error);
      await ctx.reply('❌ Помилка при обробці суми. Спробуйте ще раз.');
    }
    return;
  }
});

// Створюємо екземпляр системи нагадувань
const reminderSystem = new ReminderSystem(bot, dbManager);

// Оптимізована функція запуску бота
async function startBot() {
  try {
    console.log('🚀 Запуск бота...');
    
    // Ініціалізуємо базу даних
    await dbManager.initialize();
    
    // Ініціалізуємо конвертер валют
    await currencyConverter.initialize();
    
    // Запускаємо систему нагадувань
    reminderSystem.start();
    
    // Запускаємо бота
    await bot.launch();
    
    console.log('🤖 Бот запущено!');
    console.log('⏰ Система нагадувань активна');
    console.log('💱 Конвертер валют активний');
    
    // Обробка завершення роботи
    process.once('SIGINT', () => {
      console.log('🛑 Отримано сигнал SIGINT, завершення роботи...');
      bot.stop('SIGINT');
      reminderSystem.stop();
      db.close();
    });
    
    process.once('SIGTERM', () => {
      console.log('🛑 Отримано сигнал SIGTERM, завершення роботи...');
      bot.stop('SIGTERM');
      reminderSystem.stop();
      db.close();
    });
    
  } catch (error) {
    console.error('❌ Помилка запуску бота:', error);
    process.exit(1);
  }
}

startBot(); 

// Обробка виходу користувача з бота
bot.on('left_chat_member', async (ctx) => {
  const userId = ctx.message.left_chat_member.id;
  
  // Очищаємо всі дані користувача
  cleanupUserData(userId);
  
  console.log(`👋 Користувач ${userId} вийшов з бота. Дані очищено.`);
});

// Обробка блокування бота користувачем
bot.on('my_chat_member', async (ctx) => {
  if (ctx.update.my_chat_member.new_chat_member.status === 'kicked') {
    const userId = ctx.from.id;
    
    // Очищаємо всі дані користувача
    cleanupUserData(userId);
    
    console.log(`🚫 Користувач ${userId} заблокував бота. Дані очищено.`);
  }
});

// Функція для автоматичного очищення даних користувача
function cleanupUserData(userId) {
  messageTracker.delete(userId);
  userActivityTracker.delete(userId);
  userStates.delete(userId);
  userSessionTracker.delete(userId); // Очищаємо сесію
  console.log(`🧹 Автоматично очищено дані користувача ${userId}`);
}

// Функція для очищення повідомлень бота
async function clearBotMessages(ctx, exceptMessageId = null) {
  try {
    // Очищаємо старі повідомлення, крім поточного
    const keepCount = exceptMessageId ? 1 : 0;
    await clearAllUserMessages(ctx, exceptMessageId);
    console.log(`🧹 Очищення повідомлень бота для користувача ${ctx.from.id}`);
  } catch (error) {
    console.error('❌ Помилка при очищенні повідомлень бота:', error);
  }
}

// Безпечне редагування повідомлення
async function safeEditMessage(ctx, text, markup) {
  try {
    await ctx.editMessageText(text, markup);
  } catch (editError) {
    // Якщо повідомлення не змінилося, просто ігноруємо помилку
    if (editError.description && editError.description.includes('message is not modified')) {
      console.log(`ℹ️ Повідомлення не змінилося для користувача ${ctx.from.id}`);
      return;
    }
    throw editError;
  }
}

// Оптимізовані функції обробки введення
async function handlePlanInput(ctx) {
  try {
    const planText = ctx.message.text.trim();
    
    if (planText.length === 0) {
      await ctx.reply('❌ План не може бути порожнім.');
      return;
    }
    
    if (planText.length > 1000) {
      await ctx.reply('❌ План занадто довгий. Максимум 1000 символів.');
      return;
    }
    
    const result = await dbManager.savePlan(ctx.from.id, planText);
    userStates.delete(ctx.from.id);
    
    const actionText = result.updated ? 'оновлено' : 'збережено';
    
    await ctx.reply(
      `✅ План на завтра ${actionText}!\n\n📝 Ваш план:\n${planText}\n\n⏰ Нагадування буде відправлено завтра о 7 ранку!`,
      Markup.inlineKeyboard([
        [Markup.button.callback('👁️ Подивитися план', 'view_plan')],
        [Markup.button.callback('🔙 Назад до меню', 'tomorrow_plan')]
      ])
    );
  } catch (error) {
    console.error('Помилка збереження плану:', error);
    await ctx.reply('❌ Помилка при збереженні плану.');
  }
}

async function handleReminderTimeInput(ctx) {
  try {
    const timeText = ctx.message.text.trim();
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
    
    if (!timeRegex.test(timeText)) {
      await ctx.reply('❌ Неправильний формат часу! Використовуйте HH:MM');
      return;
    }
    
    const settings = await dbManager.getUserReminderSettings(ctx.from.id);
    await dbManager.updateUserReminderSettings(ctx.from.id, timeText, settings.reminder_enabled);
    userStates.delete(ctx.from.id);
    
    await ctx.reply(
      `✅ Час нагадування змінено на ${timeText}!`,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]])
    );
  } catch (error) {
    console.error('Помилка зміни часу:', error);
    await ctx.reply('❌ Помилка при зміні часу нагадування.');
  }
}

async function handleReminderMessageInput(ctx) {
  try {
    const messageText = ctx.message.text.trim();
    
    if (messageText.length === 0) {
      await ctx.reply('❌ Текст нагадування не може бути порожнім.');
      return;
    }
    
    if (messageText.length > 500) {
      await ctx.reply('❌ Текст нагадування занадто довгий. Максимум 500 символів.');
      return;
    }
    
    const reminderId = await dbManager.createCustomReminder(
      ctx.from.id,
      null,
      userState.selectedDate,
      userState.selectedTime,
      messageText
    );
    
    userStates.delete(ctx.from.id);
    const selectedDate = formatDate(userState.selectedDate);
    
    await ctx.reply(
      `✅ Нагадування створено!\n\n📅 Дата: ${selectedDate}\n🕐 Час: ${userState.selectedTime}\n📝 Текст: ${messageText}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📋 Мої нагадування', 'my_reminders')],
        [Markup.button.callback('🔙 Назад до налаштувань', 'reminder_settings')]
      ])
    );
  } catch (error) {
    console.error('Помилка створення нагадування:', error);
    await ctx.reply('❌ Помилка при створенні нагадування.');
  }
}

async function handleCurrencyAmountInput(ctx) {
  try {
    const amountText = ctx.message.text.trim();
    const amount = parseFloat(amountText.replace(',', '.'));
    
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Неправильна сума! Введіть додатне число.');
      return;
    }
    
    if (amount > 1000000) {
      await ctx.reply('❌ Сума занадто велика! Максимум 1,000,000.');
      return;
    }
    
    const userState = userStates.get(ctx.from.id);
    userState.amount = amount;
    userState.step = 'selecting_from_currency';
    
    const buttons = createCurrencyButtons('from', null);
    buttons.push([Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]);
    
    const menu = Markup.inlineKeyboard(buttons);
    const currencyMessage = await ctx.reply(
      `💰 Введена сума: ${amount}\n\n💱 Оберіть валюту, з якої конвертуємо:`,
      menu
    );
    
    trackMessage(ctx.from.id, currencyMessage.message_id);
  } catch (error) {
    console.error('Помилка обробки суми:', error);
    await ctx.reply('❌ Помилка при обробці суми.');
  }
}

async function handleRatesAmountInput(ctx) {
  try {
    const amountText = ctx.message.text.trim();
    const amount = parseFloat(amountText.replace(',', '.'));
    
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Неправильна сума! Введіть додатне число.');
      return;
    }
    
    if (amount > 1000000) {
      await ctx.reply('❌ Сума занадто велика! Максимум 1,000,000.');
      return;
    }
    
    userStates.delete(ctx.from.id);
    const message = currencyConverter.formatExchangeRatesForAmount(amount);
    
    const buttons = [
      [Markup.button.callback('💰 Ввести іншу суму', 'enter_amount_for_rates')],
      [Markup.button.callback('🏦 Змінити базову валюту', 'select_base_currency')],
      [Markup.button.callback('🔄 Оновити курси', 'refresh_rates')],
      [Markup.button.callback('🔙 Назад до конвертера', 'currency_converter')]
    ];
    
    const menu = Markup.inlineKeyboard(buttons);
    const ratesMessage = await ctx.reply(message, menu);
    
    trackMessage(ctx.from.id, ratesMessage.message_id);
  } catch (error) {
    console.error('Помилка обробки суми для курсів:', error);
    await ctx.reply('❌ Помилка при обробці суми.');
  }
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Не завершуємо процес!
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Не завершуємо процес!
});

const REMINDER_CHECK_INTERVAL_SECONDS = parseInt(process.env.REMINDER_CHECK_INTERVAL_SECONDS, 10) || 60;

reminderSystem.startAutoCheck();