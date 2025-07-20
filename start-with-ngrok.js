require('dotenv').config();
const { spawn } = require('child_process');

async function startWithNgrok() {
  try {
    console.log('🚀 Запуск веб-адмінки...');
    
    // Запускаємо веб-сервер
    const adminServer = spawn('node', ['admin-panel/server.js'], {
      stdio: 'inherit'
    });
    
    // Чекаємо трохи, щоб сервер запустився
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('🌐 Запуск ngrok...');
    
    // Запускаємо ngrok через командний рядок
    const ngrokProcess = spawn('ngrok', ['http', '3000'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let ngrokUrl = '';
    
    // Отримуємо URL від ngrok
    ngrokProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('Ngrok:', output);
      
      // Шукаємо URL в виводі ngrok
      const urlMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok\.io/);
      if (urlMatch && !ngrokUrl) {
        ngrokUrl = urlMatch[0];
        console.log('\n✅ Ngrok запущено!');
        console.log(`🔗 Публічне посилання: ${ngrokUrl}`);
        console.log(`🛡️ Адмін панель доступна за адресою: ${ngrokUrl}`);
        console.log(`🔑 Пароль: ${process.env.ADMIN_PASSWORD || 'admin123'}`);
        
        // Запускаємо бота з оновленим URL
        console.log('\n🤖 Запуск бота...');
        const bot = spawn('node', ['bot.js'], {
          stdio: 'inherit',
          env: { ...process.env, ADMIN_URL: ngrokUrl }
        });
        
        // Обробка завершення
        process.on('SIGINT', async () => {
          console.log('\n🛑 Зупинка сервісів...');
          adminServer.kill();
          bot.kill();
          ngrokProcess.kill();
          process.exit(0);
        });
      }
    });
    
    ngrokProcess.stderr.on('data', (data) => {
      console.log('Ngrok error:', data.toString());
    });
    
  } catch (error) {
    console.error('❌ Помилка:', error);
    process.exit(1);
  }
}

startWithNgrok(); 