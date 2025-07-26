// reminders.js
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
        let message = `⏰ Нагадування!\n\n${reminder.message}\n\n📅 Дата: ${reminder.reminder_date}\n⏰ Час: ${reminder.reminder_time}`;
        
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
    }, 60000); // 60 секунд
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

module.exports = ReminderSystem; 