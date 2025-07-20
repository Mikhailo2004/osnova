#!/bin/bash

# 🚀 Універсальний скрипт запуску Telegram бота з адмін панеллю
# Автоматично запускає: бота, адмін панель, ngrok

set -e  # Зупиняємо виконання при помилці

# Кольори для виводу
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Функції для красивого виводу
print_header() {
    echo -e "${PURPLE}================================${NC}"
    echo -e "${PURPLE}🚀 TELEGRAM BOT LAUNCHER${NC}"
    echo -e "${PURPLE}================================${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_step() {
    echo -e "${CYAN}🔧 $1${NC}"
}

# Функція очищення при завершенні
cleanup() {
    echo ""
    print_warning "Завершення роботи..."
    
    # Зупиняємо всі процеси
    pkill -f "ngrok" 2>/dev/null || true
    pkill -f "web_admin.py" 2>/dev/null || true
    pkill -f "node bot.js" 2>/dev/null || true
    
    print_success "Всі процеси зупинено"
    exit 0
}

# Обробка Ctrl+C
trap cleanup SIGINT SIGTERM

# Функція перевірки залежностей
check_dependencies() {
    print_step "Перевірка залежностей..."
    
    # Перевіряємо Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js не встановлений"
        exit 1
    fi
    print_success "Node.js встановлений"
    
    # Перевіряємо npm
    if ! command -v npm &> /dev/null; then
        print_error "npm не встановлений"
        exit 1
    fi
    print_success "npm встановлений"
    
    # Перевіряємо Python3
    if ! command -v python3 &> /dev/null; then
        print_error "Python3 не встановлений"
        exit 1
    fi
    print_success "Python3 встановлений"
    
    # Перевіряємо ngrok
    if ! command -v ngrok &> /dev/null; then
        print_error "ngrok не встановлений"
        print_info "Встановіть: brew install ngrok"
        exit 1
    fi
    print_success "ngrok встановлений"
    
    # Перевіряємо Python залежності
    if ! python3 -c "import flask, requests" 2>/dev/null; then
        print_warning "Python залежності не встановлені"
        print_info "Встановлюю залежності..."
        pip3 install -r requirements_admin.txt
    fi
    print_success "Python залежності встановлені"
}

# Функція встановлення npm залежностей
install_npm_deps() {
    if [ ! -d "node_modules" ]; then
        print_step "Встановлення npm залежностей..."
        npm install
        print_success "npm залежності встановлені"
    else
        print_success "npm залежності вже встановлені"
    fi
}

# Функція зупинки попередніх процесів
stop_previous_processes() {
    print_step "Зупинка попередніх процесів..."
    
    pkill -f "ngrok" 2>/dev/null || true
    pkill -f "web_admin.py" 2>/dev/null || true
    pkill -f "node bot.js" 2>/dev/null || true
    
    sleep 2
    print_success "Попередні процеси зупинено"
}

# Функція запуску адмін панелі
start_admin_panel() {
    print_step "Запуск адмін панелі..."
    
    python3 web_admin.py > logs/admin_panel.log 2>&1 &
    ADMIN_PID=$!
    
    # Чекаємо поки адмін панель запуститься
    for i in {1..10}; do
        if curl -s http://localhost:3000 > /dev/null 2>&1; then
            print_success "Адмін панель запущена (PID: $ADMIN_PID)"
            return 0
        fi
        sleep 1
        echo -n "."
    done
    
    print_error "Не вдалося запустити адмін панель"
    return 1
}

# Функція запуску ngrok
start_ngrok() {
    print_step "Запуск ngrok..."
    
    ngrok http 3000 > logs/ngrok.log 2>&1 &
    NGROK_PID=$!
    
    # Чекаємо поки ngrok запуститься
    for i in {1..15}; do
        if curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
            # Отримуємо публічну URL
            NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    if data['tunnels']:
        print(data['tunnels'][0]['public_url'])
    else:
        print('')
except:
    print('')
")
            
            if [ ! -z "$NGROK_URL" ]; then
                print_success "Ngrok запущений (PID: $NGROK_PID)"
                print_info "Публічна URL: $NGROK_URL"
                
                # Зберігаємо URL в файл
                echo "$NGROK_URL" > admin_url.txt
                return 0
            fi
        fi
        sleep 2
        echo -n "."
    done
    
    print_error "Не вдалося запустити ngrok"
    return 1
}

# Функція запуску бота
start_bot() {
    print_step "Запуск Telegram бота..."
    
    npm start > logs/bot.log 2>&1 &
    BOT_PID=$!
    
    # Чекаємо поки бот запуститься
    sleep 3
    
    if ps -p $BOT_PID > /dev/null; then
        print_success "Telegram бот запущений (PID: $BOT_PID)"
        return 0
    else
        print_error "Не вдалося запустити бота"
        return 1
    fi
}

# Функція показу статусу
show_status() {
    echo ""
    echo -e "${PURPLE}================================${NC}"
    echo -e "${PURPLE}🎯 СТАТУС СИСТЕМИ${NC}"
    echo -e "${PURPLE}================================${NC}"
    
    # Отримуємо поточну URL
    if [ -f "admin_url.txt" ]; then
        NGROK_URL=$(cat admin_url.txt)
        echo -e "${GREEN}🌐 Публічна URL адмін панелі:${NC} $NGROK_URL"
    else
        echo -e "${YELLOW}🌐 Публічна URL:${NC} очікування..."
    fi
    
    echo -e "${GREEN}🔑 Пароль адмін панелі:${NC} admin123"
    echo -e "${GREEN}🔧 Локальний порт:${NC} 3000"
    echo -e "${GREEN}🤖 Telegram бот:${NC} активний"
    echo -e "${GREEN}⏰ Час запуску:${NC} $(date '+%H:%M:%S')"
    
    echo -e "${PURPLE}================================${NC}"
    echo -e "${CYAN}💡 Натисніть Ctrl+C для завершення${NC}"
    echo -e "${CYAN}🌐 Відкрити адмін панель: ./open_admin.command${NC}"
    echo -e "${PURPLE}================================${NC}"
}

# Функція моніторингу процесів
monitor_processes() {
    print_info "Моніторинг процесів активний..."
    
    while true; do
        # Перевіряємо чи всі процеси працюють
        if ! ps -p $ADMIN_PID > /dev/null 2>&1; then
            print_error "Адмін панель зупинилася!"
            break
        fi
        
        if ! ps -p $NGROK_PID > /dev/null 2>&1; then
            print_error "Ngrok зупинився!"
            break
        fi
        
        if ! ps -p $BOT_PID > /dev/null 2>&1; then
            print_error "Telegram бот зупинився!"
            break
        fi
        
        sleep 10
    done
}

# Головна функція
main() {
    print_header
    
    # Створюємо папку для логів
    mkdir -p logs
    
    # Перевіряємо залежності
    check_dependencies
    
    # Встановлюємо npm залежності
    install_npm_deps
    
    # Зупиняємо попередні процеси
    stop_previous_processes
    
    # Запускаємо компоненти
    if ! start_admin_panel; then
        cleanup
    fi
    
    if ! start_ngrok; then
        cleanup
    fi
    
    if ! start_bot; then
        cleanup
    fi
    
    # Показуємо статус
    show_status
    
    # Запускаємо моніторинг
    monitor_processes
}

# Запускаємо головну функцію
main "$@" 