#!/bin/bash

# 🛑 Скрипт зупинки Telegram бота та всіх компонентів

# Кольори для виводу
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${PURPLE}================================${NC}"
    echo -e "${PURPLE}🛑 TELEGRAM BOT STOPPER${NC}"
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
    echo -e "${BLUE}🔧 $1${NC}"
}

# Функція зупинки процесів
stop_processes() {
    print_step "Зупинка всіх процесів..."
    
    # Зупиняємо ngrok
    if pkill -f "ngrok" 2>/dev/null; then
        print_success "Ngrok зупинений"
    else
        print_info "Ngrok не був запущений"
    fi
    
    # Зупиняємо адмін панель
    if pkill -f "web_admin.py" 2>/dev/null; then
        print_success "Адмін панель зупинена"
    else
        print_info "Адмін панель не була запущена"
    fi
    
    # Зупиняємо бота
    if pkill -f "node bot.js" 2>/dev/null; then
        print_success "Telegram бот зупинений"
    else
        print_info "Telegram бот не був запущений"
    fi
    
    # Додатково зупиняємо npm процеси
    if pkill -f "npm start" 2>/dev/null; then
        print_success "npm процеси зупинені"
    fi
    
    sleep 2
}

# Функція перевірки чи процеси зупинені
check_processes() {
    print_step "Перевірка статусу процесів..."
    
    local running_processes=0
    
    if pgrep -f "ngrok" > /dev/null; then
        print_warning "Ngrok все ще працює"
        running_processes=$((running_processes + 1))
    fi
    
    if pgrep -f "web_admin.py" > /dev/null; then
        print_warning "Адмін панель все ще працює"
        running_processes=$((running_processes + 1))
    fi
    
    if pgrep -f "node bot.js" > /dev/null; then
        print_warning "Telegram бот все ще працює"
        running_processes=$((running_processes + 1))
    fi
    
    if pgrep -f "npm start" > /dev/null; then
        print_warning "npm процеси все ще працюють"
        running_processes=$((running_processes + 1))
    fi
    
    if [ $running_processes -eq 0 ]; then
        print_success "Всі процеси успішно зупинені!"
    else
        print_warning "Залишилося $running_processes процесів"
        print_info "Спробуйте запустити скрипт ще раз"
    fi
}

# Функція очищення тимчасових файлів
cleanup_files() {
    print_step "Очищення тимчасових файлів..."
    
    # Видаляємо файл з URL
    if [ -f "admin_url.txt" ]; then
        rm admin_url.txt
        print_success "Файл admin_url.txt видалений"
    fi
    
    # Очищаємо логи (опціонально)
    if [ -d "logs" ]; then
        print_info "Логи збережені в папці logs/"
    fi
}

# Головна функція
main() {
    print_header
    
    # Зупиняємо процеси
    stop_processes
    
    # Перевіряємо результат
    check_processes
    
    # Очищаємо файли
    cleanup_files
    
    echo ""
    print_success "Зупинка завершена!"
    print_info "Для запуску використовуйте: ./start_bot.command"
}

# Запускаємо головну функцію
main "$@" 