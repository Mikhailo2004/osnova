#!/bin/bash

# 📊 Скрипт перевірки статусу Telegram бота та всіх компонентів

# Кольори для виводу
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${PURPLE}================================${NC}"
    echo -e "${PURPLE}📊 TELEGRAM BOT STATUS${NC}"
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

print_status() {
    if [ "$1" = "running" ]; then
        echo -e "${GREEN}🟢 $2${NC}"
    else
        echo -e "${RED}🔴 $2${NC}"
    fi
}

# Функція перевірки процесів
check_processes() {
    echo -e "${CYAN}🔍 Перевірка процесів...${NC}"
    echo ""
    
    # Перевіряємо Telegram бота
    if pgrep -f "node bot.js" > /dev/null; then
        BOT_PID=$(pgrep -f "node bot.js")
        print_status "running" "Telegram бот (PID: $BOT_PID)"
    else
        print_status "stopped" "Telegram бот"
    fi
    
    # Перевіряємо адмін панель
    if pgrep -f "web_admin.py" > /dev/null; then
        ADMIN_PID=$(pgrep -f "web_admin.py")
        print_status "running" "Адмін панель (PID: $ADMIN_PID)"
    else
        print_status "stopped" "Адмін панель"
    fi
    
    # Перевіряємо ngrok
    if pgrep -f "ngrok" > /dev/null; then
        NGROK_PID=$(pgrep -f "ngrok")
        print_status "running" "Ngrok (PID: $NGROK_PID)"
    else
        print_status "stopped" "Ngrok"
    fi
    
    # Перевіряємо npm процеси
    if pgrep -f "npm start" > /dev/null; then
        NPM_PID=$(pgrep -f "npm start")
        print_status "running" "npm процеси (PID: $NPM_PID)"
    else
        print_status "stopped" "npm процеси"
    fi
}

# Функція перевірки портів
check_ports() {
    echo ""
    echo -e "${CYAN}🔍 Перевірка портів...${NC}"
    echo ""
    
    # Перевіряємо порт 3000 (адмін панель)
    if lsof -i :3000 > /dev/null 2>&1; then
        print_status "running" "Порт 3000 (адмін панель)"
    else
        print_status "stopped" "Порт 3000 (адмін панель)"
    fi
    
    # Перевіряємо порт 4040 (ngrok API)
    if lsof -i :4040 > /dev/null 2>&1; then
        print_status "running" "Порт 4040 (ngrok API)"
    else
        print_status "stopped" "Порт 4040 (ngrok API)"
    fi
}

# Функція перевірки ngrok URL
check_ngrok_url() {
    echo ""
    echo -e "${CYAN}🔍 Перевірка ngrok URL...${NC}"
    echo ""
    
    if curl -s http://localhost:4040/api/tunnels > /dev/null 2>&1; then
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
            print_success "Ngrok URL: $NGROK_URL"
            
            # Зберігаємо URL в файл
            echo "$NGROK_URL" > admin_url.txt
            
            # Перевіряємо доступність
            if curl -s "$NGROK_URL" > /dev/null 2>&1; then
                print_success "URL доступна"
            else
                print_warning "URL недоступна"
            fi
        else
            print_warning "Ngrok URL не знайдена"
        fi
    else
        print_error "Ngrok API недоступний"
    fi
}

# Функція перевірки адмін панелі
check_admin_panel() {
    echo ""
    echo -e "${CYAN}🔍 Перевірка адмін панелі...${NC}"
    echo ""
    
    if curl -s http://localhost:3000 > /dev/null 2>&1; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
        if [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "200" ]; then
            print_success "Адмін панель працює (код: $HTTP_CODE)"
            print_info "Пароль: admin123"
        else
            print_warning "Адмін панель відповідає з кодом: $HTTP_CODE"
        fi
    else
        print_error "Адмін панель недоступна"
    fi
}

# Функція показу статистики
show_statistics() {
    echo ""
    echo -e "${CYAN}📊 Статистика...${NC}"
    echo ""
    
    # Підраховуємо запущені процеси
    local running_count=0
    local total_count=4
    
    if pgrep -f "node bot.js" > /dev/null; then running_count=$((running_count + 1)); fi
    if pgrep -f "web_admin.py" > /dev/null; then running_count=$((running_count + 1)); fi
    if pgrep -f "ngrok" > /dev/null; then running_count=$((running_count + 1)); fi
    if pgrep -f "npm start" > /dev/null; then running_count=$((running_count + 1)); fi
    
    echo -e "${BLUE}Запущено процесів:${NC} $running_count/$total_count"
    
    if [ $running_count -eq $total_count ]; then
        print_success "Всі компоненти працюють!"
    elif [ $running_count -gt 0 ]; then
        print_warning "Частково працюють ($running_count/$total_count)"
    else
        print_error "Жоден компонент не працює"
    fi
}

# Функція показу рекомендацій
show_recommendations() {
    echo ""
    echo -e "${CYAN}💡 Рекомендації...${NC}"
    echo ""
    
    if ! pgrep -f "node bot.js" > /dev/null; then
        print_info "Для запуску бота: ./start_bot.command"
    fi
    
    if ! pgrep -f "web_admin.py" > /dev/null; then
        print_info "Для запуску адмін панелі: python3 web_admin.py"
    fi
    
    if ! pgrep -f "ngrok" > /dev/null; then
        print_info "Для запуску ngrok: ngrok http 3000"
    fi
    
    if [ -f "admin_url.txt" ]; then
        NGROK_URL=$(cat admin_url.txt)
        print_info "Для відкриття адмін панелі: ./open_admin.command"
        print_info "Або відкрийте: $NGROK_URL"
    fi
}

# Головна функція
main() {
    print_header
    echo -e "${BLUE}⏰ Час перевірки:${NC} $(date '+%Y-%m-%d %H:%M:%S')"
    echo ""
    
    check_processes
    check_ports
    check_ngrok_url
    check_admin_panel
    show_statistics
    show_recommendations
    
    echo ""
    echo -e "${PURPLE}================================${NC}"
    print_info "Для запуску: ./start_bot.command"
    print_info "Для зупинки: ./stop_bot.command"
    echo -e "${PURPLE}================================${NC}"
}

# Запускаємо головну функцію
main "$@" 