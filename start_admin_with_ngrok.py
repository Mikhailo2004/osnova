#!/usr/bin/env python3
"""
Скрипт для запуску адмін панелі з ngrok
Автоматично створює публічну URL для доступу
"""

import os
import subprocess
import time
import requests
import json
import threading
from datetime import datetime

class NgrokAdmin:
    def __init__(self):
        self.admin_port = int(os.getenv('ADMIN_PORT', 3000))
        self.ngrok_process = None
        self.admin_process = None
        self.public_url = None
        
    def start_admin_panel(self):
        """Запуск адмін панелі"""
        print("🚀 Запуск адмін панелі...")
        
        try:
            # Запускаємо адмін панель у фоновому режимі
            self.admin_process = subprocess.Popen([
                'python3', 'web_admin.py'
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Чекаємо поки адмін панель запуститься
            time.sleep(3)
            
            # Перевіряємо чи адмін панель працює
            try:
                response = requests.get(f'http://localhost:{self.admin_port}', timeout=5)
                if response.status_code in [200, 302]:  # 302 - redirect to login
                    print("✅ Адмін панель успішно запущена!")
                    return True
            except:
                pass
                
            print("❌ Помилка запуску адмін панелі")
            return False
            
        except Exception as e:
            print(f"❌ Помилка: {e}")
            return False
    
    def start_ngrok(self):
        """Запуск ngrok"""
        print("🌐 Запуск ngrok...")
        
        try:
            # Запускаємо ngrok
            self.ngrok_process = subprocess.Popen([
                'ngrok', 'http', str(self.admin_port)
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Чекаємо поки ngrok запуститься
            time.sleep(5)
            
            # Отримуємо публічну URL
            try:
                response = requests.get('http://localhost:4040/api/tunnels', timeout=10)
                if response.status_code == 200:
                    tunnels = response.json()['tunnels']
                    if tunnels:
                        self.public_url = tunnels[0]['public_url']
                        print(f"✅ Ngrok запущений!")
                        print(f"🌐 Публічна URL: {self.public_url}")
                        return True
            except:
                pass
                
            print("❌ Помилка запуску ngrok")
            return False
            
        except Exception as e:
            print(f"❌ Помилка: {e}")
            return False
    
    def update_bot_admin_url(self):
        """Оновлення URL адмін панелі в боті"""
        if not self.public_url:
            return
            
        print("🤖 Оновлення URL адмін панелі в боті...")
        
        try:
            # Читаємо поточний код бота
            with open('bot.js', 'r', encoding='utf-8') as f:
                bot_code = f.read()
            
            # Замінюємо URL адмін панелі
            old_pattern = r"const adminUrl = process\.env\.ADMIN_URL \|\| 'http://localhost:3000';"
            new_pattern = f"const adminUrl = process.env.ADMIN_URL || '{self.public_url}';"
            
            if old_pattern in bot_code:
                bot_code = bot_code.replace(old_pattern, new_pattern)
                
                # Зберігаємо оновлений код
                with open('bot.js', 'w', encoding='utf-8') as f:
                    f.write(bot_code)
                
                print("✅ URL адмін панелі оновлено в боті!")
                
                # Перезапускаємо бота якщо він запущений
                self.restart_bot()
                
        except Exception as e:
            print(f"❌ Помилка оновлення URL: {e}")
    
    def restart_bot(self):
        """Перезапуск бота"""
        try:
            # Зупиняємо поточний процес бота
            subprocess.run(['pkill', '-f', 'node bot.js'], capture_output=True)
            time.sleep(2)
            
            # Запускаємо бота знову
            subprocess.Popen(['npm', 'start'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            print("🔄 Бот перезапущений з новою URL адмін панелі!")
            
        except Exception as e:
            print(f"❌ Помилка перезапуску бота: {e}")
    
    def show_status(self):
        """Показ статусу"""
        print("\n" + "="*60)
        print("🎯 СТАТУС СИСТЕМИ")
        print("="*60)
        
        if self.public_url:
            print(f"🌐 Публічна URL адмін панелі: {self.public_url}")
            print(f"🔑 Пароль: admin123")
            print(f"📱 Відкрийте посилання в браузері для доступу")
        else:
            print("❌ Ngrok не запущений")
            
        print(f"🔧 Локальний порт: {self.admin_port}")
        print(f"⏰ Час запуску: {datetime.now().strftime('%H:%M:%S')}")
        print("="*60)
    
    def monitor_processes(self):
        """Моніторинг процесів"""
        while True:
            try:
                # Перевіряємо чи адмін панель працює
                if self.admin_process and self.admin_process.poll() is not None:
                    print("❌ Адмін панель зупинилася!")
                    break
                
                # Перевіряємо чи ngrok працює
                if self.ngrok_process and self.ngrok_process.poll() is not None:
                    print("❌ Ngrok зупинився!")
                    break
                
                time.sleep(10)
                
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"❌ Помилка моніторингу: {e}")
                break
    
    def cleanup(self):
        """Очищення при завершенні"""
        print("\n🛑 Завершення роботи...")
        
        if self.admin_process:
            self.admin_process.terminate()
            print("✅ Адмін панель зупинена")
            
        if self.ngrok_process:
            self.ngrok_process.terminate()
            print("✅ Ngrok зупинений")
    
    def run(self):
        """Основний метод запуску"""
        print("🚀 Запуск адмін панелі з ngrok...")
        print("="*60)
        
        try:
            # Запускаємо адмін панель
            if not self.start_admin_panel():
                return
            
            # Запускаємо ngrok
            if not self.start_ngrok():
                return
            
            # Оновлюємо URL в боті
            self.update_bot_admin_url()
            
            # Показуємо статус
            self.show_status()
            
            # Запускаємо моніторинг
            print("\n📊 Моніторинг процесів активний...")
            print("💡 Натисніть Ctrl+C для завершення")
            
            self.monitor_processes()
            
        except KeyboardInterrupt:
            print("\n👋 Отримано сигнал завершення")
        except Exception as e:
            print(f"❌ Критична помилка: {e}")
        finally:
            self.cleanup()

if __name__ == '__main__':
    ngrok_admin = NgrokAdmin()
    ngrok_admin.run() 