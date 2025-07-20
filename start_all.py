#!/usr/bin/env python3
"""
Скрипт для запуску бота та адмін панелі разом з ngrok
Автоматично налаштовує все для роботи
"""

import os
import subprocess
import time
import requests
import json
import threading
from datetime import datetime

class BotAdminLauncher:
    def __init__(self):
        self.admin_port = int(os.getenv('ADMIN_PORT', 3000))
        self.ngrok_process = None
        self.admin_process = None
        self.bot_process = None
        self.public_url = None
        
    def check_dependencies(self):
        """Перевірка залежностей"""
        print("🔍 Перевірка залежностей...")
        
        # Перевіряємо ngrok
        try:
            result = subprocess.run(['ngrok', 'version'], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Ngrok встановлений")
            else:
                print("❌ Ngrok не знайдений")
                return False
        except:
            print("❌ Ngrok не встановлений")
            return False
        
        # Перевіряємо Node.js
        try:
            result = subprocess.run(['node', '--version'], capture_output=True, text=True)
            if result.returncode == 0:
                print("✅ Node.js встановлений")
            else:
                print("❌ Node.js не знайдений")
                return False
        except:
            print("❌ Node.js не встановлений")
            return False
        
        # Перевіряємо Python залежності
        try:
            import flask
            import requests
            print("✅ Python залежності встановлені")
        except ImportError as e:
            print(f"❌ Відсутні Python залежності: {e}")
            print("💡 Встановіть: pip3 install -r requirements_admin.txt")
            return False
        
        return True
    
    def start_ngrok(self):
        """Запуск ngrok"""
        print("🌐 Запуск ngrok...")
        
        try:
            # Зупиняємо попередні процеси ngrok
            subprocess.run(['pkill', '-f', 'ngrok'], capture_output=True)
            time.sleep(2)
            
            # Запускаємо ngrok
            self.ngrok_process = subprocess.Popen([
                'ngrok', 'http', str(self.admin_port)
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Чекаємо поки ngrok запуститься
            time.sleep(5)
            
            # Отримуємо публічну URL
            for attempt in range(10):
                try:
                    response = requests.get('http://localhost:4040/api/tunnels', timeout=5)
                    if response.status_code == 200:
                        tunnels = response.json()['tunnels']
                        if tunnels:
                            self.public_url = tunnels[0]['public_url']
                            print(f"✅ Ngrok запущений!")
                            print(f"🌐 Публічна URL: {self.public_url}")
                            return True
                except:
                    pass
                
                time.sleep(2)
                print(f"⏳ Очікування ngrok... (спроба {attempt + 1}/10)")
                
            print("❌ Не вдалося отримати URL від ngrok")
            return False
            
        except Exception as e:
            print(f"❌ Помилка запуску ngrok: {e}")
            return False
    
    def start_admin_panel(self):
        """Запуск адмін панелі"""
        print("🚀 Запуск адмін панелі...")
        
        try:
            # Зупиняємо попередні процеси адмін панелі
            subprocess.run(['pkill', '-f', 'web_admin.py'], capture_output=True)
            time.sleep(2)
            
            # Запускаємо адмін панель
            self.admin_process = subprocess.Popen([
                'python3', 'web_admin.py'
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Чекаємо поки адмін панель запуститься
            time.sleep(5)
            
            # Перевіряємо чи адмін панель працює
            for attempt in range(10):
                try:
                    response = requests.get(f'http://localhost:{self.admin_port}', timeout=5)
                    if response.status_code in [200, 302]:  # 302 - redirect to login
                        print("✅ Адмін панель успішно запущена!")
                        return True
                except:
                    pass
                
                time.sleep(2)
                print(f"⏳ Очікування адмін панелі... (спроба {attempt + 1}/10)")
                
            print("❌ Не вдалося запустити адмін панель")
            return False
            
        except Exception as e:
            print(f"❌ Помилка запуску адмін панелі: {e}")
            return False
    
    def start_bot(self):
        """Запуск бота"""
        print("🤖 Запуск Telegram бота...")
        
        try:
            # Зупиняємо попередні процеси бота
            subprocess.run(['pkill', '-f', 'node bot.js'], capture_output=True)
            time.sleep(2)
            
            # Перевіряємо чи встановлені npm залежності
            if not os.path.exists('node_modules'):
                print("📦 Встановлення npm залежностей...")
                subprocess.run(['npm', 'install'], check=True)
            
            # Запускаємо бота
            self.bot_process = subprocess.Popen([
                'npm', 'start'
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            
            # Чекаємо поки бот запуститься
            time.sleep(5)
            
            print("✅ Telegram бот запущений!")
            return True
            
        except Exception as e:
            print(f"❌ Помилка запуску бота: {e}")
            return False
    
    def show_status(self):
        """Показ статусу"""
        print("\n" + "="*70)
        print("🎯 СТАТУС СИСТЕМИ")
        print("="*70)
        
        if self.public_url:
            print(f"🌐 Публічна URL адмін панелі: {self.public_url}")
            print(f"🔑 Пароль адмін панелі: admin123")
            print(f"📱 Відкрийте посилання в браузері для доступу")
        else:
            print("❌ Ngrok не запущений")
            
        print(f"🔧 Локальний порт адмін панелі: {self.admin_port}")
        print(f"🤖 Telegram бот: активний")
        print(f"⏰ Час запуску: {datetime.now().strftime('%H:%M:%S')}")
        print("="*70)
        print("💡 Натисніть Ctrl+C для завершення роботи")
        print("="*70)
    
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
                
                # Перевіряємо чи бот працює
                if self.bot_process and self.bot_process.poll() is not None:
                    print("❌ Telegram бот зупинився!")
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
            
        if self.bot_process:
            self.bot_process.terminate()
            print("✅ Telegram бот зупинений")
    
    def run(self):
        """Основний метод запуску"""
        print("🚀 Запуск повної системи (Бот + Адмін панель + Ngrok)...")
        print("="*70)
        
        # Перевіряємо залежності
        if not self.check_dependencies():
            print("❌ Не всі залежності встановлені!")
            return
        
        try:
            # Запускаємо адмін панель
            if not self.start_admin_panel():
                return
            
            # Запускаємо ngrok
            if not self.start_ngrok():
                return
            
            # Запускаємо бота
            if not self.start_bot():
                return
            
            # Показуємо статус
            self.show_status()
            
            # Запускаємо моніторинг
            self.monitor_processes()
            
        except KeyboardInterrupt:
            print("\n👋 Отримано сигнал завершення")
        except Exception as e:
            print(f"❌ Критична помилка: {e}")
        finally:
            self.cleanup()

if __name__ == '__main__':
    launcher = BotAdminLauncher()
    launcher.run() 