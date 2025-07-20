#!/usr/bin/env python3
"""
Універсальний скрипт для запуску:
- Flask адмін панелі (web_admin.py)
- ngrok (отримує публічну URL)
- Telegram бота (node bot.js) з актуальною ngrok URL
Все працює в одному процесі, зручний моніторинг і зупинка.
"""
import os
import subprocess
import time
import requests
import signal
import sys
from datetime import datetime

ADMIN_PORT = int(os.getenv('ADMIN_PORT', 3000))
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin123')

processes = []

def start_flask():
    print("\n🚀 Запуск Flask адмін панелі...")
    proc = subprocess.Popen([
        'python3', 'web_admin.py'
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(proc)
    # Чекаємо запуску Flask
    for i in range(20):
        try:
            r = requests.get(f'http://localhost:{ADMIN_PORT}', timeout=1)
            if r.status_code in [200, 302]:
                print(f"✅ Flask адмін панель запущена на http://localhost:{ADMIN_PORT}")
                return proc
        except Exception:
            pass
        time.sleep(1)
    print("❌ Не вдалося запустити Flask адмін панель!")
    stop_all()
    sys.exit(1)

def start_ngrok():
    print("\n🌐 Запуск ngrok...")
    # Запускаємо ngrok
    proc = subprocess.Popen([
        'ngrok', 'http', str(ADMIN_PORT)
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(proc)
    # Чекаємо появи публічної URL
    for i in range(20):
        try:
            r = requests.get('http://localhost:4040/api/tunnels', timeout=2)
            tunnels = r.json().get('tunnels', [])
            if tunnels:
                url = tunnels[0]['public_url']
                print(f"✅ Ngrok URL: {url}")
                return url, proc
        except Exception:
            pass
        time.sleep(1)
    print("❌ Не вдалося отримати ngrok URL!")
    stop_all()
    sys.exit(1)

def start_bot(admin_url):
    print("\n🤖 Запуск Telegram бота...")
    env = os.environ.copy()
    env['ADMIN_URL'] = admin_url
    proc = subprocess.Popen([
        'npm', 'start'
    ], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(proc)
    time.sleep(3)
    print(f"✅ Бот запущений з ADMIN_URL={admin_url}")
    return proc

def stop_all(*args):
    print("\n🛑 Зупинка всіх процесів...")
    for proc in processes:
        try:
            proc.terminate()
        except Exception:
            pass
    time.sleep(2)
    print("✅ Всі процеси зупинено!")
    sys.exit(0)

def show_status(admin_url):
    print("\n====================================")
    print(f"🌐 Адмін панель: {admin_url}")
    print(f"🔑 Пароль: {ADMIN_PASSWORD}")
    print(f"⏰ Час запуску: {datetime.now().strftime('%H:%M:%S')}")
    print("====================================\n")
    print("💡 Для зупинки натисніть Ctrl+C")

def main():
    signal.signal(signal.SIGINT, stop_all)
    signal.signal(signal.SIGTERM, stop_all)
    print("\n🚀 Універсальний запуск: Flask + ngrok + Telegram бот")
    flask_proc = start_flask()
    ngrok_url, ngrok_proc = start_ngrok()
    bot_proc = start_bot(ngrok_url)
    show_status(ngrok_url)
    # Моніторинг
    try:
        while True:
            for proc in processes:
                if proc.poll() is not None:
                    print(f"❌ Один з процесів завершився (PID: {proc.pid})! Зупинка...")
                    stop_all()
            time.sleep(5)
    except KeyboardInterrupt:
        stop_all()

if __name__ == '__main__':
    main() 