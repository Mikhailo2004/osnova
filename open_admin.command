#!/bin/bash

# Скрипт для відкриття адмін панелі в браузері

echo "🌐 Відкриття адмін панелі..."

# Отримуємо URL з ngrok
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if data['tunnels']:
        print(data['tunnels'][0]['public_url'])
    else:
        print('http://localhost:3000')
except:
    print('http://localhost:3000')
")

if [ -z "$NGROK_URL" ]; then
    NGROK_URL="http://localhost:3000"
fi

echo "🔗 URL: $NGROK_URL"
echo "🔑 Пароль: admin123"
echo ""

# Відкриваємо в браузері
open "$NGROK_URL"

echo "✅ Адмін панель відкрита в браузері!"
echo "💡 Якщо сторінка не завантажилася, спробуйте оновити її" 