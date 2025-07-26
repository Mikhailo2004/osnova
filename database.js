// database.js
const sqlite3 = require('sqlite3').verbose();

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

module.exports = DatabaseManager; 