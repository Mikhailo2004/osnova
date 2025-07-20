#!/usr/bin/env python3
"""
Веб-адмін панель для Telegram бота
Позволяє контролювати бота через браузер
"""

import os
import sqlite3
import json
import hashlib
import time
from datetime import datetime, timedelta
from flask import Flask, render_template, request, redirect, url_for, flash, session, jsonify
from flask_socketio import SocketIO, emit
import threading
import requests
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.getenv('ADMIN_SECRET_KEY', 'your-secret-key-change-this')
socketio = SocketIO(app, cors_allowed_origins="*")

# Конфігурація
DATABASE_PATH = os.getenv('DATABASE_PATH', './data/bot.db')
BOT_TOKEN = os.getenv('TELEGRAM_BOT_TOKEN')
ADMIN_PASSWORD = os.getenv('ADMIN_PASSWORD', 'admin123')

class BotAdmin:
    def __init__(self):
        self.db_path = DATABASE_PATH
        self.bot_token = BOT_TOKEN
        self.stats_cache = {}
        self.cache_timeout = 300  # 5 хвилин
        
    def get_db_connection(self):
        """Підключення до бази даних"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    def get_bot_info(self):
        """Отримання інформації про бота"""
        try:
            if not self.bot_token:
                return {"error": "Bot token not configured"}
            
            url = f"https://api.telegram.org/bot{self.bot_token}/getMe"
            response = requests.get(url, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                if data.get('ok'):
                    return {
                        "name": data['result']['first_name'],
                        "username": data['result']['username'],
                        "id": data['result']['id'],
                        "status": "active"
                    }
            
            return {"error": "Failed to get bot info"}
        except Exception as e:
            return {"error": str(e)}
    
    def get_statistics(self):
        """Отримання статистики"""
        try:
            conn = self.get_db_connection()
            
            # Загальна статистика
            total_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            total_plans = conn.execute("SELECT COUNT(*) FROM tomorrow_plans").fetchone()[0]
            completed_plans = conn.execute("SELECT COUNT(*) FROM tomorrow_plans WHERE completed = 1").fetchone()[0]
            total_reminders = conn.execute("SELECT COUNT(*) FROM reminders").fetchone()[0]
            
            # Активність за останні 7 днів
            week_ago = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
            active_users = conn.execute(
                "SELECT COUNT(DISTINCT user_id) FROM tomorrow_plans WHERE created_at >= ?", 
                (week_ago,)
            ).fetchone()[0]
            
            # Топ користувачів
            top_users = conn.execute("""
                SELECT u.id, u.username, u.first_name, COUNT(p.id) as plans_count
                FROM users u
                LEFT JOIN tomorrow_plans p ON u.id = p.user_id
                GROUP BY u.id
                ORDER BY plans_count DESC
                LIMIT 10
            """).fetchall()
            
            conn.close()
            
            return {
                "total_users": total_users,
                "total_plans": total_plans,
                "completed_plans": completed_plans,
                "completion_rate": round((completed_plans / total_plans * 100) if total_plans > 0 else 0, 2),
                "total_reminders": total_reminders,
                "active_users_week": active_users,
                "top_users": [dict(user) for user in top_users]
            }
        except Exception as e:
            return {"error": str(e)}
    
    def get_users(self, limit=50, offset=0, search=None):
        """Отримання списку користувачів"""
        try:
            conn = self.get_db_connection()
            
            if search:
                users = conn.execute("""
                    SELECT * FROM users 
                    WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ?
                    ORDER BY last_activity DESC
                    LIMIT ? OFFSET ?
                """, (f'%{search}%', f'%{search}%', f'%{search}%', limit, offset)).fetchall()
            else:
                users = conn.execute("""
                    SELECT * FROM users 
                    ORDER BY last_activity DESC
                    LIMIT ? OFFSET ?
                """, (limit, offset)).fetchall()
            
            conn.close()
            return [dict(user) for user in users]
        except Exception as e:
            return {"error": str(e)}
    
    def get_plans(self, limit=50, offset=0, user_id=None):
        """Отримання планів"""
        try:
            conn = self.get_db_connection()
            
            if user_id:
                plans = conn.execute("""
                    SELECT p.*, u.username, u.first_name 
                    FROM tomorrow_plans p
                    JOIN users u ON p.user_id = u.id
                    WHERE p.user_id = ?
                    ORDER BY p.created_at DESC
                    LIMIT ? OFFSET ?
                """, (user_id, limit, offset)).fetchall()
            else:
                plans = conn.execute("""
                    SELECT p.*, u.username, u.first_name 
                    FROM tomorrow_plans p
                    JOIN users u ON p.user_id = u.id
                    ORDER BY p.created_at DESC
                    LIMIT ? OFFSET ?
                """, (limit, offset)).fetchall()
            
            conn.close()
            return [dict(plan) for plan in plans]
        except Exception as e:
            return {"error": str(e)}
    
    def get_reminders(self, limit=50, offset=0):
        """Отримання нагадувань"""
        try:
            conn = self.get_db_connection()
            
            reminders = conn.execute("""
                SELECT r.*, u.username, u.first_name 
                FROM reminders r
                JOIN users u ON r.user_id = u.id
                ORDER BY r.created_at DESC
                LIMIT ? OFFSET ?
            """, (limit, offset)).fetchall()
            
            conn.close()
            return [dict(reminder) for reminder in reminders]
        except Exception as e:
            return {"error": str(e)}
    
    def send_broadcast_message(self, message, user_ids=None):
        """Відправка широкомовного повідомлення"""
        try:
            if not self.bot_token:
                return {"error": "Bot token not configured"}
            
            if user_ids:
                # Відправка конкретним користувачам
                success_count = 0
                for user_id in user_ids:
                    url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
                    data = {
                        "chat_id": user_id,
                        "text": message,
                        "parse_mode": "HTML"
                    }
                    response = requests.post(url, json=data, timeout=10)
                    if response.status_code == 200:
                        success_count += 1
                
                return {"success": True, "sent": success_count, "total": len(user_ids)}
            else:
                # Відправка всім користувачам
                conn = self.get_db_connection()
                all_users = conn.execute("SELECT id FROM users").fetchall()
                conn.close()
                
                success_count = 0
                for user in all_users:
                    url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
                    data = {
                        "chat_id": user['id'],
                        "text": message,
                        "parse_mode": "HTML"
                    }
                    response = requests.post(url, json=data, timeout=10)
                    if response.status_code == 200:
                        success_count += 1
                
                return {"success": True, "sent": success_count, "total": len(all_users)}
                
        except Exception as e:
            return {"error": str(e)}
    
    def delete_user(self, user_id):
        """Видалення користувача"""
        try:
            conn = self.get_db_connection()
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.execute("DELETE FROM tomorrow_plans WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM reminders WHERE user_id = ?", (user_id,))
            conn.commit()
            conn.close()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}
    
    def delete_plan(self, plan_id):
        """Видалення плану"""
        try:
            conn = self.get_db_connection()
            conn.execute("DELETE FROM tomorrow_plans WHERE id = ?", (plan_id,))
            conn.commit()
            conn.close()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

# Створюємо екземпляр адміністратора
bot_admin = BotAdmin()

# Маршрути
@app.route('/')
def index():
    if 'logged_in' not in session:
        return redirect(url_for('login'))
    
    bot_info = bot_admin.get_bot_info()
    stats = bot_admin.get_statistics()
    
    return render_template('admin.html', 
                         bot_info=bot_info, 
                         stats=stats,
                         active_page='dashboard')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        password = request.form['password']
        
        if password == ADMIN_PASSWORD:
            session['logged_in'] = True
            session['login_time'] = time.time()
            flash('Успішний вхід!', 'success')
            return redirect(url_for('index'))
        else:
            flash('Неправильний пароль!', 'error')
    
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    flash('Ви вийшли з системи', 'info')
    return redirect(url_for('login'))

@app.route('/users')
def users():
    if 'logged_in' not in session:
        return redirect(url_for('login'))
    
    page = request.args.get('page', 1, type=int)
    search = request.args.get('search', '')
    limit = 20
    offset = (page - 1) * limit
    
    users = bot_admin.get_users(limit, offset, search if search else None)
    
    return render_template('users.html', 
                         users=users, 
                         page=page, 
                         search=search,
                         active_page='users')

@app.route('/plans')
def plans():
    if 'logged_in' not in session:
        return redirect(url_for('login'))
    
    page = request.args.get('page', 1, type=int)
    user_id = request.args.get('user_id', type=int)
    limit = 20
    offset = (page - 1) * limit
    
    plans = bot_admin.get_plans(limit, offset, user_id)
    
    return render_template('plans.html', 
                         plans=plans, 
                         page=page, 
                         user_id=user_id,
                         active_page='plans')

@app.route('/reminders')
def reminders():
    if 'logged_in' not in session:
        return redirect(url_for('login'))
    
    page = request.args.get('page', 1, type=int)
    limit = 20
    offset = (page - 1) * limit
    
    reminders = bot_admin.get_reminders(limit, offset)
    
    return render_template('reminders.html', 
                         reminders=reminders, 
                         page=page,
                         active_page='reminders')

@app.route('/broadcast', methods=['GET', 'POST'])
def broadcast():
    if 'logged_in' not in session:
        return redirect(url_for('login'))
    
    if request.method == 'POST':
        message = request.form['message']
        user_ids = request.form.getlist('user_ids')
        
        if user_ids and user_ids[0] == 'all':
            result = bot_admin.send_broadcast_message(message)
        else:
            result = bot_admin.send_broadcast_message(message, user_ids)
        
        if result.get('success'):
            flash(f'Повідомлення відправлено {result["sent"]} з {result["total"]} користувачів', 'success')
        else:
            flash(f'Помилка: {result.get("error")}', 'error')
        
        return redirect(url_for('broadcast'))
    
    users = bot_admin.get_users(1000)  # Отримуємо всіх користувачів для вибору
    
    return render_template('broadcast.html', 
                         users=users,
                         active_page='broadcast')

# API маршрути
@app.route('/api/stats')
def api_stats():
    if 'logged_in' not in session:
        return jsonify({"error": "Unauthorized"}), 401
    
    stats = bot_admin.get_statistics()
    return jsonify(stats)

@app.route('/api/delete_user/<int:user_id>', methods=['DELETE'])
def api_delete_user(user_id):
    if 'logged_in' not in session:
        return jsonify({"error": "Unauthorized"}), 401
    
    result = bot_admin.delete_user(user_id)
    return jsonify(result)

@app.route('/api/delete_plan/<int:plan_id>', methods=['DELETE'])
def api_delete_plan(plan_id):
    if 'logged_in' not in session:
        return jsonify({"error": "Unauthorized"}), 401
    
    result = bot_admin.delete_plan(plan_id)
    return jsonify(result)

@app.route('/api/send_message', methods=['POST'])
def api_send_message():
    if 'logged_in' not in session:
        return jsonify({"error": "Unauthorized"}), 401
    
    data = request.get_json()
    user_id = data.get('user_id')
    message = data.get('message')
    
    if not user_id or not message:
        return jsonify({"error": "Missing user_id or message"}), 400
    
    result = bot_admin.send_broadcast_message(message, [user_id])
    return jsonify(result)

# WebSocket для оновлення статистики в реальному часі
@socketio.on('connect')
def handle_connect():
    emit('connected', {'data': 'Connected to admin panel'})

@socketio.on('request_stats')
def handle_request_stats():
    stats = bot_admin.get_statistics()
    emit('stats_update', stats)

if __name__ == '__main__':
    port = int(os.getenv('ADMIN_PORT', 3000))
    debug = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'
    
    print(f"🚀 Запуск адмін панелі на порту {port}")
    print(f"🔗 Доступ: http://localhost:{port}")
    print(f"🔑 Пароль: {ADMIN_PASSWORD}")
    
    socketio.run(app, host='0.0.0.0', port=port, debug=debug) 